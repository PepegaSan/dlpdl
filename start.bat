@echo off
cd /d "%~dp0"
set "DOWNLOAD_DIR=%~dp0downloads"
set "TEMP_DIR=%DOWNLOAD_DIR%\.tmp"
set "PORT=8090"
if not exist "%DOWNLOAD_DIR%" mkdir "%DOWNLOAD_DIR%"
echo Clip-Direct: http://localhost:8090/
python -m backend.main
pause
