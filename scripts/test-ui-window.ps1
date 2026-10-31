param([Parameter(Mandatory=$true)][string]$ConfigPath, [ValidateSet('inspect','minimize','close')][string]$Action = 'inspect')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class DshTestWindow {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  public static IntPtr Find(int processId) {
    IntPtr found = IntPtr.Zero, hidden = IntPtr.Zero;
    EnumWindows((h,p) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == processId) {
        if (IsWindowVisible(h)) { found = h; return false; }
        var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
        if (cls.ToString() == "Chrome_WidgetWin_1") hidden = h;
      } return true;
    }, IntPtr.Zero);
    return found == IntPtr.Zero ? hidden : found;
  }
}
'@
# Operate only on the unique disposable test configuration passed by the harness.
$fullConfig = [IO.Path]::GetFullPath($ConfigPath)
if ($fullConfig -notmatch '[\\/]\.test-output[\\/](ui-autostart|release)[\\/]') { throw 'Expected isolated test configuration.' }
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($fullConfig) -and $_.CommandLine.Contains('desktop')
})
$result = @()
foreach ($item in $matches) {
  $handle = [DshTestWindow]::Find([int]$item.ProcessId)
  if ($handle -ne [IntPtr]::Zero) {
    if ($Action -eq 'minimize') { [void][DshTestWindow]::ShowWindow($handle, 6) }
    if ($Action -eq 'close') { [void][DshTestWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  }
  $result += @{ pid = [int]$item.ProcessId; visible = [DshTestWindow]::IsWindowVisible($handle);
    minimized = [DshTestWindow]::IsIconic($handle); focused = ($handle -ne [IntPtr]::Zero -and $handle -eq [DshTestWindow]::GetForegroundWindow()) }
}
ConvertTo-Json -InputObject $result -Compress
