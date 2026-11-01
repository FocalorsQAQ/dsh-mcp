$ErrorActionPreference = 'Stop'
Write-Host 'Wait for Codex to finish starting, then enter /hooks and review the dsh UserPromptSubmit hook.'
Write-Host 'This opens the review screen workflow; no trust settings are changed automatically.'
$codexExecutable = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $codexExecutable) { $codexExecutable = (Get-Command codex.exe -ErrorAction SilentlyContinue).Source }
if (-not $codexExecutable) { throw 'Codex CLI was not found. Open your Codex CLI and enter /hooks.' }
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\dsh.config.json') -Raw | ConvertFrom-Json
$inheritedTerm = $env:TERM
try {
    # Automation hosts may export TERM=dumb even when this helper opens in a real console.
    if ($env:TERM -eq 'dumb') { Remove-Item -LiteralPath Env:TERM }
    # The desktop-bundled executable can run the TUI but is not a standalone daemon package.
    & $codexExecutable --no-daemon --cd $configuration.workspace_root
    if ($LASTEXITCODE -ne 0) { throw 'Codex did not start successfully. /hooks is a Codex command, not a PowerShell command.' }
}
finally {
    if ($null -eq $inheritedTerm) { Remove-Item -LiteralPath Env:TERM -ErrorAction SilentlyContinue }
    else { $env:TERM = $inheritedTerm }
}
