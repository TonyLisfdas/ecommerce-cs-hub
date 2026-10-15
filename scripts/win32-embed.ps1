<#
.SYNOPSIS
  Windows 原生客服窗口内嵌模块 v6 (Owned Top-Level 方案，Qt5 + Chromium/Electron 双内核兼容)
  核心变更（v4 -> v6）：
  - 放弃 SetParent+WS_CHILD（Chromium 渲染层会盖在子窗口之上吃掉所有鼠标点击）
  - 改用 GWLP_HWNDPARENT 把客户端设为【拥有者顶层窗口(Owned Top-Level)】：
      窗口仍是独立顶层、保留自己的消息循环，鼠标/键盘 100% 正常，
      且永远浮在 owner 之上；owner 最小化时自动隐藏，owner 还原时自动回来。
  - 去任务栏/去 Alt-Tab：exstyle 去 WS_EX_APPWINDOW、加 WS_EX_TOOLWINDOW
  - 边框两种策略（自动/去边框/保留标题栏上移），结论写入日志
  - 实时跟随：SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE) + 60ms 轮询兜底（watch action 常驻）
  - 保留：DPI 补偿、黑屏兜底、win32-embed.log 日志
  动作：list | embed | watch | hide | show | reposition | detach | detach-all | iswindow
  说明：watch / embed -Watch 是长驻进程（主进程用 spawn 保活）；detach 只做清 owner + 还原样式，
       绝不 WM_CLOSE 客户端窗口。
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
  [int]$Height = 760,
  [ValidateSet("auto","removeBorder","keepTitlebar")]
  [string]$StyleMode = "auto",
  [int]$FollowMs = 60
)

