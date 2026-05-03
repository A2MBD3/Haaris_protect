import { Router, type Request, type Response, type NextFunction } from "express";
import { bot, getAdminPanelPassword } from "../bot";
import { listGroups, getGroupSettings, updateGroupSettings, setGroupBanned } from "../bot/settings";
import { listGlobalBans, setGlobalBan, removeGlobalBan, listGlobalMutes, setGlobalMute, removeGlobalMute } from "../bot/moderation";
import { getSuperAdmins, addSuperAdmin, removeSuperAdmin, isHardcodedSuper } from "../bot/admin";
import { createAuthKey, listAuthKeys, removeAuthKey, consumeAuthKey, authorizeGroup, deauthorizeGroup } from "../bot/auth";
import { listFilters, addFilter, removeFilter, listBlacklist, addBlacklistWord, removeBlacklistWord } from "../bot/content";
import { listNotes, saveNote, removeNote } from "../bot/notes";
import { getRecentLogs, type LogCategory } from "../bot/logging";
import { db, userSeenTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

async function resolveUserNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({
    userId: userSeenTable.userId,
    firstName: userSeenTable.firstName,
    lastName: userSeenTable.lastName,
    username: userSeenTable.username,
  }).from(userSeenTable).where(inArray(userSeenTable.userId, ids));
  const map = new Map<number, string>();
  for (const r of rows) {
    const full = [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
    const name = full || (r.username ? `@${r.username}` : null);
    if (name) map.set(Number(r.userId), name);
  }
  return map;
}

const router = Router();
const serverStart = Date.now();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || token !== getAdminPanelPassword()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.use(requireAdmin);

// ── Info / Dashboard ──────────────────────────────────────────────────────────

router.get("/info", async (_req, res) => {
  try {
    const me = await bot.api.getMe();
    const [groups, keys, bans, mutes, supers] = await Promise.all([
      listGroups(), listAuthKeys(), listGlobalBans(), listGlobalMutes(), getSuperAdmins(),
    ]);
    const now = Date.now();
    const activeKeys = keys.filter(k => {
      const expired = k.expiresAt && new Date(k.expiresAt).getTime() < now;
      return !expired && k.usedCount < k.maxUses;
    });
    res.json({
      status: "ok",
      botName: me.username,
      uptime: Math.floor((now - serverStart) / 1000),
      startedAt: new Date(serverStart).toISOString(),
      stats: {
        totalGroups: groups.length,
        activeGroups: groups.filter(g => !g.banned && g.authorized).length,
        bannedGroups: groups.filter(g => g.banned).length,
        totalKeys: keys.length,
        activeKeys: activeKeys.length,
        globalBans: bans.length,
        globalMutes: mutes.length,
        superAdmins: supers.size,
      },
    });
  } catch { res.status(500).json({ error: "Failed to fetch info" }); }
});

// ── Groups ────────────────────────────────────────────────────────────────────

router.get("/groups", async (_req, res) => {
  try {
    const groups = await listGroups();
    const result = await Promise.all(groups.map(async (g) => ({ ...g, settings: await getGroupSettings(g.groupId) })));
    res.json(result);
  } catch { res.status(500).json({ error: "Failed to list groups" }); }
});

router.put("/groups/:id/settings", async (req, res) => {
  try {
    await updateGroupSettings(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed to update settings" }); }
});

router.post("/groups/:id/ban", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deauthorizeGroup(id);
    await setGroupBanned(id, true);
    try { await bot.api.sendMessage(id, "⚠️ This group has been banned from using the bot."); } catch {}
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed to ban group" }); }
});

router.post("/groups/:id/unban", async (req, res) => {
  try {
    await setGroupBanned(parseInt(req.params.id, 10), false);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed to unban group" }); }
});

router.post("/groups/:id/leave", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deauthorizeGroup(id);
    try { await bot.api.sendMessage(id, "👋 Bot is leaving this group and authorization has been revoked."); } catch {}
    await bot.api.leaveChat(id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err?.message || "Failed to leave group" }); }
});

