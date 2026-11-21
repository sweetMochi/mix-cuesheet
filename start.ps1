<#
.SYNOPSIS
  啟動 mix-cuesheet：需要時安裝依賴、build 前端，更新 yt-dlp，然後啟動後端

.DESCRIPTION
  只有在 package-lock.json 或前端原始碼變更時才會重新安裝或重新 build
  每次啟動都會嘗試更新 yt-dlp；更新失敗（例如離線）時只顯示警告，繼續用現有版本啟動

.PARAMETER Rebuild
  強制重新安裝依賴並重新 build 前端
#>
#Requires -Version 7.0
param(
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'

# 後端直接執行 .ts 檔，需要 Node.js 內建的 type stripping
$minNodeVersion = [version]'22.18.0'

$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$stamps = Join-Path $root '.build-stamps'
$ytDlp = Join-Path $backend 'node_modules\youtube-dl-exec\bin\yt-dlp.exe'

function Invoke-Checked {
  param([string]$Description, [scriptblock]$Command)
  Write-Host "==> $Description" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description 失敗（結束代碼 $LASTEXITCODE）"
  }
}

# 以檔案內容的雜湊判斷是否需要重做某個步驟
function Get-InputHash {
  param([string[]]$Paths)
  $files = foreach ($path in $Paths) {
    if (Test-Path $path -PathType Container) {
      Get-ChildItem $path -Recurse -File | Sort-Object FullName
    } elseif (Test-Path $path) {
      Get-Item $path
    }
  }
  $lines = foreach ($file in $files) {
    "$($file.FullName)|$((Get-FileHash $file.FullName -Algorithm SHA256).Hash)"
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}

function Test-StampCurrent {
  param([string]$Name, [string]$Hash)
  $stamp = Join-Path $stamps $Name
  return (-not $Rebuild) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $Hash)
}

function Set-Stamp {
  param([string]$Name, [string]$Hash)
  New-Item -ItemType Directory -Force $stamps | Out-Null
  Set-Content (Join-Path $stamps $Name) $Hash
}

# package-lock.json 變更或 node_modules 不存在時執行 npm ci
function Install-NpmDependencies {
  param([string]$Description, [string]$Directory, [string]$StampName)
  $lockHash = Get-InputHash @(Join-Path $Directory 'package-lock.json')
  if (-not (Test-Path (Join-Path $Directory 'node_modules')) -or -not (Test-StampCurrent $StampName $lockHash)) {
    # 不能加 --ignore-scripts：ffmpeg-static 和 youtube-dl-exec 靠安裝腳本下載執行檔
    Invoke-Checked $Description { npm ci --prefix $Directory }
    Set-Stamp $StampName $lockHash
  }
}

# --- Node.js ---

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "找不到 Node.js，請先安裝 $minNodeVersion 以上的版本後再執行"
}
$nodeVersion = [version](node --version).TrimStart('v')
if ($nodeVersion -lt $minNodeVersion) {
  throw "Node.js 版本是 $nodeVersion，需要 $minNodeVersion 以上，請更新後再執行"
}

# --- 依賴 ---

Install-NpmDependencies '安裝後端依賴' $backend 'npm-backend'
Install-NpmDependencies '安裝前端依賴' $frontend 'npm-frontend'

# --- 前端 build ---

$frontendInputs = @('src', 'public', 'angular.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json') |
  ForEach-Object { Join-Path $frontend $_ }
$frontendHash = Get-InputHash $frontendInputs
$distIndex = Join-Path $frontend 'dist\frontend\browser\index.html'
if (-not (Test-Path $distIndex) -or -not (Test-StampCurrent 'frontend' $frontendHash)) {
  Push-Location $frontend
  try {
    Invoke-Checked 'Build 前端' { npm run build }
  } finally {
    Pop-Location
  }
  Set-Stamp 'frontend' $frontendHash
}

# --- 更新 yt-dlp ---
# yt-dlp 刻意不鎖定版本（見 docs/adr/0002-backend-nodejs-hono.md），每次啟動都更新到最新版

if (Test-Path $ytDlp) {
  Write-Host '==> 更新 yt-dlp' -ForegroundColor Cyan
  & $ytDlp -U
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "yt-dlp 更新失敗（結束代碼 $LASTEXITCODE），繼續使用現有版本"
  }
} else {
  Write-Warning '找不到 yt-dlp 的執行檔，請加上 -Rebuild 重新安裝依賴'
}

# --- 啟動後端 ---
# 網址由後端啟動後自己印出

Write-Host ''
Write-Host '==> 啟動後端' -ForegroundColor Green
Push-Location $backend
try {
  & node src/server.ts
} finally {
  Pop-Location
}