$ErrorActionPreference = "Continue"
$logFile = Join-Path $PSScriptRoot "..\win32-embed.log"
function Log($msg) {
  try {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $logFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {}
}

$scaling = "?"
try {
  $lp = Get-ItemProperty "HKCU:\Control Panel\Desktop" -Name LogPixels -ErrorAction Stop
  $scaling = [int]([int]$lp.LogPixels / 96 * 100)
} catch { $scaling = 100 }
Log ("ACTION=" + $Action + " PROC=" + $ProcessName + " KW=" + $TitleKeyword + " OWNER=" + $ParentHwnd + " TARGET=" + $TargetHwnd + " STYLE=" + $StyleMode + " SYS_SCALE=" + $scaling + "%")

$w6cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Threading;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Windows.Forms;
using System.Timers;

public class W6 {
  // ---------- P/Invoke ----------
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ClientToScreen(IntPtr h, ref POINT pt);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("shcore.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  // 事件钩子（实时跟随）
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmod, WinEventProc proc, uint idProc, uint idThread, uint flags);
  public delegate IntPtr WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint dwt, uint t);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }

  // 常量
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const int GWLP_HWNDPARENT = -8;
  public const int WS_CAPTION = 0x00C00000;
  public const int WS_THICKFRAME = 0x00040000;
  public const int WS_POPUP = unchecked((int)0x80000000);
  public const int WS_CHILD = 0x40000000;
  public const int WS_MINIMIZE = 0x20000000;
  public const int WS_EX_APPWINDOW = 0x00040000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int SW_HIDE = 0;
  public const int SW_SHOW = 5;
  public const int SW_RESTORE = 9;
  public const int SW_MINIMIZE_CMD = 6;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const int HWND_TOP = 0;
  public const int SM_CYCAPTION = 4;
  public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
  public const uint WINEVENT_OUTOFCONTEXT = 0x0002;
  public const uint WINEVENT_SKIPOWNPROCESS = 0x0080;

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
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (!pidSet.Contains(pid)) return true;
        var t = new StringBuilder(300); GetWindowText(h, t, 300);
        var c = new StringBuilder(150); GetClassName(h, c, 150);
        string title = t.ToString();
        RECT r; GetWindowRect(h, out r);
        int w = r.R - r.L, ht = r.B - r.T;
        int style = (int)GetWindowLongPtr(h, GWL_STYLE).ToInt64();
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

  // 计算目标屏幕矩形（跟随 owner 实时位置）
  // owner 是当前屏幕位置；X/Y/W/H 是渲染层传入的视口相对内容区 CSS 尺寸；scale 做 DPI 补偿
  public static int[] ComputeTargetRect(IntPtr owner, int cx, int cy, int cw, int ch, double scale, string styleMode, int captionH) {
    RECT r; GetWindowRect(owner, out r);
    POINT cp = new POINT(); cp.x = 0; cp.y = 0; ClientToScreen(owner, ref cp);
    int tw = (int)Math.Round(cw * scale);
    int th = (int)Math.Round(ch * scale);
    int tx = cp.x + (int)Math.Round(cx * scale);
    int ty = cp.y + (int)Math.Round(cy * scale);
    if (styleMode == "keepTitlebar") { ty = ty - captionH; th = th + captionH; }
    return new int[] { tx, ty, tw, th };
  }

  public static int[] Reposition(IntPtr target, IntPtr owner, int cx, int cy, int cw, int ch, double scale, string styleMode, bool noActivate) {
    int captionH = 0;
    try { captionH = GetSystemMetrics(SM_CYCAPTION); if (captionH <= 0) captionH = 23; } catch {}
    int[] rr = ComputeTargetRect(owner, cx, cy, cw, ch, scale, styleMode, captionH);
    uint flags = SWP_FRAMECHANGED | SWP_SHOWWINDOW | (noActivate ? SWP_NOACTIVATE : SWP_NOACTIVATE);
    SetWindowPos(target, (IntPtr)HWND_TOP, rr[0], rr[1], rr[2], rr[3], flags);
    return rr;
  }

  // ---------- Owned Top-Level 接管（替代 v4 的 SetParent embed） ----------
  public static Dictionary<string, object> DoEmbedOwned(IntPtr child, IntPtr owner, int cx, int cy, int cw, int ch, string styleMode) {
    var log = new List<string>();
    int childDpi = SafeDpi(child);
    int hostDpi = SafeDpi(owner);
    double scale = (double)childDpi / hostDpi;
    log.Add(string.Format("DPI child={0} host={1} scale={2:0.000}", childDpi, hostDpi, scale));

    int captionH = GetSystemMetrics(SM_CYCAPTION);
    if (captionH <= 0) captionH = 23;

    int oldStyle = (int)GetWindowLongPtr(child, GWL_STYLE).ToInt64();
    bool wasMinimized = (oldStyle & WS_MINIMIZE) != 0;
    RECT r0; GetWindowRect(child, out r0);
    bool wasCollapsed = (r0.R - r0.L) <= 200 || (r0.B - r0.T) <= 200;
    int oldEx = (int)GetWindowLongPtr(child, GWL_EXSTYLE).ToInt64();

    // 记录原样式用于 detach 恢复
    log.Add("oldStyle=" + oldStyle.ToString("X8") + " oldEx=" + oldEx.ToString("X8") + " wasMin=" + wasMinimized + " wasCollapsed=" + wasCollapsed);

    // 1) RESTORE -> SHOW（折叠态 199x34 也能救回）
    ShowWindow(child, SW_RESTORE);
    ShowWindow(child, SW_SHOW);
    log.Add("step1: RESTORE + SHOW");
    Thread.Sleep(300);

    // 2) ★ 核心：设置【拥有者 owner】而非父窗口。窗口保持顶层、保留自身消息循环，输入正常。
    if (owner.ToInt64() > 0) {
      SetWindowLongPtr(child, GWLP_HWNDPARENT, owner);
      log.Add("step2: GWLP_HWNDPARENT -> owner=" + owner + " (Owned Top-Level, 不是 SetParent)");
    }

    // 3) 去任务栏 / 去 Alt-Tab
    int ex2 = (int)GetWindowLongPtr(child, GWL_EXSTYLE).ToInt64();
    ex2 = (ex2 & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
    SetWindowLongPtr(child, GWL_EXSTYLE, (IntPtr)(long)ex2);
    log.Add("step3: exstyle -> -WS_EX_APPWINDOW +WS_EX_TOOLWINDOW (去任务栏/Alt-Tab)");

    // 4) 边框策略（★ 绝不加 WS_CHILD，一旦加就退化成子窗口、丢输入）
    string used;
    if (styleMode == "auto") { used = "removeBorder"; } else { used = styleMode; }
    if (used == "removeBorder") {
      int st = (int)GetWindowLongPtr(child, GWL_STYLE).ToInt64();
      st = st & ~WS_CAPTION & ~WS_THICKFRAME; // 去边框，保持顶层，不加 WS_CHILD
      SetWindowLongPtr(child, GWL_STYLE, (IntPtr)(long)st);
      log.Add("step4: STYLE_STRATEGY=removeBorder (st&=~CAPTION&~THICKFRAME, 无 WS_CHILD)");
    } else {
      // keepTitlebar: 保留标题栏，靠 Reposition 把 Y 上移 captionH 让标题栏露在可见区外
      log.Add("step4: STYLE_STRATEGY=keepTitlebar (保留标题栏, Reposition 上移 caption=" + captionH + ")");
    }

    // 5) 黑屏兜底：原本折叠/最小化的 Chromium/Qt -> MINIMIZE->RESTORE 触发重绘
    string blackScreen = "no";
    if (wasMinimized || wasCollapsed) {
      ShowWindow(child, SW_MINIMIZE_CMD); Thread.Sleep(200);
      ShowWindow(child, SW_RESTORE); Thread.Sleep(200);
      blackScreen = "recovery-cycle-applied (was " + (wasMinimized ? "minimized" : "collapsed") + ")";
      log.Add("step5: MINIMIZE->RESTORE 黑屏兜底已执行");
    } else {
      log.Add("step5: 尺寸正常, 跳过黑屏兜底");
    }

    // 6) 初次定位（屏幕坐标，跟随 owner）
    int[] rr = Reposition(child, owner, cx, cy, cw, ch, scale, used, true);
    log.Add("step6: SetWindowPos(HWND_TOP) at screen " + rr[0] + "," + rr[1] + " " + rr[2] + "x" + rr[3]);
    Thread.Sleep(150);

    var res = new Dictionary<string, object>();
    res["hwnd"] = child.ToInt64();
    res["ownerHwnd"] = owner.ToInt64();
    res["hostDpi"] = hostDpi;
    res["childDpi"] = childDpi;
    res["dpiScale"] = Math.Round(scale, 3);
    res["styleStrategy"] = used;
    res["physicalBounds"] = new object[] { rr[0], rr[1], rr[2], rr[3] };
    res["captionH"] = captionH;
    res["wasMinimized"] = wasMinimized;
    res["wasCollapsed"] = wasCollapsed;
    res["oldStyle"] = oldStyle;
    res["oldExStyle"] = oldEx;
    res["blackScreenFallback"] = blackScreen;
    res["steps"] = log;
    return res;
  }

  // ---------- 轻量显示 + 定位（不重新接管，用于切回标签 / resize / focus 置顶） ----------
  public static int[] DoLightShow(IntPtr child, IntPtr owner, int cx, int cy, int cw, int ch, string styleMode) {
    int captionH = GetSystemMetrics(SM_CYCAPTION);
    if (captionH <= 0) captionH = 23;
    int childDpi = SafeDpi(child);
    int hostDpi = SafeDpi(owner);
    double scale = (double)childDpi / hostDpi;
    ShowWindow(child, SW_SHOW);
    int[] rr = Reposition(child, owner, cx, cy, cw, ch, scale, styleMode, true);
    return rr;
  }

  // ---------- 跟随 watcher：SetWinEventHook + 60ms 轮询 ----------
  // 只在目标【当前可见】时校正位置/置顶；目标被 hide 时保持隐藏，不与渲染层抢可见性。
  // owner 最小化 -> 隐藏目标；owner 还原且目标可见 -> 显示并置顶。owner/目标任一消失 -> 退出。
  public static int RunWatcher(IntPtr target, IntPtr owner, int cx, int cy, int cw, int ch, string styleMode, int followMs) {
    int targetPid = Process.GetCurrentProcess().Id;
    WinEventProc procObj = null;
    IntPtr hook = IntPtr.Zero;
    Form f = null;
    System.Threading.Timer timer = null;
    try {
      int childDpi = SafeDpi(target);
      int hostDpi = SafeDpi(owner);
      double scale = (double)childDpi / hostDpi;

      IntPtr ownerRef = owner;
      WinEventProc proc = (h, ev, hw, idO, idC, dwt, t) => {
        try {
          if (hw == ownerRef) {
            Reposition(target, ownerRef, cx, cy, cw, ch, scale, styleMode, true);
          }
        } catch {}
        return IntPtr.Zero;
      };
      procObj = proc;
      hook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);

      f = new Form() { ShowInTaskbar = false };
      f.Hide();
      timer = new System.Threading.Timer((state) => {
        try {
          if (!IsWindow(ownerRef) || !IsWindow(target)) { f.Close(); return; }
          // 位置跟随：owner move/resize 时，若目标当前可见则重定位（覆盖拖拽丢帧）。
          // 最小化/还原的可见性交给 Owned 原生机制（owner 最小化→owned 自动隐藏，还原→自动回来），
          // 这里不手动 SW_HIDE，否则还原时 Owned 无法把客户端带回来。
          if (IsWindowVisible(target)) Reposition(target, ownerRef, cx, cy, cw, ch, scale, styleMode, true);
        } catch {}
      }, null, 200, followMs);
      Application.Run(f);
    } catch (Exception ex) {
      Console.Error.WriteLine("WATCHER_ERR " + ex.Message);
    } finally {
      try { if (timer != null) timer.Dispose(); } catch {}
      try { if (hook != IntPtr.Zero) UnhookWinEvent(hook); } catch {}
    }
    return targetPid;
  }
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
}
'@
if ("W6" -as [type]) {
  # 已编译过（watch 常驻进程内 / 之前 embed 已加载），跳过
} else {
  Add-Type -TypeDefinition $w6cs -ReferencedAssemblies 'System.Windows.Forms','System' -ErrorAction Stop
}