router.post("/groups/:id/authorize", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { key } = req.body as { key?: string };
    if (!key?.trim()) { res.status(400).json({ error: "key required" }); return; }
    const result = await consumeAuthKey(key.trim(), id);
    if (!result.ok) { res.status(400).json({ error: result.reason || "Invalid or used-up key" }); return; }
    await authorizeGroup(id, key.trim(), result.expiresAt ?? null);
    try { await bot.api.sendMessage(id, "✅ This group has been authorized by an admin. The bot is now active here."); } catch {}
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err?.message || "Failed" }); }
});

// ── Per-group: Filters ────────────────────────────────────────────────────────

router.get("/groups/:id/filters", async (req, res) => {
  try { res.json(await listFilters(parseInt(req.params.id, 10))); }
  catch { res.status(500).json({ error: "Failed" }); }
});

router.post("/groups/:id/filters", async (req, res) => {
  try {
    const { word, reply } = req.body as { word?: string; reply?: string };
    if (!word?.trim() || !reply?.trim()) { res.status(400).json({ error: "word and reply required" }); return; }
    await addFilter(parseInt(req.params.id, 10), word.trim(), reply.trim());
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.delete("/groups/:id/filters/:word", async (req, res) => {
  try {
    const ok = await removeFilter(parseInt(req.params.id, 10), decodeURIComponent(req.params.word));
    res.json({ ok });
  } catch { res.status(500).json({ error: "Failed" }); }
});

// ── Per-group: Blacklist ──────────────────────────────────────────────────────

router.get("/groups/:id/blacklist", async (req, res) => {
  try { res.json(await listBlacklist(parseInt(req.params.id, 10))); }
  catch { res.status(500).json({ error: "Failed" }); }
});

router.post("/groups/:id/blacklist", async (req, res) => {
  try {
    const { word } = req.body as { word?: string };
    if (!word?.trim()) { res.status(400).json({ error: "word required" }); return; }
    await addBlacklistWord(parseInt(req.params.id, 10), word.trim());
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.delete("/groups/:id/blacklist/:word", async (req, res) => {
  try {
    const ok = await removeBlacklistWord(parseInt(req.params.id, 10), decodeURIComponent(req.params.word));
    res.json({ ok });
  } catch { res.status(500).json({ error: "Failed" }); }
});

// ── Per-group: Notes ──────────────────────────────────────────────────────────

router.get("/groups/:id/notes", async (req, res) => {
  try { res.json(await listNotes(parseInt(req.params.id, 10))); }
  catch { res.status(500).json({ error: "Failed" }); }
});

router.post("/groups/:id/notes", async (req, res) => {
  try {
    const { name, content } = req.body as { name?: string; content?: string };
    if (!name?.trim() || !content?.trim()) { res.status(400).json({ error: "name and content required" }); return; }
    await saveNote(parseInt(req.params.id, 10), name.trim(), content.trim(), 0);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.delete("/groups/:id/notes/:name", async (req, res) => {
  try {
    const ok = await removeNote(parseInt(req.params.id, 10), decodeURIComponent(req.params.name));
    res.json({ ok });
  } catch { res.status(500).json({ error: "Failed" }); }
});

// ── Auth Keys ─────────────────────────────────────────────────────────────────

router.get("/keys", async (_req, res) => {
  try { res.json(await listAuthKeys()); }
  catch { res.status(500).json({ error: "Failed to list keys" }); }
});

router.post("/keys", async (req, res) => {
  try {
    const { maxUses = 1, expiresInDays = 30 } = req.body;
    const durationSec = expiresInDays > 0 ? Number(expiresInDays) * 86400 : 0;
    const key = await createAuthKey(durationSec, Math.max(1, maxUses), 0);
    res.json(key);
  } catch { res.status(500).json({ error: "Failed to create key" }); }
});

router.delete("/keys/:key", async (req, res) => {
  try { res.json({ ok: await removeAuthKey(req.params.key) }); }
  catch { res.status(500).json({ error: "Failed" }); }
});

// ── Super Admins ──────────────────────────────────────────────────────────────

router.get("/supers", async (_req, res) => {
  try {
    const supers = await getSuperAdmins();
    const ids = [...supers];
    const names = await resolveUserNames(ids);
    res.json(ids.map(id => ({ id, hardcoded: isHardcodedSuper(id), displayName: names.get(id) ?? null })));
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.post("/supers", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) { res.status(400).json({ error: "userId required" }); return; }
    await addSuperAdmin(Number(userId));
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});

router.delete("/supers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isHardcodedSuper(id)) { res.status(400).json({ error: "Cannot remove hardcoded super admin" }); return; }
    await removeSuperAdmin(id);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});

// ── Global Bans ───────────────────────────────────────────────────────────────

router.get("/gbans", async (_req, res) => {
  try {
    const bans = await listGlobalBans();
    const names = await resolveUserNames(bans.map(b => b.userId));
    res.json(bans.map(b => ({ ...b, displayName: names.get(b.userId) ?? null })));
  } catch { res.status(500).json({ error: "Failed" }); }
});
router.post("/gbans", async (req, res) => {
  try {
    const { userId, durationSec = 0, reason = "" } = req.body;
    if (!userId) { res.status(400).json({ error: "userId required" }); return; }
    await setGlobalBan(Number(userId), durationSec, reason);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});
router.delete("/gbans/:id", async (req, res) => {
  try { res.json({ ok: await removeGlobalBan(parseInt(req.params.id, 10)) }); }
  catch { res.status(500).json({ error: "Failed" }); }
});

// ── Global Mutes ──────────────────────────────────────────────────────────────

router.get("/gmutes", async (_req, res) => {
  try {
    const mutes = await listGlobalMutes();
    const names = await resolveUserNames(mutes.map(m => m.userId));
    res.json(mutes.map(m => ({ ...m, displayName: names.get(m.userId) ?? null })));
  } catch { res.status(500).json({ error: "Failed" }); }
});
router.post("/gmutes", async (req, res) => {
  try {
    const { userId, durationSec = 0, reason = "" } = req.body;
    if (!userId) { res.status(400).json({ error: "userId required" }); return; }
    await setGlobalMute(Number(userId), durationSec, reason);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "Failed" }); }
});
router.delete("/gmutes/:id", async (req, res) => {
  try { res.json({ ok: await removeGlobalMute(parseInt(req.params.id, 10)) }); }
  catch { res.status(500).json({ error: "Failed" }); }
});

// ── Broadcast ─────────────────────────────────────────────────────────────────

router.post("/broadcast", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) { res.status(400).json({ error: "message required" }); return; }
    const groups = await listGroups();
    let sent = 0, failed = 0;
    for (const g of groups) {
      if (g.banned || !g.authorized) continue;
      try { await bot.api.sendMessage(g.groupId, message, { parse_mode: "HTML" }); sent++; }
      catch { failed++; }
    }
    res.json({ ok: true, sent, failed });
  } catch { res.status(500).json({ error: "Failed" }); }
});

// ── Activity Logs ─────────────────────────────────────────────────────────────

router.get("/logs", async (req, res) => {
  try {
    const { category, limit = "150" } = req.query as Record<string, string>;
    const validCats: LogCategory[] = ["general", "moderation", "security", "filter", "captcha", "settings"];
    const cat = validCats.includes(category as LogCategory) ? (category as LogCategory) : undefined;
    res.json(getRecentLogs(Math.min(parseInt(limit) || 150, 500), cat));
  } catch { res.status(500).json({ error: "Failed" }); }
});

export default router;
