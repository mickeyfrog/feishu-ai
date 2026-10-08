# fix-tunnel.ps1 —— 一键修复 Cloudflare 隧道 1033 并安装「隧道自愈」
# 做的事：
#   1. 立即重启 cloudflared 服务（修当前 1033）
#   2. 注册 SYSTEM 级计划任务：每 2 分钟检查公网，隧道断了自动重启（10 分钟冷却）
#   3. 自检并打印结果
# 需要管理员：脚本会自动弹 UAC。

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
  exit
}

$ops = Split-Path -Parent $PSCommandPath
$watchdog = Join-Path $ops 'tunnel-watchdog.ps1'

Write-Host "=== 1/3 重启 cloudflared 服务 ===" -ForegroundColor Cyan
try {
  Restart-Service cloudflared -Force -ErrorAction Stop
  Write-Host "已重启 cloudflared"
} catch {
  Write-Host ("重启失败: " + $_.Exception.Message) -ForegroundColor Red
}

Write-Host "=== 2/3 注册隧道自愈计划任务（SYSTEM，每 2 分钟）===" -ForegroundColor Cyan
$tr = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $watchdog + '"'
$name = 'feishu-ai-tunnel-watchdog'
schtasks /Create /TN $name /TR $tr /SC MINUTE /MO 2 /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host "计划任务 $name 已注册（每 2 分钟）" } else { Write-Host "计划任务注册失败（错误码 $LASTEXITCODE）" -ForegroundColor Red }

Write-Host "=== 3/3 等待重连并自检 ===" -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
  Start-Sleep -Seconds 6
  try {
    $r = Invoke-WebRequest "https://ai.wzyiloveu.kdns.fr/api/test" -UseBasicParsing -TimeoutSec 12
    if ($r.StatusCode -eq 200) { $ok = $true; Write-Host ("公网验证: 200 " + $r.Content) -ForegroundColor Green }
  } catch { }
}
if (-not $ok) { Write-Host "60s 内未恢复：隧道重连较慢或网络本身有问题，稍后会自动重试" -ForegroundColor Yellow }

Write-Host ""
Write-Host "完成。之后隧道断了会在 2 分钟内自动重启（日志 C:\ProgramData\cloudflared\watchdog.log）。" -ForegroundColor Green
Write-Host "本窗口 20 秒后自动关闭。"
Start-Sleep -Seconds 20