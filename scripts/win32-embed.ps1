<#
.SYNOPSIS
  Windows 原生客服窗口内嵌模块 v4 (Qt5 + Chromium/Electron 双内核兼容)
  特性：
  - 不再按窗口尺寸过滤（折叠/最小化的 199x34 窗口也能扫出并嵌入）
  - 按标题关键词优先级排序（接待中心 > 客服 > 千帆 > 旺旺；排除"千牛工作台"主后台）
  - 嵌入顺序固定：RESTORE -> SHOW -> 300ms -> SetParent+样式+MoveWindow(DPI补偿) -> 300ms -> 再 MoveWindow -> SetWindowPos(重排)
  - 折叠/最小化窗口追加 MINIMIZE->200ms->RESTORE->MoveWindow 防 Chromium 黑屏
  - DPI 补偿：GetDpiForWindow(宿主) vs GetDpiForWindow(子窗口)，非100%缩放下坐标自动换算
  - 每步写入 win32-embed.log 便于排查
  动作：list | embed | hide | show | detach | detach-all
#>
param(
  [string]$Action = "list",
  [string]$ProcessName = "AliWorkbench",
  [string]$TitleKeyword = "接待中心",
  [long]$ParentHwnd = 0,
  [long]$TargetHwnd = 0,
  [int]$X = 0,
  [int]$Y = 92,
  [int]$Width = 1280,
  [int]$Height = 760
)

