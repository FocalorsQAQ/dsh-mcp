param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$resolved = [IO.Path]::GetFullPath($OutputPath)
if ($resolved -notmatch '[\\/]\.test-output[\\/]ui-autostart[\\/]watch-[^\\/]+[\\/]Codex\.exe$') { throw 'Expected disposable startup-test executable' }
Add-Type -OutputAssembly $resolved -OutputType WindowsApplication -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class StartupFixture {
  delegate IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WC {
    public uint style; public Proc callback; public int clsExtra, winExtra;
    public IntPtr instance, icon, cursor, brush; public string menu, name;
  }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w,l; public uint time; public int x,y; public uint unused; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassW(ref WC c);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint e, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int mode);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [STAThread] public static void Main() {
    Proc callback = DefWindowProcW;
    WC cls = new WC { callback=callback, instance=GetModuleHandleW(null), name="Chrome_WidgetWin_1" };
    if (RegisterClassW(ref cls)==0) throw new Exception("Fixture class registration failed");
    var h=CreateWindowExW(0, cls.name, "dsh startup fixture", 0x00CF0000, -32000,-32000,160,80,IntPtr.Zero,IntPtr.Zero,cls.instance,IntPtr.Zero);
    if (h==IntPtr.Zero) throw new Exception("Fixture window creation failed");
    ShowWindow(h,4); ShowWindow(h,4);
    MSG msg; while(GetMessageW(out msg,IntPtr.Zero,0,0)>0) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
    GC.KeepAlive(callback);
  }
}
'@
