@echo off
"%~dp0bin\python\python.exe" -I -B "%~dp0packaging\codex_registration.py" register --root "%~dp0."
if errorlevel 1 (
  echo Existing configuration was preserved. See codex-registration-result.json.
) else (
  echo Codex registration completed. Restart Codex to load dsh.
)
pause
