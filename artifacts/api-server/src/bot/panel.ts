import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { isSuperAdmin, getSuperAdmins, isHardcodedSuper } from "./admin";
import {
  getGroupSettings, updateGroupSettings, getJoinMustList, addJoinMust, removeJoinMust, listGroups,
} from "./settings";
import { getLocks, addLock, removeLock } from "./content";
import { LOCK_TYPES, type LockType } from "./constants";
import {
  banUser, unbanUser, muteUser, unmuteUser,
  addWarning, removeOneWarning, resetWarnings, applyAutoActionIfNeeded,
  trackRestriction, removeRestriction, listGroupRestrictions,
  listGlobalBans, listGlobalMutes,
} from "./moderation";
import { approveUser, unapproveUser, isApproved, listApproved, unapproveAll } from "./approvals";
import { parseDuration, formatDuration, escapeHtml } from "./utils";
import { logMod, logSettings, logSecurity } from "./logging";
import { getLogChannel } from "./logging";
import { listAuthKeys } from "./auth";
import { db, warningsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ── Pending text-input state ───────────────────────────────────────────────────

export interface PendingInput {
  type: "welcome_msg" | "bl_word" | "jm_add" | "filter_kw" | "filter_reply" | "note_name" | "note_content";
  chatId: number;
  groupName: string;
  data?: Record<string, string>;
}

export const pendingPanelInput = new Map<number, PendingInput>();

// ── Local helpers ─────────────────────────────────────────────────────────────

function ul(userId: number, name: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

async function getMemberName(api: any, chatId: number, userId: number): Promise<string> {
  try {
    const m = await api.getChatMember(chatId, userId);
    const u = m.user;
    return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(userId);
  } catch { return String(userId); }
}

async function isCallerAdmin(ctx: any, chatId: number): Promise<boolean> {
  const id = ctx.from?.id;
  if (!id) return false;
  if (await isSuperAdmin(id)) return true;
  try {
    const m = await ctx.api.getChatMember(chatId, id);
    return m.status === "administrator" || m.status === "creator";
  } catch { return false; }
}

function cb(...parts: (string | number)[]): string {
  return parts.join("|");
}

// ── Panel builders ────────────────────────────────────────────────────────────

async function buildMain(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  return {
    text: `⚙️ <b>Control Panel</b>\n📌 <i>${escapeHtml(title)}</i>`,
    kb: new InlineKeyboard()
      .text("🛡️ Moderation", cb("p|mod", chatId)).text("⚙️ Settings", cb("p|set", chatId)).row()
      .text("🔒 Locks", cb("p|lck", chatId)).text("🔐 Security", cb("p|sec", chatId)).row()
      .text("📋 Content", cb("p|cnt", chatId)).text("✅ Approvals", cb("p|apr", chatId)).row()
      .text("🔗 Joinmust", cb("p|jm", chatId)).row()
      .text("❌ Close", "p|close"),
  };
}

async function buildUserPanel(api: any, chatId: number, title: string, userId: number, userName: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const warns = await db.select().from(warningsTable)
    .where(and(eq(warningsTable.groupId, chatId), eq(warningsTable.userId, userId))).limit(1);
  const wCount = warns[0]?.count ?? 0;
  const [s, approved] = await Promise.all([getGroupSettings(chatId), isApproved(chatId, userId)]);
  return {
    text: `👤 <b>Actions for ${ul(userId, userName)}</b>\n📌 ${escapeHtml(title)}\n⚠️ Warns: <b>${wCount}/${s.warnLimit}</b> · ${approved ? "✅ Approved" : "Not approved"}`,
    kb: new InlineKeyboard()
      .text("⚠️ Warn", cb("p|w", chatId, userId)).text("↩️ Unwarn", cb("p|uw", chatId, userId)).text("🔄 Reset warns", cb("p|rw", chatId, userId)).row()
      .text("🔇 1h", cb("p|m", chatId, userId, 3600)).text("🔇 12h", cb("p|m", chatId, userId, 43200)).text("🔇 24h", cb("p|m", chatId, userId, 86400)).text("🔇 ∞", cb("p|m", chatId, userId, 0)).row()
      .text("⛔ 1d", cb("p|b", chatId, userId, 86400)).text("⛔ 7d", cb("p|b", chatId, userId, 604800)).text("⛔ ∞", cb("p|b", chatId, userId, 0)).row()
      .text("👢 Kick", cb("p|k", chatId, userId)).text("🔈 Unmute", cb("p|um", chatId, userId)).text("✅ Unban", cb("p|ub", chatId, userId)).row()
      .text(approved ? "🔓 Unapprove" : "✅ Approve", approved ? cb("p|ua", chatId, userId) : cb("p|ap", chatId, userId)).row()
      .text("👑 Promote", cb("p|pm", chatId, userId)).text("⬇️ Demote", cb("p|dm", chatId, userId)).row()
      .text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildMod(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const [bans, mutes, s] = await Promise.all([
    listGroupRestrictions(chatId, "ban"),
    listGroupRestrictions(chatId, "mute"),
    getGroupSettings(chatId),
  ]);
  const warnDur = s.warnDurationSec ? formatDuration(s.warnDurationSec) : "perm";
  return {
    text: `🛡️ <b>Moderation</b>\n📌 ${escapeHtml(title)}\n\n⛔ Active bans: <b>${bans.length}</b>\n🔇 Active mutes: <b>${mutes.length}</b>\n⚠️ Warn limit: <b>${s.warnLimit}</b> → ${s.warnAction} (${warnDur})`,
    kb: new InlineKeyboard()
      .text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildSettings(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const s = await getGroupSettings(chatId);
  const warnDur = s.warnDurationSec ? formatDuration(s.warnDurationSec) : "perm";
  const floodDur = s.floodActionDurationSec ? formatDuration(s.floodActionDurationSec) : "perm";
  return {
    text: `⚙️ <b>Settings</b>\n📌 ${escapeHtml(title)}\n\n` +
      `⚠️ Warns: <b>${s.warnLimit}</b> hits → ${s.warnAction} (${warnDur})\n` +
      `🌊 Flood: <b>${s.floodEnabled ? `ON · ${s.floodLimit}/${s.floodWindowSec}s → ${s.floodAction}` : "OFF"}</b>\n` +
      `👋 Welcome: <b>${s.welcomeEnabled ? "ON" : "OFF"}</b>`,
    kb: new InlineKeyboard()
      .text("⚠️ Warn Settings", cb("p|wset", chatId)).row()
      .text(s.floodEnabled ? "🌊 Flood: ON" : "🌊 Flood: OFF", cb("p|tg", chatId, "flood")).text("✏️ Flood config", cb("p|fset", chatId)).row()
      .text(s.welcomeEnabled ? "👋 Welcome: ON" : "👋 Welcome: OFF", cb("p|tg", chatId, "welcome")).text("✏️ Set welcome", cb("p|inp", chatId, "welcome_msg")).row()
      .text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildWarnSet(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const s = await getGroupSettings(chatId);
  const warnDur = s.warnDurationSec ? formatDuration(s.warnDurationSec) : "perm";
  return {
    text: `⚠️ <b>Warn Settings</b>\n📌 ${escapeHtml(title)}\n\nLimit: <b>${s.warnLimit}</b> · Action: <b>${s.warnAction}</b> · Duration: <b>${warnDur}</b>`,
    kb: new InlineKeyboard()
      .text("2 hits", cb("p|wl", chatId, 2)).text("3 hits", cb("p|wl", chatId, 3)).text("4 hits", cb("p|wl", chatId, 4)).text("5 hits", cb("p|wl", chatId, 5)).row()
      .text("→ Mute", cb("p|wa", chatId, "mute")).text("→ Ban", cb("p|wa", chatId, "ban")).text("→ Kick", cb("p|wa", chatId, "kick")).row()
      .text("1h", cb("p|wd", chatId, 3600)).text("12h", cb("p|wd", chatId, 43200)).text("24h", cb("p|wd", chatId, 86400)).text("7d", cb("p|wd", chatId, 604800)).text("Perm", cb("p|wd", chatId, 0)).row()
      .text("⬅️ Back", cb("p|set", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildFloodSet(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const s = await getGroupSettings(chatId);
  const floodDur = s.floodActionDurationSec ? formatDuration(s.floodActionDurationSec) : "perm";
  return {
    text: `🌊 <b>Flood Settings</b>\n📌 ${escapeHtml(title)}\n\nStatus: <b>${s.floodEnabled ? "ON" : "OFF"}</b> · Limit: <b>${s.floodLimit}</b> msg / <b>${s.floodWindowSec}s</b> → ${s.floodAction} (${floodDur})`,
    kb: new InlineKeyboard()
      .text("Limit: 3", cb("p|fl", chatId, 3)).text("Limit: 5", cb("p|fl", chatId, 5)).text("Limit: 8", cb("p|fl", chatId, 8)).text("Limit: 10", cb("p|fl", chatId, 10)).row()
      .text("Window: 5s", cb("p|fw", chatId, 5)).text("Window: 10s", cb("p|fw", chatId, 10)).text("Window: 15s", cb("p|fw", chatId, 15)).text("Window: 30s", cb("p|fw", chatId, 30)).row()
      .text("→ Mute", cb("p|fa", chatId, "mute")).text("→ Ban", cb("p|fa", chatId, "ban")).text("→ Kick", cb("p|fa", chatId, "kick")).row()
      .text("Dur: 10m", cb("p|fd", chatId, 600)).text("Dur: 1h", cb("p|fd", chatId, 3600)).text("Dur: 24h", cb("p|fd", chatId, 86400)).text("Dur: Perm", cb("p|fd", chatId, 0)).row()
      .text("⬅️ Back", cb("p|set", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildLocks(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const [active, s] = await Promise.all([getLocks(chatId), getGroupSettings(chatId)]);
  const lines = LOCK_TYPES.map((t) => `${active.has(t) ? "🔒" : "🔓"} ${t}`).join("  ");
  const lockDur = s.lockActionDurationSec ? formatDuration(s.lockActionDurationSec) : "perm";
  const kb = new InlineKeyboard();
  for (let i = 0; i < LOCK_TYPES.length; i += 3) {
    const row = LOCK_TYPES.slice(i, i + 3);
    for (const t of row) kb.text(`${active.has(t) ? "🔒" : "🔓"} ${t}`, cb("p|lktg", chatId, t));
    kb.row();
  }
  kb
    .text("⚡ none", cb("p|la", chatId, "none")).text("⚡ warn", cb("p|la", chatId, "warn")).text("⚡ mute", cb("p|la", chatId, "mute")).text("⚡ kick", cb("p|la", chatId, "kick")).text("⚡ ban", cb("p|la", chatId, "ban")).row()
    .text("After 1x", cb("p|ll", chatId, 1)).text("After 2x", cb("p|ll", chatId, 2)).text("After 3x", cb("p|ll", chatId, 3)).row()
    .text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close");
  return {
    text: `🔒 <b>Locks</b>\n📌 ${escapeHtml(title)}\n\n${lines}\n\n⚡ Lock action: after <b>${s.lockActionLimit}</b> violation(s) → <b>${s.lockAction}</b> (${lockDur})`,
    kb,
  };
}

async function buildSecurity(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const s = await getGroupSettings(chatId);
  return {
    text: `🔐 <b>Security</b>\n📌 ${escapeHtml(title)}\n\n` +
      `🤖 Captcha: <b>${s.captchaEnabled ? `ON · ${s.captchaType} · ${s.captchaTimeoutSec}s timeout` : "OFF"}</b>\n` +
      `🤖 Antibot: <b>${s.antibot ? "ON" : "OFF"}</b>\n` +
      `📢 Antichannel: <b>${s.antichannel ? "ON" : "OFF"}</b>`,
    kb: new InlineKeyboard()
      .text(s.captchaEnabled ? "🔐 Captcha: ON" : "🔐 Captcha: OFF", cb("p|tg", chatId, "captcha")).row()
      .text(`📝 Math${s.captchaType === "math" ? " ✓" : ""}`, cb("p|ct", chatId, "math")).text(`🔘 Button${s.captchaType === "button" ? " ✓" : ""}`, cb("p|ct", chatId, "button")).row()
      .text("⏱ 60s", cb("p|cto", chatId, 60)).text("⏱ 120s", cb("p|cto", chatId, 120)).text("⏱ 180s", cb("p|cto", chatId, 180)).text("⏱ 300s", cb("p|cto", chatId, 300)).row()
      .text(s.antibot ? "🤖 Antibot: ON" : "🤖 Antibot: OFF", cb("p|tg", chatId, "antibot")).row()
      .text(s.antichannel ? "📢 Antichannel: ON" : "📢 Antichannel: OFF", cb("p|tg", chatId, "antichannel")).row()
      .text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildContent(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const s = await getGroupSettings(chatId);
  const blDur = s.blacklistDurationSec ? formatDuration(s.blacklistDurationSec) : "perm";
  return {
    text: `📋 <b>Content</b>\n📌 ${escapeHtml(title)}\n\n` +
      `🚫 Blacklist: action=<b>${s.blacklistAction}</b> · ${s.blacklistThreshold} hits · ${blDur}\n` +
      `🌐 Global BL sync: <b>${s.globalBlacklistEnabled ? "ON" : "OFF"}</b>\n\n` +
      `<i>To manage words, filters and notes, use the Web Admin Panel for better experience.</i>`,
    kb: new InlineKeyboard()
      .text("🚫 → Mute", cb("p|bla", chatId, "mute")).text("🚫 → Ban", cb("p|bla", chatId, "ban")).text("🚫 → Kick", cb("p|bla", chatId, "kick")).row()
      .text("Hits: 1", cb("p|blt", chatId, 1)).text("Hits: 2", cb("p|blt", chatId, 2)).text("Hits: 3", cb("p|blt", chatId, 3)).text("Hits: 5", cb("p|blt", chatId, 5)).row()
      .text(s.globalBlacklistEnabled ? "🌐 Global BL: ON" : "🌐 Global BL: OFF", cb("p|tg", chatId, "gbl")).row()
      .text("➕ Add BL word", cb("p|inp", chatId, "bl_word")).row()
      .text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close"),
  };
}

async function buildApprovals(api: any, chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const list = await listApproved(chatId);
  let lines = "No approved users.";
  if (list.length > 0) {
    const names = await Promise.all(list.slice(0, 8).map(async (a) => {
      const n = await getMemberName(api, chatId, a.userId);
      return `• ${escapeHtml(n)} (<code>${a.userId}</code>)`;
    }));
    lines = names.join("\n");
    if (list.length > 8) lines += `\n<i>…and ${list.length - 8} more</i>`;
  }
  const kb = new InlineKeyboard();
  if (list.length > 0) kb.text("🗑️ Clear all approvals", cb("p|uaall", chatId)).row();
  kb.text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close");
  return { text: `✅ <b>Approvals (${list.length})</b>\n📌 ${escapeHtml(title)}\n\n${lines}`, kb };
}

async function buildJoinmust(chatId: number, title: string): Promise<{ text: string; kb: InlineKeyboard }> {
  const list = await getJoinMustList(chatId);
  let lines = "No requirements set.";
  if (list.length > 0)
    lines = list.map((j) => `• ${j.targetUsername ? `@${j.targetUsername}` : ""} <code>${j.targetId}</code>`).join("\n");
  const kb = new InlineKeyboard().text("➕ Add requirement", cb("p|inp", chatId, "jm_add")).row();
  for (const j of list) {
    const label = j.targetUsername ? `❌ @${j.targetUsername}` : `❌ ${j.targetId}`;
    const d = cb("p|rmjm", chatId, j.targetId);
    if (d.length <= 64) kb.text(label, d).row();
  }
  kb.text("⬅️ Back", cb("p|home", chatId)).text("❌ Close", "p|close");
  return {
    text: `🔗 <b>Joinmust (${list.length})</b>\n📌 ${escapeHtml(title)}\n\nNew members are muted until they join all listed channels.\n\n${lines}`,
    kb,
  };
}

// ── Super-Admin PM panels ─────────────────────────────────────────────────────

async function buildSAMain(): Promise<{ text: string; kb: InlineKeyboard }> {
  const [supers, groups] = await Promise.all([getSuperAdmins(), listGroups()]);
  const active = groups.filter((g) => !g.banned && g.authorized).length;
  return {
    text: `👑 <b>Super Admin Panel</b>\n\n👥 Super Admins: <b>${supers.size}</b>\n🏘 Active groups: <b>${active}</b> / ${groups.length}`,
    kb: new InlineKeyboard()
      .text("📋 Groups", "p|sa|grps").text("👥 Super Admins", "p|sa|supers").row()
      .text("🔑 Auth Keys", "p|sa|keys").text("🌍 Global Bans/Mutes", "p|sa|gbans").row()
      .text("📡 Log Status", "p|sa|log").row()
      .text("❌ Close", "p|close"),
  };
}

async function buildSAGroups(): Promise<{ text: string; kb: InlineKeyboard }> {
  const groups = await listGroups();
  const lines = groups.slice(0, 25).map((g) =>
    `${g.banned ? "🚫" : g.authorized ? "✅" : "⏳"} <code>${g.groupId}</code> — ${escapeHtml(g.title || "?")}`,
  );
  const text = `📋 <b>Groups (${groups.length})</b>\n\n${lines.join("\n")}${groups.length > 25 ? `\n…+${groups.length - 25} more` : ""}`;
  return { text, kb: new InlineKeyboard().text("⬅️ Back", "p|sa|home").text("❌ Close", "p|close") };
}

async function buildSASupers(): Promise<{ text: string; kb: InlineKeyboard }> {
  const supers = await getSuperAdmins();
  const lines = [...supers].map((id) => `• <code>${id}</code>${isHardcodedSuper(id) ? " 🔒" : ""}`);
  return {
    text: `👥 <b>Super Admins (${supers.size})</b>\n\n${lines.join("\n")}`,
    kb: new InlineKeyboard().text("⬅️ Back", "p|sa|home").text("❌ Close", "p|close"),
  };
}

async function buildSAKeys(): Promise<{ text: string; kb: InlineKeyboard }> {
  const keys = await listAuthKeys();
  const now = Date.now();
  const lines = keys.map((k) => {
    const expired = k.expiresAt && k.expiresAt.getTime() < now;
    const done = k.usedCount >= k.maxUses;
    const st = expired ? "❌" : done ? "✅" : "🟢";
    const exp = k.expiresAt ? k.expiresAt.toISOString().slice(0, 10) : "∞";
    return `${st} <code>${k.key}</code> · ${k.usedCount}/${k.maxUses} · exp ${exp}`;
  });
  return {
    text: `🔑 <b>Auth Keys (${keys.length})</b>\n\n${lines.join("\n") || "No keys."}`,
    kb: new InlineKeyboard().text("⬅️ Back", "p|sa|home").text("❌ Close", "p|close"),
  };
}

async function buildSAGbans(): Promise<{ text: string; kb: InlineKeyboard }> {
  const [bans, mutes] = await Promise.all([listGlobalBans(), listGlobalMutes()]);
  const bLines = bans.slice(0, 10).map((b) => `⛔ <code>${b.userId}</code>${b.until ? ` → ${b.until.toISOString().slice(0, 10)}` : " (perm)"}`);
  const mLines = mutes.slice(0, 10).map((m) => `🔇 <code>${m.userId}</code>${m.until ? ` → ${m.until.toISOString().slice(0, 10)}` : " (perm)"}`);
  return {
    text: `🌍 <b>Global Actions</b>\n\n⛔ Bans (${bans.length}):\n${bLines.join("\n") || "none"}\n\n🔇 Mutes (${mutes.length}):\n${mLines.join("\n") || "none"}`,
    kb: new InlineKeyboard().text("⬅️ Back", "p|sa|home").text("❌ Close", "p|close"),
  };
}

async function buildSALog(): Promise<{ text: string; kb: InlineKeyboard }> {
  const ch = await getLogChannel();
  return {
    text: `📡 <b>Log Channel</b>\n\n${ch ? `Target: <code>${ch}</code>` : "No log channel set.\n\nUse /setlog [channelId] to configure."}`,
    kb: new InlineKeyboard().text("⬅️ Back", "p|sa|home").text("❌ Close", "p|close"),
  };
}

// ── Helper: edit or reply with panel ─────────────────────────────────────────

async function sendOrEdit(ctx: any, text: string, kb: InlineKeyboard) {
  const opts = { parse_mode: "HTML" as const, reply_markup: kb };
  if (ctx.callbackQuery) {
    try { await ctx.editMessageText(text, opts); } catch { /* already same content */ }
  } else {
    await ctx.reply(text, opts);
  }
}

// ── Public: open panel (called from /cp command) ──────────────────────────────

export async function openGroupPanel(ctx: any, chatId: number, chatTitle: string, replyUserId?: number, replyUserName?: string) {
  if (replyUserId && replyUserName) {
    const { text, kb } = await buildUserPanel(ctx.api, chatId, chatTitle, replyUserId, replyUserName);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  } else {
    const { text, kb } = await buildMain(chatId, chatTitle);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

export async function openSAPanel(ctx: any) {
  const { text, kb } = await buildSAMain();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

// ── Text input processor (call from message handler in index.ts) ──────────────

export async function processPanelInput(ctx: any): Promise<boolean> {
  if (ctx.chat?.type !== "private") return false;
  const userId = ctx.from?.id;
  if (!userId) return false;
  const pending = pendingPanelInput.get(userId);
  if (!pending) return false;

  pendingPanelInput.delete(userId);
  const text = ctx.message?.text?.trim() || "";

  if (!text) {
    await ctx.reply("❌ Empty input — action cancelled.");
    return true;
  }

  const { type, chatId, groupName } = pending;

  if (type === "welcome_msg") {
    await updateGroupSettings(chatId, { welcomeEnabled: true, welcomeMessage: text });
    const preview = text.replace(/\{name\}/gi, "John").replace(/\{username\}/gi, "@john").replace(/\{id\}/gi, "123456").replace(/\{group\}/gi, groupName);
    await ctx.reply(`✅ <b>Welcome message set for ${escapeHtml(groupName)}</b>\n\n<b>Preview:</b>\n${preview}`, { parse_mode: "HTML" });
    await logSettings(ctx.api, `👋 <b>Welcome set</b> for <code>${chatId}</code> by <code>${userId}</code>`);
  } else if (type === "bl_word") {
    const { addBlacklistWord } = await import("./content");
    await addBlacklistWord(chatId, text);
    await ctx.reply(`✅ <b>Blacklisted</b> word: <code>${escapeHtml(text)}</code> in <b>${escapeHtml(groupName)}</b>`, { parse_mode: "HTML" });
  } else if (type === "jm_add") {
    const raw = text.replace(/^@/, "");
    const isId = /^-?\d+$/.test(raw);
    let targetId: number | null = null;
    let targetUsername: string | null = null;
    if (isId) {
      targetId = parseInt(raw, 10);
    } else {
      targetUsername = raw;
      try {
        const chatInfo = await ctx.api.getChat(`@${raw}`);
        targetId = chatInfo.id;
      } catch {
        await ctx.reply(`❌ Could not find @${raw}. Make sure the bot is a member of that channel.`);
        return true;
      }
    }
    if (!targetId) { await ctx.reply("❌ Invalid ID."); return true; }
    await addJoinMust(chatId, targetId, targetUsername);
    await ctx.reply(`✅ <b>Joinmust added</b>: ${targetUsername ? `@${targetUsername}` : ""} <code>${targetId}</code> for <b>${escapeHtml(groupName)}</b>`, { parse_mode: "HTML" });
    await logSettings(ctx.api, `🔗 <b>Joinmust added:</b> <code>${targetId}</code> for <code>${chatId}</code> by <code>${userId}</code>`);
  }

  return true;
}

// ── Register all panel callback handlers ──────────────────────────────────────

export function registerPanelHandlers(bot: Bot) {

  // Helper: get cached group title from chat info
  async function getTitle(api: any, chatId: number): Promise<string> {
    try { const c = await api.getChat(chatId); return ("title" in c ? c.title : "") || String(chatId); }
    catch { return String(chatId); }
  }

  // ── Main panel (home) ──────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|home\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildMain(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  // ── Moderation panel ───────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|mod\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildMod(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  // ── Settings panel ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|set\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildSettings(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  // ── Warn settings panel ────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|wset\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildWarnSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|wl\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, limit] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { warnLimit: limit });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildWarnSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Warn limit set to ${limit}` });
  });

  bot.callbackQuery(/^p\|wa\|(-?\d+)\|(mute|ban|kick)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const action = ctx.match[2]! as "mute" | "ban" | "kick";
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { warnAction: action });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildWarnSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Warn action: ${action}` });
  });

  bot.callbackQuery(/^p\|wd\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, dur] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { warnDurationSec: dur });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildWarnSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Warn duration: ${dur ? formatDuration(dur) : "permanent"}` });
  });

  // ── Flood settings panel ───────────────────────────────────────────────────
  bot.callbackQuery(/^p\|fset\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildFloodSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|fl\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, limit] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { floodEnabled: true, floodLimit: limit });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildFloodSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Flood limit: ${limit} messages` });
  });

  bot.callbackQuery(/^p\|fw\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, win] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { floodWindowSec: win });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildFloodSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Flood window: ${win}s` });
  });

  bot.callbackQuery(/^p\|fa\|(-?\d+)\|(mute|ban|kick)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const action = ctx.match[2]! as "mute" | "ban" | "kick";
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { floodAction: action });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildFloodSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Flood action: ${action}` });
  });

  bot.callbackQuery(/^p\|fd\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, dur] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { floodActionDurationSec: dur });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildFloodSet(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Flood duration: ${dur ? formatDuration(dur) : "permanent"}` });
  });

  // ── Locks panel ────────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|lck\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildLocks(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|lktg\|(-?\d+)\|(\w+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const type = ctx.match[2]! as LockType;
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    if (!LOCK_TYPES.includes(type)) { await ctx.answerCallbackQuery({ text: "Unknown lock type." }); return; }
    const active = await getLocks(chatId);
    if (active.has(type)) {
      await removeLock(chatId, type);
      await logSettings(ctx.api, `🔓 Lock removed: ${type} in <code>${chatId}</code>`);
    } else {
      await addLock(chatId, type);
      await logSettings(ctx.api, `🔒 Lock added: ${type} in <code>${chatId}</code>`);
    }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildLocks(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `${active.has(type) ? "🔓 Unlocked" : "🔒 Locked"}: ${type}` });
  });

  bot.callbackQuery(/^p\|la\|(-?\d+)\|(ban|mute|warn|kick|none)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const action = ctx.match[2]!;
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { lockAction: action });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildLocks(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Lock action: ${action}` });
  });

  bot.callbackQuery(/^p\|ll\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, limit] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { lockActionLimit: limit });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildLocks(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Lock violations limit: ${limit}` });
  });

  // ── Security panel ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|sec\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildSecurity(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|ct\|(-?\d+)\|(math|button)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const type = ctx.match[2]! as "math" | "button";
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { captchaType: type });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildSecurity(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Captcha type: ${type}` });
  });

  bot.callbackQuery(/^p\|cto\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, timeout] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { captchaTimeoutSec: timeout });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildSecurity(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Captcha timeout: ${timeout}s` });
  });

  // ── Content panel ──────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|cnt\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildContent(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|bla\|(-?\d+)\|(mute|ban|kick)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const action = ctx.match[2]! as "mute" | "ban" | "kick";
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { blacklistAction: action });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildContent(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ BL action: ${action}` });
  });

  bot.callbackQuery(/^p\|blt\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, threshold] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await updateGroupSettings(chatId, { blacklistThreshold: threshold });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildContent(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ BL threshold: ${threshold} hits` });
  });

  // ── Approvals panel ────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|apr\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildApprovals(ctx.api, chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|uaall\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const count = await unapproveAll(chatId);
    await ctx.answerCallbackQuery({ text: `✅ Removed ${count} approval(s)`, show_alert: true });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildApprovals(ctx.api, chatId, title);
    await sendOrEdit(ctx, text, kb);
  });

  // ── Joinmust panel ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|jm\|(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildJoinmust(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^p\|rmjm\|(-?\d+)\|(-?\d+)$/, async (ctx) => {
    const [chatId, targetId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await removeJoinMust(chatId, targetId);
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildJoinmust(chatId, title);
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery({ text: `✅ Removed joinmust for ${targetId}` });
  });

  // ── Toggle settings ────────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|tg\|(-?\d+)\|(\w+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const key = ctx.match[2]!;
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const s = await getGroupSettings(chatId);
    const title = await getTitle(ctx.api, chatId);
    const toggleMap: Record<string, string> = {
      flood: "floodEnabled", captcha: "captchaEnabled", antibot: "antibot",
      antichannel: "antichannel", welcome: "welcomeEnabled", gbl: "globalBlacklistEnabled",
    };
    const field = toggleMap[key];
    if (!field) { await ctx.answerCallbackQuery({ text: "Unknown setting." }); return; }
    const cur = (s as any)[field] as boolean;
    await updateGroupSettings(chatId, { [field]: !cur });
    await ctx.answerCallbackQuery({ text: `${!cur ? "✅ Enabled" : "❌ Disabled"}: ${key}` });
    // Refresh appropriate panel
    if (key === "flood" || key === "welcome") {
      const { text, kb } = await buildSettings(chatId, title);
      await sendOrEdit(ctx, text, kb);
    } else if (key === "captcha" || key === "antibot" || key === "antichannel") {
      const { text, kb } = await buildSecurity(chatId, title);
      await sendOrEdit(ctx, text, kb);
    } else if (key === "gbl") {
      const { text, kb } = await buildContent(chatId, title);
      await sendOrEdit(ctx, text, kb);
    }
  });

  // ── Text-input requests ────────────────────────────────────────────────────
  bot.callbackQuery(/^p\|inp\|(-?\d+)\|(\w+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]!, 10);
    const inputType = ctx.match[2]! as PendingInput["type"];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const userId = ctx.from.id;
    const title = await getTitle(ctx.api, chatId);
    const prompts: Record<string, string> = {
      welcome_msg: `✏️ <b>Set welcome message for ${escapeHtml(title)}</b>\n\nSend me the welcome text now.\nPlaceholders: {name}, {username}, {id}, {group}\nHTML formatting supported.\n\n/cancel to abort.`,
      bl_word: `✏️ <b>Add blacklisted word for ${escapeHtml(title)}</b>\n\nSend me the word/phrase to blacklist.\n\n/cancel to abort.`,
      jm_add: `✏️ <b>Add joinmust requirement for ${escapeHtml(title)}</b>\n\nSend me the channel @username or numeric ID.\nExample: @mychannel  or  -1001234567890\n\n/cancel to abort.`,
    };
    const prompt = prompts[inputType];
    if (!prompt) { await ctx.answerCallbackQuery({ text: "Unknown input type." }); return; }
    try {
      await ctx.api.sendMessage(userId, prompt, { parse_mode: "HTML" });
      pendingPanelInput.set(userId, { type: inputType, chatId, groupName: title });
      await ctx.answerCallbackQuery({ text: "📬 Check your DMs!" });
    } catch {
      await ctx.answerCallbackQuery({ text: "❌ Start a DM with me first to use this feature.", show_alert: true });
    }
  });

  // ── User action handlers ───────────────────────────────────────────────────

  bot.callbackQuery(/^p\|w\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const count = await addWarning(chatId, userId);
    const s = await getGroupSettings(chatId);
    const name = await getMemberName(ctx.api, chatId, userId);
    if (count >= s.warnLimit) {
      const action = await applyAutoActionIfNeeded(ctx, chatId, userId, count);
      await ctx.answerCallbackQuery({ text: `🚨 Warn limit! (${count}/${s.warnLimit})${action ? ` → ${action}` : ""}`, show_alert: true });
    } else {
      await ctx.answerCallbackQuery({ text: `⚠️ Warned ${name} (${count}/${s.warnLimit})` });
    }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|uw\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const count = await removeOneWarning(chatId, userId);
    const name = await getMemberName(ctx.api, chatId, userId);
    const s = await getGroupSettings(chatId);
    await ctx.answerCallbackQuery({ text: `↩️ Warning removed. Now: ${count}/${s.warnLimit}` });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|rw\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    await resetWarnings(chatId, userId);
    const name = await getMemberName(ctx.api, chatId, userId);
    await ctx.answerCallbackQuery({ text: `🔄 Warns reset for ${name}` });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|m\|(-?\d+)\|(\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId, dur] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10), parseInt(ctx.match[3]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    try {
      await muteUser(ctx, chatId, userId, dur);
      void trackRestriction(chatId, userId, "mute", dur);
      await logMod(ctx.api, `🔇 <b>Mute (panel):</b> <code>${userId}</code> in <code>${chatId}</code> — ${formatDuration(dur)} by <code>${ctx.from.id}</code>`);
      await ctx.answerCallbackQuery({ text: `🔇 Muted ${name} (${formatDuration(dur)})` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|b\|(-?\d+)\|(\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId, dur] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10), parseInt(ctx.match[3]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    if (await isSuperAdmin(userId)) { await ctx.answerCallbackQuery({ text: "❌ Cannot ban a Super Admin." }); return; }
    try {
      await banUser(ctx, chatId, userId, dur);
      void trackRestriction(chatId, userId, "ban", dur);
      await logMod(ctx.api, `⛔ <b>Ban (panel):</b> <code>${userId}</code> in <code>${chatId}</code> — ${formatDuration(dur)} by <code>${ctx.from.id}</code>`);
      await ctx.answerCallbackQuery({ text: `⛔ Banned ${name} (${formatDuration(dur)})` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|k\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    if (await isSuperAdmin(userId)) { await ctx.answerCallbackQuery({ text: "❌ Cannot kick a Super Admin." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    try {
      await ctx.api.banChatMember(chatId, userId);
      await ctx.api.unbanChatMember(chatId, userId);
      await logMod(ctx.api, `👢 <b>Kick (panel):</b> <code>${userId}</code> from <code>${chatId}</code> by <code>${ctx.from.id}</code>`);
      await ctx.answerCallbackQuery({ text: `👢 Kicked ${name}` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildMain(chatId, title);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|um\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    try {
      await unmuteUser(ctx, chatId, userId);
      void removeRestriction(chatId, userId, "mute");
      await ctx.answerCallbackQuery({ text: `🔈 Unmuted ${name}` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|ub\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    try {
      await unbanUser(ctx, chatId, userId);
      void removeRestriction(chatId, userId, "ban");
      await ctx.answerCallbackQuery({ text: `✅ Unbanned ${name}` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|ap\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    await approveUser(chatId, userId, ctx.from.id);
    await logMod(ctx.api, `✅ <b>Approved (panel):</b> <code>${userId}</code> in <code>${chatId}</code> by <code>${ctx.from.id}</code>`);
    await ctx.answerCallbackQuery({ text: `✅ Approved ${name}` });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|ua\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    await unapproveUser(chatId, userId);
    await ctx.answerCallbackQuery({ text: `🔓 Unapproved ${name}` });
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|pm\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    try {
      await ctx.api.promoteChatMember(chatId, userId, {
        can_manage_chat: true, can_change_info: true, can_delete_messages: true,
        can_invite_users: true, can_restrict_members: true, can_pin_messages: true,
        can_manage_video_chats: true, is_anonymous: false,
      });
      await ctx.answerCallbackQuery({ text: `👑 Promoted ${name} to admin` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^p\|dm\|(-?\d+)\|(\d+)$/, async (ctx) => {
    const [chatId, userId] = [parseInt(ctx.match[1]!, 10), parseInt(ctx.match[2]!, 10)];
    if (!(await isCallerAdmin(ctx, chatId))) { await ctx.answerCallbackQuery({ text: "Admins only." }); return; }
    if (await isSuperAdmin(userId)) { await ctx.answerCallbackQuery({ text: "❌ Cannot demote a Super Admin." }); return; }
    const name = await getMemberName(ctx.api, chatId, userId);
    try {
      await ctx.api.promoteChatMember(chatId, userId, {
        can_manage_chat: false, can_change_info: false, can_delete_messages: false,
        can_invite_users: false, can_restrict_members: false, can_pin_messages: false,
        can_manage_video_chats: false, is_anonymous: false,
      });
      await ctx.answerCallbackQuery({ text: `⬇️ Demoted ${name}` });
    } catch (e: any) { await ctx.answerCallbackQuery({ text: `❌ ${e?.description || "Failed"}`, show_alert: true }); return; }
    const title = await getTitle(ctx.api, chatId);
    const { text, kb } = await buildUserPanel(ctx.api, chatId, title, userId, name);
    await sendOrEdit(ctx, text, kb);
  });

  // ── Super-admin PM panel ───────────────────────────────────────────────────

  bot.callbackQuery("p|sa|home", async (ctx) => {
    if (!(await isSuperAdmin(ctx.from.id))) { await ctx.answerCallbackQuery({ text: "Super Admins only." }); return; }
    const { text, kb } = await buildSAMain();
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("p|sa|grps", async (ctx) => {
    if (!(await isSuperAdmin(ctx.from.id))) { await ctx.answerCallbackQuery({ text: "Super Admins only." }); return; }
    const { text, kb } = await buildSAGroups();
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("p|sa|supers", async (ctx) => {
    if (!(await isSuperAdmin(ctx.from.id))) { await ctx.answerCallbackQuery({ text: "Super Admins only." }); return; }
    const { text, kb } = await buildSASupers();
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("p|sa|keys", async (ctx) => {
    if (!(await isSuperAdmin(ctx.from.id))) { await ctx.answerCallbackQuery({ text: "Super Admins only." }); return; }
    const { text, kb } = await buildSAKeys();
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("p|sa|gbans", async (ctx) => {
    if (!(await isSuperAdmin(ctx.from.id))) { await ctx.answerCallbackQuery({ text: "Super Admins only." }); return; }
    const { text, kb } = await buildSAGbans();
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("p|sa|log", async (ctx) => {
    if (!(await isSuperAdmin(ctx.from.id))) { await ctx.answerCallbackQuery({ text: "Super Admins only." }); return; }
    const { text, kb } = await buildSALog();
    await sendOrEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  // ── Close ──────────────────────────────────────────────────────────────────
  bot.callbackQuery("p|close", async (ctx) => {
    try { await ctx.deleteMessage(); } catch { await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}); }
    await ctx.answerCallbackQuery();
  });
}
