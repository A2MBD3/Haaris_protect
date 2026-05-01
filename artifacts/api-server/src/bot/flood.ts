import { getGroupSettings } from "./settings";

// In-memory sliding window: key = `${groupId}:${userId}` → sorted timestamps (ms)
const windows = new Map<string, number[]>();

// Clean stale entries every 60 seconds to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of windows) {
    // keep only last 60 seconds worth regardless of settings
    const trimmed = ts.filter((t) => now - t < 60_000);
    if (trimmed.length === 0) windows.delete(key);
    else windows.set(key, trimmed);
  }
}, 60_000);

/**
 * Record a message from userId in groupId and check if they're flooding.
 * Returns true if the user exceeded the flood limit (action should be taken).
 */
export async function checkFlood(
  groupId: number,
  userId: number,
): Promise<boolean> {
  const settings = await getGroupSettings(groupId);
  if (!settings.floodEnabled) return false;

  const key = `${groupId}:${userId}`;
  const now = Date.now();
  const windowMs = settings.floodWindowSec * 1000;

  let ts = windows.get(key) ?? [];
  // Slide window: keep only timestamps within the window
  ts = ts.filter((t) => now - t < windowMs);
  ts.push(now);
  windows.set(key, ts);

  return ts.length > settings.floodLimit;
}

/** Reset flood counter for a user (e.g. after taking action) */
export function resetFlood(groupId: number, userId: number): void {
  windows.delete(`${groupId}:${userId}`);
}
