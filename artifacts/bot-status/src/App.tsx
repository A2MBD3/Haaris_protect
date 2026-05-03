import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Stats {
  totalGroups: number; activeGroups: number; bannedGroups: number;
  totalKeys: number; activeKeys: number; globalBans: number; globalMutes: number; superAdmins: number;
}
interface BotInfo { status: string; botName: string; uptime: number; startedAt: string; stats: Stats; }
interface Group {
  groupId: number; title: string; banned: boolean; authorized: boolean;
  authorizedKey: string | null; authorizedExpiresAt: string | null; settings: Record<string, unknown>;
}
interface AuthKey { key: string; expiresAt: string | null; maxUses: number; usedCount: number; createdBy: number; createdAt: string; }
interface SuperAdmin { id: number; hardcoded: boolean; displayName?: string; }
interface GlobalEntry { userId: number; until: string | null; reason: string; displayName?: string; }
interface LogEntry { id: number; ts: number; category: string; text: string; }
interface FilterItem { word: string; reply: string; }
interface NoteItem { name: string; content: string; }

interface AppSettings {
  watermarkText: string;
  watermarkHandle: string;
  watermarkLink: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  watermarkText: "Bot developer Abdullah Al Mamun",
  watermarkHandle: "@A2MBD3",
  watermarkLink: "https://info-abdullah.netlify.app",
};

type Page = "dashboard" | "groups" | "keys" | "admins" | "security" | "broadcast" | "filters" | "logs";

// ── Settings hook ─────────────────────────────────────────────────────────────

function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("admin_settings") || "{}") }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  });
  const save = useCallback((s: AppSettings) => {
    localStorage.setItem("admin_settings", JSON.stringify(s));
    setSettings(s);
  }, []);
  return { settings, save };
}

// ── API hook ──────────────────────────────────────────────────────────────────

function useApi(token: string) {
  const BASE = (import.meta.env.BASE_URL as string) || "/";
  const prefix = `${BASE}api/admin`;
  const request = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await fetch(`${prefix}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...((options.headers as Record<string, string>) || {}) },
    });
    if (!res.ok) { const msg = await res.text().catch(() => `HTTP ${res.status}`); throw new Error(msg || `HTTP ${res.status}`); }
    return res.json();
  }, [token, prefix]);
  return {
    get: (p: string) => request(p),
    post: (p: string, body?: unknown) => request(p, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
    put: (p: string, body: unknown) => request(p, { method: "PUT", body: JSON.stringify(body) }),
    del: (p: string) => request(p, { method: "DELETE" }),
  };
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface ToastState { msg: string; type: "ok" | "err"; }
function ToastEl({ msg, type, onDone }: { msg: string; type: "ok" | "err"; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-2xl text-sm font-medium text-white max-w-[88vw] text-center transition-all ${type === "ok" ? "bg-emerald-600" : "bg-red-600"}`}>
      {type === "ok" ? "✓ " : "✕ "}{msg}
    </div>
  );
}
function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const show = useCallback((msg: string, type: "ok" | "err" = "ok") => setToast({ msg, type }), []);
  const el = toast ? <ToastEl msg={toast.msg} type={toast.type} onDone={() => setToast(null)} /> : null;
  return { show, el };
}

// ── Utility components ────────────────────────────────────────────────────────

function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  const s = size === "sm" ? "w-3.5 h-3.5" : "w-5 h-5";
  return <div className={`${s} border-2 border-primary border-t-transparent rounded-full animate-spin flex-shrink-0`} />;
}

