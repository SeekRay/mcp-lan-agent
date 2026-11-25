#!/usr/bin/env node
/**
 * smoke-test.mjs — 用官方 MCP 客户端连一遍 pc-agent，验证端到端可用。
 *
 *   node tools/smoke-test.mjs [url] [token]
 *
 * 例：
 *   node tools/smoke-test.mjs http://192.168.1.50:40000/mcp "$PC_AGENT_TOKEN"
 *
 * 特点：先问服务端 system_info，再按**对端**平台挑命令——所以可以在一台
 * Mac/Linux 上验证一台 Windows PC，不会被本机平台带偏。
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2] || process.env.PC_AGENT_URL || 'http://127.0.0.1:40000/mcp';
const token = process.argv[3] || process.env.PC_AGENT_TOKEN || '';

const problems = [];
const note = (msg) => problems.push(msg);

const textOf = (result) =>
  (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
});
const client = new Client({ name: 'pc-agent-smoke', version: '1.0.0' });

const call = async (name, args) => {
  console.log(`\n=== ${name} ===`);
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    note(`${name} 抛出异常：${error.message}`);
    console.log(`❌ ${error.message}`);
    return null;
  }
  const text = textOf(result);
  if (result.isError) {
    note(`${name} 返回 isError：${text.split('\n')[0]}`);
    console.log(`❌ ${text}`);
    return null;
  }
  console.log(text.length > 1000 ? `${text.slice(0, 1000)}\n…（已截断）` : text);
  return text;
};

let exitCode = 0;

try {
  await client.connect(transport);
  console.log(`已连接 ${url}`);

  const tools = (await client.listTools()).tools;
  console.log(`\n=== tools/list (${tools.length}) ===`);
  for (const tool of tools) {
    console.log(`- ${tool.name.padEnd(13)} ${tool.description?.slice(0, 52) ?? ''}`);
  }
  if (tools.length < 8) note(`工具数量少于预期：${tools.length}`);

  // 先探对端平台，再决定用什么命令
  const infoText = await call('system_info', {});
  let remote = {};
  try {
    remote = JSON.parse(infoText ?? '{}');
  } catch {
    note('system_info 返回的不是 JSON');
  }
  const isWindows = String(remote.platform ?? '').startsWith('win32');

  await call('write_file', {
    path: 'smoke-test.txt',
    content: `written by smoke-test at ${new Date().toISOString()}\n`,
  });
  await call('read_file', { path: 'smoke-test.txt' });

  await call('run_command', {
    command: isWindows ? 'echo hello from pc-agent && ver' : 'echo hello from pc-agent && uname -a',
    timeoutSec: 20,
  });

  // 验证非 ASCII 输出没有被解成乱码：Windows 上这条命令会触发中文报错
  const missText = await call('run_command', { command: '__pc_agent_missing_command__', timeoutSec: 15 });
  if (missText !== null) {
    const parsed = (() => {
      try {
        return JSON.parse(missText);
      } catch {
        return null;
      }
    })();
    const err = parsed?.stderr ?? '';
    if (/\uFFFD/.test(err)) {
      note('stderr 出现 U+FFFD，说明编码没解对（中文系统应为 UTF-8 或 GBK 正常可读）');
    } else if (isWindows && !/不是|not recognized|не является/i.test(err)) {
      note(`stderr 内容异常，预期包含 Windows 的"不是内部或外部命令"：${err.slice(0, 80)}`);
    }
  }

  const job = await call('spawn_job', {
    command: isWindows ? 'ping -n 3 127.0.0.1 >nul & echo job done' : 'sleep 2; echo job done',
    name: 'smoke-job',
  });
  let jobId = null;
  try {
    jobId = JSON.parse(job ?? '{}').jobId ?? null;
  } catch {
    /* ignore */
  }
  if (!jobId) {
    note('spawn_job 没有返回 jobId');
  } else {
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const status = await call('job_status', { jobId });
    try {
      const parsed = JSON.parse(status ?? '{}');
      if (parsed.state !== 'exited') note(`任务 ${jobId} 状态是 ${parsed.state}，预期 exited`);
      if (parsed.exitCode !== 0) note(`任务 ${jobId} 退出码 ${parsed.exitCode}，预期 0`);
      if (!/job done/.test(parsed.log ?? '')) note(`任务 ${jobId} 日志里没有 "job done"`);
    } catch {
      note('job_status 返回的不是 JSON');
    }
  }
} catch (error) {
  note(`连接失败：${error?.message ?? error}`);
  const msg = String(error?.message ?? '');
  if (msg.includes('401')) console.error('   提示：token 不对，或服务端 .env 里 PC_AGENT_TOKEN 为空。');
  if (msg.includes('fetch failed')) {
    console.error('   提示：连不上。查 PC 的防火墙入站规则、服务是否在跑、IP 是否正确。');
  }
} finally {
  await client.close().catch(() => {});
}

console.log('\n' + '-'.repeat(60));
if (problems.length === 0) {
  console.log('✅ 全部通过');
} else {
  console.log(`❌ ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`   - ${problem}`);
  exitCode = 1;
}
process.exit(exitCode);
