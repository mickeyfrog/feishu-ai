# feishu-ai 登录自启：进程守护(supervisor) + 调试 Chrome
# 由计划任务「feishu-ai」在用户登录时触发（-WindowStyle Hidden 无窗口）
$root = 'D:\feishu-ai'
$work = Join-Path $PSScriptRoot '.'

# 已在跑就不重复启动（看 3000 端口）
$up = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
if (-not $up) {
  Start-Process node -ArgumentList 'supervisor.mjs' -WorkingDirectory $root -WindowStyle Hidden
}

# 调试 Chrome（生图/浏览器对话依赖）
$cdp = Test-NetConnection 127.0.0.1 -Port 9222 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $cdp) {
  & (Join-Path $work 'start-debug-chrome.ps1')
}