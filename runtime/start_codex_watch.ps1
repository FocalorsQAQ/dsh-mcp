param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Config,
  [Parameter(Mandatory=$true)][string]$Python
)
$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$configPath = (Resolve-Path -LiteralPath $Config).Path
$pythonPath = (Resolve-Path -LiteralPath $Python).Path
$watchPath = (Resolve-Path -LiteralPath (Join-Path $rootPath 'runtime\codex_watch.py')).Path
foreach ($path in @($rootPath, $configPath, $pythonPath, $watchPath)) {
  if ($path.Contains('"')) { throw 'Invalid companion path' }
}
$arguments = '-I -B "' + $watchPath + '" --root "' + $rootPath + '" --config "' + $configPath + '"'
# Use the existing Windows desktop's Shell object. A newly created Shell.Application
# or a detached child still inherits Codex's kill-on-close job on some installations.
$shell = New-Object -ComObject Shell.Application
$windows = $shell.Windows()
$desktopHandle = 0
$desktop = $windows.FindWindowSW(0, 0, 8, [ref]$desktopHandle, 1) # SWC_DESKTOP, SWFO_NEEDDISPATCH
if (-not $desktop) { throw 'Windows desktop shell is unavailable' }
$desktop.Document.Application.ShellExecute($pythonPath, $arguments, $rootPath, 'open', 0)
