# Start Clip-Direct (uses python from PATH)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:DOWNLOAD_DIR = Join-Path $PSScriptRoot "downloads"
$env:TEMP_DIR = Join-Path $env:DOWNLOAD_DIR ".tmp"
$env:PORT = "8090"

New-Item -ItemType Directory -Force -Path $env:DOWNLOAD_DIR | Out-Null
Write-Host "Clip-Direct: http://localhost:8090/"
python -m backend.main