# ---------------------------------------------------------------- list
if ($Action -eq "list") {
  $wins = [W6]::Find($ProcessName, $TitleKeyword)
  $sum = ($wins | ForEach-Object { ('{0:X8}' -f $_.hwnd) + " (" + $_.w + "x" + $_.h + ") '" + $_.title + "'" } ) -join '; '
  Log ("LIST: " + $ProcessName + " found=" + $wins.Count + " " + $sum)
  @{ ok = $true; processName = $ProcessName; windows = $wins | ForEach-Object {
      [PSCustomObject]@{ hwnd=$_.hwnd; pid=$_.pid; title=$_.title; className=$_.className; w=$_.w; h=$_.h; isMinimized=$_.isMinimized; isCollapsed=$_.isCollapsed; isVisible=$_.isVisible }
    } } | ConvertTo-Json -Compress -Depth 5
  exit 0
}

# 解析目标窗口（embed/watch/hide/show/reposition 都需要）
function Resolve-Target {
  if ($script:TargetHwnd -gt 0) { return [IntPtr]$script:TargetHwnd }
  $w = [W6]::Find($script:ProcessName, $script:TitleKeyword)
  if ($w.Count -eq 0) { return [IntPtr]0 }
  return [IntPtr]$w[0].hwnd
}

# 选择窗口（过滤噪声）
function Pick-Target {
  $w = [W6]::Find($script:ProcessName, $script:TitleKeyword)
  foreach ($x in $w) {
    if ($x.hwnd -and ($x.className -notmatch 'IME|GDI|MSCTFIME|Static') -and ($x.w -gt 30) -and ($x.h -gt 20)) { return $x }
  }
  return $null
}

