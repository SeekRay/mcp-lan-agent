#!/usr/bin/env node
/**
 * pc-agent — 一台局域网 PC 上的轻量 MCP Server
 * ---------------------------------------------------------------
 * 传输：Streamable HTTP (MCP 2026-07-28 / 2025 系列自动协商)
 * 暴露：文件读写、终端命令、后台任务（渲染 / FFmpeg）三项能力
 * 安全：Bearer Token + Host/Origin 校验 + IP 白名单 + 路径围栏
 *
 * 启动：  node server.mjs
 * 健康检查： curl http://127.0.0.1:40000/health
 */

import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { McpServer } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
} from '@modelcontextprotocol/node';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. 配置
// ---------------------------------------------------------------------------

/** 读取同目录下的 .env（不覆盖已存在的真实环境变量）。 */
function loadDotEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '.env');
  if (!fs.existsSync(file)) return;
  // 去掉可能存在的 UTF-8 BOM：PowerShell 5.1 的 Set-Content -Encoding utf8 会写入 BOM，
  // 不去掉的话第一个键名会变成 "\uFEFFPC_AGENT_HOST" 而读不到。
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const listEnv = (name, fallback) =>
  (process.env[name] ?? fallback)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);

const CFG = {
  host: process.env.PC_AGENT_HOST || '0.0.0.0',
  port: Number(process.env.PC_AGENT_PORT || 40000),
  token: process.env.PC_AGENT_TOKEN || '',
  /** 允许读写的目录；第一个目录也是相对路径的基准。 */
  roots: listEnv('PC_AGENT_ROOTS', process.cwd()).map((p) => path.resolve(p)),
  /** Host 头白名单（DNS rebinding 防护），不含端口。 */
  allowedHosts: listEnv('PC_AGENT_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1]'),
  /** 客户端 IP 白名单；留空表示任何持有 token 的来源都放行。 */
  allowedIps: listEnv('PC_AGENT_ALLOWED_IPS', ''),
  maxOutputBytes: Number(process.env.PC_AGENT_MAX_OUTPUT || 200_000),
  maxReadBytes: Number(process.env.PC_AGENT_MAX_READ || 4 * 1024 * 1024),
  defaultTimeoutSec: Number(process.env.PC_AGENT_CMD_TIMEOUT || 120),
};

const JOB_DIR = path.join(os.tmpdir(), 'pc-agent-jobs');

/**
 * 本机所有非回环地址（IPv6 加方括号，去掉 %zone 后缀）。
 * 自动并进 Host 白名单：这样 DHCP 换了地址，也不用回来改 .env 的 ALLOWED_HOSTS。
 */
function localHostNames() {
  const names = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = entry.address.split('%')[0];
      if (!address) continue;
      names.push(address.includes(':') ? `[${address}]` : address);
    }
  }
  return names;
}

CFG.allowedHosts = [...new Set([...CFG.allowedHosts, ...localHostNames()])];

// ---------------------------------------------------------------------------
// 2. 小工具
// ---------------------------------------------------------------------------

const log = (...args) => console.error(`[pc-agent ${new Date().toISOString()}]`, ...args);

const ok = (value) => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

const fail = (message) => ({
  isError: true,
  content: [{ type: 'text', text: String(message) }],
});

/** 把用户给的路径解析成绝对路径，并确认它落在允许的根目录内。 */
function resolveInside(input, { mustExist = false } = {}) {
  const raw = String(input ?? '.').trim() || '.';
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(CFG.roots[0], raw);
  if (!CFG.roots.some((root) => isInside(abs, root))) {
    throw new Error(
      `路径越界：${abs}\n只允许访问：\n${CFG.roots.map((r) => `  - ${r}`).join('\n')}`,
    );
  }
  if (mustExist && !fs.existsSync(abs)) throw new Error(`路径不存在：${abs}`);
  return abs;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

const clip = (text, cap = CFG.maxOutputBytes) => {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(-cap), truncated: true };
};

