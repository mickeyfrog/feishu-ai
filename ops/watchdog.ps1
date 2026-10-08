# feishu-ai 看门狗：每 3 分钟由计划任务触发，确保服务与调试 Chrome 始终在线
# supervisor 负责子进程崩溃秒级重启；本脚本负责 supervisor 本身被杀/卡死的情况。
$root = 'D:\feishu-ai'
$log  = Join-Path $env:TEMP 'feishu-ai-watchdog.log'
$out  = Join-Path $env:TEMP 'feishu-ai-out.log'
$err  = Join-Path $env:TEMP 'feishu-ai-err.log'

function Write-Wd([string]$msg) {
  $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
  Add-Content -Path $log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

$healthy = $false
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:3000/api/test' -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { $healthy = $true }
} catch { $healthy = $false }

if (-not $healthy) {
  Write-Wd "服务无响应，开始恢复..."
  $owners = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($o in $owners) { Stop-Process -Id $o -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  $sup = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'supervisor' }
  if (-not $sup) {
    Start-Process node -ArgumentList 'supervisor.mjs' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Wd "已拉起 supervisor.mjs"
  } else {
    Write-Wd ("supervisor 在跑（PID=" + ($sup.ProcessId -join ",") + "），等待其自动重启子进程")
  }
  Start-Sleep -Seconds 6
  try {
    $r2 = Invoke-WebRequest 'http://127.0.0.1:3000/api/test' -UseBasicParsing -TimeoutSec 6
    Write-Wd ("恢复结果: " + $r2.StatusCode)
  } catch { Write-Wd "恢复失败，下次再试" }
}

$cdp = Test-NetConnection 127.0.0.1 -Port 9222 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $cdp) {
  & (Join-Path (Split-Path -Parent $PSCommandPath) 'start-debug-chrome.ps1') | Out-Null
  Write-Wd "已拉起调试 Chrome（9222）"
}