# ---------------------------------------------------------------- embed (Owned 接管)
if ($Action -eq "embed") {
  $child = Resolve-Target
  if ($child.ToInt64() -le 0) {
    Log "EMBED: no window found"
    @{ ok=$false; error=("未检测到「"+$ProcessName+"」客户端窗口，请先打开并登录该客户端") } | ConvertTo-Json -Compress; exit 0
  }
  $res = [W6]::DoEmbedOwned($child, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode)
  Log ("EMBED(owned): " + ($res["steps"] -join ' | ') + " ==> 结论 STYLE_STRATEGY=" + $res["styleStrategy"] + " DPI_SCALE=" + $res["dpiScale"])
  $out = @{ ok=$true }
  foreach ($k in $res.Keys) { $out[$k] = $res[$k] }
  $out | ConvertTo-Json -Compress -Depth 5
  exit 0
}

# ---------------------------------------------------------------- watch (常驻跟随)
if ($Action -eq "watch") {
  $child = Resolve-Target
  if ($child.ToInt64() -le 0) { Log "WATCH: no target"; @{ ok=$false } | ConvertTo-Json -Compress; exit 0 }
  Log ("WATCH: start for target=" + $child + " owner=" + $ParentHwnd + " every " + $FollowMs + "ms, style=" + $StyleMode)
  [W6]::RunWatcher($child, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode, $FollowMs) | Out-Null
  exit 0
}

