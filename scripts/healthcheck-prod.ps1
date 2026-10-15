$ErrorActionPreference = "Stop"

$urls = @(
  "https://api.c-pay.global/health",
  "https://admin.c-pay.global",
  "https://merchant.c-pay.global"
)

foreach ($url in $urls) {
  Write-Host "$url ..." -NoNewline
  Invoke-WebRequest -Uri $url -UseBasicParsing | Out-Null
  Write-Host " OK"
}
