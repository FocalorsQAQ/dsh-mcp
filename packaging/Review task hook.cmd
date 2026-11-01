@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0packaging\review-hook.ps1"
if errorlevel 1 pause
