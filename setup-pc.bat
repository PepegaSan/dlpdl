@echo off
rem Clip-Direct PC-Instanz einrichten (Doppelklick). Entfernen: setup-pc.bat -Remove
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-pc.ps1" %*
pause
