import { useState, useEffect, useCallback, type ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Stats {
  totalGroups: number;
  activeGroups: number;
  bannedGroups: number;
  totalKeys: number;
  activeKeys: number;
  globalBans: number;
  globalMutes: number;
  superAdmins: number;
}

interface BotInfo {
  status: string;
  botName: string;
  uptime: number;
  startedAt: string;
  stats: Stats;
}

interface Group {
  groupId: number;
  title: string;
  banned: boolean;
  authorized: boolean;
  authorizedKey: string | null;
  authorizedExpiresAt: string | null;
  settings: Record<string, unknown>;
}

interface AuthKey {
  key: string;
  expiresAt: string | null;
  maxUses: number;
  usedCount: number;
  createdBy: number;
  createdAt: string;
}

interface SuperAdmin {
  id: number;
  hardcoded: boolean;
}

interface GlobalEntry {
  userId: number;
  until: string | null;
  reason: string;
}

type Page = "dashboard" | "groups" | "keys" | "admins" | "security" | "broadcast";

// ── API hook ──────────────────────────────────────────────────────────────────

function useApi(token: string) {
  const BASE = (import.meta.env.BASE_URL as string) || "/";
  const prefix = `${BASE}api/admin`;

  const request = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await fetch(`${prefix}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...((options.headers as Record<string, string>) || {}),
      },
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(msg || `HTTP ${res.status}`);
    }
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

type BadgeColor = "blue" | "green" | "red" | "yellow" | "gray";
function Badge({ children, color = "blue" }: { children: ReactNode; color?: BadgeColor }) {
  const cls: Record<BadgeColor, string> = {
    blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    red: "bg-red-500/20 text-red-400 border-red-500/30",
    yellow: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    gray: "bg-gray-500/20 text-gray-400 border-gray-500/30",
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
    <input
      {...rest}
      className={`w-full bg-input border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-shadow ${className}`}
    />
  );
}

function Btn({
  children, onClick, variant = "primary", size = "md", loading, disabled, className = "",
}: {
  children: ReactNode; onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md"; loading?: boolean; disabled?: boolean; className?: string;
}) {
  const v = {
    primary: "bg-primary hover:bg-blue-600 text-white",
    ghost: "bg-transparent hover:bg-accent text-muted-foreground hover:text-foreground border border-border",
    danger: "bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30",
  }[variant];
  const s = size === "sm" ? "px-3 py-1.5 text-xs gap-1.5" : "px-4 py-2.5 text-sm gap-2";
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className={`${v} ${s} rounded-lg font-medium transition-colors flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
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
      const res = await fetch(`${BASE}api/admin/info`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) { localStorage.setItem("admin_token", token); onLogin(token); }
      else setError("Wrong password. Send /adminpanel to the bot to get yours.");
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
              <Input
                type={show ? "text" : "password"}
                placeholder="Paste your admin password…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                className="pr-14"
              />
              <button
                onClick={() => setShow(!show)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Send <code className="bg-muted px-1.5 py-0.5 rounded text-[11px] text-primary">/adminpanel</code> to the bot in Telegram to get your password
            </p>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs px-3 py-2.5 rounded-lg">
              {error}
            </div>
          )}

          <Btn onClick={submit} loading={loading} className="w-full">
            Sign In →
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "groups",    label: "Groups",    icon: "🏢" },
  { id: "keys",      label: "Keys",      icon: "🔑" },
  { id: "admins",    label: "Admins",    icon: "👑" },
  { id: "security",  label: "Security",  icon: "🛡️" },
  { id: "broadcast", label: "Broadcast", icon: "📢" },
];

