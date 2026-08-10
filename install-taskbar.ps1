# Builds the Axion launch script + a taskbar-pinnable shortcut.
# The shortcut carries the same AppUserModelID the running Electron app sets
# (com.iyad.axion) so the pinned slot and the live window merge
# into one taskbar button instead of two. Re-runnable. ASCII-only (PS 5.1 safe).
param([switch]$Unpin)

$ErrorActionPreference = 'Stop'
$root        = 'C:\Users\Iyad\ollama-desktop-harness'
$exe         = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico         = Join-Path $root 'src\assets\icon.ico'
$appId       = 'com.iyad.axion'
$lnkName     = 'Axion.lnk'
$startMenu   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnkPath     = Join-Path $startMenu $lnkName

if (-not (Test-Path $exe)) { throw "electron.exe not found at $exe -- run 'npm install' first." }
if (-not (Test-Path $ico)) { throw "icon.ico not found at $ico" }

# 1) the little launch script (manual-run fallback; flashes a console, then detaches)
$cmd = "@echo off`r`ncd /d ""$root""`r`nstart """" ""$exe"" .`r`n"
Set-Content -Path (Join-Path $root 'launch.cmd') -Value $cmd -Encoding ASCII
Write-Host "wrote launch.cmd"

# 2) the shortcut (target = electron.exe directly, so no console window ever)
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnkPath)
$s.TargetPath       = $exe
$s.Arguments        = '.'
$s.WorkingDirectory = $root
$s.IconLocation     = "$ico,0"
$s.Description      = 'Axion local agent workspace'
$s.WindowStyle      = 1
$s.Save()
Write-Host "wrote $lnkPath"

# 3) stamp the AppUserModelID onto the .lnk (PropertyStore on the ShellLink COM object)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OllamaLnk {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY { public Guid fmtid; public int pid; }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellLinkW { }

  [ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPersistFile {
    void GetClassID(out Guid p);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, int m);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    uint GetCount(out uint c);
    uint GetAt(uint i, out PROPERTYKEY k);
    uint GetValue([In] ref PROPERTYKEY k, [Out] IntPtr v);
    uint SetValue([In] ref PROPERTYKEY k, [In] IntPtr v);
    uint Commit();
  }

  [DllImport("propsys.dll", CharSet = CharSet.Unicode)]
  static extern int PSGetPropertyKeyFromName(string name, out PROPERTYKEY key);

  public static string SetAppUserModelID(string lnk, string appId) {
    var clsid = new Guid("00021401-0000-0000-C000-000000000046");
    object sl = Activator.CreateInstance(Type.GetTypeFromCLSID(clsid));
    try {
      var pf = (IPersistFile)sl;
      pf.Load(lnk, 2);                      // STGM_READWRITE
      var ps = (IPropertyStore)sl;
      PROPERTYKEY key;
      int hr = PSGetPropertyKeyFromName("System.AppUserModel.ID", out key);
      if (hr != 0) return "PSGetPropertyKeyFromName failed 0x" + hr.ToString("X");
      IntPtr pv = Marshal.AllocCoTaskMem(16);
      IntPtr str = Marshal.StringToCoTaskMemUni(appId);
      try {
        Marshal.WriteInt16(pv, 0, 31);      // VT_LPWSTR
        Marshal.WriteIntPtr(pv, 8, str);
        ps.SetValue(ref key, pv);
        ps.Commit();
      } finally { Marshal.FreeCoTaskMem(str); Marshal.FreeCoTaskMem(pv); }
      pf.Save(lnk, true);
      return "ok";
    } finally { Marshal.ReleaseComObject(sl); }
  }
}
"@ -Language CSharp
$result = [OllamaLnk]::SetAppUserModelID($lnkPath, $appId)
Write-Host "AppUserModelID = $appId ($result)"

# 4) try to pin via the shell verb (Win11 may not expose it -- fall back to a clear message)
$shell = New-Object -ComObject Shell.Application
$item  = $shell.Namespace((Split-Path $lnkPath)).ParseName((Split-Path $lnkPath -Leaf))
if ($Unpin) {
  $u = $item.Verbs() | Where-Object { $_.Name -match 'Unpin.*taskbar' } | Select-Object -First 1
  if ($u) { $u.DoIt(); Write-Host "Unpinned." } else { Write-Host "No unpin verb found." }
} else {
  $verb = $item.Verbs() | Where-Object { $_.Name -match 'taskbar' } | Select-Object -First 1
  if ($verb) {
    $verb.DoIt(); Write-Host "Pinned to taskbar automatically."
  } else {
    Write-Host ""
    Write-Host "Auto-pin not available on this Windows build." -ForegroundColor Yellow
    Write-Host "Open Start menu, right-click 'Axion', then 'Pin to taskbar'." -ForegroundColor Yellow
  }
}
Write-Host ""
Write-Host "Done. launch.cmd and the $lnkName shortcut are ready."
