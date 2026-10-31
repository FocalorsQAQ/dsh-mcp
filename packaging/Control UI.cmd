@echo off
"%~dp0bin\node\node.exe" "%~dp0scripts\start-ui.mjs" --config "%~dp0dsh.config.json" %*
if errorlevel 1 pause
