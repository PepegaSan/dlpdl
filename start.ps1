# Start Clip-Direct (uses python from PATH)
#
#   .\start.ps1                                        downloads next to this script — or the
#                                                      folder from setup-pc.ps1 when that was run
#   .\start.ps1 -DownloadDir "<drive>:\clip-direct\downloads"  write into the NAS folder the
#                                                      Docker container mounts as /downloads
#
# With a network drive as DownloadDir the temp dir stays local (LOCALAPPDATA) —
# segment buffers on SMB are slow and litter the share.
param(
  [string]$DownloadDir = (Join-Path $PSScriptRoot "downloads"),
  [string]$TempDir = "",
  [int]$Port = 8090,
  [string]$BindHost = "0.0.0.0"
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# setup-pc.ps1 configuration (PC render instance): used unless overridden on the command line.
$ConfigPath = if ($env:CLIP_DIRECT_PC_CONFIG) { $env:CLIP_DIRECT_PC_CONFIG } else { Join-Path $env:LOCALAPPDATA "clip-direct\pc-render.json" }
if (-not $PSBoundParameters.ContainsKey("DownloadDir") -and (Test-Path $ConfigPath)) {
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  if ($cfg.downloadDir) { $DownloadDir = $cfg.downloadDir }
  if (-not $TempDir -and $cfg.tempDir) { $TempDir = $cfg.tempDir }
  if (-not $PSBoundParameters.ContainsKey("Port") -and $cfg.port) { $Port = [int]$cfg.port }
  if (-not $PSBoundParameters.ContainsKey("BindHost") -and $cfg.bindHost) { $BindHost = $cfg.bindHost }
  if ($cfg.token) { $env:CLIP_DIRECT_TOKEN = $cfg.token }
  Write-Host "Konfiguration: $ConfigPath"
}

function Test-NetworkPath([string]$path) {
  if ($path.StartsWith("\\")) { return $true }
  if ($path -match '^([A-Za-z]):') {
    $drive = Get-PSDrive -Name $Matches[1] -ErrorAction SilentlyContinue
    return [bool]($drive -and $drive.DisplayRoot)
  }
  return $false
}

if (-not $TempDir) {
  $TempDir = if (Test-NetworkPath $DownloadDir) {
    Join-Path $env:LOCALAPPDATA "clip-direct\tmp"
  } else {
    Join-Path $DownloadDir ".tmp"
  }
}

$env:DOWNLOAD_DIR = $DownloadDir
$env:TEMP_DIR = $TempDir
$env:PORT = "$Port"
$env:HOST = $BindHost

New-Item -ItemType Directory -Force -Path $env:DOWNLOAD_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $env:TEMP_DIR | Out-Null
Write-Host "Clip-Direct: http://localhost:$Port/"
Write-Host "  downloads: $env:DOWNLOAD_DIR"
Write-Host "  temp:      $env:TEMP_DIR"
python -m backend.main
