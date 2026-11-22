// fwd: the fw daemon. Runs in the interactive Windows session and executes
// desktop commands (input, UI Automation, screenshots, recording) sent to
// http://127.0.0.1:9877/run as a plain-text script, one command per line.
// Built with the C# 5 compiler that ships with Windows, so no SDK is needed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr h, uint min, uint max);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
}

class Ref
{
    public AutomationElement El;
    public Rectangle Rect;
}

static class Fwd
{
    const string Version = "0.1.0";
    const string Root = @"C:\dev\fw";
    static readonly string OutDir = Path.Combine(Root, "out");
    static readonly string LogDir = Path.Combine(Root, "log");
    static string token = "";

    static readonly object inputLock = new object();
    static readonly object logLock = new object();
    static readonly object stateLock = new object();

    static volatile bool paused;
    static uint ourLastTick;

    static Dictionary<string, Ref> refs = new Dictionary<string, Ref>();
    static int fileSeq;

    // Transform of the last shot: image pixel = (screen - origin) * scale.
    static int shotX, shotY;
    static double shotScale = 1.0;
    static Bitmap prevFull;
    static Rectangle prevRect;

    static Process rec;
    static string recFile;

    static readonly HashSet<string> InputCmds = new HashSet<string>(new string[] {
        "click", "move", "drag", "scroll", "key", "keydown", "keyup", "type", "paste", "focus" });

    // ---------------------------------------------------------------- main

    [STAThread]
    static void Main()
    {
        bool fresh;
        Mutex m = new Mutex(true, "Global\\fwd", out fresh);
        if (!fresh) return;

        try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
        catch { Native.SetProcessDPIAware(); }

        Directory.CreateDirectory(OutDir);
        Directory.CreateDirectory(LogDir);
        token = File.ReadAllText(Path.Combine(Root, "token")).Trim();
        if (token.Length < 16) throw new Exception("token file is missing or too short");
        foreach (string f in Directory.GetFiles(OutDir))
            try { if (File.GetLastWriteTimeUtc(f) < DateTime.UtcNow.AddDays(-1)) File.Delete(f); } catch { }

        Thread hk = new Thread(HotkeyLoop);
        hk.IsBackground = true;
        hk.Start();

        HttpListener l = new HttpListener();
        l.Prefixes.Add("http://127.0.0.1:9877/");
        l.Start();
        Log("start", true, 0, "fwd " + Version);
        while (true)
        {
            HttpListenerContext ctx = l.GetContext();
            ThreadPool.QueueUserWorkItem(delegate { Handle(ctx); });
        }
    }