/**
 * 解码子进程输出。Windows 的 cmd.exe 默认用 OEM 代码页（中文系统是 GBK/936），
 * 直接 toString('utf8') 会得到「不是内部或外部命令」这类乱码。
 * 先按 UTF-8 解，替换字符过多时退回 GBK。
 */
function decodeSmart(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const utf8 = buffer.toString('utf8');
  const replacement = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacement === 0 || replacement / Math.max(utf8.length, 1) < 0.005) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

function tokenize(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

const SHELLS = ['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'none'];

function buildSpawn(command, shell, cwd) {
  const kind = (shell || (process.platform === 'win32' ? 'cmd' : 'bash')).toLowerCase();
  const opts = {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: process.env,
  };
  switch (kind) {
    case 'cmd':
      // 先把控制台切到 UTF-8，cmd 自己输出的中文提示（"不是内部或外部命令"）
      // 才不会变成乱码。保留退出码语义：& 之后 cmd 返回最后一条命令的 errorlevel。
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`],
        opts,
      };
    case 'powershell':
      return {
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        opts,
      };
    case 'pwsh':
      return {
        file: 'pwsh.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        opts,
      };
    case 'bash':
      return { file: 'bash', args: ['-lc', command], opts };
    case 'sh':
      return { file: 'sh', args: ['-c', command], opts };
    case 'none': {
      const argv = tokenize(command);
      if (!argv.length) throw new Error('command 为空');
      return { file: argv[0], args: argv.slice(1), opts };
    }
    default:
      throw new Error(`不支持的 shell：${kind}（可选 ${SHELLS.join(' / ')}）`);
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出了 */
    }
  }
}

const elapsed = (start) => `${Date.now() - start} ms`;

// ---------------------------------------------------------------------------
// 3. 后台任务表
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const jobs = new Map();

function jobView(job) {
  return {
    jobId: job.id,
    name: job.name,
    pid: job.pid,
    command: job.command,
    shell: job.shell,
    cwd: job.cwd,
    state: job.exitCode !== null ? 'exited' : job.signal ? 'killed' : 'running',
    exitCode: job.exitCode,
    signal: job.signal,
    startedAt: new Date(job.startedAt).toISOString(),
    endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
    durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
    logFile: job.logFile,
    logBytes: (() => {
      try {
        return fs.statSync(job.logFile).size;
      } catch {
        return 0;
      }
    })(),
  };
}

function jobTail(job, bytes) {
  try {
    const size = fs.statSync(job.logFile).size;
    const from = Math.max(0, size - bytes);
    const fd = fs.openSync(job.logFile, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      return { text: buf.toString('utf8'), truncated: from > 0 };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { text: `（无法读取日志：${error.message}）`, truncated: false };
  }
}

// ---------------------------------------------------------------------------
// 4. MCP Server 与工具
// ---------------------------------------------------------------------------

function buildServer() {
  const server = new McpServer(
    { name: 'pc-agent', version: '1.0.0' },
    {
      instructions:
        '这是一台局域网 PC 上的执行代理。文件路径可以是绝对路径，也可以是相对于第一个允许根目录的相对路径；' +
        '所有路径都被限制在允许根目录之内。短命令用 run_command；渲染、FFmpeg 合成这类长任务用 spawn_job 起后台进程，' +
        '再用 job_status 轮询日志，避免让单次工具调用一直阻塞。',
    },
  );

  // --- 系统信息 ---------------------------------------------------------
  server.registerTool(
    'system_info',
    {
      title: '系统信息',
      description: '返回这台 PC 的操作系统、CPU、内存、Node 版本、允许的根目录与后台任务数。',
      inputSchema: z.object({}),
    },
    async () => {
      const cpus = os.cpus();
      return ok({
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        hostname: os.hostname(),
        cpu: cpus.length ? `${cpus[0].model} × ${cpus.length}` : 'unknown',
        memory: {
          totalGB: +(os.totalmem() / 2 ** 30).toFixed(1),
          freeGB: +(os.freemem() / 2 ** 30).toFixed(1),
        },
        node: process.version,
        pid: process.pid,
        cwd: process.cwd(),
        roots: CFG.roots,
        listen: `${CFG.host}:${CFG.port}`,
        jobs: jobs.size,
        uptimeSec: Math.round(process.uptime()),
      });
    },
  );

  // --- 列目录 -----------------------------------------------------------
  server.registerTool(
    'list_dir',
    {
      title: '列目录',
      description: '列出目录内容（可递归）。返回类型、大小、修改时间。',
      inputSchema: z.object({
        path: z.string().describe('目录路径，相对或绝对'),
        depth: z.number().int().min(1).max(6).optional().describe('递归深度，默认 1'),
        limit: z.number().int().min(1).max(5000).optional().describe('最多返回条目数，默认 500'),
        includeHidden: z.boolean().optional().describe('是否包含以 . 开头的条目，默认 false'),
      }),
    },
    async ({ path: dir, depth = 1, limit = 500, includeHidden = false }) => {
      try {
        const root = resolveInside(dir, { mustExist: true });
        const entries = [];
        let clipped = false;

        const walk = async (current, level) => {
          if (entries.length >= limit) {
            clipped = true;
            return;
          }
          let names;
          try {
            names = await fsp.readdir(current, { withFileTypes: true });
          } catch (error) {
            entries.push({ path: current, error: error.message });
            return;
          }
          names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          for (const entry of names) {
            if (!includeHidden && entry.name.startsWith('.')) continue;
            if (entries.length >= limit) {
              clipped = true;
              return;
            }
            const full = path.join(current, entry.name);
            let stat = null;
            try {
              stat = await fsp.stat(full);
            } catch {
              /* 断开的符号链接等 */
            }
            entries.push({
              path: full,
              rel: path.relative(root, full) || '.',
              type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file',
              size: stat?.isFile() ? stat.size : undefined,
              modified: stat ? new Date(stat.mtimeMs).toISOString() : undefined,
            });
            if (entry.isDirectory() && level < depth) await walk(full, level + 1);
          }
        };

        await walk(root, 1);
        return ok({ root, count: entries.length, clipped, entries });
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  // --- 读文件 -----------------------------------------------------------
  server.registerTool(
    'read_file',
    {
      title: '读文件',
      description:
        `读取文本文件，带行号。默认最多 ${Math.round(CFG.maxReadBytes / 1024)} KB。` +
        '二进制文件请用 encoding="base64" 配合 offset/limit(字节) 分段读。',
      inputSchema: z.object({
        path: z.string().describe('文件路径'),
        offset: z.number().int().min(1).optional().describe('文本模式=起始行号(1基)；base64 模式=起始字节'),
        limit: z.number().int().min(1).optional().describe('文本模式=行数；base64 模式=字节数'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('默认 utf8'),
      }),
    },
    async ({ path: file, offset = 1, limit, encoding = 'utf8' }) => {
      try {
        const abs = resolveInside(file, { mustExist: true });
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) return fail(`${abs} 是目录，请用 list_dir`);

        const handle = await fsp.open(abs, 'r');
        try {
          if (encoding === 'base64') {
            const bytes = Math.min(limit ?? 65536, CFG.maxReadBytes);
            const buf = Buffer.alloc(bytes);
            const { bytesRead } = await handle.read(buf, 0, bytes, offset - 1);
            return ok({
              path: abs,
              size: stat.size,
              byteOffset: offset - 1,
              bytesRead,
              eof: offset - 1 + bytesRead >= stat.size,
              base64: buf.subarray(0, bytesRead).toString('base64'),
            });
          }

          const size = Math.min(stat.size, CFG.maxReadBytes);
          const buf = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buf, 0, size, 0);
          const head = buf.subarray(0, Math.min(bytesRead, 8000));
          if (head.includes(0)) {
            return fail(
              `${abs} 看起来是二进制文件（${stat.size} 字节）。请用 encoding="base64" 读取。`,
            );
          }

          const lines = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
          const total = lines.length;
          const start = Math.min(offset, total);
          const take = limit ?? total - start + 1;
          const slice = lines.slice(start - 1, start - 1 + take);
          const body = slice
            .map((line, index) => `${String(start + index).padStart(6, ' ')}\t${line}`)
            .join('\n');

          return ok({
            path: abs,
            size: stat.size,
            totalLines: total,
            fromLine: start,
            toLine: start + slice.length - 1,
            truncated: stat.size > CFG.maxReadBytes,
            content: body,
          });
        } finally {
          await handle.close();
        }
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  // --- 写文件 -----------------------------------------------------------
  server.registerTool(
    'write_file',
    {
      title: '写文件',
      description: '写入文本文件（默认覆盖，append=true 追加）。自动创建父目录。',
      inputSchema: z.object({
        path: z.string().describe('文件路径'),
        content: z.string().describe('文件内容'),
        append: z.boolean().optional().describe('追加而非覆盖，默认 false'),
        createDirs: z.boolean().optional().describe('自动创建父目录，默认 true'),
      }),
    },
    async ({ path: file, content, append = false, createDirs = true }) => {
      try {
        const abs = resolveInside(file);
        if (createDirs) await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content, append ? { flag: 'a', encoding: 'utf8' } : 'utf8');
        const stat = await fsp.stat(abs);
        return ok({
          path: abs,
          bytes: stat.size,
          mode: append ? 'append' : 'overwrite',
        });
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  // --- 前台命令 ---------------------------------------------------------
  server.registerTool(
    'run_command',
    {
      title: '执行命令（前台）',
      description:
        '执行一条命令并等待结束，返回退出码与输出。适合几秒到几分钟的任务。' +
        '更长的任务（渲染、FFmpeg 合成）请用 spawn_job。超时会杀掉整个进程树。',
      inputSchema: z.object({
        command: z.string().describe('命令行字符串'),
        shell: z.enum(SHELLS).optional().describe('默认 Windows 用 cmd，其他平台用 bash'),
        cwd: z.string().optional().describe('工作目录，默认第一个允许根目录'),
        timeoutSec: z.number().int().min(1).max(3600).optional().describe(`默认 ${CFG.defaultTimeoutSec}`),
      }),
    },
    async ({ command, shell, cwd, timeoutSec = CFG.defaultTimeoutSec }) => {
      const started = Date.now();
      let spec;
      let workdir;
      try {
        workdir = resolveInside(cwd ?? '.', { mustExist: true });
        spec = buildSpawn(command, shell, workdir);
      } catch (error) {
        return fail(error.message);
      }

      return await new Promise((resolve) => {
        /** 先攒 Buffer，结束时统一解码：按块 toString 会把多字节字符切断。 */
        const outChunks = [];
        const errChunks = [];
        let outBytes = 0;
        let errBytes = 0;
        let truncated = false;
        let timedOut = false;
        let settled = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;

        const push = (chunks, chunk, addBytes) => {
          if (addBytes > CFG.maxOutputBytes * 2) {
            truncated = true;
            return addBytes;
          }
          chunks.push(chunk);
          return addBytes + chunk.length;
        };

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const out = clip(decodeSmart(Buffer.concat(outChunks)));
          const err = clip(decodeSmart(Buffer.concat(errChunks)));
          resolve(
            ok({
              ...payload,
              command,
              shell: shell || (process.platform === 'win32' ? 'cmd' : 'bash'),
              cwd: workdir,
              duration: elapsed(started),
              timedOut,
              truncated: truncated || out.truncated || err.truncated,
              stdout: out.text,
              stderr: err.text,
            }),
          );
        };

        let child;
        try {
          child = spawn(spec.file, spec.args, { ...spec.opts, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          return resolve(fail(`无法启动进程：${error.message}`));
        }

        const timerMs = timeoutSec * 1000;
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timerMs);

        child.stdout?.on('data', (chunk) => {
          outBytes = push(outChunks, chunk, outBytes);
        });
        child.stderr?.on('data', (chunk) => {
          errBytes = push(errChunks, chunk, errBytes);
        });
        child.on('error', (error) => finish({ exitCode: null, error: error.message }));
        child.on('close', (code, signal) => finish({ exitCode: code, signal: signal ?? null }));
      });
    },
  );

  // --- 后台任务 ---------------------------------------------------------
  server.registerTool(
    'spawn_job',
    {
      title: '启动后台任务',
      description:
        '在后台启动一条命令（stdout/stderr 写入日志文件），立刻返回 jobId。' +
        '用于渲染、FFmpeg 合成等几分钟以上的任务；用 job_status 轮询进度。',
      inputSchema: z.object({
        command: z.string().describe('命令行字符串'),
        name: z.string().optional().describe('任务名，便于识别'),
        shell: z.enum(SHELLS).optional(),
        cwd: z.string().optional().describe('工作目录，默认第一个允许根目录'),
      }),
    },
    async ({ command, name, shell, cwd }) => {
      try {
        const workdir = resolveInside(cwd ?? '.', { mustExist: true });
        const spec = buildSpawn(command, shell, workdir);
        await fsp.mkdir(JOB_DIR, { recursive: true });

        const id = randomUUID().slice(0, 8);
        const logFile = path.join(JOB_DIR, `${id}.log`);
        const fd = fs.openSync(logFile, 'a');

        const child = spawn(spec.file, spec.args, {
          ...spec.opts,
          stdio: ['ignore', fd, fd],
        });
        fs.closeSync(fd);

        const job = {
          id,
          name: name || command.slice(0, 60),
          command,
          shell: shell || (process.platform === 'win32' ? 'cmd' : 'bash'),
          cwd: workdir,
          pid: child.pid,
          logFile,
          startedAt: Date.now(),
          exitCode: null,
          signal: null,
          endedAt: null,
          child,
        };

        child.on('error', (error) => {
          job.error = error.message;
          job.exitCode = -1;
          job.endedAt = Date.now();
        });
        child.on('close', (code, signal) => {
          job.exitCode = code;
          job.signal = signal ?? null;
          job.endedAt = Date.now();
        });

        jobs.set(id, job);
        return ok({
          ...jobView(job),
          hint: '用 job_status 查看日志与状态；用 kill_job 终止。',
        });
      } catch (error) {
        return fail(error.message);
      }
    },
  );

  server.registerTool(
    'job_status',
    {
      title: '查询后台任务',
      description: '不传 jobId 时列出全部任务；传入 jobId 时返回该任务的状态与日志尾部。',
      inputSchema: z.object({
        jobId: z.string().optional(),
        tailBytes: z.number().int().min(256).max(2_000_000).optional().describe('日志尾部字节数，默认 65536'),
      }),
    },
    async ({ jobId, tailBytes = 65536 }) => {
      if (!jobId) {
        return ok({
          count: jobs.size,
          jobs: [...jobs.values()].map(jobView),
        });
      }
      const job = jobs.get(jobId);
      if (!job) return fail(`没有 jobId=${jobId} 的任务`);
      const tail = jobTail(job, tailBytes);
      return ok({
        ...jobView(job),
        logTruncated: tail.truncated,
        log: tail.text,
      });
    },
  );

  server.registerTool(
    'kill_job',
    {
      title: '终止后台任务',
      description: '终止指定后台任务及其子进程树。',
      inputSchema: z.object({ jobId: z.string() }),
    },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      if (!job) return fail(`没有 jobId=${jobId} 的任务`);
      killTree(job.child);
      return ok({ jobId, killed: true, ...jobView(job) });
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// 5. HTTP 入口
// ---------------------------------------------------------------------------

const validateHost = hostHeaderValidation(CFG.allowedHosts);
const validateOrigin = originValidation(CFG.allowedHosts);

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function authorized(req) {
  if (!CFG.token) return true; // 仅允许在回环地址上无 token 运行
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEquals(match[1].trim(), CFG.token);
}

function ipAllowed(req) {
  if (!CFG.allowedIps.length) return true;
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return CFG.allowedIps.some((ip) => ip === remote);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // 健康检查：不鉴权，方便 Mac 侧先探连通性
  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      server: 'pc-agent',
      version: '1.0.0',
      platform: process.platform,
      hostname: os.hostname(),
      uptimeSec: Math.round(process.uptime()),
      jobs: jobs.size,
      authRequired: Boolean(CFG.token),
    });
  }

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(
      'pc-agent MCP server\n\n' +
        'MCP endpoint : POST /mcp\n' +
        'Health       : GET  /health\n' +
        (CFG.token ? 'Auth         : Authorization: Bearer <PC_AGENT_TOKEN>\n' : ''),
    );
  }

  if (url.pathname !== '/mcp') {
    return sendJson(res, 404, { error: 'not_found', hint: 'MCP 端点是 /mcp' });
  }

  // DNS rebinding / 跨站防护
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;

  if (!ipAllowed(req)) {
    log('拒绝非白名单来源', req.socket.remoteAddress);
    return sendJson(res, 403, { error: 'ip_not_allowed', remote: req.socket.remoteAddress });
  }

  if (!authorized(req)) {
    res.setHeader('www-authenticate', 'Bearer realm="pc-agent"');
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const server = buildServer();
  // sessionIdGenerator: undefined ⇒ 无状态模式，每个请求一个独立的 transport。
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    log('处理 MCP 请求失败：', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// 6. 启动
// ---------------------------------------------------------------------------

const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(CFG.host);

if (!CFG.token && !isLoopback) {
  console.error(
    '\n[拒绝启动] PC_AGENT_TOKEN 为空，却要绑定非回环地址 ' +
      `${CFG.host}。\n` +
      '这台服务器能执行任意命令，绝不能无鉴权暴露到局域网。\n' +
      '请先生成一个 token，例如 PowerShell：\n' +
      '  $b = New-Object byte[] 32; ([Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($b); [Convert]::ToBase64String($b)\n' +
      '然后写进 .env：PC_AGENT_TOKEN=<那个值>\n',
  );
  process.exit(1);
}

if (!CFG.token) {
  console.error('[警告] 未设置 PC_AGENT_TOKEN，正在无鉴权运行（仅限本机测试）。');
}

await fsp.mkdir(JOB_DIR, { recursive: true }).catch(() => {});

httpServer.listen(CFG.port, CFG.host, () => {
  log(`pc-agent 已启动  http://${CFG.host}:${CFG.port}/mcp`);
  log(`健康检查        http://127.0.0.1:${CFG.port}/health`);
  log(`允许的根目录    ${CFG.roots.join('  |  ')}`);
  log(`Host 白名单     ${CFG.allowedHosts.join(', ')}`);
  log(`IP 白名单       ${CFG.allowedIps.length ? CFG.allowedIps.join(', ') : '(任意持有 token 的来源)'}`);
  log(`鉴权            ${CFG.token ? 'Bearer token 已启用' : '无（仅回环）'}`);
  log(`任务日志目录    ${JOB_DIR}`);
});

httpServer.on('error', (error) => {
  console.error('[pc-agent] 监听失败：', error.message);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`收到 ${signal}，正在退出…`);
    for (const job of jobs.values()) killTree(job.child);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