# ---------------------------------------------------------------- hide
if ($Action -eq "hide") {
  if ($TargetHwnd -gt 0) { [W6]::ShowWindow([IntPtr]$TargetHwnd, [W6]::SW_HIDE) | Out-Null; Log ("HIDE target=" + $TargetHwnd) }
  @{ ok=$true } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- show (轻量：显示+定位，不重新接管)
if ($Action -eq "show") {
  if ($TargetHwnd -gt 0 -and $ParentHwnd -gt 0) {
    [W6]::DoLightShow([IntPtr]$TargetHwnd, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode) | Out-Null
    Log ("SHOW target=" + $TargetHwnd + " light-show+reposition (no re-takeover)")
  } elseif ($TargetHwnd -gt 0) {
    [W6]::ShowWindow([IntPtr]$TargetHwnd, [W6]::SW_SHOW) | Out-Null
    Log ("SHOW target=" + $TargetHwnd + " SW_SHOW only")
  }
  @{ ok=$true } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- reposition (一次性校正，供 focus 置顶用)
if ($Action -eq "reposition") {
  if ($TargetHwnd -gt 0 -and $ParentHwnd -gt 0) {
    [W6]::DoLightShow([IntPtr]$TargetHwnd, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode) | Out-Null
    Log ("REPOSITION target=" + $TargetHwnd)
  }
  @{ ok=$true } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- iswindow
if ($Action -eq "iswindow") {
  $exists = $false
  if ($TargetHwnd -gt 0) { $exists = [W6]::IsWindow([IntPtr]$TargetHwnd) }
  @{ ok=$true; exists=$exists; targetHwnd=$TargetHwnd } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- detach / detach-all (清 owner + 还原样式，绝不关窗口)
if ($Action -eq "detach" -or $Action -eq "detach-all") {
  $targets = @()
  if ($Action -eq "detach" -and $TargetHwnd -gt 0) { $targets += [IntPtr]$TargetHwnd }
  else {
    $w = [W6]::Find($ProcessName, $TitleKeyword)
    foreach ($x in $w) { $targets += [IntPtr]$x.hwnd }
  }
  $n = 0
  foreach ($h in $targets) {
    if ($h.ToInt64() -le 0) { continue }
    # 清掉 owner 关系
    [W6]::SetWindowLongPtr($h, [W6]::GWLP_HWNDPARENT, [IntPtr]::Zero) | Out-Null
    # 恢复 exstyle（去 TOOLWINDOW、加回 APPWINDOW）
    $ex64 = [W6]::GetWindowLongPtr($h, [W6]::GWL_EXSTYLE).ToInt64()
    $ex = [int]$ex64
    $ex = ($ex -band (-bnot [W6]::WS_EX_TOOLWINDOW)) -bor [W6]::WS_EX_APPWINDOW
    [W6]::SetWindowLongPtr($h, [W6]::GWL_EXSTYLE, [IntPtr][int64]$ex) | Out-Null
    # 恢复边框（若之前去掉了）
    $st64 = [W6]::GetWindowLongPtr($h, [W6]::GWL_STYLE).ToInt64()
    $st = [int]$st64
    $st = $st -band (-bnot [W6]::WS_CHILD)
    $st = $st -bor [W6]::WS_CAPTION -bor [W6]::WS_THICKFRAME
    [W6]::SetWindowLongPtr($h, [W6]::GWL_STYLE, [IntPtr][int64]$st) | Out-Null
    [W6]::MoveWindow($h, 120, 120, 1100, 720, $true) | Out-Null
    [W6]::ShowWindow($h, [W6]::SW_SHOW) | Out-Null
    $n++
  }
  Log ("DETACH(owned): " + $n + " window(s) 清 owner + 还原样式 + 桌面显示，未关闭任何窗口")
  @{ ok=$true; detached=$n } | ConvertTo-Json -Compress; exit 0
}

@{ ok=$false; error="unknown action: $Action" } | ConvertTo-Json -Compress
exit 0
