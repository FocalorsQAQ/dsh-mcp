param([long]$WindowHandle, [int]$WindowProcessId, [switch]$Inspect)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class DshWindow {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetLong(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] public static extern IntPtr SetLong(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  public static bool Belongs(IntPtr h, int pid) { uint actual; GetWindowThreadProcessId(h, out actual); return IsWindow(h) && actual == pid; }
  public static bool IsCodex(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try {
      var p = Process.GetProcessById((int)pid);
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var path = p.MainModule.FileName;
      bool codexApp = (p.ProcessName.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase) && path.IndexOf(@"\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0) || (p.ProcessName.Equals("Codex", StringComparison.OrdinalIgnoreCase) && cls.ToString() == "Chrome_WidgetWin_1");
      return codexApp && p.SessionId == Process.GetCurrentProcess().SessionId && GetWindow(h, 4) == IntPtr.Zero;
    } catch { return false; }
  }
  public static IntPtr FindCodex() {
    var foreground = GetForegroundWindow();
    if (IsCodex(foreground)) return foreground;
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,p) => { if (IsWindowVisible(h) && IsCodex(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindProcessWindow(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,p) => { if (Belongs(h, pid) && IsWindowVisible(h)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static void Attach(IntPtr h, IntPtr owner) {
    SetLong(h, -8, owner);
    if (GetWindow(h, 4) != owner) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    long style = GetLong(h, -20).ToInt64();
    SetLong(h, -20, new IntPtr((style | 0x80L) & ~0x40000L));
    if (!SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x33)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
$handle = [IntPtr]$WindowHandle
if ($Inspect) {
  if ($handle -eq [IntPtr]::Zero) { $handle = [DshWindow]::FindProcessWindow($WindowProcessId) }
  if ($handle -eq [IntPtr]::Zero) { throw 'Control window not found' }
  $owner = [DshWindow]::GetWindow($handle, 4)
  $style = [DshWindow]::GetLong($handle, -20).ToInt64()
  @{ owner = $owner.ToInt64(); codex_owner = [DshWindow]::IsCodex($owner); tool_window = [bool]($style -band 0x80); app_window = [bool]($style -band 0x40000); topmost = [bool]($style -band 8) } | ConvertTo-Json -Compress
  exit
}
while ([DshWindow]::Belongs($handle, $WindowProcessId)) {
  $owner = [DshWindow]::GetWindow($handle, 4)
  if (-not [DshWindow]::IsCodex($owner)) { $owner = [DshWindow]::FindCodex() }
  $style = [DshWindow]::GetLong($handle, -20).ToInt64()
  if ($owner -ne [IntPtr]::Zero -and ([DshWindow]::GetWindow($handle, 4) -ne $owner -or -not ($style -band 0x80) -or ($style -band 0x40008))) {
    [DshWindow]::Attach($handle, $owner)
  }
  Start-Sleep -Seconds 2
}
