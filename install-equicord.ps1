# Equicord Installer CLI setup script
# Run this script from the directory you want to use as EQUICORD_USER_DATA_DIR.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoOwner = "SirMonteiro"
$RepoName  = "equicord-userplugins"

$workDir       = (Get-Location).Path
$distDir       = Join-Path -Path $workDir -ChildPath 'dist'
$installerPath = Join-Path -Path $workDir -ChildPath 'EquilotlCli.exe'

$apiUrl       = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/tags/devbuild"
$installerUrl = 'https://github.com/Equicord/Equilotl/releases/latest/download/EquilotlCli.exe'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. Fetch asset metadata from GitHub API
Write-Host "Querying release assets for $RepoOwner/$RepoName (devbuild)..." -ForegroundColor Cyan
$headers = @{ "User-Agent" = "Equicord-Installer" }
$release = Invoke-RestMethod -Uri $apiUrl -Headers $headers

if (-not $release.assets -or $release.assets.Count -eq 0) {
    throw "No assets found in the devbuild release for $RepoOwner/$RepoName."
}

# 2. Recreate local dist directory
if (Test-Path $distDir) {
    Remove-Item -Path $distDir -Recurse -Force
}
New-Item -ItemType Directory -Path $distDir | Out-Null

# 3. Download all loose distribution assets directly into dist/
$total = $release.assets.Count
Write-Host "Downloading $total build assets to $distDir..." -ForegroundColor Cyan

$count = 0
foreach ($asset in $release.assets) {
    $count++
    $fileName = $asset.name
    $destPath = Join-Path -Path $distDir -ChildPath $fileName

    Write-Host "[$count/$total] Downloading $fileName"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $destPath
}

# 4. Download official installer CLI
Write-Host "`nDownloading EquilotlCli.exe..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath
Unblock-File -Path $installerPath -ErrorAction SilentlyContinue
Write-Host "Downloaded to $installerPath"

# 5. Run install pointing to the local dist folder
Write-Host "Running: EquilotlCli.exe -install with EQUICORD_USER_DATA_DIR=$workDir and EQUICORD_DEV_INSTALL=1" -ForegroundColor Cyan
$env:EQUICORD_USER_DATA_DIR = $workDir
$env:EQUICORD_DEV_INSTALL = '1'
try {
    & $installerPath '-install'
    if ($LASTEXITCODE -ne 0) {
        throw "Equicord installation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Remove-Item Env:\EQUICORD_USER_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\EQUICORD_DEV_INSTALL -ErrorAction SilentlyContinue
}

# 6. Install OpenAsar
Write-Host "Running: EquilotlCli.exe -install-openasar" -ForegroundColor Cyan
& $installerPath '-install-openasar'
if ($LASTEXITCODE -ne 0) {
    Write-Host "OpenAsar installation failed with exit code $LASTEXITCODE"
}

Write-Host "`nEquicord installation completed successfully." -ForegroundColor Green
