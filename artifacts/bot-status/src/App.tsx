import { useEffect, useState } from "react";

interface StatusData {
  status: string;
  botName: string;
  uptime: number;
  startedAt: string;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default function App() {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState(false);
  const [uptime, setUptime] = useState(0);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}api/status`);
        if (!res.ok) throw new Error("not ok");
        const json = await res.json() as StatusData;
        setData(json);
        setUptime(json.uptime);
        setError(false);
      } catch {
        setError(true);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!data) return;
    const tick = setInterval(() => setUptime((u) => u + 1), 1000);
    return () => clearInterval(tick);
  }, [data]);

  const isOnline = !error && data?.status === "ok";

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-5">
        <div className="fade-in text-center space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Bot Status
          </p>
          <h1 className="text-3xl font-bold text-foreground">
            {data?.botName ? `@${data.botName}` : "Haaris Bot"}
          </h1>
        </div>

        <div className="fade-in-delay flex justify-center">
          <div className="relative flex items-center justify-center w-28 h-28">
            {isOnline && (
              <span className="absolute inline-block w-16 h-16 rounded-full bg-green-400 opacity-40 ring-ping" />
            )}
            <span
              className={[
                "relative z-10 flex items-center justify-center w-20 h-20 rounded-full shadow-lg",
                isOnline
                  ? "bg-green-500 dot-active"
                  : error
                  ? "bg-red-500"
                  : "bg-gray-300 animate-pulse",
              ].join(" ")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-10 h-10 text-white"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
          </div>
        </div>

        <div className="fade-in-delay-2 bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="px-6 py-5 space-y-4">
            <StatusRow
              label="Status"
              value={
                !data && !error ? (
                  <span className="text-muted-foreground animate-pulse">Checking…</span>
                ) : isOnline ? (
                  <span className="inline-flex items-center gap-1.5 text-green-600 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-green-500 dot-active inline-block" />
                    Online
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-red-500 font-semibold">
                    <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                    Offline
                  </span>
                )
              }
            />

            {isOnline && (
              <>
                <div className="h-px bg-border" />
                <StatusRow
                  label="Uptime"
                  value={
                    <span className="font-mono text-sm tabular-nums text-foreground">
                      {formatUptime(uptime)}
                    </span>
                  }
                />
                <div className="h-px bg-border" />
                <StatusRow
                  label="Started"
                  value={
                    <span className="text-sm text-muted-foreground">
                      {data?.startedAt ? formatDate(data.startedAt) : "—"}
                    </span>
                  }
                />
              </>
            )}

            {error && (
              <>
                <div className="h-px bg-border" />
                <p className="text-sm text-muted-foreground text-center">
                  Unable to reach the bot. It may be restarting.
                </p>
              </>
            )}
          </div>
        </div>

        <p className="fade-in-delay-2 text-center text-xs text-muted-foreground">
          Refreshes every 30 seconds
        </p>
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
