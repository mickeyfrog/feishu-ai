# 启动「生图专用」调试 Chrome（AI_IMAGE_PROVIDER=browser 的前置条件）
# - 独立用户目录 data\chrome-profile，和你的日常 Chrome 完全隔离
# - 首次启动后请在这个窗口里访问 https://chatgpt.com 并人工登录，登录态持久化在该目录
# - 该 Chrome 窗口需要一直开着；关闭后生图接口会返回「浏览器未连接」

$chrome  = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profileDir = 'D:\feishu-ai\data\chrome-profile'

if (-not (Test-Path $chrome)) {
  Write-Host "找不到 Chrome：$chrome"
  exit 1
}
New-Item -ItemType Directory -Force $profileDir | Out-Null

$listening = Test-NetConnection 127.0.0.1 -Port 9222 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($listening) {
  Write-Host '调试 Chrome 已在运行（9222 端口监听中），只补开一个 chatgpt.com 标签'
  Start-Process $chrome -ArgumentList @("--user-data-dir=$profileDir", 'https://chatgpt.com/')
} else {
  Start-Process $chrome -ArgumentList @('--remote-debugging-port=9222', "--user-data-dir=$profileDir", 'https://chatgpt.com/')
  Write-Host ('已启动调试 Chrome，user-data-dir=' + $profileDir)
}
Write-Host '首次使用请在该窗口登录 chatgpt.com；之后重启服务即可直接生图'