    // Ctrl+Alt+F12 pauses and resumes every input command.
    static void HotkeyLoop()
    {
        Native.RegisterHotKey(IntPtr.Zero, 1, 0x1 | 0x2, 0x7B);
        Native.MSG msg;
        while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.message == 0x312)
            {
                paused = !paused;
                Log("hotkey", true, 0, paused ? "paused" : "resumed");
            }
        }
    }

    // ---------------------------------------------------------------- http

    static void Handle(HttpListenerContext ctx)
    {
        try
        {
            string sent = ctx.Request.Headers["X-Fw-Token"] ?? "";
            if (!SameText(sent, token)) { Reply(ctx, 401, "bad token"); return; }
            string path = ctx.Request.Url.AbsolutePath;
            if (path == "/file")
            {
                string name = Path.GetFileName(ctx.Request.QueryString["name"] ?? "");
                string full = Path.Combine(OutDir, name);
                if (name == "" || !File.Exists(full)) { Reply(ctx, 404, "no such file: " + name); return; }
                byte[] data = File.ReadAllBytes(full);
                ctx.Response.ContentType = "application/octet-stream";
                ctx.Response.ContentLength64 = data.Length;
                ctx.Response.OutputStream.Write(data, 0, data.Length);
                ctx.Response.Close();
                return;
            }
            if (path == "/run" && ctx.Request.HttpMethod == "POST")
            {
                string body;
                using (StreamReader r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = r.ReadToEnd();
                bool force = ctx.Request.Headers["X-Fw-Force"] == "1";
                bool ok;
                string text = RunScript(body, force, out ok);
                Reply(ctx, ok ? 200 : 400, text);
                return;
            }
            Reply(ctx, 404, "unknown path");
        }
        catch (Exception e)
        {
            try { Reply(ctx, 500, "daemon error: " + e.Message); } catch { }
        }
    }

    static void Reply(HttpListenerContext ctx, int code, string text)
    {
        byte[] data = Encoding.UTF8.GetBytes(text.EndsWith("\n") ? text : text + "\n");
        ctx.Response.StatusCode = code;
        ctx.Response.ContentType = "text/plain; charset=utf-8";
        ctx.Response.ContentLength64 = data.Length;
        ctx.Response.OutputStream.Write(data, 0, data.Length);
        ctx.Response.Close();
    }

    static bool SameText(string a, string b)
    {
        if (a.Length != b.Length) return false;
        int d = 0;
        for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i];
        return d == 0;
    }

    // -------------------------------------------------------------- script

    static string RunScript(string body, bool force, out bool ok)
    {
        List<string> lines = new List<string>();
        foreach (string raw in body.Replace("\r", "").Split('\n'))
        {
            string s = raw.Trim();
            if (s != "" && !s.StartsWith("#")) lines.Add(s);
        }
        ok = true;
        if (lines.Count == 0) { ok = false; return "empty script; try: help"; }
        bool input = false;
        foreach (string s in lines) if (InputCmds.Contains(Name(s))) input = true;
        if (input)
        {
            lock (inputLock) return RunLines(lines, force, out ok);
        }
        return RunLines(lines, force, out ok);
    }

    static string RunLines(List<string> lines, bool force, out bool ok)
    {
        ok = true;
        StringBuilder sb = new StringBuilder();
        bool many = lines.Count > 1;
        for (int i = 0; i < lines.Count; i++)
        {
            string line = lines[i];
            Stopwatch sw = Stopwatch.StartNew();
            string shown = Redact(line);
            try
            {
                string res = Exec(line, force);
                if (res == null || res == "") res = "ok";
                Log(shown, true, sw.ElapsedMilliseconds, res);
                sb.Append(many ? "[" + (i + 1) + "] " + shown + " -> " + res : res).Append('\n');
            }
            catch (Exception e)
            {
                ok = false;
                Log(shown, false, sw.ElapsedMilliseconds, e.Message);
                sb.Append("ERR").Append(many ? " line " + (i + 1) + " (" + shown + ")" : "").Append(": ").Append(e.Message).Append('\n');
                if (many && i + 1 < lines.Count) sb.Append("stopped; " + (lines.Count - i - 1) + " line(s) not run\n");
                break;
            }
        }
        return sb.ToString();
    }

    static string Name(string line)
    {
        int i = line.IndexOf(' ');
        return (i < 0 ? line : line.Substring(0, i)).ToLowerInvariant();
    }

    static string Rest(string line)
    {
        int i = line.IndexOf(' ');
        return i < 0 ? "" : line.Substring(i + 1).Trim();
    }

    // Typed and pasted text never reaches the log: it may be a secret.
    static string Redact(string line)
    {
        string n = Name(line);
        if (n == "type" || n == "paste") return n + " <" + Rest(line).Length + " chars>";
        return line;
    }

    static List<string> Tokens(string s)
    {
        List<string> r = new List<string>();
        StringBuilder cur = new StringBuilder();
        bool q = false, any = false;
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '\\' && q && i + 1 < s.Length && s[i + 1] == '"') { cur.Append('"'); i++; }
            else if (c == '"') { q = !q; any = true; }
            else if (!q && char.IsWhiteSpace(c)) { if (cur.Length > 0 || any) { r.Add(cur.ToString()); cur.Length = 0; any = false; } }
            else cur.Append(c);
        }
        if (cur.Length > 0 || any) r.Add(cur.ToString());
        return r;
    }

    static bool Flag(List<string> a, string flag)
    {
        return a.Remove(flag);
    }

    static string Opt(List<string> a, string flag, string def)
    {
        int i = a.IndexOf(flag);
        if (i < 0) return def;
        if (i + 1 >= a.Count) throw new Exception(flag + " needs a value");
        string v = a[i + 1];
        a.RemoveRange(i, 2);
        return v;
    }

    static int Int(string s, string what)
    {
        int v;
        if (!int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) throw new Exception(what + " must be a number, got: " + s);
        return v;
    }

    static string Exec(string line, bool force)
    {
        string name = Name(line);
        string rest = Rest(line);
        List<string> a = Tokens(rest);
        if (InputCmds.Contains(name)) Guard(force);
        switch (name)
        {
            case "help": return Help;
            case "status": return Status();
            case "windows": return Windows();
            case "focus": Focus(Find(Need(rest, "focus <window>"))); return "focused " + Title(Native.GetForegroundWindow());
            case "waitfor": return WaitFor(a);
            case "wait": Thread.Sleep(Math.Min(Int(Need(rest, "wait <ms>"), "ms"), 60000)); return "";
            case "snap": return Snap(a);
            case "invoke": return Invoke(Need(rest, "invoke <ref>"));
            case "set": return SetValue(rest);
            case "click": return Click(a);
            case "move": MoveTo(Target(Need(rest, "move <target>"))); return "";
            case "drag": return Drag(a);
            case "scroll": return Scroll(a);
            case "key": foreach (string combo in a) Combo(combo); if (a.Count == 0) throw new Exception("usage: key <combo>..."); return "";
            case "keydown": Key(Vk(Need(rest, "keydown <key>")), false); return "";
            case "keyup": Key(Vk(Need(rest, "keyup <key>")), true); return "";
            case "type": TypeText(rest); return "typed " + rest.Length + " chars";
            case "paste": Paste(rest); return "pasted " + rest.Length + " chars";
            case "shot": return Shot(a);
            case "exec": return Run(rest);
            case "rec": return Rec(a);
            case "log": return Tail(a.Count > 0 ? Int(a[0], "count") : 20);
            default: throw new Exception("unknown command: " + name + "; try: help");
        }
    }

    static string Need(string s, string usage)
    {
        if (s == "") throw new Exception("usage: " + usage);
        return s;
    }

    const string Help =
@"fw commands (one per line; a script stops at the first error)
look
  status                          version, screen, cursor, idle time, foreground window
  windows                         visible windows: process, title, rect
  snap [window] [--max N]         UI Automation tree as text; each element gets a ref (e1, e2..)
  shot [screen|window [name]|region x,y,w,h|<ref>] [--max 1280] [--q 70] [--marks] [--grid N] [--diff]
                                  JPEG, scaled so the long side is at most --max
                                  --marks draws the refs of the last snap, --grid draws image coordinates
                                  --diff returns only the area that changed since the last shot of that target
  log [N]                         last N commands
