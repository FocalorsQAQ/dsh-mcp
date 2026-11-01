$ErrorActionPreference = 'Stop'
Write-Host 'In Codex, enter /hooks and review the dsh UserPromptSubmit hook.'
Write-Host 'This opens the review screen workflow; no trust settings are changed automatically.'
$codexExecutable = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $codexExecutable) { $codexExecutable = (Get-Command codex.exe -ErrorAction SilentlyContinue).Source }
if (-not $codexExecutable) { throw 'Codex CLI was not found. Open your Codex CLI and enter /hooks.' }
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\dsh.config.json') -Raw | ConvertFrom-Json
& $codexExecutable --cd $configuration.workspace_root
