param(
    [string]$Log = "gong-neng-you-hua",
    [switch]$Deploy = $false
)

$jsonPath = ".\version.json"
$htmlPath = ".\index.html"

$json = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$oldVer = $json.version

$parts = $oldVer -split '\.'
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2]

# normalize: carry patch tens digit to minor
if ($patch -ge 10) {
    $carry = [Math]::Floor($patch / 10)
    $patch = $patch - $carry * 10
    $minor = $minor + $carry
}

# increment patch
$patch = $patch + 1

# carry: if patch >= 10, wrap to 0 and increment minor
if ($patch -ge 10) {
    $patch = 0
    $minor = $minor + 1
}

$newVer = "$major.$minor.$patch"

$json.version = $newVer
$json.releaseDate = (Get-Date -Format "yyyy-MM-dd")
$json.updateLog = $Log
$json | ConvertTo-Json | Set-Content $jsonPath -Encoding UTF8

$html = Get-Content $htmlPath -Encoding UTF8
$html = $html -replace '(id="versionBadge">)(.*?)(\d+\.\d+\.\d+)', "`${1}`${2}$newVer"
$html | Set-Content $htmlPath -Encoding UTF8

Write-Host "OK: $oldVer -> $newVer"
Write-Host "Log: $Log"

# version update ok, deploy to Netlify if -Deploy specified
if ($Deploy) {
    Write-Host "Deploying to Netlify..."
    $deployResult = & "npm" "run" "deploy:token" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Deploy success!"
    } else {
        Write-Host 'Deploy failed:'
        Write-Host $deployResult
        Write-Host 'Run manually: npm run deploy:token'
    }
}