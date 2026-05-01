export function parseDuration(input: string | undefined): number | null {
  // Returns seconds. null = invalid. 0 = permanent (when allowed).
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "0" || trimmed === "perm" || trimmed === "permanent") return 0;
  const match = trimmed.match(/^(\d+)\s*([smhdw]?)$/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  if (Number.isNaN(n) || n < 0) return null;
  const unit = match[2] || "s";
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };
  return n * multipliers[unit]!;
}

export function formatDuration(sec: number): string {
  if (sec <= 0) return "permanent";
  if (sec >= 604800 && sec % 604800 === 0) return `${sec / 604800}w`;
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function parseUserId(
  input: string | undefined,
): number | null {
  if (!input) return null;
  const cleaned = input.replace(/^@/, "").trim();
  if (!/^-?\d+$/.test(cleaned)) return null;
  const n = parseInt(cleaned, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
