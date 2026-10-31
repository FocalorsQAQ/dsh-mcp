@echo off
"%~dp0bin\node\node.exe" "%~dp0packaging\initialize.mjs" %*
if errorlevel 1 pause
