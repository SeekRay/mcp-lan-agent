# install-autostart.ps1
# ---------------------------------------------------------------------------
# 把 pc-agent 注册成「开机/登录后自动运行」的计划任务（无需第三方工具）。
# 在 PC 上以管理员身份运行 PowerShell，然后：
#     cd <本目录>;  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# 卸载：  .\install-autostart.ps1 -Uninstall
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string]$TaskName = 'PcAgentMcp',
    [int]$Port = 40000,
    [string]$AllowRemoteAddress = '',  # 客户端 IP；强烈建议填，留空=不限制来源
    # 默认「登录后启动」：停在登录界面时服务不可用。
    # -AtStartup 改成「开机即启动」（S4U，无需存密码），登录界面也能连。
    [switch]$AtStartup,
    # -AtStartup 失败（S4U 权限不足）时用这个，以 SYSTEM 身份运行，最不容易被权限挡住。
    [switch]$AsSystem,
    [switch]$SkipFirewall,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}
$isAdmin = Test-Admin

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除计划任务 $TaskName" -ForegroundColor Green
    } else {
        Write-Host "没有找到计划任务 $TaskName" -ForegroundColor Yellow
    }
    if ($isAdmin) {
        Get-NetFirewallRule -DisplayName "pc-agent MCP*" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule
        Write-Host '已删除防火墙规则' -ForegroundColor Green
    }
    return
}

# ---------------------------------------------------------------- 前置检查
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node.exe。请先安装 Node.js LTS。' }

if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Warning '.env 不存在。请先复制 .env.example 为 .env 并设置 PC_AGENT_TOKEN，否则服务会拒绝在 0.0.0.0 上启动。'
}

# ---------------------------------------------------------------- 计划任务
$action = New-ScheduledTaskAction -Execute $node -Argument 'server.mjs' -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

if ($AtStartup -or $AsSystem) {
    # 开机即启动：不依赖谁登录。留 20 秒等网络栈起来（静态 IP 通常更快，
    # 但 DHCP/网卡初始化在部分机器上要等一会儿）。
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT20S'

    if ($AsSystem) {
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $how = '开机即启动（SYSTEM 身份，无需登录）'
    } else {
        $principal = New-ScheduledTaskPrincipal `
            -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
        $how = '开机即启动（S4U，无需登录、无需存密码）'
    }

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'LAN MCP server (pc-agent)' -Force | Out-Null
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description 'LAN MCP server (pc-agent)' -Force | Out-Null
    $how = '登录后自动启动（停在登录界面时不可用；要开机即用请加 -AtStartup）'
}

Write-Host "已注册计划任务 $TaskName：$how，崩溃自动重启" -ForegroundColor Green

# ---------------------------------------------------------------- 防火墙
if (-not $SkipFirewall) {
    if (-not $isAdmin) {
        Write-Warning '当前不是管理员，跳过防火墙配置。请用管理员身份重跑，或手动执行下面这条：'
        Write-Host ("  New-NetFirewallRule -DisplayName 'pc-agent MCP' -Direction Inbound " +
                    "-Protocol TCP -LocalPort $Port -Action Allow -Profile Private" +
                    $(if ($AllowRemoteAddress) { " -RemoteAddress $AllowRemoteAddress" } else { '' }))
    } else {
        Get-NetFirewallRule -DisplayName "pc-agent MCP" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule
        $params = @{
            DisplayName  = 'pc-agent MCP'
            Direction    = 'Inbound'
            Protocol     = 'TCP'
            LocalPort    = $Port
            Action       = 'Allow'
            Profile      = 'Private'
        }
        if ($AllowRemoteAddress) { $params.RemoteAddress = $AllowRemoteAddress }
        New-NetFirewallRule @params | Out-Null
        Write-Host "已添加防火墙入站规则：TCP $Port（来源 $(if ($AllowRemoteAddress) { $AllowRemoteAddress } else { '任意' })，仅专用网络）" -ForegroundColor Green
    }
}

# ---------------------------------------------------------------- 立即启动
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
    Write-Host "服务已就绪：$($health.server) v$($health.version) on $($health.hostname)" -ForegroundColor Green
} catch {
    Write-Warning "任务已启动但健康检查失败：$($_.Exception.Message)"
    Write-Host '看看任务状态： Get-ScheduledTask -TaskName PcAgentMcp | Get-ScheduledTaskInfo'
}

Write-Host "`n下一步：在 Mac mini 上用 token 连一次——" -ForegroundColor Cyan
Write-Host "  node tools/smoke-test.mjs http://<这台PC的IP>:$Port/mcp `"<PC_AGENT_TOKEN>`""
