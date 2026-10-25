# Clip-Direct: PC-Instanz einrichten (der "schnelle Server" der Extension).
#
#   .\setup-pc.ps1                 interaktiv: NAS-Ordner suchen, Autostart fragen, starten
#   .\setup-pc.ps1 -Stop           laufende PC-Instanz beenden
#   .\setup-pc.ps1 -Remove         Autostart, Verknüpfungen und Konfiguration entfernen
#
# Die Konfiguration liegt unter %LOCALAPPDATA%\clip-direct\pc-render.json und wird
# von start.ps1, start.bat und `pythonw -m backend.pc_render` (Autostart) gelesen.
param(
  [string]$DownloadDir = "",
  [int]$Port = 8090,
  [string]$BindHost = "127.0.0.1",
  [string]$Token = "",
  [switch]$Autostart,
  [switch]$NoAutostart,
  [switch]$NoShortcut,
  [switch]$NoStart,
  [switch]$NonInteractive,
  [string]$ConfigPath = "",
  [switch]$Stop,
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$Repo = $PSScriptRoot
$ConfigDir = Join-Path $env:LOCALAPPDATA "clip-direct"
if (-not $ConfigPath) { $ConfigPath = Join-Path $ConfigDir "pc-render.json" }
$TaskName = "Clip-Direct PC Render"
$StartMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Clip-Direct"

function Step([string]$text) { Write-Host "» $text" }

function Read-Config {
  if (Test-Path $ConfigPath) { return Get-Content $ConfigPath -Raw | ConvertFrom-Json }
  return $null
}

function Resolve-Unc([string]$path) {
  # Netzlaufwerk-Buchstaben gibt es nur in der Anmeldesitzung; der Autostart bekommt den UNC-Pfad.
  if ($path -match '^([A-Za-z]):(.*)$') {
    $drive = Get-PSDrive -Name $Matches[1] -ErrorAction SilentlyContinue
    if ($drive -and $drive.DisplayRoot) { return ($drive.DisplayRoot.TrimEnd('\') + $Matches[2]) }
  }
  return $path
}

function Find-NasClones {
  $hits = @()
  foreach ($drive in Get-PSDrive -PSProvider FileSystem | Where-Object { $_.DisplayRoot }) {
    $roots = @("$($drive.Name):\") + (Get-ChildItem "$($drive.Name):\" -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($dir in $roots) {
      if ((Test-Path (Join-Path $dir "deploy\docker-compose.yml")) -and (Test-Path (Join-Path $dir "downloads"))) {
        $hits += (Join-Path $dir "downloads")
      }
    }
  }
  return $hits
}

function Stop-Instance([int]$port) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match '^python') {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Step "Instanz auf Port $port beendet (PID $($proc.Id))"
    }
  }
}

function Wait-Instance([int]$port, [string]$token) {
  $headers = @{}
  if ($token) { $headers["X-Clip-Direct-Token"] = $token }
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/jobs" -Headers $headers -UseBasicParsing -TimeoutSec 2
      if ($res.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function New-Shortcut([string]$name, [string]$target, [string]$arguments) {
  New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $StartMenu "$name.lnk"))
  $lnk.TargetPath = $target
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = $Repo
  $lnk.Save()
}

# --- Stop / Remove ---------------------------------------------------------
if ($Stop -or $Remove) {
  $cfg = Read-Config
  $port = if ($cfg -and $cfg.port) { [int]$cfg.port } else { $Port }
  Stop-Instance $port
  if ($Stop) { exit 0 }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Step "Autostart-Aufgabe entfernt"
  }
  if (Test-Path $StartMenu) { Remove-Item $StartMenu -Recurse -Force; Step "Startmenü-Verknüpfungen entfernt" }
  if (Test-Path $ConfigPath) { Remove-Item $ConfigPath -Force; Step "Konfiguration entfernt ($ConfigPath)" }
  Write-Host "Fertig. Die Extension-Einstellung 'PC bevorzugen' ggf. ausschalten."
  exit 0
}

# --- 1. NAS-Ordner ---------------------------------------------------------
if (-not $DownloadDir) {
  $found = @(Find-NasClones)
  if ($found.Count -eq 1) {
    if ($NonInteractive) {
      $DownloadDir = $found[0]
    } else {
      $answer = Read-Host "Gefundener NAS-Ordner: $($found[0])  — verwenden? [J/n]"
      if ($answer -notin @("n", "N")) { $DownloadDir = $found[0] }
    }
  } elseif ($found.Count -gt 1 -and -not $NonInteractive) {
    Write-Host "Mehrere Clip-Direct-Ordner gefunden:"
    for ($i = 0; $i -lt $found.Count; $i++) { Write-Host "  [$($i + 1)] $($found[$i])" }
    $pick = Read-Host "Nummer wählen (oder leer für eigenen Pfad)"
    if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $found.Count) { $DownloadDir = $found[[int]$pick - 1] }
  }
  if (-not $DownloadDir) {
    if ($NonInteractive) { throw "Kein NAS-Ordner gefunden — -DownloadDir angeben" }
    $DownloadDir = Read-Host "Pfad zum downloads-Ordner des NAS-Containers (z. B. <Laufwerk>:\clip-direct\downloads oder \\<nas>\<freigabe>\clip-direct\downloads)"
  }
}
if (-not (Test-Path $DownloadDir)) { New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null }
$DownloadUnc = Resolve-Unc $DownloadDir
Step "Download-Ordner: $DownloadUnc"

