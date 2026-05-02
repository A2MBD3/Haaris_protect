import { Router, type Request, type Response, type NextFunction } from "express";
import { bot, getAdminPanelPassword } from "../bot";
import {
  listGroups, getGroupSettings, updateGroupSettings,
  setGroupBanned,
} from "../bot/settings";
import {
  listGlobalBans, setGlobalBan, removeGlobalBan,
  listGlobalMutes, setGlobalMute, removeGlobalMute,
} from "../bot/moderation";
import {
  getSuperAdmins, addSuperAdmin, removeSuperAdmin, isHardcodedSuper,
} from "../bot/admin";
import {
  createAuthKey, listAuthKeys, removeAuthKey, consumeAuthKey, authorizeGroup, deauthorizeGroup,
} from "../bot/auth";

const router = Router();

const serverStart = Date.now();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const adminPassword = getAdminPanelPassword();
  if (!token || token !== adminPassword) {
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
      const exhausted = k.usedCount >= k.maxUses;
      return !expired && !exhausted;
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
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch info" });
  }
});

// ── Groups ────────────────────────────────────────────────────────────────────

router.get("/groups", async (_req, res) => {
  try {
    const groups = await listGroups();
    const result = await Promise.all(
      groups.map(async (g) => ({ ...g, settings: await getGroupSettings(g.groupId) }))
    );
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to list groups" });
  }
});

router.put("/groups/:id/settings", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await updateGroupSettings(id, req.body);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to update settings" });
  }
});

router.post("/groups/:id/ban", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await setGroupBanned(id, true);
    try { await bot.api.sendMessage(id, "⚠️ This group has been banned from using the bot."); } catch {}
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to ban group" });
  }
});

router.post("/groups/:id/unban", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await setGroupBanned(id, false);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to unban group" });
  }
});

router.post("/groups/:id/leave", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deauthorizeGroup(id);
    try { await bot.api.sendMessage(id, "👋 Bot is leaving this group and authorization has been revoked."); } catch {}
    await bot.api.leaveChat(id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to leave group" });
  }
});

router.post("/groups/:id/authorize", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { key } = req.body as { key?: string };
    if (!key?.trim()) { res.status(400).json({ error: "key required" }); return; }
    const result = await consumeAuthKey(key.trim(), id);
    if (!result) { res.status(400).json({ error: "Invalid, expired, or used-up key" }); return; }
    try {
      await bot.api.sendMessage(id, "✅ This group has been authorized by an admin. The bot is now active here.");
    } catch {}
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to authorize group" });
  }
});

// ── Auth Keys ─────────────────────────────────────────────────────────────────

router.get("/keys", async (_req, res) => {
  try {
    res.json(await listAuthKeys());
  } catch {
    res.status(500).json({ error: "Failed to list keys" });
  }
});

router.post("/keys", async (req, res) => {
  try {
    const { maxUses = 1, expiresInDays = 30 } = req.body;
    const key = await createAuthKey(
      Math.max(1, expiresInDays) * 86400,
      Math.max(1, maxUses),
      0,
    );
    res.json(key);
  } catch {
    res.status(500).json({ error: "Failed to create key" });
  }
});

router.delete("/keys/:key", async (req, res) => {
  try {
    const ok = await removeAuthKey(req.params.key);
    res.json({ ok });
  } catch {
    res.status(500).json({ error: "Failed to delete key" });
  }
});

// ── Super Admins ──────────────────────────────────────────────────────────────

router.get("/supers", async (_req, res) => {
  try {
    const supers = await getSuperAdmins();
    res.json([...supers].map(id => ({ id, hardcoded: isHardcodedSuper(id) })));
  } catch {
    res.status(500).json({ error: "Failed to list super admins" });
  }
});

router.post("/supers", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) { res.status(400).json({ error: "userId required" }); return; }
    await addSuperAdmin(Number(userId));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to add super admin" });
  }
});

router.delete("/supers/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isHardcodedSuper(id)) { res.status(400).json({ error: "Cannot remove a hardcoded super admin" }); return; }
    await removeSuperAdmin(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to remove super admin" });
  }
});

// ── Global Bans ───────────────────────────────────────────────────────────────

router.get("/gbans", async (_req, res) => {
  try { res.json(await listGlobalBans()); } catch { res.status(500).json({ error: "Failed" }); }
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
  try {
    const ok = await removeGlobalBan(parseInt(req.params.id, 10));
    res.json({ ok });
  } catch { res.status(500).json({ error: "Failed" }); }
});

// ── Global Mutes ──────────────────────────────────────────────────────────────

router.get("/gmutes", async (_req, res) => {
  try { res.json(await listGlobalMutes()); } catch { res.status(500).json({ error: "Failed" }); }
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
  try {
    const ok = await removeGlobalMute(parseInt(req.params.id, 10));
    res.json({ ok });
  } catch { res.status(500).json({ error: "Failed" }); }
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

export default router;
