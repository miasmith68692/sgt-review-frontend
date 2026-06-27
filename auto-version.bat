@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM auto-version.bat — 自动递增版本补丁号
REM 用法: auto-version.bat "更新日志内容"
REM 默认: auto-version.bat (使用通用日志)
REM
REM 注意: 在 Trae 环境中可能因执行策略受限无法直接运行。
REM       如需在 Trae 中使用，可手动同步更新:
REM       1. version.json 中的 "version" 字段
REM       2. index.html 中 id="versionBadge" 的版本号

set LOG=%~1
if "%LOG%"=="" set LOG=功能优化与问题修复

set JSON_FILE=version.json
set HTML_FILE=index.html

REM 使用 PowerShell 读取和更新版本号
powershell -ExecutionPolicy Bypass -Command ^
  "$json = Get-Content '%JSON_FILE%' -Raw -Encoding UTF8 | ConvertFrom-Json;" ^
  "$oldVer = $json.version;" ^
  "$parts = $oldVer -split '\.';" ^
  "$patch = [int]$parts[2] + 1;" ^
  "$newVer = $parts[0] + '.' + $parts[1] + '.' + $patch;" ^
  "$json.version = $newVer;" ^
  "$json.releaseDate = (Get-Date -Format 'yyyy-MM-dd');" ^
  "$json.updateLog = '%LOG%';" ^
  "$json | ConvertTo-Json | Set-Content '%JSON_FILE%' -Encoding UTF8;" ^
  "$html = Get-Content '%HTML_FILE%' -Encoding UTF8;" ^
  "$html = $html -replace '(id=\"versionBadge\">)\d+\.\d+\.\d+', ('$1' + $newVer);" ^
  "$html | Set-Content '%HTML_FILE%' -Encoding UTF8;" ^
  "Write-Host ('版本已更新: ' + $oldVer + ' -> ' + $newVer);" ^
  "Write-Host ('更新日志: %LOG%');"

echo Done.