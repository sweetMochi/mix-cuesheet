<#
.SYNOPSIS
  啟動 mix-cuesheet：需要時建立 venv、安裝依賴、build 前端，然後啟動後端

.DESCRIPTION
  只有在 requirements.txt、package-lock.json 或前端原始碼變更時才會重新安裝或重新 build
  使用者不需要手動啟用虛擬環境；腳本直接呼叫 venv 內的 Python

.PARAMETER Rebuild
  強制重新安裝依賴並重新 build 前端
#>
#Requires -Version 7.0
param(
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$venv = Join-Path $backend '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$stamps = Join-Path $root '.build-stamps'

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

function Find-Python {
  $candidates = @(@('py', '-3.14'), @('python'))
  foreach ($candidate in $candidates) {
    if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
    $candidateArgs = @($candidate | Select-Object -Skip 1) + @('-c', 'import sys; print(sys.version_info[:2] == (3, 14))')
    $result = & $candidate[0] @candidateArgs 2> $null
    # 前置逗號避免單一元素的陣列在回傳時被展開成字串
    if ($LASTEXITCODE -eq 0 -and "$result".Trim() -eq 'True') { return , $candidate }
  }
  throw '找不到 Python 3.14，請先安裝後再執行'
}

# --- 後端：venv 與依賴 ---

if (-not (Test-Path $venvPython)) {
  $python = Find-Python
  $pythonArgs = @($python | Select-Object -Skip 1) + @('-m', 'venv', $venv)
  Invoke-Checked '建立虛擬環境' { & $python[0] @pythonArgs }
  Remove-Item (Join-Path $stamps 'requirements') -ErrorAction SilentlyContinue
}

$requirements = Join-Path $backend 'requirements.txt'
$requirementsHash = Get-InputHash @($requirements)
if (-not (Test-StampCurrent 'requirements' $requirementsHash)) {
  Invoke-Checked '安裝後端依賴' { & $venvPython -m pip install --disable-pip-version-check -q -r $requirements }
  Set-Stamp 'requirements' $requirementsHash
}

# --- 前端：npm 依賴與 build ---

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw '找不到 npm，請先安裝 Node.js 後再執行'
}

$lockFile = Join-Path $frontend 'package-lock.json'
$lockHash = Get-InputHash @($lockFile)
if (-not (Test-Path (Join-Path $frontend 'node_modules')) -or -not (Test-StampCurrent 'npm' $lockHash)) {
  Invoke-Checked '安裝前端依賴' { npm ci --prefix $frontend }
  Set-Stamp 'npm' $lockHash
}

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

# --- 啟動後端 ---

$port = & $venvPython -c 'import sys; sys.path.insert(0, sys.argv[1]); from app import config; print(config.PORT)' $backend
Write-Host ''
Write-Host "==> 啟動後端，請用瀏覽器開啟 http://127.0.0.1:$port/" -ForegroundColor Green
Write-Host '    按 Ctrl+C 結束' -ForegroundColor Green
Write-Host ''

Push-Location $backend
try {
  & $venvPython -m app
} finally {
  Pop-Location
}
