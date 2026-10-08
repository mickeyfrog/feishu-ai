# cloudflared 隧道看门狗（需以 SYSTEM / 管理员运行，才能重启服务）
# 逻辑：公网探测失败 + 本机服务正常 => 判定隧道断开 => 重启 cloudflared
# 冷却：10 分钟内最多重启 1 次，避免断网时反复重启

$publicUrl = 'https://ai.wzyiloveu.kdns.fr/api/test'
$localUrl  = 'http://127.0.0.1:3000/api/test'
$logFile   = 'C:\ProgramData\cloudflared\watchdog.log'
$stampFile = 'C:\ProgramData\cloudflared\watchdog-last-restart.txt'

function Write-Tw([string]$msg) {
  $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

function Test-Url([string]$url, [int]$timeoutSec) {
  try {
    $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec $timeoutSec
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# 1) 本机服务不健康 -> 交给 app 看门狗处理，这里不动隧道
if (-not (Test-Url $localUrl 5)) { exit 0 }

# 2) 公网连续 3 次探测（每次间隔 5s）都失败，才判定隧道断开
$publicOk = $false
for ($i = 1; $i -le 3; $i++) {
  if (Test-Url $publicUrl 10) { $publicOk = $true; break }
  if ($i -lt 3) { Start-Sleep -Seconds 5 }
}
if ($publicOk) { exit 0 }

# 3) 冷却检查
if (Test-Path $stampFile) {
  try {
    $last = [datetime]::Parse((Get-Content $stampFile -Raw).Trim())
    if (((Get-Date) - $last).TotalMinutes -lt 10) {
      Write-Tw "隧道仍不通，但 10 分钟冷却中（上次重启 $last），跳过"
      exit 0
    }
  } catch { }
}

Write-Tw "公网探测失败且本机正常 -> 判定隧道断开，重启 cloudflared"
(Get-Date).ToString("o") | Set-Content $stampFile -Encoding UTF8
try {
  Restart-Service cloudflared -Force -ErrorAction Stop
  Write-Tw "cloudflared 服务已重启"
} catch {
  Write-Tw ("重启失败: " + $_.Exception.Message)
  exit 1
}

# 4) 等待重连并复检
Start-Sleep -Seconds 25
if (Test-Url $publicUrl 15) { Write-Tw "恢复成功：公网 200" }
else { Write-Tw "25s 后仍未恢复，下次触发会再试（冷却结束后）" }