$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "..\win32-embed.log"
function Log($msg) {
  try {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

# 系统缩放（LogPixels: 96=100% 120=125% 144=150%）
$scaling = "?"
try {
  $lp = Get-ItemProperty "HKCU:\Control Panel\Desktop" -Name LogPixels -ErrorAction Stop
  $scaling = [int]([int]$lp.LogPixels / 96 * 100)
} catch { $scaling = 100 }
Log ("ACTION=" + $Action + " PROC=" + $ProcessName + " TITLEKW=" + $TitleKeyword + " SYS_SCALE=" + $scaling + "% (LogPixels)")

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class W4 {
  // ---------- P/Invoke ----------
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("shcore.dll")] public static extern uint GetDpiForWindow(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public const int GWL_STYLE = -16;
  public const int WS_CAPTION = 0x00C00000;
  public const int WS_THICKFRAME = 0x00040000;
  public const int WS_POPUP = unchecked((int)0x80000000);
  public const int WS_CHILD = 0x40000000;
  public const int WS_MINIMIZE = 0x20000000;
  public const int SW_HIDE = 0;
  public const int SW_SHOW = 5;
  public const int SW_RESTORE = 9;
  public const int SW_MINIMIZE_CMD = 6;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_SHOWWINDOW = 0x0040;

  public class WinInfo {
    public long hwnd; public int pid; public string title; public string className;
    public int w; public int h; public bool isMinimized; public bool isCollapsed; public bool isVisible;
    public int priority;
  }

  public static int SafeDpi(IntPtr h) {
    try { if (h.ToInt64() != 0) { uint d = GetDpiForWindow(h); if (d > 0) return (int)d; } } catch {}
    return 96;
  }

  public static List<WinInfo> Find(string processName, string keyword) {
    var pidSet = new HashSet<uint>();
    foreach (var p in Process.GetProcesses()) {
      try { if (string.Equals(p.ProcessName, processName, StringComparison.OrdinalIgnoreCase)) pidSet.Add((uint)p.Id); } catch {} finally { p.Dispose(); }
    }
    var list = new List<WinInfo>();
    EnumWindows((h, l) => {
      try {
        // 不过滤 IsWindowVisible：被 hide 过的接待中心/客服窗口（SW_HIDE）也必须能扫到并唤醒，
        // 否则切标签 hide 之后就再也 list 不到、永远显示"未检测到"。EnumWindows 本就只枚举顶层窗口。
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (!pidSet.Contains(pid)) return true;
        var t = new StringBuilder(300); GetWindowText(h, t, 300);
        var c = new StringBuilder(150); GetClassName(h, c, 150);
        string title = t.ToString();
        RECT r; GetWindowRect(h, out r);
        int w = r.R - r.L, ht = r.B - r.T;
        int style = GetWindowLong(h, GWL_STYLE);
        // 排除主后台窗口
        if (title.IndexOf("千牛工作台", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (title.IndexOf("设置", StringComparison.Ordinal) >= 0 && title.Length < 12) return true;
        int pr = 9;
        if (title.IndexOf("接待中心", StringComparison.OrdinalIgnoreCase) >= 0) pr = 0;
        else if (title.IndexOf("客服", StringComparison.OrdinalIgnoreCase) >= 0) pr = 1;
        else if (title.IndexOf("千帆", StringComparison.OrdinalIgnoreCase) >= 0) pr = 2;
        else if (title.IndexOf("旺旺", StringComparison.OrdinalIgnoreCase) >= 0) pr = 3;
        else if (title.IndexOf("咚咚", StringComparison.OrdinalIgnoreCase) >= 0) pr = 4;
        else if (!string.IsNullOrEmpty(keyword) && title.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0) pr = 5;
        list.Add(new WinInfo {
          hwnd = h.ToInt64(), pid = (int)pid, title = title, className = c.ToString(),
          w = w, h = ht, isMinimized = (style & WS_MINIMIZE) != 0,
          isCollapsed = (w <= 200 || ht <= 200), isVisible = IsWindowVisible(h), priority = pr
        });
      } catch {}
      return true;
    }, IntPtr.Zero);
    list.Sort((a, b) => a.priority != b.priority ? a.priority.CompareTo(b.priority) : (a.isVisible ? 0 : 1).CompareTo(b.isVisible ? 0 : 1));
    return list;
  }

  // ---------- 嵌入：固定顺序 + DPI 补偿 + 黑屏兜底 ----------
  public static Dictionary<string, object> DoEmbed(IntPtr child, IntPtr parent, int lx, int ly, int lw, int lh) {
    var log = new List<string>();
    int childDpi = SafeDpi(child);
    int hostDpi = SafeDpi(parent);
    double scale = (double)childDpi / hostDpi;
    int px = (int)Math.Round(lx * scale);
    int py = (int)Math.Round(ly * scale);
    int pw = (int)Math.Round(lw * scale);
    int ph = (int)Math.Round(lh * scale);
    log.Add(string.Format("DPI child={0} host={1} scale={2:0.000} physical={3}x{4}", childDpi, hostDpi, scale, pw, ph));

    int oldStyle = GetWindowLong(child, GWL_STYLE);
    bool wasMinimized = (oldStyle & WS_MINIMIZE) != 0;
    RECT r0; GetWindowRect(child, out r0);
    bool wasCollapsed = (r0.R - r0.L) <= 200 || (r0.B - r0.T) <= 200;

    // 1) RESTORE -> 2) SHOW
    ShowWindow(child, SW_RESTORE);
    ShowWindow(child, SW_SHOW);
    log.Add("step1: RESTORE + SHOW (" + (wasMinimized ? "was-minimized" : "normal") + ")");
    Thread.Sleep(300);

    // 3) 样式：去边框加子窗口
    int ns = (oldStyle & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_POPUP) | WS_CHILD;
    SetWindowLong(child, GWL_STYLE, ns);
    if (parent.ToInt64() > 0) SetParent(child, parent);
    log.Add("step2: style->WS_CHILD + SetParent");

    // 4) MoveWindow（DPI 换算后）
    MoveWindow(child, px, py, pw, ph, true);
    Thread.Sleep(300);
    // 5) 再来一次 MoveWindow（Chromium 有时吞第一次尺寸变更）
    MoveWindow(child, px, py, pw, ph, true);
    log.Add("step3: MoveWindow x2 (" + pw + "x" + ph + ")");
    // 6) SetWindowPos 强制重排
    SetWindowPos(child, IntPtr.Zero, px, py, pw, ph, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    log.Add("step4: SetWindowPos FRAMECHANGED|SHOWWINDOW");

    // 7) 黑屏兜底：原本就是折叠/最小化的 Chromium/Qt 窗口 -> MINIMIZE->RESTORE 触发重绘
    string blackScreen = "no";
    if (wasMinimized || wasCollapsed) {
      ShowWindow(child, SW_MINIMIZE_CMD);
      Thread.Sleep(200);
      ShowWindow(child, SW_RESTORE);
      MoveWindow(child, px, py, pw, ph, true);
      Thread.Sleep(200);
      blackScreen = "recovery-cycle-applied (was " + (wasMinimized ? "minimized" : "collapsed") + ")";
      log.Add("step5: MINIMIZE->RESTORE->MoveWindow 黑屏兜底已执行");
    } else {
      log.Add("step5: 窗口原本尺寸正常，跳过黑屏兜底");
    }

    var res = new Dictionary<string, object>();
    res["hwnd"] = child.ToInt64();
    res["hostDpi"] = hostDpi;
    res["childDpi"] = childDpi;
    res["dpiScale"] = Math.Round(scale, 3);
    res["physicalBounds"] = new object[] { px, py, pw, ph };
    res["wasMinimized"] = wasMinimized;
    res["wasCollapsed"] = wasCollapsed;
    res["blackScreenFallback"] = blackScreen;
    res["steps"] = log;
    return res;
  }
}
'@ -ErrorAction Stop

if ($Action -eq "list") {
  $wins = [W4]::Find($ProcessName, $TitleKeyword)
  $sum = ($wins | ForEach-Object { $_.hwnd.ToString('X8') + " (" + $_.w + "x" + $_.h + ") '" + $_.title + "'" } ) -join '; '
  Log ("LIST: " + $ProcessName + " found=" + $wins.Count + " " + $sum)
  @{ ok = $true; processName = $ProcessName; windows = $wins | ForEach-Object {
      [PSCustomObject]@{ hwnd=$_.hwnd; pid=$_.pid; title=$_.title; className=$_.className; w=$_.w; h=$_.h; isMinimized=$_.isMinimized; isCollapsed=$_.isCollapsed; isVisible=$_.isVisible }
    } } | ConvertTo-Json -Compress -Depth 5
  exit 0
}

if ($Action -eq "embed") {
  $child = [IntPtr]0
  if ($TargetHwnd -gt 0) {
    $child = [IntPtr]$TargetHwnd
  } else {
    $wins = [W4]::Find($ProcessName, $TitleKeyword)
    if ($wins.Count -eq 0) {
      Log ("EMBED: no window found for " + $ProcessName)
      @{ ok=$false; error=("未检测到「" + $ProcessName + "」客户端窗口，请先打开并登录该客户端") } | ConvertTo-Json -Compress
      exit 0
    }
    $child = [IntPtr]$wins[0].hwnd
    Log ("EMBED: auto-picked hwnd=" + $child + " '" + $wins[0].title + "' " + $wins[0].w + "x" + $wins[0].h)
  }
  $res = [W4]::DoEmbed($child, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height)
  Log ("EMBED DONE: " + ($res["steps"] -join ' | '))
  @{ ok=$true } + $res.GetEnumerator() | ForEach-Object { } ; 
  $out = @{ ok=$true }
  foreach ($k in $res.Keys) { $out[$k] = $res[$k] }
  $out | ConvertTo-Json -Compress -Depth 4
  exit 0
}

if ($Action -eq "hide") {
  if ($TargetHwnd -gt 0) {
    [W4]::ShowWindow([IntPtr]$TargetHwnd, [W4]::SW_HIDE) | Out-Null
    Log ("HIDE hwnd=" + $TargetHwnd)
  }
  @{ ok=$true } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "show") {
  if ($TargetHwnd -gt 0) {
    $res = [W4]::DoEmbed([IntPtr]$TargetHwnd, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height)
    Log ("SHOW: " + ($res["steps"] -join ' | '))
  }
  @{ ok=$true } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "detach" -or $Action -eq "detach-all") {
  $targets = @()
  if ($Action -eq "detach" -and $TargetHwnd -gt 0) {
    $targets += [IntPtr]$TargetHwnd
  } else {
    $wins = [W4]::Find($ProcessName, $TitleKeyword)
    foreach ($w in $wins) { $targets += [IntPtr]$w.hwnd }
  }
  $n = 0
  foreach ($h in $targets) {
    $st = [W4]::GetWindowLong($h, [W4]::GWL_STYLE)
    if ($st -band [W4]::WS_CHILD) {
      [W4]::SetParent($h, [IntPtr]::Zero) | Out-Null
      $ns = ($st -band (-bnot [W4]::WS_CHILD)) -bor [W4]::WS_CAPTION -bor [W4]::WS_THICKFRAME
      [W4]::SetWindowLong($h, [W4]::GWL_STYLE, $ns) | Out-Null
      [W4]::MoveWindow($h, 120, 120, 1100, 720, $true) | Out-Null
      [W4]::ShowWindow($h, [W4]::SW_SHOW) | Out-Null
      $n++
    }
  }
  Log ("DETACH: " + $n + " window(s) restored to desktop")
  @{ ok=$true; detached=$n } | ConvertTo-Json -Compress
  exit 0
}

@{ ok=$false; error="unknown action: $Action" } | ConvertTo-Json -Compress
exit 0