function Layout({ page, onPage, onLogout, children }: {
  page: Page; onPage: (p: Page) => void; onLogout: () => void; children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar — desktop */}
      <aside className="hidden md:flex flex-col w-56 lg:w-60 bg-card border-r border-border fixed h-full z-40">
        <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
          <span className="text-2xl">🤖</span>
          <div>
            <p className="text-sm font-semibold text-foreground">Haaris Admin</p>
            <p className="text-xs text-muted-foreground">Control Panel</p>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((n) => (
            <button
              key={n.id}
              onClick={() => onPage(n.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
                page === n.id
                  ? "bg-primary/15 text-primary font-semibold"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <span className="text-base">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-border">
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
          >
            <span>🚪</span> Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 md:ml-56 lg:ml-60 min-h-screen flex flex-col">
        {/* Mobile top bar */}
        <header className="md:hidden sticky top-0 z-30 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="text-lg">{NAV_ITEMS.find(n => n.id === page)?.icon}</span>
            <span className="text-sm font-semibold text-foreground">{NAV_ITEMS.find(n => n.id === page)?.label}</span>
          </div>
          <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Sign out
          </button>
        </header>

        {/* Content */}
        <div className="flex-1 px-4 py-5 md:px-6 md:py-6 max-w-4xl w-full mx-auto pb-24 md:pb-8">
          {children}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur border-t border-border flex z-40 safe-area-pb">
        {NAV_ITEMS.map((n) => (
          <button
            key={n.id}
            onClick={() => onPage(n.id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors ${
              page === n.id ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <span className="text-lg leading-none">{n.icon}</span>
            <span className="text-[9px] font-medium leading-none mt-0.5">{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ api }: { api: ReturnType<typeof useApi> }) {
  const [info, setInfo] = useState<BotInfo | null>(null);
  const [uptime, setUptime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get("/info") as BotInfo;
      setInfo(d); setUptime(d.uptime); setErr(false);
    } catch { setErr(true); }
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

      {/* Bot status */}
      <div className={`bg-card border rounded-xl p-4 flex items-center gap-4 ${err ? "border-red-500/30" : "border-emerald-500/30"}`}>
        <div className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl flex-shrink-0 ${err ? "bg-red-500/10" : "bg-emerald-500/10"}`}>
          🤖
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-foreground">@{info?.botName || "haarish_helpbot"}</span>
            {!loading && (err
              ? <Badge color="red">● Offline</Badge>
              : <Badge color="green">● Online</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 font-mono">
            {info ? `⏱ ${fmtUptime(uptime)}  ·  since ${new Date(info.startedAt).toLocaleString()}` : "Connecting…"}
          </p>
        </div>
        <button onClick={load} title="Refresh" className="text-muted-foreground hover:text-foreground text-xl transition-colors flex-shrink-0">↻</button>
      </div>

      {loading && <div className="flex justify-center py-10"><Spinner /></div>}

      {err && !loading && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400 text-center">
          Cannot reach the API server. Is the bot running?
        </div>
      )}

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
            <div>
              <p className="text-2xl font-bold text-emerald-400">{info.stats.activeGroups}</p>
              <p className="text-xs text-muted-foreground">Active</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-400">{info.stats.totalGroups - info.stats.activeGroups - info.stats.bannedGroups}</p>
              <p className="text-xs text-muted-foreground">Unauthorized</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-red-400">{info.stats.bannedGroups}</p>
              <p className="text-xs text-muted-foreground">Banned</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────────

function GroupSettings({ draft, onChange }: { draft: Record<string, unknown>; onChange: (d: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...draft, [k]: v });
  const num = (k: string, def: number) => Number(draft[k] ?? def);
  const bool = (k: string) => Boolean(draft[k]);
  const str = (k: string, def: string) => String(draft[k] ?? def);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Warnings</p>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Limit</span>
          <Input type="number" min={1} max={20} className="!w-20 !py-1 !text-xs" value={num("warnLimit", 3)} onChange={e => set("warnLimit", parseInt(e.target.value) || 3)} />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Action</span>
          <select className="bg-input border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring" value={str("warnAction", "mute")} onChange={e => set("warnAction", e.target.value)}>
            <option value="mute">Mute</option><option value="ban">Ban</option>
          </select>
        </label>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Flood Control</p>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Enabled</span>
          <input type="checkbox" checked={bool("floodEnabled")} onChange={e => set("floodEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Message limit</span>
          <Input type="number" min={2} max={50} className="!w-20 !py-1 !text-xs" value={num("floodLimit", 5)} onChange={e => set("floodLimit", parseInt(e.target.value) || 5)} />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Window (sec)</span>
          <Input type="number" min={1} max={60} className="!w-20 !py-1 !text-xs" value={num("floodWindowSec", 5)} onChange={e => set("floodWindowSec", parseInt(e.target.value) || 5)} />
        </label>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Protection</p>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Captcha on join</span>
          <input type="checkbox" checked={bool("captchaEnabled")} onChange={e => set("captchaEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Anti-bot</span>
          <input type="checkbox" checked={bool("antibot")} onChange={e => set("antibot", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Anti-channel</span>
          <input type="checkbox" checked={bool("antichannel")} onChange={e => set("antichannel", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" />
        </label>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Blacklist</p>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Hit threshold</span>
          <Input type="number" min={1} max={10} className="!w-20 !py-1 !text-xs" value={num("blacklistThreshold", 3)} onChange={e => set("blacklistThreshold", parseInt(e.target.value) || 3)} />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Global BL sync</span>
          <input type="checkbox" checked={bool("globalBlacklistEnabled")} onChange={e => set("globalBlacklistEnabled", e.target.checked)} className="w-4 h-4 rounded accent-blue-500" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">Action</span>
          <select className="bg-input border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring" value={str("blacklistAction", "mute")} onChange={e => set("blacklistAction", e.target.value)}>
            <option value="mute">Mute</option><option value="ban">Ban</option><option value="kick">Kick</option>
          </select>
        </label>
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
    try {
      const [g, k] = await Promise.all([api.get("/groups"), api.get("/keys")]);
      setGroups(g as Group[]);
      setKeys(k as AuthKey[]);
    }
    catch { toast("Failed to load groups", "err"); }
    finally { setLoading(false); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const toggleBan = async (g: Group) => {
    try {
      await api.post(`/groups/${g.groupId}/${g.banned ? "unban" : "ban"}`);
      toast(`Group ${g.banned ? "unbanned" : "banned"} ✓`);
      load();
    } catch { toast("Action failed", "err"); }
  };

  const leaveGroup = async (g: Group) => {
    if (!confirm(`Leave "${g.title || g.groupId}" and revoke authorization?`)) return;
    setLeaving(g.groupId);
    try {
      await api.post(`/groups/${g.groupId}/leave`);
      toast("Bot left the group ✓");
      load();
    } catch (e: unknown) { toast((e as Error).message || "Failed to leave", "err"); }
    finally { setLeaving(null); }
  };

  const authorizeGroup = async (g: Group) => {
    const key = authKey[g.groupId]?.trim();
    if (!key) { toast("Select an auth key first", "err"); return; }
    setAuthorizing(g.groupId);
    try {
      await api.post(`/groups/${g.groupId}/authorize`, { key });
      toast("Group authorized ✓");
      setAuthKey(prev => { const n = { ...prev }; delete n[g.groupId]; return n; });
      load();
    } catch (e: unknown) { toast((e as Error).message || "Authorization failed", "err"); }
    finally { setAuthorizing(null); }
  };

  const saveSettings = async (g: Group) => {
    setSaving(g.groupId);
    try {
      await api.put(`/groups/${g.groupId}/settings`, draft);
      toast("Settings saved ✓");
      setEditing(null); load();
    } catch { toast("Save failed", "err"); }
    finally { setSaving(null); }
  };

  const filtered = groups.filter(g =>
    g.title.toLowerCase().includes(search.toLowerCase()) ||
    String(g.groupId).includes(search)
  );

  const activeKeys = keys.filter(k => {
    const expired = k.expiresAt && new Date(k.expiresAt) < new Date();
    const used = k.usedCount >= k.maxUses;
    return !expired && !used;
  });

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
                <div className="flex items-center gap-3 p-4">
                  <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center text-sm flex-shrink-0">🏢</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <span className="font-medium text-sm text-foreground truncate max-w-[140px] sm:max-w-none">{g.title || "Unnamed Group"}</span>
                      {g.banned && <Badge color="red">Banned</Badge>}
                      {keyBadge(g)}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono select-all">{g.groupId}</p>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0 flex-wrap justify-end">
                    <Btn size="sm" variant="ghost" onClick={() => { setEditing(editing === g.groupId ? null : g.groupId); setDraft(g.settings || {}); }}>
                      {editing === g.groupId ? "↑" : "Settings"}
                    </Btn>
                    <Btn size="sm" variant={g.banned ? "ghost" : "danger"} onClick={() => toggleBan(g)}>
                      {g.banned ? "Unban" : "Ban"}
                    </Btn>
                    <Btn size="sm" variant="danger" loading={leaving === g.groupId} onClick={() => leaveGroup(g)}>
                      🚪 Leave
                    </Btn>
                  </div>
                </div>

                {/* Authorize panel — shown for unauthorized or expired groups */}
                {(!g.authorized || (g.authorizedExpiresAt && new Date(g.authorizedExpiresAt) < new Date())) && !g.banned && (
                  <div className="border-t border-yellow-500/20 bg-yellow-500/5 px-4 py-3 flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-yellow-400 font-medium flex-shrink-0">🔑 Authorize:</span>
                    {activeKeys.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No active keys — generate one in the Keys tab</span>
                    ) : (
                      <>
                        <select
                          className="flex-1 min-w-0 bg-input border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          value={authKey[g.groupId] || ""}
                          onChange={e => setAuthKey(prev => ({ ...prev, [g.groupId]: e.target.value }))}
                        >
                          <option value="">Select a key…</option>
                          {activeKeys.map(k => (
                            <option key={k.key} value={k.key}>{k.key.slice(0, 20)}… ({k.usedCount}/{k.maxUses} uses)</option>
                          ))}
                        </select>
                        <Btn size="sm" loading={authorizing === g.groupId} onClick={() => authorizeGroup(g)}>
                          Authorize
                        </Btn>
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
  const [form, setForm] = useState({ maxUses: 1, expiresInDays: 30 });
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
    try {
      const k = await api.post("/keys", form) as AuthKey;
      setNewKey(k.key); toast("Key created ✓"); load();
    } catch { toast("Failed to create key", "err"); }
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
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Max Uses</label>
            <Input type="number" min={1} value={form.maxUses} onChange={e => setForm(f => ({ ...f, maxUses: parseInt(e.target.value) || 1 }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Expires (days)</label>
            <Input type="number" min={1} value={form.expiresInDays} onChange={e => setForm(f => ({ ...f, expiresInDays: parseInt(e.target.value) || 30 }))} />
          </div>
        </div>
        <Btn onClick={create} loading={creating}>🔑 Generate Key</Btn>

        {newKey && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">New key (tap to copy):</p>
            <code
              className="text-sm font-mono text-emerald-400 cursor-pointer select-all block"
              onClick={() => { navigator.clipboard.writeText(newKey); toast("Copied!"); }}
            >
              {newKey}
            </code>
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
                      <code
                        className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded cursor-pointer select-all hover:bg-primary/20 transition-colors"
                        onClick={() => { navigator.clipboard.writeText(k.key); toast("Copied!"); }}
                        title="Tap to copy"
                      >
                        {k.key}
                      </code>
                      <Badge color={s.color}>{s.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Uses: <b>{k.usedCount}/{k.maxUses}</b> · Expires: {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"} · Created: {new Date(k.createdAt).toLocaleDateString()}
                    </p>
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
          <Input
            placeholder="Telegram User ID"
            value={userId}
            onChange={e => setUserId(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()}
            type="number"
          />
          <Btn onClick={add} loading={adding}>Add</Btn>
        </div>
        <p className="text-xs text-muted-foreground">You can find a user's ID by messaging @userinfobot on Telegram.</p>
      </div>

      {loading ? <div className="flex justify-center py-8"><Spinner /></div>
        : admins.length === 0 ? <EmptyState icon="👑" text="No super admins" />
        : (
          <div className="space-y-2">
            {admins.map(a => (
              <div key={a.id} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
                <div className="w-9 h-9 bg-yellow-500/10 rounded-lg flex items-center justify-center text-lg flex-shrink-0">👑</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono text-foreground select-all">{a.id}</code>
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
    try {
      const [b, m] = await Promise.all([api.get("/gbans"), api.get("/gmutes")]);
      setBans(b as GlobalEntry[]); setMutes(m as GlobalEntry[]);
    } catch { toast("Failed to load security data", "err"); }
    finally { setLoading(false); }
  }, [api, toast]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const id = parseInt(form.userId.trim(), 10);
    if (!id) { toast("Enter a valid user ID", "err"); return; }
    setAdding(true);
    const durationSec = form.days ? parseInt(form.days) * 86400 : 0;
    try {
      await api.post(tab === "bans" ? "/gbans" : "/gmutes", {
        userId: id, durationSec, reason: form.reason,
      });
      toast(`Global ${tab === "bans" ? "ban" : "mute"} added ✓`);
      load(); setForm({ userId: "", reason: "", days: "" });
    } catch { toast("Failed to add", "err"); }
    finally { setAdding(false); }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`${tab === "bans" ? "/gbans" : "/gmutes"}/${id}`);
      toast("Removed"); load();
    } catch { toast("Failed", "err"); }
  };

  const list = tab === "bans" ? bans : mutes;

  return (
    <div className="space-y-4">
      <SectionHeader title="Security" sub="Global bans and mutes across all groups" />

      <div className="flex bg-muted rounded-xl p-1 gap-1">
        {(["bans", "mutes"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm rounded-lg font-medium transition-colors ${tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t === "bans" ? `⛔ Bans (${bans.length})` : `🔇 Mutes (${mutes.length})`}
          </button>
        ))}
      </div>

      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-foreground">Add Global {tab === "bans" ? "Ban" : "Mute"}</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">User ID</label>
            <Input placeholder="e.g. 123456789" type="number" value={form.userId} onChange={e => setForm(f => ({ ...f, userId: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Days (0 = permanent)</label>
            <Input placeholder="0" type="number" min={0} value={form.days} onChange={e => setForm(f => ({ ...f, days: e.target.value }))} />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Reason (optional)</label>
          <Input placeholder="Reason for action…" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
        </div>
        <Btn onClick={add} loading={adding}>
          {tab === "bans" ? "⛔ Add Ban" : "🔇 Add Mute"}
        </Btn>
      </div>

      {loading ? <div className="flex justify-center py-8"><Spinner /></div>
        : list.length === 0 ? <EmptyState icon={tab === "bans" ? "⛔" : "🔇"} text={`No global ${tab} yet`} />
        : (
          <div className="space-y-2">
            {list.map(entry => (
              <div key={entry.userId} className={`bg-card border rounded-xl p-4 flex items-center gap-3 ${tab === "bans" ? "border-red-500/20" : "border-orange-500/20"}`}>
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm flex-shrink-0 ${tab === "bans" ? "bg-red-500/10" : "bg-orange-500/10"}`}>
                  {tab === "bans" ? "⛔" : "🔇"}
                </div>
                <div className="flex-1 min-w-0">
                  <code className="text-sm font-mono text-foreground select-all">{entry.userId}</code>
                  {entry.reason && <p className="text-xs text-muted-foreground mt-0.5 truncate">"{entry.reason}"</p>}
                  <p className="text-xs text-muted-foreground">
                    {entry.until ? `Until: ${new Date(entry.until).toLocaleDateString()}` : "⚠️ Permanent"}
                  </p>
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
    try {
      const r = await api.post("/broadcast", { message: msg }) as { sent: number; failed: number };
      setResult(r); toast(`Sent to ${r.sent} group${r.sent !== 1 ? "s" : ""} ✓`);
    } catch { toast("Broadcast failed", "err"); }
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
          <p className="text-xs text-muted-foreground">Supports HTML: <code className="bg-muted px-1 rounded text-[11px]">&lt;b&gt;</code> <code className="bg-muted px-1 rounded text-[11px]">&lt;i&gt;</code> <code className="bg-muted px-1 rounded text-[11px]">&lt;code&gt;</code> <code className="bg-muted px-1 rounded text-[11px]">&lt;a href&gt;</code></p>
          <textarea
            value={msg}
            onChange={e => setMsg(e.target.value)}
            rows={7}
            placeholder="Type your broadcast message here…"
            className="w-full bg-input border border-border rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none transition-shadow"
          />
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

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("admin_token") || "");
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState<Page>("dashboard");
  const api = useApi(token);
  const { show: toast, el: toastEl } = useToast();

  useEffect(() => {
    if (!token) { setChecking(false); return; }
    api.get("/info")
      .then(() => setAuthed(true))
      .catch(() => { localStorage.removeItem("admin_token"); setToken(""); })
      .finally(() => setChecking(false));
  }, []);

  const logout = () => {
    localStorage.removeItem("admin_token");
    setToken(""); setAuthed(false);
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!authed || !token) {
    return <Login onLogin={(t) => { setToken(t); setAuthed(true); }} />;
  }

  return (
    <Layout page={page} onPage={setPage} onLogout={logout}>
      {toastEl}
      {page === "dashboard" && <Dashboard api={api} />}
      {page === "groups"    && <Groups    api={api} toast={toast} />}
      {page === "keys"      && <Keys      api={api} toast={toast} />}
      {page === "admins"    && <Admins    api={api} toast={toast} />}
      {page === "security"  && <Security  api={api} toast={toast} />}
      {page === "broadcast" && <Broadcast api={api} toast={toast} />}
    </Layout>
  );
}