# --- 2. Python / ffmpeg / Abhängigkeiten ----------------------------------
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python nicht im PATH — Python 3.11+ installieren (python.org, 'Add to PATH')" }
$okVersion = & $python -c "import sys; print(int(sys.version_info >= (3, 11)))"
if ($okVersion -ne "1") { throw "Python 3.11 oder neuer nötig ($(& $python --version))" }
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning "ffmpeg nicht im PATH — ohne ffmpeg kann die PC-Instanz nicht schneiden (ffmpeg.org, dann PATH)."
}
# Native stderr must not become a terminating error under $ErrorActionPreference = "Stop" (PowerShell 5.1).
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$null = & $python -c "import aiohttp, yt_dlp" 2>&1
$depsOk = ($LASTEXITCODE -eq 0)
if (-not $depsOk) {
  Step "Installiere Python-Abhängigkeiten (requirements.txt)…"
  & $python -m pip install -q -r (Join-Path $Repo "requirements.txt") 2>&1 | Out-Host
  $depsOk = ($LASTEXITCODE -eq 0)
}
$ErrorActionPreference = $previousEap
if (-not $depsOk) { throw "pip install fehlgeschlagen" }

# --- 3. Konfiguration --------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Split-Path $ConfigPath) | Out-Null
$config = [ordered]@{
  downloadDir = $DownloadUnc
  tempDir     = Join-Path $ConfigDir "tmp"
  port        = $Port
  bindHost    = $BindHost
  token       = $Token
  repo        = $Repo
  createdAt   = (Get-Date -Format "o")
}
$config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
Step "Konfiguration geschrieben: $ConfigPath"

# --- 4. Autostart / Verknüpfungen -------------------------------------------
$wantAutostart = $false
if ($Autostart) { $wantAutostart = $true }
elseif (-not $NoAutostart -and -not $NonInteractive) {
  $answer = Read-Host "Beim Anmelden automatisch im Hintergrund starten? [J/n]"
  $wantAutostart = $answer -notin @("n", "N")
}
if ($wantAutostart) {
  # %USERNAME% alone is not always resolvable by the Task Scheduler (a PC named like its
  # user, Microsoft accounts): use the qualified name Windows itself reports (PC-NAME\User).
  # A SID is refused here ("Falscher Parameter"), so it has to be the name.
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $action = New-ScheduledTaskAction -Execute $pythonw -Argument "-m backend.pc_render" -WorkingDirectory $Repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $trigger.Delay = "PT20S"   # Netzlaufwerke und gespeicherte Anmeldedaten sind dann da
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Step "Autostart eingerichtet (Aufgabenplanung: '$TaskName', ohne Fenster)"
  } catch {
    Write-Warning "Autostart konnte nicht eingerichtet werden: $($_.Exception.Message)"
    Write-Warning "Alternative: Startmenü-Verknüpfung 'Clip-Direct PC Render starten' nach shell:startup kopieren."
  }
}
if (-not $NoShortcut) {
  New-Shortcut "Clip-Direct PC Render starten" $pythonw "-m backend.pc_render"
  New-Shortcut "Clip-Direct PC Render beenden" "powershell.exe" "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Repo\setup-pc.ps1`" -Stop"
  Step "Startmenü → Clip-Direct: 'PC Render starten' / 'PC Render beenden'"
}

# --- 5. Jetzt starten --------------------------------------------------------
if (-not $NoStart) {
  Stop-Instance $Port
  if ($ConfigPath -ne (Join-Path $ConfigDir "pc-render.json")) { $env:CLIP_DIRECT_PC_CONFIG = $ConfigPath }
  Start-Process $pythonw -ArgumentList "-m", "backend.pc_render" -WorkingDirectory $Repo | Out-Null
  if (Wait-Instance $Port $Token) {
    Step "PC-Instanz läuft: http://localhost:$Port/"
  } else {
    Write-Warning "PC-Instanz antwortet nicht — Log: $(Join-Path (Split-Path $ConfigPath) 'pc-render.log')"
  }
}

Write-Host ""
Write-Host "In den Extension-Einstellungen:"
Write-Host "  Schneller Server auf dem PC:   http://localhost:$Port/"
Write-Host "  PC bevorzugen, wenn erreichbar: An"
if ($Token) { Write-Host "  API-Token: wie auf dem NAS" }
Write-Host "Oder im Popup auf den Punkt 'PC' klicken."
