@echo off
cd /d "%~dp0"
rem After setup-pc.bat: run the PC render instance with its saved configuration.
if exist "%LOCALAPPDATA%\clip-direct\pc-render.json" (
  echo Clip-Direct PC render instance ^(config: %LOCALAPPDATA%\clip-direct\pc-render.json^)
  python -m backend.pc_render
  pause
  exit /b
)
set "DOWNLOAD_DIR=%~dp0downloads"
set "TEMP_DIR=%DOWNLOAD_DIR%\.tmp"
set "PORT=8090"
if not exist "%DOWNLOAD_DIR%" mkdir "%DOWNLOAD_DIR%"
echo Clip-Direct: http://localhost:8090/
python -m backend.main
pause