type BadgeColor = "blue" | "green" | "red" | "yellow" | "gray" | "purple" | "pink";
function Badge({ children, color = "blue" }: { children: ReactNode; color?: BadgeColor }) {
  const cls: Record<BadgeColor, string> = {
    blue:   "bg-blue-500/20 text-blue-400 border-blue-500/30",
    green:  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    red:    "bg-red-500/20 text-red-400 border-red-500/30",
    yellow: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    gray:   "bg-gray-500/20 text-gray-400 border-gray-500/30",
    purple: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    pink:   "bg-pink-500/20 text-pink-400 border-pink-500/30",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cls[color]}`}>{children}</span>;
}

function StatCard({ label, value, sub, icon }: { label: string; value: number | string; sub?: string; icon: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-xl flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-foreground tabular-nums leading-tight">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input {...rest} className={`w-full bg-input border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-shadow ${className}`} />
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", loading, disabled, className = "" }: {
  children: ReactNode; onClick?: () => void;
  variant?: "primary" | "ghost" | "danger"; size?: "sm" | "md"; loading?: boolean; disabled?: boolean; className?: string;
}) {
  const v = { primary: "bg-primary hover:bg-blue-600 text-white", ghost: "bg-transparent hover:bg-accent text-muted-foreground hover:text-foreground border border-border", danger: "bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30" }[variant];
  const s = size === "sm" ? "px-3 py-1.5 text-xs gap-1.5" : "px-4 py-2.5 text-sm gap-2";
  return (
    <button onClick={onClick} disabled={loading || disabled} className={`${v} ${s} rounded-lg font-medium transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${className}`}>
      {loading && <Spinner size="sm" />}{children}
    </button>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

function SectionHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-1">
      <div>
        <h1 className="text-xl font-bold text-foreground">{title}</h1>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

// ── Settings Modal ────────────────────────────────────────────────────────────

function SettingsModal({ settings, onSave, onClose, token }: {
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  onClose: () => void;
  token: string;
}) {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [pwVisible, setPwVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => { onSave(form); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto z-10">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <span className="text-lg">⚙️</span>
            <div>
              <p className="text-sm font-bold text-foreground">Settings</p>
              <p className="text-xs text-muted-foreground">Panel & watermark preferences</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Password section */}
          <div className="space-y-2">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">🔐 Admin Password</p>
            <div className="bg-muted/30 border border-border rounded-xl p-3 space-y-2">
              <p className="text-xs text-muted-foreground">Your current login password. Share with trusted admins only.</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-input border border-border rounded-lg px-3 py-2 font-mono text-xs text-foreground select-all overflow-hidden">
                  {pwVisible ? token : "•".repeat(Math.min(token.length, 24))}
                </div>
                <button onClick={() => setPwVisible(v => !v)} className="text-xs px-2.5 py-1.5 rounded-lg border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0">
                  {pwVisible ? "Hide" : "Show"}
                </button>
                <button onClick={copy} className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors flex-shrink-0 ${copied ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">To change this password, use <code className="bg-muted px-1 rounded">/resetpass</code> in Telegram (super admins only). Use <code className="bg-muted px-1 rounded">/resetpassdefault</code> to revert.</p>
            </div>
          </div>

          {/* Watermark section */}
          <div className="space-y-3">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest">🏷️ Dashboard Watermark</p>
            <p className="text-xs text-muted-foreground">Shown at the bottom of the dashboard. Click the handle to open the link.</p>
            <div className="space-y-2.5">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Developer Name</label>
                <Input placeholder="e.g. Bot developer Abdullah Al Mamun" value={form.watermarkText} onChange={e => setForm(f => ({ ...f, watermarkText: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Handle / Username</label>
                <Input placeholder="e.g. @A2MBD3" value={form.watermarkHandle} onChange={e => setForm(f => ({ ...f, watermarkHandle: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-medium">Profile Link (URL)</label>
                <Input placeholder="e.g. https://info-abdullah.netlify.app" value={form.watermarkLink} onChange={e => setForm(f => ({ ...f, watermarkLink: e.target.value }))} />
              </div>
            </div>
            {/* Preview */}
            <div className="bg-muted/20 border border-border/50 rounded-xl p-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Preview</p>
              <p className="text-xs text-muted-foreground">{form.watermarkText || "—"}</p>
              <a href={form.watermarkLink || "#"} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline font-medium">{form.watermarkHandle || "—"}</a>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Btn variant="ghost" onClick={onClose} className="flex-1">Cancel</Btn>
            <Btn onClick={handleSave} className="flex-1">Save Settings</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Login ─────────────────────────────────────────────────────────────────────

function Login({ onLogin }: { onLogin: (t: string) => void }) {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!token.trim()) { setError("Please enter your admin password."); return; }
    setLoading(true); setError("");
    try {
      const BASE = (import.meta.env.BASE_URL as string) || "/";
      const res = await fetch(`${BASE}api/admin/info`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) { localStorage.setItem("admin_token", token); onLogin(token); }
      else setError("Wrong password. Send /adminpanel to the bot in Telegram to get yours.");
    } catch { setError("Cannot reach the server. Is the bot running?"); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-3">
          <div className="w-20 h-20 bg-primary/10 border border-primary/20 rounded-2xl flex items-center justify-center text-4xl mx-auto shadow-lg">🤖</div>
          <h1 className="text-2xl font-bold text-foreground">Haaris Admin</h1>
          <p className="text-sm text-muted-foreground">Sign in to manage your bot</p>
        </div>
        <div className="bg-card border border-border rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Password</label>
            <div className="relative">
              <Input type={show ? "text" : "password"} placeholder="Paste your admin password…" value={token}
                onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} className="pr-14" />
              <button onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors">
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Send <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] text-primary">/adminpanel</code> to the bot in Telegram</p>
          </div>
          {error && <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs px-3 py-2.5 rounded-lg">{error}</div>}
          <Btn onClick={submit} loading={loading} className="w-full">Sign In →</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

const NAV_ITEMS: { id: Page; label: string; icon: string; navOnly?: boolean }[] = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "groups",    label: "Groups",    icon: "🏢" },
  { id: "filters",   label: "Filters",   icon: "📋" },
  { id: "keys",      label: "Keys",      icon: "🔑" },
  { id: "admins",    label: "Admins",    icon: "👑" },
  { id: "security",  label: "Security",  icon: "🛡️" },
  { id: "broadcast", label: "Broadcast", icon: "📢" },
  { id: "logs",      label: "Logs",      icon: "🪵", navOnly: true },
];

const BOTTOM_NAV = NAV_ITEMS.filter(n => n.id !== "logs");

const PAGE_LABELS: Record<Page, { icon: string; label: string }> = {
  dashboard: { icon: "📊", label: "Dashboard" },
  groups:    { icon: "🏢", label: "Groups" },
  filters:   { icon: "📋", label: "Filters & Content" },
  keys:      { icon: "🔑", label: "Auth Keys" },
  admins:    { icon: "👑", label: "Super Admins" },
  security:  { icon: "🛡️", label: "Security" },
  broadcast: { icon: "📢", label: "Broadcast" },
  logs:      { icon: "🪵", label: "Activity Logs" },
};

function Layout({ page, onPage, onLogout, onSettings, children }: {
  page: Page; onPage: (p: Page) => void; onLogout: () => void; onSettings: () => void; children: ReactNode;
}) {
  const pl = PAGE_LABELS[page];
  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar — desktop */}
      <aside className="hidden md:flex flex-col w-56 lg:w-60 bg-card border-r border-border fixed h-full z-40">
        {/* Logo + Settings icon */}
        <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
          <button
            onClick={onSettings}
            title="Settings"
            className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-lg hover:bg-primary/20 transition-colors flex-shrink-0"
          >
            ⚙️
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground leading-tight">Haaris Admin</p>
            <p className="text-[11px] text-muted-foreground leading-tight">Control Panel</p>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(n => (
            <button key={n.id} onClick={() => onPage(n.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
                page === n.id ? "bg-primary/15 text-primary font-semibold" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <span className="text-base">{n.icon}</span>
              {n.label}
              {n.id === "logs" && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-border">
          <button onClick={onLogout} className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors">
            <span>🚪</span> Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 md:ml-56 lg:ml-60 min-h-screen flex flex-col">
        {/* Mobile top bar */}
        <header className="md:hidden sticky top-0 z-30 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between px-3 py-2.5">
          <div className="flex items-center gap-2">
            <button onClick={onSettings} title="Settings"
              className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-base hover:bg-primary/20 transition-colors flex-shrink-0">
              ⚙️
            </button>
            <span className="text-base">{pl.icon}</span>
            <span className="text-sm font-semibold text-foreground">{pl.label}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onPage("logs")}
              className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg transition-colors ${page === "logs" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
              <span>🪵</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            </button>
            <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Out</button>
          </div>
        </header>

        {/* Desktop page header bar */}
        <div className="hidden md:flex items-center justify-between px-6 py-3 border-b border-border/60 bg-card/50 backdrop-blur sticky top-0 z-20">
          <div className="flex items-center gap-2.5">
            <span className="text-base opacity-70">{pl.icon}</span>
            <span className="text-sm font-semibold text-foreground">{pl.label}</span>
          </div>
          <button onClick={() => onPage("logs")}
            className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              page === "logs" ? "bg-primary/15 text-primary border-primary/30 font-semibold" : "text-muted-foreground hover:text-foreground hover:bg-accent border-border"
            }`}>
            <span>🪵</span>
            <span>Logs</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 px-4 py-5 md:px-6 md:py-6 max-w-4xl w-full mx-auto pb-24 md:pb-8">
          {children}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur border-t border-border flex z-40 safe-area-pb">
        {BOTTOM_NAV.map(n => (
          <button key={n.id} onClick={() => onPage(n.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 transition-colors ${page === n.id ? "text-primary" : "text-muted-foreground"}`}>
            <span className="text-base leading-none">{n.icon}</span>
            <span className="text-[8px] font-medium leading-none mt-0.5">{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ api, settings }: { api: ReturnType<typeof useApi>; settings: AppSettings }) {
  const [info, setInfo] = useState<BotInfo | null>(null);
  const [uptime, setUptime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.get("/info") as BotInfo; setInfo(d); setUptime(d.uptime); setErr(false); }
    catch { setErr(true); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!info) return;
    const t = setInterval(() => setUptime(u => u + 1), 1000);
    return () => clearInterval(t);
  }, [info?.startedAt]);

  const fmtUptime = (s: number) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    return `${m}m ${sec}s`;
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="Dashboard" sub="Bot overview and live statistics" />

      <div className={`bg-card border rounded-xl p-4 flex items-center gap-4 ${err ? "border-red-500/30" : "border-emerald-500/30"}`}>
        <div className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl flex-shrink-0 ${err ? "bg-red-500/10" : "bg-emerald-500/10"}`}>🤖</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-foreground">@{info?.botName || "haarish_helpbot"}</span>
            {!loading && (err ? <Badge color="red">● Offline</Badge> : <Badge color="green">● Online</Badge>)}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 font-mono">
            {info ? `⏱ ${fmtUptime(uptime)}  ·  since ${new Date(info.startedAt).toLocaleString()}` : "Connecting…"}
          </p>
        </div>
        <button onClick={load} title="Refresh" className="text-muted-foreground hover:text-foreground text-xl transition-colors flex-shrink-0">↻</button>
      </div>

      {loading && <div className="flex justify-center py-10"><Spinner /></div>}
      {err && !loading && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400 text-center">Cannot reach the API server. Is the bot running?</div>}

      {info && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon="🏢" label="Groups" value={info.stats.totalGroups} sub={`${info.stats.activeGroups} active`} />
          <StatCard icon="🔑" label="Auth Keys" value={info.stats.totalKeys} sub={`${info.stats.activeKeys} active`} />
          <StatCard icon="⛔" label="Global Bans" value={info.stats.globalBans} />
          <StatCard icon="👑" label="Super Admins" value={info.stats.superAdmins} />
        </div>
      )}

      {info && (
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Group Breakdown</p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><p className="text-2xl font-bold text-emerald-400">{info.stats.activeGroups}</p><p className="text-xs text-muted-foreground">Active</p></div>
            <div><p className="text-2xl font-bold text-yellow-400">{info.stats.totalGroups - info.stats.activeGroups - info.stats.bannedGroups}</p><p className="text-xs text-muted-foreground">Unauthorized</p></div>
            <div><p className="text-2xl font-bold text-red-400">{info.stats.bannedGroups}</p><p className="text-xs text-muted-foreground">Banned</p></div>
          </div>
        </div>
      )}

      {/* Watermark */}
      {(settings.watermarkText || settings.watermarkHandle) && (
        <div className="pt-2 text-center space-y-0.5">
          {settings.watermarkText && (
            <p className="text-xs text-muted-foreground/60">{settings.watermarkText}</p>
          )}
          {settings.watermarkHandle && (
            <a
              href={settings.watermarkLink || "#"}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary/60 hover:text-primary transition-colors font-medium"
            >
              {settings.watermarkHandle}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────────

const SEL_CLS = "w-full bg-input border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 min-h-[32px]">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2 pt-1">{title}</p>
      {children}
    </div>
  );
}

function GroupSettings({ draft, onChange }: { draft: Record<string, unknown>; onChange: (d: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...draft, [k]: v });
  const num = (k: string, def: number) => Number(draft[k] ?? def);
  const bool = (k: string) => Boolean(draft[k]);
  const str = (k: string, def: string) => String(draft[k] ?? def);

  return (
    <div className="divide-y divide-border/50 text-sm">
      <div className="pb-4 mb-4">
        <SettingsSection title="⚠️ Warnings">
          <SettingsRow label="Warn limit"><Input type="number" min={1} max={20} className="!w-20 !py-1 !text-xs" value={num("warnLimit", 3)} onChange={e => set("warnLimit", parseInt(e.target.value) || 3)} /></SettingsRow>
          <SettingsRow label="Auto-action"><select className={SEL_CLS + " !w-28"} value={str("warnAction", "mute")} onChange={e => set("warnAction", e.target.value)}><option value="mute">Mute</option><option value="ban">Ban</option><option value="kick">Kick</option></select></SettingsRow>
          <SettingsRow label="Duration (sec, 0=perm)"><Input type="number" min={0} className="!w-24 !py-1 !text-xs" value={num("warnDurationSec", 0)} onChange={e => set("warnDurationSec", parseInt(e.target.value) || 0)} /></SettingsRow>
        </SettingsSection>
      </div>
      <div className="py-4 mb-4">
        <SettingsSection title="🌊 Flood Control">
          <SettingsRow label="Enabled"><input type="checkbox" checked={bool("floodEnabled")} onChange={e => set("floodEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" /></SettingsRow>
          <SettingsRow label="Message limit"><Input type="number" min={2} max={50} className="!w-20 !py-1 !text-xs" value={num("floodLimit", 5)} onChange={e => set("floodLimit", parseInt(e.target.value) || 5)} /></SettingsRow>
          <SettingsRow label="Window (sec)"><Input type="number" min={1} max={60} className="!w-20 !py-1 !text-xs" value={num("floodWindowSec", 5)} onChange={e => set("floodWindowSec", parseInt(e.target.value) || 5)} /></SettingsRow>
          <SettingsRow label="Action"><select className={SEL_CLS + " !w-28"} value={str("floodAction", "mute")} onChange={e => set("floodAction", e.target.value)}><option value="mute">Mute</option><option value="ban">Ban</option><option value="kick">Kick</option></select></SettingsRow>
          <SettingsRow label="Action duration (sec)"><Input type="number" min={0} className="!w-24 !py-1 !text-xs" value={num("floodActionDurationSec", 300)} onChange={e => set("floodActionDurationSec", parseInt(e.target.value) || 0)} /></SettingsRow>
        </SettingsSection>
      </div>
      <div className="py-4 mb-4">
        <SettingsSection title="👋 Welcome Message">
          <SettingsRow label="Enabled"><input type="checkbox" checked={bool("welcomeEnabled")} onChange={e => set("welcomeEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" /></SettingsRow>
          <div className="mt-2 space-y-1.5">
            <p className="text-xs text-muted-foreground">HTML ok · placeholders: <code className="bg-muted px-1 rounded text-[10px]">{"{name}"}</code> <code className="bg-muted px-1 rounded text-[10px]">{"{group}"}</code> <code className="bg-muted px-1 rounded text-[10px]">{"{id}"}</code></p>
            <textarea value={str("welcomeMessage", "")} onChange={e => set("welcomeMessage", e.target.value)} rows={3} placeholder="Welcome, {name}! Please read the rules." className="w-full bg-input border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y transition-shadow" />
          </div>
        </SettingsSection>
      </div>
      <div className="py-4 mb-4">
        <SettingsSection title="🛡️ Protection">
          <SettingsRow label="Captcha on join"><input type="checkbox" checked={bool("captchaEnabled")} onChange={e => set("captchaEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" /></SettingsRow>
          <SettingsRow label="Captcha type"><select className={SEL_CLS + " !w-28"} value={str("captchaType", "button")} onChange={e => set("captchaType", e.target.value)}><option value="button">Button click</option><option value="math">Math problem</option></select></SettingsRow>
          <SettingsRow label="Captcha timeout (sec)"><Input type="number" min={30} max={600} className="!w-20 !py-1 !text-xs" value={num("captchaTimeoutSec", 120)} onChange={e => set("captchaTimeoutSec", parseInt(e.target.value) || 120)} /></SettingsRow>
          <SettingsRow label="Anti-bot (kick bots)"><input type="checkbox" checked={bool("antibot")} onChange={e => set("antibot", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" /></SettingsRow>
          <SettingsRow label="Anti-channel"><input type="checkbox" checked={bool("antichannel")} onChange={e => set("antichannel", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" /></SettingsRow>
        </SettingsSection>
      </div>
      <div className="py-4 mb-4">
        <SettingsSection title="🚫 Blacklist">
          <SettingsRow label="Hit threshold"><Input type="number" min={1} max={10} className="!w-20 !py-1 !text-xs" value={num("blacklistThreshold", 3)} onChange={e => set("blacklistThreshold", parseInt(e.target.value) || 3)} /></SettingsRow>
          <SettingsRow label="Action"><select className={SEL_CLS + " !w-28"} value={str("blacklistAction", "mute")} onChange={e => set("blacklistAction", e.target.value)}><option value="mute">Mute</option><option value="ban">Ban</option><option value="kick">Kick</option></select></SettingsRow>
          <SettingsRow label="Duration (sec, 0=perm)"><Input type="number" min={0} className="!w-24 !py-1 !text-xs" value={num("blacklistDurationSec", 0)} onChange={e => set("blacklistDurationSec", parseInt(e.target.value) || 0)} /></SettingsRow>
          <SettingsRow label="Global BL sync"><input type="checkbox" checked={bool("globalBlacklistEnabled")} onChange={e => set("globalBlacklistEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" /></SettingsRow>
        </SettingsSection>
      </div>
      <div className="pt-4">
        <SettingsSection title="🔒 Lock Violations">
          <SettingsRow label="Action on violation"><select className={SEL_CLS + " !w-36"} value={str("lockAction", "none")} onChange={e => set("lockAction", e.target.value)}><option value="none">None (delete only)</option><option value="mute">Mute</option><option value="ban">Ban</option><option value="kick">Kick</option></select></SettingsRow>
          <SettingsRow label="After N violations"><Input type="number" min={1} max={10} className="!w-20 !py-1 !text-xs" value={num("lockActionLimit", 3)} onChange={e => set("lockActionLimit", parseInt(e.target.value) || 3)} /></SettingsRow>
          <SettingsRow label="Punishment (sec, 0=perm)"><Input type="number" min={0} className="!w-24 !py-1 !text-xs" value={num("lockActionDurationSec", 0)} onChange={e => set("lockActionDurationSec", parseInt(e.target.value) || 0)} /></SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
}

function Groups({ api, toast }: { api: ReturnType<typeof useApi>; toast: (m: string, t?: "ok" | "err") => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [keys, setKeys] = useState<AuthKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [authorizing, setAuthorizing] = useState<number | null>(null);
  const [authKey, setAuthKey] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try { const [g, k] = await Promise.all([api.get("/groups"), api.get("/keys")]); setGroups(g as Group[]); setKeys(k as AuthKey[]); }
    catch { toast("Failed to load groups", "err"); }
    finally { setLoading(false); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const toggleBan = async (g: Group) => {
    try { await api.post(`/groups/${g.groupId}/${g.banned ? "unban" : "ban"}`); toast(`Group ${g.banned ? "unbanned" : "banned"} ✓`); load(); }
    catch { toast("Action failed", "err"); }
  };
  const leaveGroup = async (g: Group) => {
    if (!confirm(`Leave "${g.title || g.groupId}" and revoke authorization?`)) return;
    setLeaving(g.groupId);
    try { await api.post(`/groups/${g.groupId}/leave`); toast("Bot left the group ✓"); load(); }
    catch (e: unknown) { toast((e as Error).message || "Failed to leave", "err"); }
    finally { setLeaving(null); }
  };
  const authorizeGroup = async (g: Group) => {
    const key = authKey[g.groupId]?.trim();
    if (!key) { toast("Select an auth key first", "err"); return; }
    setAuthorizing(g.groupId);
    try { await api.post(`/groups/${g.groupId}/authorize`, { key }); toast("Group authorized ✓"); setAuthKey(prev => { const n = { ...prev }; delete n[g.groupId]; return n; }); load(); }
    catch (e: unknown) { toast((e as Error).message || "Authorization failed", "err"); }
    finally { setAuthorizing(null); }
  };
  const saveSettings = async (g: Group) => {
    setSaving(g.groupId);
    try { await api.put(`/groups/${g.groupId}/settings`, draft); toast("Settings saved ✓"); setEditing(null); load(); }
    catch { toast("Save failed", "err"); }
    finally { setSaving(null); }
  };

  const filtered = groups.filter(g => g.title.toLowerCase().includes(search.toLowerCase()) || String(g.groupId).includes(search));
  const activeKeys = keys.filter(k => { const exp = k.expiresAt && new Date(k.expiresAt) < new Date(); return !exp && k.usedCount < k.maxUses; });
  const keyBadge = (g: Group) => {
    if (!g.authorized) return <Badge color="gray">Unauthorized</Badge>;
    if (g.authorizedExpiresAt && new Date(g.authorizedExpiresAt) < new Date()) return <Badge color="yellow">Expired</Badge>;
    return <Badge color="green">Active</Badge>;
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Groups" sub={`${groups.length} groups registered`} />
      <Input placeholder="Search by name or ID…" value={search} onChange={e => setSearch(e.target.value)} />
      {loading ? <div className="flex justify-center py-10"><Spinner /></div>
        : filtered.length === 0 ? <EmptyState icon="🏢" text="No groups found" />
        : (
          <div className="space-y-2">
            {filtered.map(g => (
              <div key={g.groupId} className={`bg-card border rounded-xl overflow-hidden ${g.banned ? "border-red-500/30" : "border-border"}`}>
                <div className="p-4 space-y-2.5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center text-sm flex-shrink-0">🏢</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                        <span className="font-medium text-sm text-foreground truncate max-w-[180px] sm:max-w-none">{g.title || "Unnamed Group"}</span>
                        {g.banned && <Badge color="red">Banned</Badge>}
                        {keyBadge(g)}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono select-all">{g.groupId}</p>
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    <Btn size="sm" variant="ghost" onClick={() => { setEditing(editing === g.groupId ? null : g.groupId); setDraft(g.settings || {}); }}>
                      {editing === g.groupId ? "▲ Close" : "⚙️ Settings"}
                    </Btn>
                    <Btn size="sm" variant={g.banned ? "ghost" : "danger"} onClick={() => toggleBan(g)}>{g.banned ? "✅ Unban" : "🚫 Ban"}</Btn>
                    <Btn size="sm" variant="danger" loading={leaving === g.groupId} onClick={() => leaveGroup(g)}>🚪 Leave</Btn>
                  </div>
                </div>
                {(!g.authorized || (g.authorizedExpiresAt && new Date(g.authorizedExpiresAt) < new Date())) && !g.banned && (
                  <div className="border-t border-yellow-500/20 bg-yellow-500/5 px-4 py-3 flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-yellow-400 font-medium flex-shrink-0">🔑 Authorize:</span>
                    {activeKeys.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No active keys — generate one in the Keys tab</span>
                    ) : (
                      <>
                        <select className="flex-1 min-w-0 bg-input border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          value={authKey[g.groupId] || ""} onChange={e => setAuthKey(prev => ({ ...prev, [g.groupId]: e.target.value }))}>
                          <option value="">Select a key…</option>
                          {activeKeys.map(k => <option key={k.key} value={k.key}>{k.key.slice(0, 20)}… ({k.usedCount}/{k.maxUses} uses)</option>)}
                        </select>
                        <Btn size="sm" loading={authorizing === g.groupId} onClick={() => authorizeGroup(g)}>Authorize</Btn>
                      </>
                    )}
                  </div>
                )}
                {editing === g.groupId && (
                  <div className="border-t border-border p-4 bg-muted/10 space-y-4">
                    <GroupSettings draft={draft} onChange={setDraft} />
                    <div className="flex gap-2 justify-end pt-1">
                      <Btn size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
                      <Btn size="sm" loading={saving === g.groupId} onClick={() => saveSettings(g)}>Save Changes</Btn>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Auth Keys ─────────────────────────────────────────────────────────────────

function Keys({ api, toast }: { api: ReturnType<typeof useApi>; toast: (m: string, t?: "ok" | "err") => void }) {
  const [keys, setKeys] = useState<AuthKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ maxUses: 1, expiresInDays: 0 });
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setKeys(await api.get("/keys") as AuthKey[]); }
    catch { toast("Failed to load keys", "err"); }
    finally { setLoading(false); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true); setNewKey(null);
    try { const k = await api.post("/keys", form) as AuthKey; setNewKey(k.key); toast("Key created ✓"); load(); }
    catch { toast("Failed to create key", "err"); }
    finally { setCreating(false); }
  };
  const remove = async (key: string) => {
    try { await api.del(`/keys/${key}`); toast("Key revoked"); load(); }
    catch { toast("Failed to revoke key", "err"); }
  };
  const keyStatus = (k: AuthKey): { label: string; color: BadgeColor } => {
    if (k.expiresAt && new Date(k.expiresAt) < new Date()) return { label: "Expired", color: "yellow" };
    if (k.usedCount >= k.maxUses) return { label: "Used up", color: "red" };
    return { label: "Active", color: "green" };
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Auth Keys" sub={`${keys.length} keys total`} />
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">Generate New Key</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><label className="text-xs text-muted-foreground">Max Uses</label><Input type="number" min={1} value={form.maxUses} onChange={e => setForm(f => ({ ...f, maxUses: Math.max(1, parseInt(e.target.value) || 1) }))} /></div>
          <div className="space-y-1"><label className="text-xs text-muted-foreground">Expires (days, 0 = permanent)</label><Input type="number" min={0} value={form.expiresInDays} onChange={e => { const v = parseInt(e.target.value); setForm(f => ({ ...f, expiresInDays: isNaN(v) || v < 0 ? 0 : v })); }} /></div>
        </div>
        <Btn onClick={create} loading={creating}>🔑 Generate Key</Btn>
        {newKey && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">New key (tap to copy):</p>
            <code className="text-sm font-mono text-emerald-400 cursor-pointer select-all block" onClick={() => { navigator.clipboard.writeText(newKey); toast("Copied!"); }}>{newKey}</code>
          </div>
        )}
      </div>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div>
        : keys.length === 0 ? <EmptyState icon="🔑" text="No auth keys yet" />
        : (
          <div className="space-y-2">
            {keys.map(k => {
              const s = keyStatus(k);
              return (
                <div key={k.key} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded cursor-pointer select-all hover:bg-primary/20 transition-colors" onClick={() => { navigator.clipboard.writeText(k.key); toast("Copied!"); }} title="Tap to copy">{k.key}</code>
                      <Badge color={s.color}>{s.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">Uses: <b>{k.usedCount}/{k.maxUses}</b> · Expires: {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"} · Created: {new Date(k.createdAt).toLocaleDateString()}</p>
                  </div>
                  <Btn size="sm" variant="danger" onClick={() => remove(k.key)}>✕</Btn>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

// ── Super Admins ──────────────────────────────────────────────────────────────

function Admins({ api, toast }: { api: ReturnType<typeof useApi>; toast: (m: string, t?: "ok" | "err") => void }) {
  const [admins, setAdmins] = useState<SuperAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setAdmins(await api.get("/supers") as SuperAdmin[]); }
    catch { toast("Failed to load", "err"); }
    finally { setLoading(false); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const id = parseInt(userId.trim(), 10);
    if (!id) { toast("Enter a valid user ID", "err"); return; }
    setAdding(true);
    try { await api.post("/supers", { userId: id }); toast("Super admin added ✓"); load(); setUserId(""); }
    catch { toast("Failed to add", "err"); }
    finally { setAdding(false); }
  };
  const remove = async (id: number) => {
    try { await api.del(`/supers/${id}`); toast("Removed"); load(); }
    catch (e: unknown) { toast((e as Error).message || "Failed", "err"); }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Super Admins" sub={`${admins.length} super admins configured`} />
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">Add Super Admin</p>
        <div className="flex gap-2">
          <Input placeholder="Telegram User ID" value={userId} onChange={e => setUserId(e.target.value)} onKeyDown={e => e.key === "Enter" && add()} type="number" />
          <Btn onClick={add} loading={adding}>Add</Btn>
        </div>
        <p className="text-xs text-muted-foreground">Find a user's ID by messaging @userinfobot on Telegram.</p>
      </div>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div>
        : admins.length === 0 ? <EmptyState icon="👑" text="No super admins" />
        : (
          <div className="space-y-2">
            {admins.map(a => (
              <div key={a.id} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
                <div className="w-9 h-9 bg-yellow-500/10 rounded-lg flex items-center justify-center text-lg flex-shrink-0">👑</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {a.displayName && <span className="text-sm font-semibold text-foreground">{a.displayName}</span>}
                    <code className="text-xs font-mono text-muted-foreground select-all bg-muted px-1.5 py-0.5 rounded">{a.id}</code>
                    {a.hardcoded && <Badge color="yellow">🔒 Hardcoded</Badge>}
                  </div>
                </div>
                {!a.hardcoded && <Btn size="sm" variant="danger" onClick={() => remove(a.id)}>✕</Btn>}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Security ──────────────────────────────────────────────────────────────────

function Security({ api, toast }: { api: ReturnType<typeof useApi>; toast: (m: string, t?: "ok" | "err") => void }) {
  const [tab, setTab] = useState<"bans" | "mutes">("bans");
  const [bans, setBans] = useState<GlobalEntry[]>([]);
  const [mutes, setMutes] = useState<GlobalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ userId: "", reason: "", days: "" });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const [b, m] = await Promise.all([api.get("/gbans"), api.get("/gmutes")]); setBans(b as GlobalEntry[]); setMutes(m as GlobalEntry[]); }
    catch { toast("Failed to load security data", "err"); }
    finally { setLoading(false); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const id = parseInt(form.userId.trim(), 10);
    if (!id) { toast("Enter a valid user ID", "err"); return; }
    setAdding(true);
    const durationSec = form.days ? parseInt(form.days) * 86400 : 0;
    try { await api.post(tab === "bans" ? "/gbans" : "/gmutes", { userId: id, durationSec, reason: form.reason }); toast(`Global ${tab === "bans" ? "ban" : "mute"} added ✓`); load(); setForm({ userId: "", reason: "", days: "" }); }
    catch { toast("Failed to add", "err"); }
    finally { setAdding(false); }
  };
  const remove = async (id: number) => {
    try { await api.del(`${tab === "bans" ? "/gbans" : "/gmutes"}/${id}`); toast("Removed"); load(); }
    catch { toast("Failed", "err"); }
  };

  const list = tab === "bans" ? bans : mutes;
  return (
    <div className="space-y-4">
      <SectionHeader title="Security" sub="Global bans and mutes across all groups" />
      <div className="flex bg-muted rounded-xl p-1 gap-1">
        {(["bans", "mutes"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 py-2 text-sm rounded-lg font-medium transition-colors ${tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {t === "bans" ? `⛔ Bans (${bans.length})` : `🔇 Mutes (${mutes.length})`}
          </button>
        ))}
      </div>
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">Add Global {tab === "bans" ? "Ban" : "Mute"}</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1"><label className="text-xs text-muted-foreground">User ID</label><Input placeholder="e.g. 123456789" type="number" value={form.userId} onChange={e => setForm(f => ({ ...f, userId: e.target.value }))} /></div>
          <div className="space-y-1"><label className="text-xs text-muted-foreground">Days (0 = permanent)</label><Input placeholder="0" type="number" min={0} value={form.days} onChange={e => setForm(f => ({ ...f, days: e.target.value }))} /></div>
        </div>
        <div className="space-y-1"><label className="text-xs text-muted-foreground">Reason (optional)</label><Input placeholder="Reason for action…" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} /></div>
        <Btn onClick={add} loading={adding}>{tab === "bans" ? "⛔ Add Ban" : "🔇 Add Mute"}</Btn>
      </div>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div>
        : list.length === 0 ? <EmptyState icon={tab === "bans" ? "⛔" : "🔇"} text={`No global ${tab} yet`} />
        : (
          <div className="space-y-2">
            {list.map(entry => (
              <div key={entry.userId} className={`bg-card border rounded-xl p-4 flex items-center gap-3 ${tab === "bans" ? "border-red-500/20" : "border-orange-500/20"}`}>
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm flex-shrink-0 ${tab === "bans" ? "bg-red-500/10" : "bg-orange-500/10"}`}>{tab === "bans" ? "⛔" : "🔇"}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {entry.displayName && <span className="text-sm font-semibold text-foreground">{entry.displayName}</span>}
                    <code className="text-xs font-mono text-muted-foreground select-all bg-muted px-1.5 py-0.5 rounded">{entry.userId}</code>
                  </div>
                  {entry.reason && <p className="text-xs text-muted-foreground mt-0.5 truncate">"{entry.reason}"</p>}
                  <p className="text-xs text-muted-foreground">{entry.until ? `Until: ${new Date(entry.until).toLocaleDateString()}` : "⚠️ Permanent"}</p>
                </div>
                <Btn size="sm" variant="danger" onClick={() => remove(entry.userId)}>✕</Btn>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

function Broadcast({ api, toast }: { api: ReturnType<typeof useApi>; toast: (m: string, t?: "ok" | "err") => void }) {
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null);

  const send = async () => {
    if (!msg.trim()) { toast("Message cannot be empty", "err"); return; }
    setSending(true); setResult(null);
    try { const r = await api.post("/broadcast", { message: msg }) as { sent: number; failed: number }; setResult(r); toast(`Sent to ${r.sent} group${r.sent !== 1 ? "s" : ""} ✓`); }
    catch { toast("Broadcast failed", "err"); }
    finally { setSending(false); }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Broadcast" sub="Send a message to all authorized groups" />
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Message</label>
            <span className="text-xs text-muted-foreground">{msg.length} chars</span>
          </div>
          <p className="text-xs text-muted-foreground">Supports HTML: <code className="bg-muted px-1 rounded text-[11px]">&lt;b&gt;</code> <code className="bg-muted px-1 rounded text-[11px]">&lt;i&gt;</code> <code className="bg-muted px-1 rounded text-[11px]">&lt;code&gt;</code></p>
          <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={7} placeholder="Type your broadcast message here…" className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none transition-shadow" />
        </div>
        <div className="flex items-center justify-between gap-3 pt-1">
          <button onClick={() => setMsg("")} className="text-xs text-muted-foreground hover:text-foreground transition-colors">Clear</button>
          <Btn onClick={send} loading={sending}>📢 Send Broadcast</Btn>
        </div>
      </div>
      {result && (
        <div className={`border rounded-xl p-4 text-sm ${result.failed === 0 ? "bg-emerald-500/10 border-emerald-500/30" : "bg-yellow-500/10 border-yellow-500/30"}`}>
          <p className="font-semibold text-foreground mb-1">Broadcast complete</p>
          <p className="text-muted-foreground">✅ Delivered: {result.sent} &nbsp;·&nbsp; ❌ Failed: {result.failed}</p>
        </div>
      )}
    </div>
  );
}

// ── Filters & Content ─────────────────────────────────────────────────────────

function Filters({ api, toast }: { api: ReturnType<typeof useApi>; toast: (m: string, t?: "ok" | "err") => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [tab, setTab] = useState<"blacklist" | "filters" | "notes">("blacklist");

  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [blWord, setBlWord] = useState("");
  const [blAdding, setBlAdding] = useState(false);

  const [filterItems, setFilterItems] = useState<FilterItem[]>([]);
  const [fWord, setFWord] = useState("");
  const [fReply, setFReply] = useState("");
  const [fAdding, setFAdding] = useState(false);

  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [nName, setNName] = useState("");
  const [nContent, setNContent] = useState("");
  const [nAdding, setNAdding] = useState(false);
  const [editNote, setEditNote] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get("/groups").then(g => {
      const gs = g as Group[];
      setGroups(gs);
      if (gs.length > 0 && !groupId) setGroupId(gs[0]!.groupId);
    }).catch(() => toast("Failed to load groups", "err"));
  }, []);

  const loadTab = useCallback(async () => {
    if (!groupId) return;
    setLoading(true);
    try {
      if (tab === "blacklist") setBlacklist(await api.get(`/groups/${groupId}/blacklist`) as string[]);
      if (tab === "filters") setFilterItems(await api.get(`/groups/${groupId}/filters`) as FilterItem[]);
      if (tab === "notes") setNotes(await api.get(`/groups/${groupId}/notes`) as NoteItem[]);
    } catch { toast("Failed to load data", "err"); }
    finally { setLoading(false); }
  }, [api, groupId, tab, toast]);

  useEffect(() => { loadTab(); }, [loadTab]);

  const addBl = async () => {
    if (!blWord.trim() || !groupId) return;
    setBlAdding(true);
    try { await api.post(`/groups/${groupId}/blacklist`, { word: blWord.trim() }); toast("Word blacklisted ✓"); setBlWord(""); loadTab(); }
    catch { toast("Failed", "err"); }
    finally { setBlAdding(false); }
  };
  const removeBl = async (word: string) => {
    if (!groupId) return;
    try { await api.del(`/groups/${groupId}/blacklist/${encodeURIComponent(word)}`); toast("Removed ✓"); loadTab(); }
    catch { toast("Failed", "err"); }
  };

  const addFilter = async () => {
    if (!fWord.trim() || !fReply.trim() || !groupId) return;
    setFAdding(true);
    try { await api.post(`/groups/${groupId}/filters`, { word: fWord.trim(), reply: fReply.trim() }); toast("Filter saved ✓"); setFWord(""); setFReply(""); loadTab(); }
    catch { toast("Failed", "err"); }
    finally { setFAdding(false); }
  };
  const removeFilter = async (word: string) => {
    if (!groupId) return;
    try { await api.del(`/groups/${groupId}/filters/${encodeURIComponent(word)}`); toast("Filter removed ✓"); loadTab(); }
    catch { toast("Failed", "err"); }
  };

  const addNote = async () => {
    if (!nName.trim() || !nContent.trim() || !groupId) return;
    setNAdding(true);
    try { await api.post(`/groups/${groupId}/notes`, { name: nName.trim(), content: nContent.trim() }); toast("Note saved ✓"); setNName(""); setNContent(""); setEditNote(null); loadTab(); }
    catch { toast("Failed", "err"); }
    finally { setNAdding(false); }
  };
  const removeNote = async (name: string) => {
    if (!groupId) return;
    try { await api.del(`/groups/${groupId}/notes/${encodeURIComponent(name)}`); toast("Note deleted ✓"); loadTab(); }
    catch { toast("Failed", "err"); }
  };

  const tabBtn = (id: typeof tab, label: string) => (
    <button onClick={() => setTab(id)} className={`flex-1 py-2 text-xs rounded-lg font-medium transition-colors ${tab === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <SectionHeader title="Filters & Content" sub="Manage blacklisted words, auto-reply filters, and saved notes per group" />

      {/* Group selector */}
      <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3">
        <span className="text-sm text-muted-foreground flex-shrink-0 font-medium">Group:</span>
        {groups.length === 0 ? (
          <span className="text-sm text-muted-foreground">No groups yet</span>
        ) : (
          <select className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={groupId ?? ""} onChange={e => setGroupId(parseInt(e.target.value, 10))}>
            {groups.map(g => <option key={g.groupId} value={g.groupId}>{g.title || `Group ${g.groupId}`} — {g.groupId}</option>)}
          </select>
        )}
      </div>

      {groupId && (
        <>
          {/* Tab switcher */}
          <div className="flex bg-muted rounded-xl p-1 gap-1">
            {tabBtn("blacklist", "🚫 Blacklist")}
            {tabBtn("filters", "📋 Filters")}
            {tabBtn("notes", "📓 Notes")}
          </div>

          {/* Tab content — fixed min-height prevents zoom/shift when switching */}
          <div className="min-h-[320px]">
            {loading ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : (
              <>
                {/* ── Blacklist tab ── */}
                {tab === "blacklist" && (
                  <div className="space-y-3">
                    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Add blocked word</p>
                      <div className="flex gap-2">
                        <Input placeholder="e.g. badword" value={blWord} onChange={e => setBlWord(e.target.value)} onKeyDown={e => e.key === "Enter" && addBl()} />
                        <Btn onClick={addBl} loading={blAdding}>Add</Btn>
                      </div>
                      <p className="text-xs text-muted-foreground">Matched whole-word, case-insensitive. Bot deletes messages containing it.</p>
                    </div>
                    {blacklist.length === 0 ? <EmptyState icon="🚫" text="No blacklisted words for this group" /> : (
                      <div className="bg-card border border-border rounded-xl divide-y divide-border/50">
                        {blacklist.map(word => (
                          <div key={word} className="flex items-center justify-between px-4 py-3 gap-3">
                            <code className="text-sm font-mono text-foreground">{word}</code>
                            <Btn size="sm" variant="danger" onClick={() => removeBl(word)}>✕ Remove</Btn>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Filters tab ── */}
                {tab === "filters" && (
                  <div className="space-y-3">
                    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Add auto-reply filter</p>
                      <div className="space-y-2">
                        <Input placeholder="Keyword (e.g. hello)" value={fWord} onChange={e => setFWord(e.target.value)} />
                        <Input placeholder="Reply text" value={fReply} onChange={e => setFReply(e.target.value)} onKeyDown={e => e.key === "Enter" && addFilter()} />
                      </div>
                      <Btn onClick={addFilter} loading={fAdding}>✅ Save Filter</Btn>
                      <p className="text-xs text-muted-foreground">When a member sends a message with the keyword, the bot auto-replies.</p>
                    </div>
                    {filterItems.length === 0 ? <EmptyState icon="📋" text="No filters for this group" /> : (
                      <div className="space-y-2">
                        {filterItems.map(f => (
                          <div key={f.word} className="bg-card border border-border rounded-xl p-4 flex items-start gap-3">
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-muted-foreground">Keyword:</span>
                                <code className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{f.word}</code>
                              </div>
                              <p className="text-sm text-foreground break-words">{f.reply}</p>
                            </div>
                            <Btn size="sm" variant="danger" onClick={() => removeFilter(f.word)}>✕</Btn>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Notes tab ── */}
                {tab === "notes" && (
                  <div className="space-y-3">
                    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {editNote ? `Editing: #${editNote}` : "Save new note"}
                      </p>
                      <div className="space-y-2">
                        <Input placeholder="Note name (e.g. rules)" value={nName} onChange={e => setNName(e.target.value)} disabled={!!editNote} />
                        <textarea value={nContent} onChange={e => setNContent(e.target.value)} rows={4} placeholder="Note content (HTML supported). Retrieve with #notename" className="w-full bg-input border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y transition-shadow" />
                      </div>
                      <div className="flex gap-2">
                        <Btn onClick={addNote} loading={nAdding}>{editNote ? "✏️ Update Note" : "📓 Save Note"}</Btn>
                        {editNote && <Btn variant="ghost" onClick={() => { setEditNote(null); setNName(""); setNContent(""); }}>Cancel</Btn>}
                      </div>
                      <p className="text-xs text-muted-foreground">Members retrieve with <code className="bg-muted px-1 rounded">#notename</code></p>
                    </div>
                    {notes.length === 0 ? <EmptyState icon="📓" text="No notes for this group" /> : (
                      <div className="space-y-2">
                        {notes.map(n => (
                          <div key={n.name} className="bg-card border border-border rounded-xl p-4 flex items-start gap-3">
                            <div className="flex-1 min-w-0 space-y-1">
                              <code className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">#{n.name}</code>
                              <p className="text-xs text-muted-foreground line-clamp-2 break-words">{n.content}</p>
                            </div>
                            <div className="flex gap-1.5 flex-shrink-0">
                              <Btn size="sm" variant="ghost" onClick={() => { setEditNote(n.name); setNName(n.name); setNContent(n.content); }}>✏️</Btn>
                              <Btn size="sm" variant="danger" onClick={() => removeNote(n.name)}>✕</Btn>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Activity Logs ─────────────────────────────────────────────────────────────

const LOG_CAT_COLORS: Record<string, BadgeColor> = {
  general: "blue", moderation: "red", security: "yellow",
  filter: "pink", captcha: "green", settings: "purple",
};
const LOG_CAT_ICONS: Record<string, string> = {
  general: "🌐", moderation: "⚔️", security: "🛡️", filter: "🔍", captcha: "🤖", settings: "⚙️",
};
const ALL_CATEGORIES = ["all", "general", "moderation", "security", "filter", "captcha", "settings"];

function Logs({ api }: { api: ReturnType<typeof useApi> }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  const load = useCallback(async () => {
    try {
      const params = category !== "all" ? `?category=${category}&limit=150` : "?limit=150";
      const data = await api.get(`/logs${params}`) as LogEntry[];
      setLogs(data);
      setLoading(false);
    } catch { setLoading(false); }
  }, [api, category]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load, autoRefresh]);

  useEffect(() => {
    if (logs.length > prevCount.current && listRef.current) listRef.current.scrollTop = 0;
    prevCount.current = logs.length;
  }, [logs.length]);

  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtDate = (ts: number) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Activity Logs"
        sub="Real-time bot activity across all groups"
        action={
          <button onClick={() => setAutoRefresh(a => !a)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${autoRefresh ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "text-muted-foreground border-border hover:bg-accent"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? "bg-emerald-400 animate-pulse" : "bg-gray-500"}`} />
            {autoRefresh ? "Live" : "Paused"}
          </button>
        }
      />

      <div className="flex flex-wrap gap-1.5">
        {ALL_CATEGORIES.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${category === cat ? "bg-primary/15 text-primary border-primary/30" : "text-muted-foreground border-border hover:bg-accent hover:text-foreground"}`}>
            {cat === "all" ? "🔀 All" : `${LOG_CAT_ICONS[cat] || ""} ${cat}`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : logs.length === 0 ? (
        <EmptyState icon="🪵" text={`No ${category === "all" ? "" : category + " "}logs yet. Activity appears as the bot takes actions.`} />
      ) : (
        <div ref={listRef} className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {logs.map(entry => (
            <div key={entry.id} className="bg-card border border-border rounded-xl px-4 py-3 flex items-start gap-3">
              <div className="flex-shrink-0 text-right pt-0.5">
                <p className="text-[10px] font-mono text-muted-foreground leading-tight">{fmtTime(entry.ts)}</p>
                <p className="text-[9px] text-muted-foreground/60 leading-tight">{fmtDate(entry.ts)}</p>
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <Badge color={LOG_CAT_COLORS[entry.category] || "gray"}>
                  {LOG_CAT_ICONS[entry.category] || ""} {entry.category}
                </Badge>
                <p className="text-sm text-foreground break-words leading-snug">{entry.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {logs.length > 0 && (
        <p className="text-xs text-center text-muted-foreground">
          {logs.length} entries · {autoRefresh ? "Refreshes every 4s" : "Auto-refresh paused"}
        </p>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("admin_token") || "");
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState<Page>("dashboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const api = useApi(token);
  const { show: toast, el: toastEl } = useToast();
  const { settings, save: saveSettings } = useSettings();

  useEffect(() => {
    if (!token) { setChecking(false); return; }
    api.get("/info")
      .then(() => setAuthed(true))
      .catch(() => { localStorage.removeItem("admin_token"); setToken(""); })
      .finally(() => setChecking(false));
  }, []);

  const logout = () => { localStorage.removeItem("admin_token"); setToken(""); setAuthed(false); };

  if (checking) return <div className="min-h-screen bg-background flex items-center justify-center"><Spinner /></div>;
  if (!authed || !token) return <Login onLogin={t => { setToken(t); setAuthed(true); }} />;

  return (
    <>
      <Layout page={page} onPage={setPage} onLogout={logout} onSettings={() => setSettingsOpen(true)}>
        {toastEl}
        {page === "dashboard" && <Dashboard api={api} settings={settings} />}
        {page === "groups"    && <Groups    api={api} toast={toast} />}
        {page === "filters"   && <Filters   api={api} toast={toast} />}
        {page === "keys"      && <Keys      api={api} toast={toast} />}
        {page === "admins"    && <Admins    api={api} toast={toast} />}
        {page === "security"  && <Security  api={api} toast={toast} />}
        {page === "broadcast" && <Broadcast api={api} toast={toast} />}
        {page === "logs"      && <Logs      api={api} />}
      </Layout>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
          token={token}
        />
      )}
    </>
  );
}