act without the cursor (safe to run in parallel)
  invoke <ref>                    press, toggle, select or expand an element through UI Automation
  set <ref> <text>                set the value of an edit field
  exec <command line>             start a program in the desktop session
  exec --wait [seconds] <command> run a command, wait, return its output
act with the cursor and keyboard (queued; refused while a person uses the machine)
  focus <window>                  bring a window to the front (title substring or process name)
  click <target> [--right|--middle] [--double]
  move <target>
  drag <target> <target>.. [--right|--middle]
  scroll <target> <notches>       positive scrolls up
  key <combo>..                   ENTER, ctrl+s, ctrl+shift+ESC, F5 ..
  keydown <key> / keyup <key>     hold a key across other commands
  type <text>                     Unicode key events
  paste <text>                    through the clipboard; use when type is mangled
flow
  wait <ms>
  waitfor <window> [seconds]      wait until a window exists
  rec start [fps] | rec stop      record the desktop to mp4
targets
  e12        a ref from the last snap (its center)
  @640,360   a pixel in the last shot
  640,360    a screen pixel
Ctrl+Alt+F12 on the machine pauses and resumes all cursor and keyboard commands.";

    // --------------------------------------------------------------- guard

    static uint IdleMs()
    {
        Native.LASTINPUTINFO li = new Native.LASTINPUTINFO();
        li.cbSize = 8;
        Native.GetLastInputInfo(ref li);
        return Native.GetTickCount() - li.dwTime;
    }

    static void Guard(bool force)
    {
        if (paused) throw new Exception("paused by Ctrl+Alt+F12 on the machine; press it again to resume");
        if (force) return;
        Native.LASTINPUTINFO li = new Native.LASTINPUTINFO();
        li.cbSize = 8;
        Native.GetLastInputInfo(ref li);
        uint now = Native.GetTickCount();
        bool notOurs = (int)(li.dwTime - ourLastTick) > 150;
        if (notOurs && now - li.dwTime < 3000)
            throw new Exception("a person is using the machine (last input " + (now - li.dwTime) + " ms ago); retry later or pass --force");
    }

    static void Send(Native.INPUT[] inputs)
    {
        uint n = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
        ourLastTick = Native.GetTickCount();
        if (n != inputs.Length) throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + ")");
    }

    // -------------------------------------------------------------- screen

    static Rectangle VirtualScreen()
    {
        return new Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77), Native.GetSystemMetrics(78), Native.GetSystemMetrics(79));
    }

    static string Status()
    {
        Rectangle v = VirtualScreen();
        Native.POINT p;
        Native.GetCursorPos(out p);
        IntPtr fg = Native.GetForegroundWindow();
        return "fwd " + Version + "\n"
            + "screen " + v.X + "," + v.Y + " " + v.Width + "x" + v.Height + "\n"
            + "cursor " + p.X + "," + p.Y + "\n"
            + "idle " + (IdleMs() / 1000) + "s\n"
            + "paused " + (paused ? "yes" : "no") + "\n"
            + "recording " + (rec != null && !rec.HasExited ? "yes" : "no") + "\n"
            + "foreground " + Proc(fg) + " \"" + Title(fg) + "\"";
    }

    // ------------------------------------------------------------- windows

    static string Title(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        Native.GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    static string Proc(IntPtr h)
    {
        uint pid;
        Native.GetWindowThreadProcessId(h, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }

    static List<IntPtr> TopWindows()
    {
        List<IntPtr> r = new List<IntPtr>();
        Native.EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            // Cloaked windows are suspended store apps: listed by Windows, never drawn.
            int cloaked = 0;
            Native.DwmGetWindowAttribute(h, 14, out cloaked, 4);
            if (Native.IsWindowVisible(h) && cloaked == 0 && Title(h) != "") r.Add(h);
            return true;
        }, IntPtr.Zero);
        return r;
    }

    static Rectangle WinRect(IntPtr h)
    {
        Native.RECT r;
        Native.GetWindowRect(h, out r);
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }

    static string Windows()
    {
        StringBuilder sb = new StringBuilder();
        IntPtr fg = Native.GetForegroundWindow();
        foreach (IntPtr h in TopWindows())
        {
            Rectangle r = WinRect(h);
            sb.Append(h == fg ? "* " : "  ").Append(Proc(h)).Append(" \"").Append(Title(h)).Append("\" ")
              .Append(r.X).Append(',').Append(r.Y).Append(' ').Append(r.Width).Append('x').Append(r.Height)
              .Append(Native.IsIconic(h) ? " minimized" : "").Append('\n');
        }
        return sb.Length == 0 ? "no windows" : sb.ToString().TrimEnd();
    }

    static IntPtr TryFind(string q)
    {
        q = q.Trim().Trim('"');
        List<IntPtr> all = TopWindows();
        foreach (IntPtr h in all) if (string.Equals(Proc(h), q, StringComparison.OrdinalIgnoreCase)) return h;
        foreach (IntPtr h in all) if (Title(h).IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) return h;
        return IntPtr.Zero;
    }

    static IntPtr Find(string q)
    {
        IntPtr h = TryFind(q);
        if (h == IntPtr.Zero) throw new Exception("no window matches \"" + q + "\"; run: windows");
        return h;
    }

    static void Focus(IntPtr h)
    {
        if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
        uint pid;
        uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
        uint me = Native.GetCurrentThreadId();
        Native.AttachThreadInput(me, fgThread, true);
        Native.BringWindowToTop(h);
        Native.SetForegroundWindow(h);
        Native.AttachThreadInput(me, fgThread, false);
        if (Native.GetForegroundWindow() != h)
        {
            // Windows only hands over the foreground after an input event.
            Native.keybd_event(0x12, 0, 0, UIntPtr.Zero);
            Native.keybd_event(0x12, 0, 2, UIntPtr.Zero);
            ourLastTick = Native.GetTickCount();
            Native.SetForegroundWindow(h);
        }
        Thread.Sleep(200);
        if (Native.GetForegroundWindow() != h) throw new Exception("Windows refused to bring \"" + Title(h) + "\" to the front");
    }

    static string WaitFor(List<string> a)
    {
        if (a.Count == 0) throw new Exception("usage: waitfor <window> [seconds]");
        int secs = a.Count > 1 ? Int(a[1], "seconds") : 15;
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < secs * 1000)
        {
            IntPtr h = TryFind(a[0]);
            if (h != IntPtr.Zero) return "found \"" + Title(h) + "\" after " + sw.ElapsedMilliseconds + " ms";
            Thread.Sleep(250);
        }
        throw new Exception("no window matches \"" + a[0] + "\" after " + secs + " s");
    }

    // ------------------------------------------------------- ui automation

    static readonly HashSet<string> Interactive = new HashSet<string>(new string[] {
        "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem", "RadioButton",
        "Slider", "Spinner", "TabItem", "TreeItem", "SplitButton", "Document" });

    static string Snap(List<string> a)
    {
        int max = Int(Opt(a, "--max", "400"), "--max");
        IntPtr h = a.Count > 0 ? Find(string.Join(" ", a.ToArray())) : Native.GetForegroundWindow();
        if (h == IntPtr.Zero) throw new Exception("no foreground window");
        AutomationElement root = AutomationElement.FromHandle(h);
        Dictionary<string, Ref> fresh = new Dictionary<string, Ref>();
        StringBuilder sb = new StringBuilder();
        Rectangle wr = WinRect(h);
        sb.Append("window ").Append(Proc(h)).Append(" \"").Append(Title(h)).Append("\" ")
          .Append(wr.X).Append(',').Append(wr.Y).Append(' ').Append(wr.Width).Append('x').Append(wr.Height).Append('\n');
        int n = 0;
        Walk(root, 0, fresh, sb, ref n, max);
        lock (stateLock) refs = fresh;
        if (n == 0) sb.Append("no elements: this window draws its own interface; use shot --grid and @x,y targets\n");
        if (n >= max) sb.Append("stopped at " + max + " elements; pass --max to see more\n");
        return sb.ToString().TrimEnd();
    }

    static void Walk(AutomationElement el, int depth, Dictionary<string, Ref> into, StringBuilder sb, ref int n, int max)
    {
        if (n >= max || depth > 40) return;
        string type, name;
        System.Windows.Rect b;
        bool off;
        try
        {
            AutomationElement.AutomationElementInformation c = el.Current;
            type = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
            name = c.Name ?? "";
            b = c.BoundingRectangle;
            off = c.IsOffscreen;
        }
        catch { return; }
        bool usable = !b.IsEmpty && !double.IsInfinity(b.Width) && !double.IsInfinity(b.Height) && b.Width >= 1 && b.Height >= 1;
        if (off && depth > 0) return;
        bool show = depth > 0 && usable && (name != "" || Interactive.Contains(type));
        if (show)
        {
            n++;
            string id = "e" + n;
            Ref r = new Ref();
            r.El = el;
            r.Rect = new Rectangle((int)b.X, (int)b.Y, (int)b.Width, (int)b.Height);
            into[id] = r;
            if (name.Length > 80) name = name.Substring(0, 77) + "...";
            sb.Append(' ', Math.Min(depth, 12) * 2).Append(id).Append(' ').Append(type);
            if (name != "") sb.Append(" \"").Append(name.Replace("\r", " ").Replace("\n", " ")).Append('"');
            sb.Append(' ').Append(r.Rect.X).Append(',').Append(r.Rect.Y).Append(' ').Append(r.Rect.Width).Append('x').Append(r.Rect.Height).Append('\n');
        }
        AutomationElement child;
        try { child = TreeWalker.ControlViewWalker.GetFirstChild(el); } catch { return; }
        while (child != null && n < max)
        {
            Walk(child, depth + (show || depth == 0 ? 1 : 0), into, sb, ref n, max);
            try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { return; }
        }
    }

    static Ref GetRef(string id)
    {
        Ref r;
        lock (stateLock) if (refs.TryGetValue(id, out r)) return r;
        throw new Exception("unknown ref " + id + "; refs come from the last snap, run snap again");
    }

    static string Invoke(string id)
    {
        AutomationElement el = GetRef(id.Trim()).El;
        object p;
        try
        {
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoked"; }
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggled to " + ((TogglePattern)p).Current.ToggleState; }
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "selected"; }
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
            {
                ExpandCollapsePattern e = (ExpandCollapsePattern)p;
                if (e.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) { e.Expand(); return "expanded"; }
                e.Collapse();
                return "collapsed";
            }
        }
        catch (ElementNotAvailableException) { throw new Exception(id + " is gone; run snap again"); }
        throw new Exception(id + " has no invoke, toggle, select or expand action; use click " + id);
    }

    static string SetValue(string rest)
    {
        int i = rest.IndexOf(' ');
        if (i < 0) throw new Exception("usage: set <ref> <text>");
        string id = rest.Substring(0, i);
        AutomationElement el = GetRef(id).El;
        object p;
        if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) throw new Exception(id + " takes no value; click it and use type");
        ((ValuePattern)p).SetValue(rest.Substring(i + 1));
        return "set";
    }

    // --------------------------------------------------------------- mouse

    static Point Target(string s)
    {
        s = s.Trim();
        if (s.Length > 1 && s[0] == 'e' && char.IsDigit(s[1]))
        {
            Ref r = GetRef(s);
            try
            {
                System.Windows.Rect b = r.El.Current.BoundingRectangle;
                if (!b.IsEmpty && !double.IsInfinity(b.Width)) return new Point((int)(b.X + b.Width / 2), (int)(b.Y + b.Height / 2));
            }
            catch { }
            return new Point(r.Rect.X + r.Rect.Width / 2, r.Rect.Y + r.Rect.Height / 2);
        }
        bool image = s.StartsWith("@");
        string[] p = (image ? s.Substring(1) : s).Split(',');
        if (p.Length != 2) throw new Exception("bad target \"" + s + "\"; use a ref (e12), an image pixel (@x,y) or a screen pixel (x,y)");
        int x = Int(p[0], "x"), y = Int(p[1], "y");
        if (image)
        {
            lock (stateLock) return new Point(shotX + (int)Math.Round(x / shotScale), shotY + (int)Math.Round(y / shotScale));
        }
        return new Point(x, y);
    }

    static void MoveTo(Point p)
    {
        Rectangle v = VirtualScreen();
        if (!v.Contains(p)) throw new Exception("target " + p.X + "," + p.Y + " is outside the screen " + v.Width + "x" + v.Height);
        Native.INPUT[] i = new Native.INPUT[1];
        i[0].type = 0;
        i[0].mi.dx = (int)Math.Round((p.X - v.X) * 65535.0 / Math.Max(1, v.Width - 1));
        i[0].mi.dy = (int)Math.Round((p.Y - v.Y) * 65535.0 / Math.Max(1, v.Height - 1));
        i[0].mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
        Send(i);
        Native.SetCursorPos(p.X, p.Y);
    }

    static void Button(uint flag)
    {
        Native.INPUT[] i = new Native.INPUT[1];
        i[0].type = 0;
        i[0].mi.dwFlags = flag;
        Send(i);
    }

    static void Buttons(List<string> a, out uint down, out uint up)
    {
        down = 0x0002; up = 0x0004;
        if (Flag(a, "--right")) { down = 0x0008; up = 0x0010; }
        if (Flag(a, "--middle")) { down = 0x0020; up = 0x0040; }
    }

    static string Click(List<string> a)
    {
        uint down, up;
        Buttons(a, out down, out up);
        bool twice = Flag(a, "--double");
        if (a.Count != 1) throw new Exception("usage: click <target> [--right|--middle] [--double]");
        Point p = Target(a[0]);
        MoveTo(p);
        Thread.Sleep(40);
        for (int k = 0; k < (twice ? 2 : 1); k++)
        {
            Button(down);
            Thread.Sleep(30);
            Button(up);
            Thread.Sleep(60);
        }
        return "clicked " + p.X + "," + p.Y;
    }

    static string Drag(List<string> a)
    {
        uint down, up;
        Buttons(a, out down, out up);
        if (a.Count < 2) throw new Exception("usage: drag <target> <target>.. [--right|--middle]");
        List<Point> pts = new List<Point>();
        foreach (string s in a) pts.Add(Target(s));
        MoveTo(pts[0]);
        Thread.Sleep(60);
        Button(down);
        try
        {
            Thread.Sleep(80);
            for (int k = 1; k < pts.Count; k++)
            {
                Point from = pts[k - 1], to = pts[k];
                int steps = Math.Max(8, Math.Min(40, (int)(Math.Sqrt(Math.Pow(to.X - from.X, 2) + Math.Pow(to.Y - from.Y, 2)) / 25)));
                for (int s = 1; s <= steps; s++)
                {
                    MoveTo(new Point(from.X + (to.X - from.X) * s / steps, from.Y + (to.Y - from.Y) * s / steps));
                    Thread.Sleep(12);
                }
            }
            Thread.Sleep(80);
        }
        finally { Button(up); }
        Point end = pts[pts.Count - 1];
        return "dragged to " + end.X + "," + end.Y;
    }

    static string Scroll(List<string> a)
    {
        if (a.Count != 2) throw new Exception("usage: scroll <target> <notches>");
        MoveTo(Target(a[0]));
        Thread.Sleep(40);
        int notches = Int(a[1], "notches");
        for (int k = 0; k < Math.Abs(notches); k++)
        {
            Native.INPUT[] i = new Native.INPUT[1];
            i[0].type = 0;
            i[0].mi.dwFlags = 0x0800;
            i[0].mi.mouseData = unchecked((uint)(notches > 0 ? 120 : -120));
            Send(i);
            Thread.Sleep(15);
        }
        return "";
    }

    // ------------------------------------------------------------ keyboard

    static readonly Dictionary<string, ushort> Keys = MakeKeys();

    static Dictionary<string, ushort> MakeKeys()
    {
        Dictionary<string, ushort> k = new Dictionary<string, ushort>();
        k["CTRL"] = 0x11; k["CONTROL"] = 0x11; k["SHIFT"] = 0x10; k["ALT"] = 0x12; k["WIN"] = 0x5B;
        k["ENTER"] = 0x0D; k["RETURN"] = 0x0D; k["ESC"] = 0x1B; k["ESCAPE"] = 0x1B; k["TAB"] = 0x09; k["SPACE"] = 0x20;
        k["BACKSPACE"] = 0x08; k["DELETE"] = 0x2E; k["DEL"] = 0x2E; k["INSERT"] = 0x2D; k["HOME"] = 0x24; k["END"] = 0x23;
        k["PGUP"] = 0x21; k["PAGEUP"] = 0x21; k["PGDN"] = 0x22; k["PAGEDOWN"] = 0x22;
        k["UP"] = 0x26; k["DOWN"] = 0x28; k["LEFT"] = 0x25; k["RIGHT"] = 0x27;
        k["PLUS"] = 0xBB; k["MINUS"] = 0xBD; k["COMMA"] = 0xBC; k["PERIOD"] = 0xBE;
        k["CAPSLOCK"] = 0x14; k["PRINTSCREEN"] = 0x2C; k["APPS"] = 0x5D;
        for (int i = 1; i <= 24; i++) k["F" + i] = (ushort)(0x70 + i - 1);
        for (int i = 0; i <= 9; i++) k["NUMPAD" + i] = (ushort)(0x60 + i);
        return k;
    }

    static readonly HashSet<ushort> Extended = new HashSet<ushort>(new ushort[] {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5D, 0x2C });

    static ushort Vk(string name)
    {
        string k = name.Trim();
        ushort v;
        if (Keys.TryGetValue(k.ToUpperInvariant(), out v)) return v;
        if (k.Length == 1)
        {
            char c = char.ToUpperInvariant(k[0]);
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
            short r = Native.VkKeyScan(k[0]);
            if (r != -1) return (ushort)(r & 0xFF);
        }
        throw new Exception("unknown key \"" + name + "\"; examples: ENTER, ESC, TAB, F5, a, ctrl+s");
    }

    static void Key(ushort vk, bool up)
    {
        Native.INPUT[] i = new Native.INPUT[1];
        i[0].type = 1;
        i[0].ki.wVk = vk;
        i[0].ki.wScan = (ushort)Native.MapVirtualKey(vk, 0);
        i[0].ki.dwFlags = (up ? 0x0002u : 0u) | (Extended.Contains(vk) ? 0x0001u : 0u);
        Send(i);
    }

    static void Combo(string combo)
    {
        List<ushort> keys = new List<ushort>();
        foreach (string part in combo.Split('+')) keys.Add(Vk(part));
        int pressed = 0;
        try
        {
            foreach (ushort k in keys) { Key(k, false); pressed++; Thread.Sleep(15); }
            Thread.Sleep(25);
        }
        finally
        {
            for (int i = pressed - 1; i >= 0; i--) { Key(keys[i], true); Thread.Sleep(15); }
        }
        Thread.Sleep(40);
    }

    static void TypeText(string text)
    {
        foreach (char c in text)
        {
            Native.INPUT[] i = new Native.INPUT[2];
            i[0].type = 1; i[0].ki.wScan = c; i[0].ki.dwFlags = 0x0004;
            i[1].type = 1; i[1].ki.wScan = c; i[1].ki.dwFlags = 0x0004 | 0x0002;
            Send(i);
            Thread.Sleep(6);
        }
    }

    static void Paste(string text)
    {
        Exception err = null;
        Thread t = new Thread(delegate()
        {
            try { System.Windows.Forms.Clipboard.SetText(text == "" ? " " : text); } catch (Exception e) { err = e; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (err != null) throw new Exception("clipboard is busy: " + err.Message);
        Thread.Sleep(60);
        Combo("ctrl+v");
    }

    // ---------------------------------------------------------- screenshot

    static string Shot(List<string> a)
    {
        int max = Int(Opt(a, "--max", "1280"), "--max");
        int q = Int(Opt(a, "--q", "70"), "--q");
        int grid = Int(Opt(a, "--grid", "0"), "--grid");
        bool marks = Flag(a, "--marks");
        bool diff = Flag(a, "--diff");

        Rectangle v = VirtualScreen();
        Rectangle r;
        string what = a.Count > 0 ? a[0].ToLowerInvariant() : "window";
        if (what == "screen") r = v;
        else if (what == "window")
        {
            IntPtr h = a.Count > 1 ? Find(string.Join(" ", a.GetRange(1, a.Count - 1).ToArray())) : Native.GetForegroundWindow();
            if (h == IntPtr.Zero) throw new Exception("no foreground window; use: shot screen");
            if (Native.IsIconic(h)) throw new Exception("\"" + Title(h) + "\" is minimized; run: focus " + Proc(h));
            r = WinRect(h);
        }
        else if (what == "region")
        {
            string[] p = a.Count > 1 ? a[1].Split(',') : new string[0];
            if (p.Length != 4) throw new Exception("usage: shot region x,y,w,h");
            r = new Rectangle(Int(p[0], "x"), Int(p[1], "y"), Int(p[2], "w"), Int(p[3], "h"));
        }
        else if (what.Length > 1 && what[0] == 'e' && char.IsDigit(what[1])) r = GetRef(what).Rect;
        else throw new Exception("usage: shot [screen|window [name]|region x,y,w,h|<ref>]");
        r.Intersect(v);
        if (r.Width < 1 || r.Height < 1) throw new Exception("nothing to capture: the target is off screen");

        Bitmap full = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);

        Rectangle crop = new Rectangle(0, 0, r.Width, r.Height);
        lock (stateLock)
        {
            if (diff && prevFull != null && prevRect == r)
            {
                Rectangle changed = Changed(prevFull, full);
                if (changed.IsEmpty) { prevFull.Dispose(); prevFull = full; return "nochange"; }
                changed.Inflate(24, 24);
                changed.Intersect(crop);
                crop = changed;
            }
            if (prevFull != null) prevFull.Dispose();
            prevFull = (Bitmap)full.Clone();
            prevRect = r;
        }

        double scale = Math.Min(1.0, max / (double)Math.Max(crop.Width, crop.Height));
        int ow = Math.Max(1, (int)Math.Round(crop.Width * scale)), oh = Math.Max(1, (int)Math.Round(crop.Height * scale));
        int ox = r.X + crop.X, oy = r.Y + crop.Y;
        string name;
        long bytes;
        using (Bitmap img = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
        {
            using (Graphics g = Graphics.FromImage(img))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(full, new Rectangle(0, 0, ow, oh), crop, GraphicsUnit.Pixel);
                Overlay(g, ox, oy, scale, ow, oh, marks, grid);
            }
            name = "shot-" + Interlocked.Increment(ref fileSeq) + "-" + DateTime.Now.ToString("HHmmss") + ".jpg";
            string path = Path.Combine(OutDir, name);
            ImageCodecInfo jpg = null;
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) jpg = c;
            EncoderParameters ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(10, Math.Min(95, q)));
            img.Save(path, jpg, ep);
            bytes = new FileInfo(path).Length;
        }
        full.Dispose();
        lock (stateLock) { shotX = ox; shotY = oy; shotScale = scale; }
        return name + " " + ow + "x" + oh + " of screen " + ox + "," + oy + " " + crop.Width + "x" + crop.Height
            + " scale " + scale.ToString("0.###", CultureInfo.InvariantCulture) + " " + (bytes / 1024) + "KB; target its pixels as @x,y";
    }

    static void Overlay(Graphics g, int ox, int oy, double scale, int ow, int oh, bool marks, int grid)
    {
        using (Font font = new Font("Consolas", 9f, FontStyle.Bold))
        {
            if (grid > 0)
            {
                using (Pen pen = new Pen(Color.FromArgb(110, 255, 0, 255)))
                {
                    for (int x = grid; x < ow; x += grid) { g.DrawLine(pen, x, 0, x, oh); Label(g, font, x.ToString(), x + 2, 2, Color.Magenta); }
                    for (int y = grid; y < oh; y += grid) { g.DrawLine(pen, 0, y, ow, y); Label(g, font, y.ToString(), 2, y + 2, Color.Magenta); }
                }
            }
            if (marks)
            {
                Dictionary<string, Ref> snapshot;
                lock (stateLock) snapshot = refs;
                using (Pen pen = new Pen(Color.Lime))
                {
                    foreach (KeyValuePair<string, Ref> kv in snapshot)
                    {
                        Rectangle b = kv.Value.Rect;
                        int x = (int)((b.X - ox) * scale), y = (int)((b.Y - oy) * scale);
                        int w = (int)(b.Width * scale), h = (int)(b.Height * scale);
                        if (x + w < 0 || y + h < 0 || x > ow || y > oh) continue;
                        g.DrawRectangle(pen, x, y, w, h);
                        Label(g, font, kv.Key, x, y, Color.Lime);
                    }
                }
            }
            Native.POINT c;
            Native.GetCursorPos(out c);
            int cx = (int)((c.X - ox) * scale), cy = (int)((c.Y - oy) * scale);
            if (cx >= 0 && cy >= 0 && cx < ow && cy < oh)
            {
                using (Pen pen = new Pen(Color.Red, 2f))
                {
                    g.DrawLine(pen, cx - 8, cy, cx + 8, cy);
                    g.DrawLine(pen, cx, cy - 8, cx, cy + 8);
                }
            }
        }
    }

    static void Label(Graphics g, Font font, string text, int x, int y, Color color)
    {
        SizeF s = g.MeasureString(text, font);
        using (SolidBrush bg = new SolidBrush(Color.FromArgb(200, 0, 0, 0))) g.FillRectangle(bg, x, y, s.Width, s.Height);
        using (SolidBrush fg = new SolidBrush(color)) g.DrawString(text, font, fg, x, y);
    }

    // Bounding box of the pixels that differ, sampled every 4 pixels.
    static Rectangle Changed(Bitmap a, Bitmap b)
    {
        int w = a.Width, h = a.Height;
        BitmapData da = a.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        BitmapData db = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        int x0 = w, y0 = h, x1 = -1, y1 = -1;
        try
        {
            byte[] ra = new byte[da.Stride], rb = new byte[db.Stride];
            for (int y = 0; y < h; y += 4)
            {
                Marshal.Copy(new IntPtr(da.Scan0.ToInt64() + (long)y * da.Stride), ra, 0, da.Stride);
                Marshal.Copy(new IntPtr(db.Scan0.ToInt64() + (long)y * db.Stride), rb, 0, db.Stride);
                for (int x = 0; x < w; x += 4)
                {
                    int i = x * 3;
                    int d = Math.Abs(ra[i] - rb[i]) + Math.Abs(ra[i + 1] - rb[i + 1]) + Math.Abs(ra[i + 2] - rb[i + 2]);
                    if (d > 30)
                    {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }
        }
        finally { a.UnlockBits(da); b.UnlockBits(db); }
        if (x1 < 0) return Rectangle.Empty;
        return Rectangle.FromLTRB(x0, y0, Math.Min(w, x1 + 4), Math.Min(h, y1 + 4));
    }

    // ------------------------------------------------------------- process

    static string Run(string rest)
    {
        if (rest == "") throw new Exception("usage: exec [--wait [seconds]] <command line>");
        if (!rest.StartsWith("--wait"))
        {
            ProcessStartInfo si = new ProcessStartInfo("cmd.exe", "/s /c \"start \"\" " + rest + "\"");
            si.CreateNoWindow = true;
            si.UseShellExecute = false;
            Process.Start(si);
            return "started";
        }
        string cmd = rest.Substring(6).Trim();
        int secs = 120;
        int sp = cmd.IndexOf(' ');
        int parsed;
        if (sp > 0 && int.TryParse(cmd.Substring(0, sp), out parsed)) { secs = parsed; cmd = cmd.Substring(sp + 1).Trim(); }
        if (cmd == "") throw new Exception("usage: exec --wait [seconds] <command line>");
        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/s /c \"" + cmd + " 2>&1\"");
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.StandardOutputEncoding = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage);
        Process p = Process.Start(psi);
        StringBuilder sb = new StringBuilder();
        Thread reader = new Thread(delegate()
        {
            try
            {
                string line;
                while ((line = p.StandardOutput.ReadLine()) != null) lock (sb) sb.Append(line).Append('\n');
            }
            catch { }
        });
        reader.IsBackground = true;
        reader.Start();
        bool done = p.WaitForExit(secs * 1000);
        if (!done) { try { p.Kill(); } catch { } }
        reader.Join(2000);
        string output;
        lock (sb) output = sb.ToString().TrimEnd();
        if (output.Length > 6000) output = "...(" + (output.Length - 6000) + " chars cut)\n" + output.Substring(output.Length - 6000);
        if (!done) throw new Exception("still running after " + secs + " s, killed\n" + output);
        if (p.ExitCode != 0) throw new Exception("exit code " + p.ExitCode + "\n" + output);
        return output == "" ? "exit code 0" : output;
    }

    static string Rec(List<string> a)
    {
        string sub = a.Count > 0 ? a[0].ToLowerInvariant() : "";
        lock (stateLock)
        {
            if (sub == "start")
            {
                if (rec != null && !rec.HasExited) throw new Exception("already recording; run: rec stop");
                int fps = a.Count > 1 ? Int(a[1], "fps") : 15;
                recFile = "rec-" + Interlocked.Increment(ref fileSeq) + "-" + DateTime.Now.ToString("HHmmss") + ".mp4";
                ProcessStartInfo si = new ProcessStartInfo("ffmpeg.exe",
                    "-hide_banner -loglevel error -y -f gdigrab -framerate " + fps + " -draw_mouse 1 -i desktop "
                    + "-vf \"scale='min(1920,iw)':-2\" -c:v h264_nvenc -b:v 3M -pix_fmt yuv420p \"" + Path.Combine(OutDir, recFile) + "\"");
                si.CreateNoWindow = true;
                si.UseShellExecute = false;
                si.RedirectStandardInput = true;
                try { rec = Process.Start(si); }
                catch (Exception e) { throw new Exception("ffmpeg did not start: " + e.Message + "; install it with: winget install ffmpeg"); }
                Thread.Sleep(700);
                if (rec.HasExited) throw new Exception("ffmpeg exited at once with code " + rec.ExitCode);
                return "recording at " + fps + " fps";
            }
            if (sub == "stop")
            {
                if (rec == null || rec.HasExited) throw new Exception("not recording; run: rec start");
                rec.StandardInput.Write("q");
                rec.StandardInput.Flush();
                if (!rec.WaitForExit(10000)) { try { rec.Kill(); } catch { } }
                rec = null;
                string path = Path.Combine(OutDir, recFile);
                if (!File.Exists(path)) throw new Exception("ffmpeg wrote no file");
                return recFile + " " + (new FileInfo(path).Length / 1024) + "KB";
            }
        }
        throw new Exception("usage: rec start [fps] | rec stop");
    }

    // ----------------------------------------------------------------- log

    static string Json(string s)
    {
        StringBuilder sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c < 0x20) sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static void Log(string cmd, bool ok, long ms, string res)
    {
        if (cmd.StartsWith("log")) return;
        if (res.Length > 300) res = res.Substring(0, 300) + "...";
        string line = "{\"t\":\"" + DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fff") + "\",\"cmd\":\"" + Json(cmd)
            + "\",\"ok\":" + (ok ? "true" : "false") + ",\"ms\":" + ms + ",\"out\":\"" + Json(res) + "\"}";
        lock (logLock)
        {
            try { File.AppendAllText(Path.Combine(LogDir, DateTime.Now.ToString("yyyy-MM-dd") + ".jsonl"), line + "\n", new UTF8Encoding(false)); } catch { }
        }
    }

    static string Tail(int n)
    {
        string path = Path.Combine(LogDir, DateTime.Now.ToString("yyyy-MM-dd") + ".jsonl");
        if (!File.Exists(path)) return "no commands today";
        string[] all;
        lock (logLock) all = File.ReadAllLines(path, Encoding.UTF8);
        int from = Math.Max(0, all.Length - Math.Max(1, n));
        return string.Join("\n", all, from, all.Length - from);
    }
}
