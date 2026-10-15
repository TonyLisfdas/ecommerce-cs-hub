<#
.SYNOPSIS
  Windows 原生客服窗口内嵌模块 v6.3 (Owned Top-Level 方案，Qt5 + Chromium/Electron 双内核兼容)
  核心变更（v6 -> v6.3）：
  - 修复12: 窗口选取重写 —— 第一道硬过滤(不可见/空标题/尺寸<200/类名黑名单含Chrome_WidgetWin_0/标题黑名单加载中等)
            + 第二道排序(关键词: 接待中心>客服工作台>千帆>eva>旺旺 > 类名Win_1 > 面积 > z-order)，
            并输出候选明细 + 最终选中 + 选中理由（写入 win32-embed.log）
  - 修复13: watcher 守卫 —— owner 最小化(IsIconic)/离屏(rect<=-30000) 不重定位；owner 还原的当个 tick 立即重定位；
            目标窗口 IsWindow 失效则 watcher 自行退出
  - 保留: GWLP_HWNDPARENT 拥有者顶层(去任务栏 TOOLWINDOW/去边框不加 WS_CHILD)、SetWinEventHook+60ms 跟随、
          DPI 补偿、黑屏兜底、日志、detach 清 owner 不关窗口
  动作：list | embed | watch | hide | show | reposition | detach | detach-all | iswindow
  说明：watch 是长驻进程（主进程 spawn 保活、单实例去重）；detach 只做清 owner + 还原样式，绝不 WM_CLOSE。
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
  [int]$FollowMs = 60,
  [string]$ExpectClass = ""
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
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmod, WinEventProc proc, uint idProc, uint idThread, uint flags);
  [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
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
    public int priority;      // 关键词排序：0接待中心 1客服工作台 2千帆 3eva 4旺旺 5传入keyword 9无
    public int classRank;     // 0=Chrome_WidgetWin_1 1=其他
    public int zIndex;        // EnumWindows 顺序（越小越靠前）
    public bool isCandidate;  // 是否通过第一道硬过滤
    public string excludedReason;
    public string pickReason;
    public long Area() { return (long)w * h; }
  }

  public static int SafeDpi(IntPtr h) {
    try { if (h.ToInt64() != 0) { uint d = GetDpiForWindow(h); if (d > 0) return (int)d; } } catch {}
    return 96;
  }

  // ---------- 修复12: 第一道硬过滤 + 第二道排序 ----------
  public static List<WinInfo> Find(string processName, string keyword) {
    var pidSet = new HashSet<uint>();
    foreach (var p in Process.GetProcesses()) {
      try { if (string.Equals(p.ProcessName, processName, StringComparison.OrdinalIgnoreCase)) pidSet.Add((uint)p.Id); } catch {} finally { p.Dispose(); }
    }
    var list = new List<WinInfo>();
    int zidx = 0;
    EnumWindows((h, l) => {
      try {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (!pidSet.Contains(pid)) return true;
        var t = new StringBuilder(300); GetWindowText(h, t, 300);
        var c = new StringBuilder(150); GetClassName(h, c, 150);
        string title = t.ToString();
        string cn = c.ToString();
        RECT r; GetWindowRect(h, out r);
        int w = r.R - r.L, ht = r.B - r.T;
        int style = (int)GetWindowLongPtr(h, GWL_STYLE).ToInt64();
        var info = new WinInfo {
          hwnd = h.ToInt64(), pid = (int)pid, title = title, className = cn,
          w = w, h = ht, isMinimized = (style & WS_MINIMIZE) != 0,
          isCollapsed = (w <= 200 || ht <= 200), isVisible = IsWindowVisible(h),
          priority = 9, classRank = 1, zIndex = zidx++
        };
        // ---- 第一道硬过滤（命中即丢弃，记录原因） ----
        // 修复24: 最小化窗口尺寸会塌缩(~199x34 / 挪到-32000)且 IsWindowVisible=False，
        // 用 WS_MINIMIZE 样式/IsIconic 识别；业务窗放行（embed 时黑屏兜底还原），非业务的小窗仍按 too-small 排除
        bool isMin = info.isMinimized || IsIconic(h);
        if (!info.isVisible && !isMin) { info.excludedReason = "invisible"; list.Add(info); return true; }
        if (string.IsNullOrEmpty(title)) { info.excludedReason = "empty-title"; list.Add(info); return true; }
        if ((w < 200 || ht < 200) && !isMin) { info.excludedReason = "too-small"; list.Add(info); return true; }
        if (cn.IndexOf("MSCTFIME", StringComparison.OrdinalIgnoreCase) >= 0
            || cn.IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0
            || cn.IndexOf("GDI", StringComparison.OrdinalIgnoreCase) >= 0
            || cn.IndexOf("tooltips_class32", StringComparison.OrdinalIgnoreCase) >= 0
            || cn.IndexOf("Chrome_WidgetWin_0", StringComparison.OrdinalIgnoreCase) >= 0) {
          info.excludedReason = "class-blacklist:" + cn;
          list.Add(info); return true;
        }
        if (title.IndexOf("\u52A0\u8F7D\u4E2D", StringComparison.OrdinalIgnoreCase) >= 0          // 加载中
            || title.IndexOf("Default IME", StringComparison.OrdinalIgnoreCase) >= 0
            || title.IndexOf("GDI+Window", StringComparison.OrdinalIgnoreCase) >= 0
            || title.IndexOf("\u5343\u725B\u5DE5\u4F5C\u53F0", StringComparison.OrdinalIgnoreCase) >= 0  // 千牛工作台(主后台,非接待窗)
            || (title.IndexOf("\u8BBE\u7F6E", StringComparison.Ordinal) >= 0 && title.Length < 12)) { // 设置
          info.excludedReason = "title-blacklist:" + title;
          list.Add(info); return true;
        }
        // ---- 第二道排序键 ----
        // ① 标题关键词: 接待中心>客服工作台>千帆>eva>旺旺（千帆真窗口标题就是 eva）
        if (title.IndexOf("\u63A5\u5F85\u4E2D\u5FC3", StringComparison.OrdinalIgnoreCase) >= 0) info.priority = 0;
        else if (title.IndexOf("\u5BA2\u670D\u5DE5\u4F5C\u53F0", StringComparison.OrdinalIgnoreCase) >= 0) info.priority = 1;
        else if (title.IndexOf("\u5343\u5E06", StringComparison.OrdinalIgnoreCase) >= 0) info.priority = 2;
        else if (title.IndexOf("eva", StringComparison.OrdinalIgnoreCase) >= 0) info.priority = 3;
        else if (title.IndexOf("\u65FA\u65FA", StringComparison.OrdinalIgnoreCase) >= 0) info.priority = 4;
        else if (!string.IsNullOrEmpty(keyword) && title.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0) info.priority = 5;
        // ② Electron/CEF 客户端 Chrome_WidgetWin_1 优于其他
        info.classRank = cn.Equals("Chrome_WidgetWin_1") ? 0 : 1;
        info.isCandidate = true;
        list.Add(info);
      } catch {}
      return true;
    }, IntPtr.Zero);
    // 排序: ①关键词rank → ②类名rank → ③面积大优先 → ④z-order靠前优先；非候选排最后
    list.Sort((a, b) => {
      if (a.isCandidate != b.isCandidate) return a.isCandidate ? -1 : 1;
      if (!a.isCandidate) {
        var c1 = a.excludedReason ?? ""; var c2 = b.excludedReason ?? "";
        return string.CompareOrdinal(c1, c2);
      }
      int c = a.priority.CompareTo(b.priority); if (c != 0) return c;
      c = a.classRank.CompareTo(b.classRank); if (c != 0) return c;
      c = b.Area().CompareTo(a.Area()); if (c != 0) return c;
      return a.zIndex.CompareTo(b.zIndex);
    });
    return list;
  }

  // 从 Find 结果选出目标 + 生成"选中理由"（供日志核对）
  public static WinInfo Pick(List<WinInfo> all) {
    WinInfo p = null;
    foreach (var x in all) { if (x.isCandidate) { p = x; break; } }
    if (p == null) return null;
    string kwName = null;
    switch (p.priority) {
      case 0: kwName = "接待中心"; break;
      case 1: kwName = "客服工作台"; break;
      case 2: kwName = "千帆"; break;
      case 3: kwName = "eva"; break;
      case 4: kwName = "旺旺"; break;
      case 5: kwName = "keyword"; break;
    }
    if (kwName != null) {
      p.pickReason = "R1-keyword'" + kwName + "'(rank" + p.priority + ") + visible + class=" + p.className + " " + p.w + "x" + p.h;
    } else {
      p.pickReason = "R1-fallback(no-keyword-hit) + visible + class=" + p.className + " + largest-area=" + p.Area() + " + z-order#" + p.zIndex + " (title '" + p.title + "')";
    }
    return p;
  }

  // owner 是否离屏（最小化时 Windows 把窗口挪到 -32000）
  public static bool OwnerOffscreen(IntPtr owner) {
    if (owner.ToInt64() <= 0) return true;
    RECT r;
    if (!GetWindowRect(owner, out r)) return true;
    return r.L <= -30000 || r.T <= -30000;
  }

  // ---------- 计算目标屏幕矩形（跟随 owner 实时位置） ----------
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
    uint flags = SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE;
    SetWindowPos(target, (IntPtr)HWND_TOP, rr[0], rr[1], rr[2], rr[3], flags);
    return rr;
  }

  // 守卫式重定位（修复13）：owner 最小化/离屏 → 跳过；目标可见才动
  // ---------- 修复21: 目标被隐藏/最小化时先还原（show/embed 前置） ----------
  public static int RestoreHidden(IntPtr child) {
    if (child.ToInt64() <= 0) return 0;
    int did = 0;
    if (!IsWindow(child)) return 0;
    if (IsIconic(child)) { ShowWindow(child, SW_RESTORE); Thread.Sleep(120); did += 1; }
    if (!IsWindowVisible(child)) { ShowWindow(child, SW_SHOW); did += 1; }
    if (did > 0) Thread.Sleep(120); // 等窗口真正上屏，尺寸就位
    return did;
  }

  public static bool GuardedReposition(IntPtr target, IntPtr owner, int cx, int cy, int cw, int ch, double scale, string styleMode) {
    if (!IsWindow(target)) return false;
    if (owner.ToInt64() > 0) {
      if (IsIconic(owner)) return false;      // owner 最小化 → 不重定位（Owned 原生会自动隐藏）
      if (OwnerOffscreen(owner)) return false; // owner 离屏(-32000) → 不重定位
    }
    // 修复24: 目标自己被最小化（如客户端误触最小化）→ watcher 帮它还原，嵌入窗必须跟随主窗可见
    if (IsIconic(target)) { ShowWindow(target, SW_RESTORE); Thread.Sleep(60); }
    if (IsWindowVisible(target)) Reposition(target, owner, cx, cy, cw, ch, scale, styleMode, true);
    return true;
  }

  // ---------- Owned Top-Level 接管（embed） ----------
  public static Dictionary<string, object> DoEmbedOwned(IntPtr child, IntPtr owner, int cx, int cy, int cw, int ch, string styleMode) {
    var log = new List<string>();
    { int _rh = RestoreHidden(child); if (_rh > 0) log.Add("restore-hidden=" + _rh); } // 修复21: 隐藏/最小化先还原
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
    log.Add("oldStyle=" + oldStyle.ToString("X8") + " oldEx=" + oldEx.ToString("X8") + " wasMin=" + wasMinimized + " wasCollapsed=" + wasCollapsed);

    ShowWindow(child, SW_RESTORE);
    ShowWindow(child, SW_SHOW);
    log.Add("step1: RESTORE + SHOW");
    Thread.Sleep(300);

    if (owner.ToInt64() > 0) {
      SetWindowLongPtr(child, GWLP_HWNDPARENT, owner);
      log.Add("step2: GWLP_HWNDPARENT -> owner=" + owner + " (Owned Top-Level, 不是 SetParent)");
    }

    int ex2 = (int)GetWindowLongPtr(child, GWL_EXSTYLE).ToInt64();
    ex2 = (ex2 & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
    SetWindowLongPtr(child, GWL_EXSTYLE, (IntPtr)(long)ex2);
    log.Add("step3: exstyle -> -WS_EX_APPWINDOW +WS_EX_TOOLWINDOW (去任务栏/Alt-Tab)");

    string used;
    if (styleMode == "auto") { used = "removeBorder"; } else { used = styleMode; }
    if (used == "removeBorder") {
      int st = (int)GetWindowLongPtr(child, GWL_STYLE).ToInt64();
      st = st & ~WS_CAPTION & ~WS_THICKFRAME; // 去边框，保持顶层，绝不加 WS_CHILD
      SetWindowLongPtr(child, GWL_STYLE, (IntPtr)(long)st);
      log.Add("step4: STYLE_STRATEGY=removeBorder (st&=~CAPTION&~THICKFRAME, 无 WS_CHILD)");
    } else {
      log.Add("step4: STYLE_STRATEGY=keepTitlebar (保留标题栏, Reposition 上移 caption=" + captionH + ")");
    }

    string blackScreen = "no";
    if (wasMinimized || wasCollapsed) {
      ShowWindow(child, SW_MINIMIZE_CMD); Thread.Sleep(200);
      ShowWindow(child, SW_RESTORE); Thread.Sleep(200);
      blackScreen = "recovery-cycle-applied (was " + (wasMinimized ? "minimized" : "collapsed") + ")";
      log.Add("step5: MINIMIZE->RESTORE 黑屏兜底已执行");
    } else {
      log.Add("step5: 尺寸正常, 跳过黑屏兜底");
    }

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

  // ---------- 轻量显示 + 定位（show：不重新接管） ----------
  // 修复17: 每次 show 幂等重绑 owner —— 重启后旧主窗已销毁、新主窗 HWND 不同，必须重绑到新主窗，
  // 否则新主窗 z-order 靠上会盖在客户端旧坐标上、点击被 Electron 抢走。
  public static int[] DoLightShow(IntPtr child, IntPtr owner, int cx, int cy, int cw, int ch, string styleMode) {
    int captionH = GetSystemMetrics(SM_CYCAPTION);
    if (captionH <= 0) captionH = 23;
    int childDpi = SafeDpi(child);
    int hostDpi = SafeDpi(owner);
    double scale = (double)childDpi / hostDpi;
    if (owner.ToInt64() > 0) SetWindowLongPtr(child, GWLP_HWNDPARENT, owner); // ★ 修复17 重绑 owner（幂等）
    RestoreHidden(child); // 修复21: 最小化/隐藏先还原，保证 Reposition 时尺寸有效
    ShowWindow(child, SW_SHOW);
    int[] rr = Reposition(child, owner, cx, cy, cw, ch, scale, styleMode, true); // SetWindowPos(HWND_TOP,...)
    return rr;
  }

  // ---------- 修复18: 缓存指纹校验（不能只验 IsWindow） ----------
  public static Dictionary<string, object> ValidateTarget(IntPtr hwnd, string procName, string expectClass) {
    var d = new Dictionary<string, object>();
    bool alive = IsWindow(hwnd);
    bool vis = alive && IsWindowVisible(hwnd);
    string pnm = ""; bool procOk = false;
    uint pid = 0;
    if (alive) {
      GetWindowThreadProcessId(hwnd, out pid);
      try { var pp = Process.GetProcessById((int)pid); if (pp != null) pnm = pp.ProcessName; } catch { }
      procOk = !string.IsNullOrEmpty(procName) && pnm.IndexOf(procName, StringComparison.OrdinalIgnoreCase) >= 0;
    }
    string cls = ""; bool clsOk = false; bool clsBlack = false;
    if (alive) { var sb2 = new StringBuilder(150); GetClassName(hwnd, sb2, 150); cls = sb2.ToString(); }
    clsOk = !string.IsNullOrEmpty(expectClass) && cls == expectClass;
    if (cls.IndexOf("Chrome_WidgetWin_0", StringComparison.OrdinalIgnoreCase) >= 0
      || cls.IndexOf("MSCTFIME", StringComparison.OrdinalIgnoreCase) >= 0
      || cls.IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0
      || cls.IndexOf("GDI", StringComparison.OrdinalIgnoreCase) >= 0
      || cls.IndexOf("tooltips_class32", StringComparison.OrdinalIgnoreCase) >= 0) clsBlack = true;
    RECT r; GetWindowRect(hwnd, out r); int w = r.R - r.L, h = r.B - r.T;
    bool minNow = IsIconic(hwnd);
    bool sizeOk = (w >= 200 && h >= 200) || minNow; // 修复24: 最小化时尺寸塌缩≠假窗，show 会 RestoreHidden 还原
    int ttl = GetWindowTextLength(hwnd); bool titleOk = ttl > 0;
    // 修复18b: 不要求 visible（切走时 SW_HIDE 会误丢缓存）；陈旧假窗由 clsBlack+clsOk+proc+size+title 挡
    d["hwnd"] = hwnd.ToInt64();
    d["process"] = pnm;
    d["className"] = cls;
    d["size"] = w + "x" + h;
    d["checks"] = "IsWindow=" + alive + " IsWindowVisible=" + vis + " proc=" + (procOk ? "OK" : "FAIL")
      + " class=" + (clsOk ? "OK" : "FAIL") + " black=" + clsBlack + " size=" + (sizeOk ? "OK" : "FAIL") + " title=" + (titleOk ? "OK" : "FAIL");
    bool reuse = alive && procOk && clsOk && !clsBlack && sizeOk && titleOk; // 修复18b: 不要求 visible (陈旧假窗由 clsBlack+clsOk+proc+size+title 挡)
    d["reuse"] = reuse;
    return d;
  }

  // ---------- 修复19: 启动救援（biz-only 关键词过滤，避免 Find 全枚举超时） ----------
  public static List<long> Rescue(string procName) {
    var pidSet = new HashSet<uint>();
    foreach (var pp in System.Diagnostics.Process.GetProcesses()) {
      try { if (string.Equals(pp.ProcessName, procName, StringComparison.OrdinalIgnoreCase)) pidSet.Add((uint)pp.Id); } catch {} finally { pp.Dispose(); }
    }
    if (pidSet.Count == 0) return new List<long>();
    var restored = new List<long>();
    EnumWindows((h, l) => {
      try {
        uint p2; GetWindowThreadProcessId(h, out p2);
        if (!pidSet.Contains(p2)) return true;
        RECT rr; GetWindowRect(h, out rr);
        int w = rr.R - rr.L, ht = rr.B - rr.T;
        // 修复24: 最小化业务窗尺寸塌缩，也要救（SW_RESTORE 还原即恢复原尺寸）
        bool minNow = IsIconic(h);
        if ((w < 200 || ht < 200) && !minNow) return true;
        if (IsWindowVisible(h) && !minNow) return true;  // 可见且非最小化 → 不用救
        var t = new StringBuilder(300); GetWindowText(h, t, 300); string title = t.ToString();
        bool biz = title.IndexOf("接待", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("客服", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("旺旺", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("咚咚", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("千帆", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("eva", StringComparison.OrdinalIgnoreCase) >= 0;
        if (biz && IsWindow(h)) {
          ShowWindow(h, SW_RESTORE);
          ShowWindow(h, SW_SHOW);
          restored.Add(h.ToInt64());
        }
      } catch {}
      return true;
    }, IntPtr.Zero);
    return restored;
  }
  // ---------- 跟随 watcher（修复13：owner 最小化/离屏守卫 + 目标失效自退出） ----------
  public static int RunWatcher(IntPtr target, IntPtr owner, int cx, int cy, int cw, int ch, string styleMode, int followMs) {
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
            if (IsIconic(ownerRef)) return IntPtr.Zero;             // 主窗口最小化 → 不动（Owned 原生自动隐藏）
            if (OwnerOffscreen(ownerRef)) return IntPtr.Zero;      // 主窗口离屏(-32000) → 不动
            if (IsWindowVisible(target)) Reposition(target, ownerRef, cx, cy, cw, ch, scale, styleMode, true);
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
          if (!IsWindow(ownerRef) || !IsWindow(target)) { f.Close(); return; }  // 目标/主窗口已关闭 → watcher 自行退出
          if (!GuardedReposition(target, ownerRef, cx, cy, cw, ch, scale, styleMode)) return;
          // owner 从最小化还原的瞬间：本 tick 的 GuardedReposition 已立即校正（skipNow 变 false 的当个 tick 就定位，不等下一轮）
        } catch {}
      }, null, 200, followMs);
      Application.Run(f);
    } catch (Exception ex) {
      Console.Error.WriteLine("WATCHER_ERR " + ex.Message);
    } finally {
      try { if (timer != null) timer.Dispose(); } catch {}
      try { if (hook != IntPtr.Zero) UnhookWinEvent(hook); } catch {}
    }
    return 0;
  }
}
'@
if ("W6" -as [type]) {
  # 已编译过（watch 常驻进程内 / 之前 embed 已加载），跳过
} else {
  Add-Type -TypeDefinition $w6cs -ReferencedAssemblies 'System.Windows.Forms','System' -ErrorAction Stop
}

# ---------------------------------------------------------------- list（带候选明细 + Pick + 理由）
if ($Action -eq "list") {
  $wins = [W6]::Find($ProcessName, $TitleKeyword)
  $pick = [W6]::Pick($wins)
  # 修复22: 无候选 → 可能是接待窗口被隐藏/最小化（上次 detach 或用户最小化），自动 rescue 一次再重扫
  if (-not $pick) {
    $rescued = [W6]::Rescue($ProcessName)
    if ($rescued.Count -gt 0) { Log ("LIST-AUTORESCUE: " + $ProcessName + " rescued=" + ($rescued -join ",") + " re-scanning"); Start-Sleep -Milliseconds 400
      $wins = [W6]::Find($ProcessName, $TitleKeyword)
      $pick = [W6]::Pick($wins)
    }
  }
  $cand = @($wins | Where-Object { $_.isCandidate })
  $excl = @($wins | Where-Object { -not $_.isCandidate })
  $candSum = ($cand | ForEach-Object { "hwnd=" + $_.hwnd + " " + $_.className + " '" + $_.title + "' " + $_.w + "x" + $_.h + " vis=" + $_.isVisible + " rank=" + $_.priority }) -join '; '
  $exclSum = ($excl | ForEach-Object { "hwnd=" + $_.hwnd + " '" + $_.title + "' " + $_.className + " excluded=" + $_.excludedReason }) -join '; '
  if ($pick) {
    Log ("LIST: " + $ProcessName + " found=" + $wins.Count + " CANDIDATES=[" + $candSum + "] EXCLUDED=[" + $exclSum + "] ==> PICK=" + $pick.hwnd + " reason=" + $pick.pickReason)
  } else {
    Log ("LIST: " + $ProcessName + " found=" + $wins.Count + " NO_CANDIDATE (excluded=[" + $exclSum + "])")
  }
  @{ ok = $true; processName = $ProcessName;
     windows = ($wins | ForEach-Object {
       [PSCustomObject]@{ hwnd=$_.hwnd; pid=$_.pid; title=$_.title; className=$_.className; w=$_.w; h=$_.h;
         isMinimized=$_.isMinimized; isCollapsed=$_.isCollapsed; isVisible=$_.isVisible;
         isCandidate=$_.isCandidate; excludedReason=$_.excludedReason; zIndex=$_.zIndex } })
     candidates = ($cand | ForEach-Object { [PSCustomObject]@{ hwnd=$_.hwnd; title=$_.title; className=$_.className; w=$_.w; h=$_.h; rank=$_.priority; classRank=$_.classRank; zIndex=$_.zIndex } })
     pickHwnd = $(if ($pick) { $pick.hwnd } else { 0 })
     pickReason = $(if ($pick) { $pick.pickReason } else { "NO_CANDIDATE: " + $exclSum })
   } | ConvertTo-Json -Compress -Depth 6
  exit 0
}

# 解析目标窗口：显式 TargetHwnd 优先；否则走新 Pick
function Resolve-Target {
  if ($script:TargetHwnd -gt 0) { return [IntPtr]$script:TargetHwnd }
  $w = [W6]::Find($script:ProcessName, $script:TitleKeyword)
  $p = [W6]::Pick($w)
  if ($p) { return [IntPtr]$p.hwnd }
  return [IntPtr]0
}

# ---------------------------------------------------------------- embed (Owned 接管)
if ($Action -eq "embed") {
  $child = Resolve-Target
  if ($child.ToInt64() -le 0) {
    Log "EMBED: no candidate window (全部被硬过滤排除)"
    @{ ok=$false; error=("「"+$ProcessName+"」未找到可用窗口（可能被隐藏或尚未登录）。请先显示该窗口，再点「重新扫描」。") } | ConvertTo-Json -Compress; exit 0
  }
  $res = [W6]::DoEmbedOwned($child, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode)
  Log ("EMBED(owned): target=" + $child + " " + ($res["steps"] -join ' | ') + " ==> 结论 STYLE_STRATEGY=" + $res["styleStrategy"] + " DPI_SCALE=" + $res["dpiScale"])
  $out = @{ ok=$true }
  foreach ($k in $res.Keys) { $out[$k] = $res[$k] }
  $out | ConvertTo-Json -Compress -Depth 5
  exit 0
}

# ---------------------------------------------------------------- watch (常驻跟随，带守卫)
if ($Action -eq "watch") {
  $child = Resolve-Target
  if ($child.ToInt64() -le 0) { Log "WATCH: no target"; @{ ok=$false } | ConvertTo-Json -Compress; exit 0 }
  Log ("WATCH: start for target=" + $child + " owner=" + $ParentHwnd + " every " + $FollowMs + "ms, style=" + $StyleMode + " (guard: owner-iconic/offscreen skip, target-dead exit)")
  [W6]::RunWatcher($child, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode, $FollowMs) | Out-Null
  exit 0
}

# ---------------------------------------------------------------- hide
if ($Action -eq "hide") {
  if ($TargetHwnd -gt 0) { [W6]::ShowWindow([IntPtr]$TargetHwnd, [W6]::SW_HIDE) | Out-Null; Log ("HIDE target=" + $TargetHwnd) }
  @{ ok=$true } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- show (修复17：显示+重绑owner+定位，不重新接管)
if ($Action -eq "show") {
  $rebound = ($TargetHwnd -gt 0 -and $ParentHwnd -gt 0)
  if ($rebound) {
    [W6]::DoLightShow([IntPtr]$TargetHwnd, [IntPtr]$ParentHwnd, $X, $Y, $Width, $Height, $StyleMode) | Out-Null
    Log ("SHOW target=" + $TargetHwnd + " owner=" + $ParentHwnd + " (rebound=是) light-show+rebind-owner+reposition")
  } elseif ($TargetHwnd -gt 0) {
    [W6]::ShowWindow([IntPtr]$TargetHwnd, [W6]::SW_SHOW) | Out-Null
    Log ("SHOW target=" + $TargetHwnd + " SW_SHOW only (no owner)")
  }
  @{ ok=$true; targetHwnd=$TargetHwnd; owner=$ParentHwnd; rebound=$rebound } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- reposition (一次性校正)
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

# ---------------------------------------------------------------- validatecache (修复18: 缓存指纹校验)
if ($Action -eq "validatecache") {
  if ($TargetHwnd -le 0) { @{ ok=$true; reuse=$false; reason='no-target' } | ConvertTo-Json -Compress; exit 0 }
  $expectCls = if ($ExpectClass) { $ExpectClass } else { $TitleKeyword }
  $v = [W6]::ValidateTarget([IntPtr]$TargetHwnd, $ProcessName, $expectCls)
  $verdict = if ($v["reuse"]) { "REUSE" } else { "DISCARD, fallback to list" }
  Log ("CACHE_VALIDATE: hwnd=" + $TargetHwnd + " proc=" + $v["process"] + " class=" + $v["className"] + " " + $v["checks"] + " ==> " + $verdict)
  @{ ok=$true; reuse=$v["reuse"]; process=$v["process"]; className=$v["className"]; size=$v["size"]; checks=$v["checks"]; targetHwnd=$TargetHwnd } | ConvertTo-Json -Compress; exit 0
}

# ---------------------------------------------------------------- rescue (修复19: 启动救援)
if ($Action -eq "rescue") {
  $restored = [W6]::Rescue($ProcessName)
  Log ("RESCUE: 恢复了 " + $restored.Count + " 个窗口, HWND=[" + ($restored -join ', ') + "] (process=" + $ProcessName + ")")
  @{ ok=$true; restored=$restored.Count; hwnds=$restored; processName=$ProcessName } | ConvertTo-Json -Compress; exit 0
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
    [W6]::SetWindowLongPtr($h, [W6]::GWLP_HWNDPARENT, [IntPtr]::Zero) | Out-Null
    $ex64 = [W6]::GetWindowLongPtr($h, [W6]::GWL_EXSTYLE).ToInt64()
    $ex = [int]$ex64
    $ex = ($ex -band (-bnot [W6]::WS_EX_TOOLWINDOW)) -bor [W6]::WS_EX_APPWINDOW
    [W6]::SetWindowLongPtr($h, [W6]::GWL_EXSTYLE, [IntPtr][int64]$ex) | Out-Null
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
