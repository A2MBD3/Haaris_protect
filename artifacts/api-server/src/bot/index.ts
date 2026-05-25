import { Bot, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { logger } from "../lib/logger";
import { HARDCODED_SUPER_ADMINS, LOCK_TYPES, type LockType } from "./constants";
import {
  ensureHardcodedSupers,
  isSuperAdmin,
  addSuperAdmin,
  removeSuperAdmin,
  isHardcodedSuper,
  getSuperAdmins,
} from "./admin";
import {
  banUser, unbanUser, muteUser, unmuteUser,
  addWarning, removeOneWarning, resetWarnings,
  applyAutoActionIfNeeded,
  setGlobalBan, isGloballyBanned, removeGlobalBan,
  setGlobalMute, removeGlobalMute, isGloballyMuted,
  getGlobalBanRow, getGlobalMuteRow,
  listGlobalBans, listGlobalMutes,
  trackRestriction, removeRestriction, countGroupRestrictions, listGroupRestrictions,
} from "./moderation";
import {
  addFilter, removeFilter, listFilters, findFilter,
  addBlacklistWord, removeBlacklistWord, listBlacklist,
  resetBlacklist, findBlacklisted, bumpBlacklistHit,
  resetBlacklistHits, addLock, removeLock, getLocks, violatesLock,
} from "./content";
import {
  getGroupSettings, updateGroupSettings, upsertGroup,
  setGroupBanned, isGroupBanned, listGroups,
  addJoinMust, removeJoinMust, getJoinMustList,
} from "./settings";
import {
  startCaptchaForJoin, deliverCaptchaToPrivate,
  checkCaptchaAnswer, startCaptchaWatcher,
} from "./captcha";
import {
  createAuthKey, listAuthKeys, removeAuthKey,
  consumeAuthKey, isGroupAuthorized, authorizeGroup,
  deauthorizeGroup, startAuthExpiryWatcher,
} from "./auth";
import {
  getLogChannel, setLogChannel, initLogTopics, resetAndRecreateTopics,
  logGeneral, logMod, logSecurity, logFilter, logCaptcha, logSettings,
} from "./logging";
import { startScheduler } from "./scheduler";
import { checkFlood, resetFlood } from "./flood";
import { saveNote, getNote, removeNote, listNotes } from "./notes";
import {
  approveUser, unapproveUser, isApproved,
  listApproved, unapproveAll,
} from "./approvals";
import { parseDuration, parseUserId, formatDuration, escapeHtml, fmtAdmin, fmtGroupCtx, fmtGroupById, fmtUser } from "./utils";
import { addTag, getUserTags, clearUserTags } from "./tags";
import { upsertUserSeen, getUserActivity } from "./activity";
import { db, warningsTable, authKeysTable, botConfigTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import { registerPanelHandlers, openGroupPanel, openSAPanel, processPanelInput, pendingPanelInput } from "./panel";

let _adminPasswordOverride: string | null = null;

export function getAdminPanelPassword(): string {
  if (_adminPasswordOverride !== null) return _adminPasswordOverride;
  const tok = process.env["TELEGRAM_BOT_TOKEN"] || "";
  return createHash("sha256").update("haaris:admin:" + tok).digest("hex").slice(0, 24);
}

export async function loadAdminPasswordOverride(): Promise<void> {
  const rows = await db.select().from(botConfigTable)
    .where(eq(botConfigTable.key, "admin_panel_password_override")).limit(1);
  _adminPasswordOverride = rows[0]?.value ?? null;
}

export async function setAdminPanelPassword(newPwd: string | null): Promise<void> {
  if (newPwd === null) {
    await db.delete(botConfigTable).where(eq(botConfigTable.key, "admin_panel_password_override"));
  } else {
    await db.insert(botConfigTable).values({ key: "admin_panel_password_override", value: newPwd })
      .onConflictDoUpdate({ target: botConfigTable.key, set: { value: newPwd } });
  }
  _adminPasswordOverride = newPwd;
}

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");

export const bot: Bot = new Bot(token);
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

let botUsername = "haarish_helpbot";

// ── Pending /edit sessions: superAdminId → {chatId, messageId, currentText} ──
const pendingEdits = new Map<number, { chatId: number; messageId: number; currentText: string }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function splitArgs(text: string | undefined): string[] {
  if (!text) return [];
  return text.split(/\s+/).slice(1).filter((x) => x.length > 0);
}

async function getMemberName(api: typeof bot.api, chatId: number, userId: number): Promise<string> {
  try {
    const m = await api.getChatMember(chatId, userId);
    const u = m.user;
    return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(userId);
  } catch {
    return String(userId);
  }
}

function userLink(userId: number, name: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
}

async function resolveTarget(ctx: any, args: string[]): Promise<{ id: number; name: string } | null> {
  const reply = ctx.message?.reply_to_message;
  if (reply?.from) {
    const u = reply.from;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
    return { id: u.id, name };
  }
  const entities = ctx.message?.entities || [];
  for (const e of entities) {
    if (e.type === "text_mention" && e.user) {
      const u = e.user;
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.id);
      return { id: u.id, name };
    }
  }
  for (const a of args) {
    const id = parseUserId(a);
    if (id !== null) {
      const name = ctx.chat?.id ? await getMemberName(ctx.api, ctx.chat.id, id) : String(id);
      return { id, name };
    }
  }
  return null;
}

/**
 * Resolves target + optional duration from command args.
 * Format: /cmd [id] [time]  — or reply to user: /cmd [time]
 * If replying, args[0] is treated as optional duration.
 * If not replying, args[0] is the target ID and args[1] is optional duration.
 */
async function resolveTargetAndDuration(ctx: any, args: string[]): Promise<{ target: { id: number; name: string } | null; durationSec: number }> {
  const reply = ctx.message?.reply_to_message;
  if (reply?.from) {
    const u = reply.from;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
    const durationSec = args.length > 0 ? (parseDuration(args[0]) ?? 0) : 0;
    return { target: { id: u.id, name }, durationSec };
  }
  const entities = ctx.message?.entities || [];
  for (const e of entities) {
    if (e.type === "text_mention" && e.user) {
      const u = e.user;
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.id);
      const durArg = args.find(a => parseDuration(a) !== null);
      const durationSec = durArg ? (parseDuration(durArg) ?? 0) : 0;
      return { target: { id: u.id, name }, durationSec };
    }
  }
  if (args.length === 0) return { target: null, durationSec: 0 };
  const id = parseUserId(args[0]);
  if (id === null) return { target: null, durationSec: 0 };
  const name = ctx.chat?.id ? await getMemberName(ctx.api, ctx.chat.id, id) : String(id);
  const durationSec = args.length > 1 ? (parseDuration(args[1]) ?? 0) : 0;
  return { target: { id, name }, durationSec };
}

async function senderIsGroupAdmin(ctx: any): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (await isSuperAdmin(userId)) return true;
  try {
    const m = await ctx.api.getChatMember(ctx.chat.id, userId);
    return m.status === "administrator" || m.status === "creator";
  } catch { return false; }
}

async function requireGroupAdmin(ctx: any): Promise<boolean> {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("❌ This command only works in groups.").catch(() => {});
    return false;
  }
  if (!(await senderIsGroupAdmin(ctx))) {
    await ctx.reply("❌ Only group admins can use this command.").catch(() => {});
    return false;
  }
  return true;
}

async function requireBotCan(ctx: any, right: string): Promise<boolean> {
  try {
    const me = await ctx.api.getMe();
    const m = await ctx.api.getChatMember(ctx.chat.id, me.id);
    if (m.status !== "administrator" && m.status !== "creator") {
      await ctx.reply("❌ I need to be an admin here.").catch(() => {});
      return false;
    }
    if ((m as any)[right] !== true) {
      const readable: Record<string, string> = {
        can_restrict_members: "Restrict Members",
        can_delete_messages: "Delete Messages",
        can_promote_members: "Add New Admins",
        can_invite_users: "Invite Users",
        can_pin_messages: "Pin Messages",
        can_change_info: "Change Group Info",
      };
      await ctx.reply(`❌ I need the "<b>${readable[right] || right}</b>" admin right.`, { parse_mode: "HTML" }).catch(() => {});
      return false;
    }
    return true;
  } catch {
    await ctx.reply("❌ Could not check my own permissions.").catch(() => {});
    return false;
  }
}

async function isBotAdminInChat(api: typeof bot.api, chatId: number): Promise<boolean> {
  try {
    const me = await api.getMe();
    const m = await api.getChatMember(chatId, me.id);
    return m.status === "administrator" || m.status === "creator";
  } catch { return false; }
}

async function isUserGroupAdmin(api: typeof bot.api, chatId: number, userId: number): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;
  try {
    const m = await api.getChatMember(chatId, userId);
    return m.status === "administrator" || m.status === "creator";
  } catch { return false; }
}

async function requireSuperAdmin(ctx: any): Promise<boolean> {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("❌ Super admin commands must be used in a private chat with the bot.").catch(() => {});
    return false;
  }
  const fromId = ctx.from?.id;
  if (!fromId || !(await isSuperAdmin(fromId))) {
    await ctx.reply("⛔ This command is for Super Admins only.").catch(() => {});
    return false;
  }
  return true;
}

// ── my_chat_member ────────────────────────────────────────────────────────────

bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.myChatMember.chat;
  const newStatus = ctx.myChatMember.new_chat_member.status;
  if (chat.type === "private") return;

  if (newStatus === "left" || newStatus === "kicked") {
    await deauthorizeGroup(chat.id).catch(() => {});
    await logGeneral(
      ctx.api,
      `🚪 <b>Bot removed:</b> from <code>${chat.id}</code> <i>${escapeHtml("title" in chat ? chat.title || "" : "")}</i> — authorization revoked`,
    );
    return;
  }

  await upsertGroup(chat.id, "title" in chat ? chat.title || "" : "");

  if (await isGroupBanned(chat.id)) {
    await ctx.api.sendMessage(chat.id, "🚫 This group is banned from using this bot.").catch(() => {});
    await ctx.api.leaveChat(chat.id).catch(() => {});
    return;
  }

  if (newStatus !== "administrator" && newStatus !== "creator") {
    await ctx.api.sendMessage(chat.id, "⚠️ Make me an admin with Ban/Restrict/Delete rights.").catch(() => {});
    await ctx.api.leaveChat(chat.id).catch(() => {});
    return;
  }

  if (!(await isGroupAuthorized(chat.id))) {
    await ctx.api
      .sendMessage(
        chat.id,
        `🔑 <b>Token required</b>\n\nThis group must be authorized before I can work here.\nA group admin must run:\n\n<code>/redeem YOUR_TOKEN</code>\n\nContact a Super Admin to obtain a token.`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    await logGeneral(
      ctx.api,
      `➕ <b>Bot added to group:</b> <code>${chat.id}</code> <i>${escapeHtml("title" in chat ? chat.title || "" : "")}</i> — awaiting token`,
    );
  } else {
    await ctx.api.sendMessage(chat.id, "✅ Bot is active and ready.").catch(() => {});
    await logGeneral(
      ctx.api,
      `✅ <b>Bot re-added as admin:</b> <code>${chat.id}</code> <i>${escapeHtml("title" in chat ? chat.title || "" : "")}</i>`,
    );
  }
});

// ── New member joins ──────────────────────────────────────────────────────────

async function handleNewMember(ctx: any, chatId: number, user: any, chatTitle: string) {
  if (await isGroupBanned(chatId)) return;
  if (!(await isGroupAuthorized(chatId))) return;
  if (!(await isBotAdminInChat(ctx.api, chatId))) return;

  const settings = await getGroupSettings(chatId);

  if (user.is_bot) {
    if (settings.antibot && user.id !== ctx.me?.id) {
      try {
        await ctx.api.banChatMember(chatId, user.id);
        await logSecurity(ctx.api, `🤖 <b>Antibot kicked:</b> @${escapeHtml(user.username || String(user.id))} in <code>${chatId}</code>`);
      } catch (err) {
        logger.warn({ err }, "Antibot ban failed");
      }
    }
    return;
  }

  if (await isGloballyBanned(user.id)) {
    await ctx.api.banChatMember(chatId, user.id).catch(() => {});
    await logSecurity(ctx.api, `🌍 <b>Global ban enforced:</b> <code>${user.id}</code> in <code>${chatId}</code>`);
    return;
  }

  const userName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);

  // Send welcome message if enabled
  if (settings.welcomeEnabled) {
    const template = settings.welcomeMessage ||
      `👋 Welcome, <b>{name}</b>, to <b>{group}</b>! Please read the group rules.`;
    const msg = template
      .replace(/\{name\}/gi, escapeHtml(userName))
      .replace(/\{id\}/gi, String(user.id))
      .replace(/\{group\}/gi, escapeHtml(chatTitle))
      .replace(/\{username\}/gi, user.username ? `@${user.username}` : userName);
    await ctx.api.sendMessage(chatId, msg, { parse_mode: "HTML" }).catch(() => {});
  }

  // Joinmust check — mute new member until they've subscribed to all required channels
  const joinMustList = await getJoinMustList(chatId);
  if (joinMustList.length > 0) {
    try {
      await muteUser(ctx, chatId, user.id, 0);
      const lines = joinMustList.map((jm) =>
        jm.targetUsername ? `• @${jm.targetUsername}` : `• <code>${jm.targetId}</code>`,
      );
      await ctx.api.sendMessage(
        chatId,
        `👋 ${userLink(user.id, userName)}, welcome! To chat here you must first join:\n\n${lines.join("\n")}\n\nTap the button below once you've joined all of them.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "✅ I Joined", callback_data: `jm_verify:${chatId}:${user.id}` }]],
          },
        },
      ).catch(() => {});
      await logGeneral(ctx.api, `🔗 <b>Joinmust muted on join:</b> ${escapeHtml(userName)} (<code>${user.id}</code>) in <code>${chatId}</code>`);
    } catch (err) {
      logger.warn({ err }, "Joinmust mute failed");
    }
    return; // joinmust takes priority over captcha
  }

  if (!settings.captchaEnabled) return;
  await startCaptchaForJoin(ctx, chatId, chatTitle, user.id, userName);
  await logCaptcha(ctx.api, `🔐 <b>Captcha started:</b> ${escapeHtml(userName)} (<code>${user.id}</code>) in <code>${chatId}</code>`);
}

bot.on("chat_member", async (ctx) => {
  const upd = ctx.chatMember;
  const chat = upd.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const oldS = upd.old_chat_member.status;
  const newS = upd.new_chat_member.status;
  if ((oldS === "left" || oldS === "kicked") && (newS === "member" || newS === "restricted")) {
    await handleNewMember(ctx, chat.id, upd.new_chat_member.user, chat.title || "group");
  }
});

bot.on("message:new_chat_members", async (ctx) => {
  const chat = ctx.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  for (const u of ctx.message.new_chat_members) {
    await handleNewMember(ctx, chat.id, u, chat.title || "group");
  }
});

// ── Captcha button callbacks ──────────────────────────────────────────────────

bot.callbackQuery(/^cap_btn:(\d+)$/, async (ctx) => {
  const answer = ctx.match[1]!;
  const result = await checkCaptchaAnswer(ctx, ctx.from.id, answer);
  if (!result) {
    await ctx.answerCallbackQuery({ text: "No active captcha session found." });
    return;
  }
  if (result.ok) {
    await ctx.answerCallbackQuery({ text: "✅ Verified! Welcome to the group!" });
    await ctx.editMessageText("✅ Verified! You can now participate in the group. Welcome!").catch(() => {});
    await logCaptcha(ctx.api, `✅ <b>Captcha passed:</b> <code>${ctx.from.id}</code> @${escapeHtml(ctx.from.username || "")} in <code>${result.groupId}</code>`);
  } else {
    await ctx.answerCallbackQuery({ text: "❌ Wrong answer. Try again." });
  }
});

// ── /start ────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const text = ctx.message?.text || "";
  const payload = text.split(/\s+/)[1];

  if (ctx.chat?.type === "private" && payload?.startsWith("cap_")) {
    const parts = payload.split("_");
    const dbId = parts[2] ? parseInt(parts[2], 10) : NaN;
    if (!Number.isNaN(dbId)) {
      await deliverCaptchaToPrivate(ctx, dbId);
      return;
    }
  }

  if (ctx.chat?.type === "private") {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    if (await isSuperAdmin(fromId)) {
      await openSAPanel(ctx);
    } else {
      await ctx.reply(
        `👋 Hi! I'm <b>@${botUsername}</b>, a Telegram group management bot.\n\n` +
        `Add me to your group as an admin, then use <code>/redeem [token]</code> to authorize the group.\n\n` +
        `<b>Need a token?</b> Contact a Super Admin.\n\n` +
        `Once authorized, group admins can use <b>/cp</b> to open the control panel.`,
        { parse_mode: "HTML" },
      );
    }
  } else {
    await ctx.reply(
      `👋 Hi! To get started:\n1. Make me an admin\n2. Use /redeem [token] to authorize this group\n3. Then use /cp to manage settings`,
    ).catch(() => {});
  }
});

// ── /help ─────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  const fromId = ctx.from?.id;
  if (!fromId) return;
  const chat = ctx.chat;
  const isGroup = chat?.type === "group" || chat?.type === "supergroup";

  if (isGroup) {
    await ctx.reply(
      `🤖 <b>@${botUsername}</b>\n\n` +
      `<b>⚙️ Panel</b>\n/cp · /cp (reply to user)\n\n` +
      `<b>👮 Moderation</b>\n/ban /unban /kick /mute /unmute\n/warn /unwarn /warns /resetwarns /del /pin\n\n` +
      `<b>📋 Content</b>\n/filter /unfilter /filters\n/addbl /rmbl /bl /resetbl\n/lock /unlock /locks\n\n` +
      `<b>⚙️ Settings</b>\n/welcome /setwelcome /captcha\n/antibot /antichannel /gbl\n/flood /floodaction /warnlimit /warnaction\n\n` +
      `<b>📌 Notes</b>\n/note /getnote /delnote /notes · <code>#name</code>\n\n` +
      `<b>✅ Approvals</b>\n/approve /unapprove /approved /unapproveall\n\n` +
      `<b>🔗 Joinmust</b>\n/joinmust /unjoinmust /joinmustlist\n\n` +
      `<b>🔧 Util</b>\n/id /me /redeem /backup /restore\n\n` +
      `<b>⏱ Time</b>: <code>30s 10m 2h 7d 1w</code> — omit = permanent`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (await isSuperAdmin(fromId)) {
    await ctx.reply(
      `👑 <b>Super Admin Commands</b>\n\n` +
      `<b>⚙️ Panel</b>\n/cp — SA control panel\n\n` +
      `<b>🌍 Global</b>\n/gban /ungban /gmute /ungmute\n/listgbans /listgmutes\n\n` +
      `<b>👑 Admins</b>\n/addsa /rmsa /listsa\n\n` +
      `<b>🏘️ Groups</b>\n/listgroups /bangroup /unbangroup\n/sync /get [id|key]\n\n` +
      `<b>🔑 Keys</b>\n/genkey [time] [uses] /listkeys /revokekey\n\n` +
      `<b>📢 Broadcast</b>\n/broadcast [message]\n\n` +
      `<b>📊 Logging</b>\n/setlog /clearlog\n\n` +
      `<b>💾 Backup</b>\n/backup [groupId] /restore\n\n` +
      `<b>🔐 Web Panel</b>\n/adminpanel /resetpass /resetpassdefault\n\n` +
      `<b>🛠️ Util</b>\n/resetrestriction /edit /cancel /id`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await ctx.reply(
    `👋 I'm <b>@${botUsername}</b> — a Telegram group management bot.\n\nAdd me to your group as admin and authorize it with a token to use me.`,
    { parse_mode: "HTML" },
  );
});

// ── Captcha math text answer in PM ────────────────────────────────────────────

bot.on("message:text", async (ctx, next) => {
  if (ctx.chat?.type === "private") {
    const fromId = ctx.from?.id ?? 0;

    // Handle pending /edit session — user sends new text
    const editSession = pendingEdits.get(fromId);
    if (editSession && ctx.message.text && !ctx.message.text.startsWith("/")) {
      pendingEdits.delete(fromId);
      try {
        await ctx.api.editMessageText(
          editSession.chatId,
          editSession.messageId,
          ctx.message.text,
          { parse_mode: "HTML" },
        );
        await ctx.reply("✅ Message updated.");
      } catch (err: any) {
        await ctx.reply(`❌ Failed to edit: ${err?.description || err?.message}`);
      }
      return;
    }

    // Handle pending panel text input (welcome msg, BL word, joinmust, etc.)
    if (!ctx.message.text.startsWith("/") && (await processPanelInput(ctx))) return;

    // Handle captcha math answer
    const text = ctx.message.text.trim();
    if (/^\d+$/.test(text)) {
      const result = await checkCaptchaAnswer(ctx, fromId, text);
      if (result) {
        if (result.ok) {
          await ctx.reply("✅ Correct! You are now verified and can chat in the group.");
          await logCaptcha(ctx.api, `✅ <b>Captcha passed (math):</b> <code>${fromId}</code> in group <code>${result.groupId}</code>`);
        } else {
          await ctx.reply("❌ Wrong answer. Please try again.");
        }
        return;
      }
    }

    // Non-super-admin in PM gets the info message (unless they're awaiting captcha)
    if (!(await isSuperAdmin(fromId))) {
      await ctx.reply(
        `👋 I'm <b>@${botUsername}</b> — a group management bot.\n\nAdd me to your group as an admin and authorize it with a token to use me.`,
        { parse_mode: "HTML" },
      );
      return;
    }
  }
  await next();
});

// ── Private chat gate: only super admins beyond this point ────────────────────

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === "private") {
    if (!(await isSuperAdmin(ctx.from?.id))) return;
  }
  await next();
});

// ── Group guard: banned, admin check, auth gate ───────────────────────────────

bot.use(async (ctx, next) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await next();
    return;
  }

  if (await isGroupBanned(chat.id)) {
    await ctx.api.sendMessage(chat.id, "🚫 This group is banned.").catch(() => {});
    await ctx.api.leaveChat(chat.id).catch(() => {});
    return;
  }

  await upsertGroup(chat.id, chat.title || "");

  if (!(await isGroupAuthorized(chat.id))) {
    const cmd = ctx.message?.text?.split(/\s+/)[0]?.toLowerCase().split("@")[0];
    if (cmd === "/redeem" || cmd === "/start" || cmd === "/help") {
      await next();
      return;
    }
    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply(
        "🔑 This group is not authorized.\nA group admin must run:\n<code>/redeem YOUR_TOKEN</code>",
        { parse_mode: "HTML" },
      ).catch(() => {});
    }
    return;
  }
  await next();
});

// ── Antichannel ───────────────────────────────────────────────────────────────

bot.on("message", async (ctx, next) => {
  const chat = ctx.chat;
  if (chat?.type !== "group" && chat?.type !== "supergroup") return next();
  const settings = await getGroupSettings(chat.id);
  if (!settings.antichannel) return next();
  const senderChat = ctx.message?.sender_chat;
  if (senderChat && senderChat.id !== chat.id && senderChat.type !== "group" && senderChat.type !== "supergroup") {
    await ctx.deleteMessage().catch(() => {});
    try { await ctx.api.banChatSenderChat(chat.id, senderChat.id); } catch {}
    await logSecurity(ctx.api, `📛 <b>Antichannel:</b> Removed post from <code>${senderChat.id}</code> in <code>${chat.id}</code>`);
    return;
  }
  await next();
});

// ── Track user activity in groups ─────────────────────────────────────────────

bot.on("message", async (ctx, next) => {
  const chat = ctx.chat;
  if ((chat?.type === "group" || chat?.type === "supergroup") && ctx.from && !ctx.from.is_bot) {
    const u = ctx.from;
    void upsertUserSeen(
      u.id, chat.id,
      u.first_name || "",
      u.last_name || "",
      u.username,
    );
  }
  await next();
});

// ── Flood control ─────────────────────────────────────────────────────────────

bot.on("message", async (ctx, next) => {
  const chat = ctx.chat;
  if (chat?.type !== "group" && chat?.type !== "supergroup") return next();
  const userId = ctx.from?.id;
  if (!userId) return next();

  // Approved users and admins bypass flood
  if (await isUserGroupAdmin(ctx.api, chat.id, userId)) return next();
  if (await isApproved(chat.id, userId)) return next();

  const flooding = await checkFlood(chat.id, userId);
  if (flooding) {
    resetFlood(chat.id, userId);
    const settings = await getGroupSettings(chat.id);
    const name = await getMemberName(ctx.api, chat.id, userId);
    const link = userLink(userId, name);
    try {
      await ctx.deleteMessage().catch(() => {});
      if (settings.floodAction === "ban") {
        await banUser(ctx, chat.id, userId, settings.floodActionDurationSec);
        await ctx.api.sendMessage(chat.id, `🚫 ${link} has been <b>banned</b> for ${formatDuration(settings.floodActionDurationSec)} due to flooding.`, { parse_mode: "HTML" }).catch(() => {});
        await logMod(ctx.api, `🌊 <b>Flood ban:</b> ${link} (<code>${userId}</code>) in <code>${chat.id}</code> — ${formatDuration(settings.floodActionDurationSec)}`);
      } else if (settings.floodAction === "kick") {
        await ctx.api.banChatMember(chat.id, userId);
        await ctx.api.unbanChatMember(chat.id, userId);
        await ctx.api.sendMessage(chat.id, `👢 ${link} has been <b>kicked</b> for flooding.`, { parse_mode: "HTML" }).catch(() => {});
        await logMod(ctx.api, `🌊 <b>Flood kick:</b> ${link} (<code>${userId}</code>) in <code>${chat.id}</code>`);
      } else {
        await muteUser(ctx, chat.id, userId, settings.floodActionDurationSec);
        await ctx.api.sendMessage(chat.id, `🔇 ${link} has been <b>muted</b> for ${formatDuration(settings.floodActionDurationSec)} due to flooding.`, { parse_mode: "HTML" }).catch(() => {});
        await logMod(ctx.api, `🌊 <b>Flood mute:</b> ${link} (<code>${userId}</code>) in <code>${chat.id}</code> — ${formatDuration(settings.floodActionDurationSec)}`);
      }
    } catch (err) {
      logger.warn({ err }, "Flood action failed");
    }
    return;
  }
  await next();
});

// ── Content moderation: locks + blacklist + filters ───────────────────────────

bot.on("message", async (ctx, next) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return next();
  const userId = ctx.from?.id;
  if (!userId) return next();

  // Admins and approved users bypass all content checks
  if (await isUserGroupAdmin(ctx.api, chat.id, userId)) return next();
  if (await isApproved(chat.id, userId)) return next();

  const violated = await violatesLock(chat.id, ctx);
  if (violated) {
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  const text = ctx.message?.text || ctx.message?.caption || "";
  if (text) {
    const word = await findBlacklisted(chat.id, text);
    if (word) {
      await ctx.deleteMessage().catch(() => {});
      const hits = await bumpBlacklistHit(chat.id, userId);
      const settings = await getGroupSettings(chat.id);
      if (hits >= settings.blacklistThreshold) {
        const name = await getMemberName(ctx.api, chat.id, userId);
        const link = userLink(userId, name);
        try {
          if (settings.blacklistAction === "ban") {
            await banUser(ctx, chat.id, userId, settings.blacklistDurationSec);
            await resetBlacklistHits(chat.id, userId);
            await ctx.api.sendMessage(chat.id, `🚫 ${link} has been <b>banned</b> for ${formatDuration(settings.blacklistDurationSec)} due to repeated use of blacklisted words.`, { parse_mode: "HTML" }).catch(() => {});
            await logFilter(ctx.api, `⛔ <b>Blacklist ban:</b> ${link} in <code>${chat.id}</code> (${formatDuration(settings.blacklistDurationSec)}, word: <i>${escapeHtml(word)}</i>)`);
          } else if (settings.blacklistAction === "kick") {
            await ctx.api.banChatMember(chat.id, userId);
            await ctx.api.unbanChatMember(chat.id, userId, { only_if_banned: true });
            await resetBlacklistHits(chat.id, userId);
            await ctx.api.sendMessage(chat.id, `🚪 ${link} has been <b>kicked</b> for repeated use of blacklisted words.`, { parse_mode: "HTML" }).catch(() => {});
            await logFilter(ctx.api, `🚪 <b>Blacklist kick:</b> ${link} in <code>${chat.id}</code> (word: <i>${escapeHtml(word)}</i>)`);
          } else {
            await muteUser(ctx, chat.id, userId, settings.blacklistDurationSec);
            await resetBlacklistHits(chat.id, userId);
            await ctx.api.sendMessage(chat.id, `🔇 ${link} has been <b>muted</b> for ${formatDuration(settings.blacklistDurationSec)} due to using blacklisted words.`, { parse_mode: "HTML" }).catch(() => {});
            await logFilter(ctx.api, `🔇 <b>Blacklist mute:</b> ${link} in <code>${chat.id}</code> (${formatDuration(settings.blacklistDurationSec)}, word: <i>${escapeHtml(word)}</i>)`);
          }
        } catch (err) {
          logger.warn({ err }, "Blacklist auto-action failed");
        }
      }
      return;
    }

    const reply = await findFilter(chat.id, text);
    if (reply) {
      await ctx.reply(reply).catch(() => {});
      const filterName = await getMemberName(ctx.api, chat.id, userId);
      await logFilter(ctx.api, `💬 <b>Filter triggered</b> in <code>${chat.id}</code> — ${userLink(userId, filterName)} sent a matching message`);
    }

    // #notename lookup
    if (text.startsWith("#")) {
      const noteName = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
      if (noteName) {
        const content = await getNote(chat.id, noteName);
        if (content) await ctx.reply(content, { parse_mode: "HTML" }).catch(() => {});
      }
    }
  }
  await next();
});

// ── /redeem ───────────────────────────────────────────────────────────────────

bot.command("redeem", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("Use /redeem inside a group.");
    return;
  }
  if (!(await requireGroupAdmin(ctx))) return;

  const args = splitArgs(ctx.message?.text);
  if (args.length === 0) {
    await ctx.reply("Usage: /redeem [token]");
    return;
  }

  if (await isGroupAuthorized(chat.id)) {
    await ctx.deleteMessage().catch(() => {});
    const m = await ctx.reply("✅ This group is already authorized.");
    setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 8000);
    return;
  }

  await ctx.deleteMessage().catch(() => {});

  const result = await consumeAuthKey(args[0]!, chat.id);
  if (!result.ok) {
    const m = await ctx.reply(`❌ ${result.reason}`);
    setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 8000);
    return;
  }

  await authorizeGroup(chat.id, args[0]!, result.expiresAt ?? null);
  const expiryNote = result.expiresAt
    ? `\nExpires: <b>${result.expiresAt.toISOString().slice(0, 16)} UTC</b>`
    : "";
  const m = await ctx.reply(`✅ Token accepted! Group is now authorized.${expiryNote}`, { parse_mode: "HTML" });
  setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 15000);

  await logGeneral(
    ctx.api,
    `🔑 <b>Group authorized:</b> <code>${chat.id}</code> <i>${escapeHtml(chat.title || "")}</i>\nToken: <code>${args[0]!.toUpperCase()}</code> | By: <code>${ctx.from!.id}</code>` +
      (result.expiresAt ? `\nExpires: ${result.expiresAt.toISOString().slice(0, 16)} UTC` : ""),
  );
});

// ── /cp (control panel) ───────────────────────────────────────────────────────

bot.command("cp", async (ctx) => {
  const chat = ctx.chat;
  const fromId = ctx.from?.id;
  if (!fromId) return;

  if (chat?.type === "private") {
    if (!(await isSuperAdmin(fromId))) {
      await ctx.reply("⚙️ Use /cp in a group to open the control panel, or contact a Super Admin.");
      return;
    }
    await openSAPanel(ctx);
    return;
  }

  if (chat?.type !== "group" && chat?.type !== "supergroup") return;
  if (!(await senderIsGroupAdmin(ctx))) {
    await ctx.reply("❌ Only group admins can open the control panel.").catch(() => {});
    return;
  }

  const title = chat.title || String(chat.id);
  const reply = ctx.message?.reply_to_message;
  if (reply?.from && !reply.from.is_bot) {
    const u = reply.from;
    const userName = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
    await ctx.deleteMessage().catch(() => {});
    await openGroupPanel(ctx, chat.id, title, u.id, userName);
  } else {
    await ctx.deleteMessage().catch(() => {});
    await openGroupPanel(ctx, chat.id, title);
  }
});

// ── /ban ──────────────────────────────────────────────────────────────────────

bot.command("ban", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_restrict_members"))) return;
  const args = splitArgs(ctx.message?.text);
  const { target, durationSec } = await resolveTargetAndDuration(ctx, args);
  if (!target) { await ctx.reply("Usage: /ban [id] [time] — or reply to user: /ban [time]\nExamples: /ban 123456789 1d  •  /ban 7d  (when replying)  •  /ban  (permanent, replying)"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot ban a Super Admin."); return; }
  try {
    await banUser(ctx, ctx.chat!.id, target.id, durationSec);
    void trackRestriction(ctx.chat!.id, target.id, "ban", durationSec);
    await ctx.reply(`⛔ <b>Banned</b> · ${userLink(target.id, target.name)}\n⏳ Duration: <b>${formatDuration(durationSec)}</b>`, { parse_mode: "HTML" });
    await logMod(ctx.api, `⛔ <b>Ban:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)} — ${formatDuration(durationSec)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not ban: ${err?.description || err?.message}`); }
});

// ── /unban ────────────────────────────────────────────────────────────────────

bot.command("unban", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_restrict_members"))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /unban — reply to user, or /unban [userid]"); return; }
  try {
    await unbanUser(ctx, ctx.chat!.id, target.id);
    void removeRestriction(ctx.chat!.id, target.id, "ban");
    await ctx.reply(`✅ <b>Unbanned</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `✅ <b>Unban:</b> ${userLink(target.id, target.name)} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not unban: ${err?.description || err?.message}`); }
});

// ── /kick ─────────────────────────────────────────────────────────────────────

bot.command("kick", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_restrict_members"))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /kick — reply to user, or /kick [userid]"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot kick a Super Admin."); return; }
  try {
    await ctx.api.banChatMember(ctx.chat!.id, target.id);
    await ctx.api.unbanChatMember(ctx.chat!.id, target.id);
    await ctx.reply(`👢 <b>Kicked</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `👢 <b>Kick:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) from <code>${ctx.chat!.id}</code> by ${fmtAdmin(ctx)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not kick: ${err?.description || err?.message}`); }
});

// ── /mute ─────────────────────────────────────────────────────────────────────

bot.command("mute", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_restrict_members"))) return;
  const args = splitArgs(ctx.message?.text);
  const { target, durationSec } = await resolveTargetAndDuration(ctx, args);
  if (!target) { await ctx.reply("Usage: /mute [id] [time] — or reply to user: /mute [time]\nExamples: /mute 123456789 1h  •  /mute 10m  (when replying)  •  /mute  (permanent, replying)"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot mute a Super Admin."); return; }
  try {
    await muteUser(ctx, ctx.chat!.id, target.id, durationSec);
    void trackRestriction(ctx.chat!.id, target.id, "mute", durationSec);
    await ctx.reply(`🔇 <b>Muted</b> · ${userLink(target.id, target.name)}\n⏳ Duration: <b>${formatDuration(durationSec)}</b>`, { parse_mode: "HTML" });
    await logMod(ctx.api, `🔇 <b>Mute:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)} — ${formatDuration(durationSec)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not mute: ${err?.description || err?.message}`); }
});

// ── /unmute ───────────────────────────────────────────────────────────────────

bot.command("unmute", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_restrict_members"))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /unmute — reply to user, or /unmute [userid]"); return; }
  try {
    await unmuteUser(ctx, ctx.chat!.id, target.id);
    void removeRestriction(ctx.chat!.id, target.id, "mute");
    await ctx.reply(`🔈 <b>Unmuted</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `🔈 <b>Unmute:</b> ${userLink(target.id, target.name)} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not unmute: ${err?.description || err?.message}`); }
});

// ── /warn ─────────────────────────────────────────────────────────────────────

bot.command("warn", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /warn — reply to user, or /warn [userid]"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot warn a Super Admin."); return; }
  const count = await addWarning(ctx.chat!.id, target.id);
  const settings = await getGroupSettings(ctx.chat!.id);
  const link = userLink(target.id, target.name);
  if (count >= settings.warnLimit) {
    const action = await applyAutoActionIfNeeded(ctx, ctx.chat!.id, target.id, count);
    const extra = action ? `\n➡️ Auto-action: <b>${action}</b>` : "";
    await ctx.reply(`🚨 <b>Warn limit reached!</b> · ${link} · <b>${count}/${settings.warnLimit}</b>${extra}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `⚠️ <b>Warn limit:</b> ${link} (${count}/${settings.warnLimit}) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}${action ? ` → ${action}` : ""}`);
  } else {
    await ctx.reply(`⚠️ <b>Warning ${count}/${settings.warnLimit}</b> · ${link}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `⚠️ <b>Warn:</b> ${link} (${count}/${settings.warnLimit}) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  }
});

// ── /unwarn ───────────────────────────────────────────────────────────────────

bot.command("unwarn", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /unwarn — reply to user, or /unwarn [userid]"); return; }
  const count = await removeOneWarning(ctx.chat!.id, target.id);
  const settings = await getGroupSettings(ctx.chat!.id);
  await ctx.reply(`✅ <b>Warning removed</b> · ${userLink(target.id, target.name)}\n📊 Now: <b>${count}/${settings.warnLimit}</b>`, { parse_mode: "HTML" });
});

// ── /resetwarns ───────────────────────────────────────────────────────────────

bot.command("resetwarns", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /resetwarns — reply to user, or /resetwarns [userid]"); return; }
  await resetWarnings(ctx.chat!.id, target.id);
  await ctx.reply(`✅ <b>Warnings cleared</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
});

// ── /warns — check own warns ──────────────────────────────────────────────────

bot.command("warns", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const userId = ctx.from?.id;
  if (!userId) return;
  const settings = await getGroupSettings(chat.id);
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  const targetId = target?.id ?? userId;
  const targetName = target?.name ?? ([ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || String(userId));
  const row = await db.select().from(warningsTable)
    .where(and(eq(warningsTable.groupId, chat.id), eq(warningsTable.userId, targetId))).limit(1);
  const count = row[0]?.count ?? 0;
  await ctx.reply(`⚠️ ${userLink(targetId, targetName)} has <b>${count}/${settings.warnLimit}</b> warning(s).`, { parse_mode: "HTML" });
});

bot.command("gban", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  let durationSec = 0, targetArgs = args;
  if (args.length >= 1) { const d = parseDuration(args[0]); if (d !== null) { durationSec = d; targetArgs = args.slice(1); } }
  const id = parseUserId(targetArgs[0]);
  if (!id) { await ctx.reply("Usage: /gban [time] [userId]"); return; }
  await setGlobalBan(id, durationSec);
  const groups = await listGroups();
  let count = 0;
  for (const g of groups) {
    if (g.banned) continue;
    try {
      const untilDate = durationSec > 0 ? Math.floor(Date.now() / 1000) + durationSec : 0;
      await ctx.api.banChatMember(g.groupId, id, { until_date: untilDate || undefined });
      count++;
    } catch {}
  }
  await ctx.reply(`🌍 <code>${id}</code> globally banned for <b>${formatDuration(durationSec)}</b>. Applied in ${count} group(s).`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `🌍 <b>Global ban:</b> <code>${id}</code> (${formatDuration(durationSec)}) by ${fmtAdmin(ctx)}, applied to ${count} groups`);
});

bot.command("resetrestriction", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /resetrestriction [groupId]"); return; }
  const supers = await getSuperAdmins();
  let count = 0;
  for (const sid of supers) {
    try { await ctx.api.unbanChatMember(gid, sid, { only_if_banned: true }); } catch {}
    try {
      await ctx.api.restrictChatMember(gid, sid, {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
        can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
      count++;
    } catch {}
  }
  await ctx.reply(`✅ Cleared restrictions for ${count} super admin(s) in <code>${gid}</code>.`, { parse_mode: "HTML" });
});

// ── /adminpanel ───────────────────────────────────────────────────────────────

bot.command("adminpanel", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const password = getAdminPanelPassword();
  await ctx.reply(
    `🔐 <b>Admin Panel Password</b>\n\n` +
    `<code>${password}</code>\n\n` +
    `Copy this password and paste it into the admin panel login screen.\n` +
    `<i>Keep it private — it grants full admin access.</i>`,
    { parse_mode: "HTML" },
  );
});

// ── /edit (super admin) ───────────────────────────────────────────────────────

bot.command("edit", async (ctx) => {
  const fromId = ctx.from?.id;
  if (!fromId || !(await isSuperAdmin(fromId))) return;

  const reply = ctx.message?.reply_to_message;
  if (!reply) {
    await ctx.reply("Reply to one of my messages with /edit.");
    return;
  }

  // Get the current text of the message to pre-fill
  const currentText =
    reply.text ||
    reply.caption ||
    "[no text content — media message]";

  const chatId = ctx.chat!.id;
  const messageId = reply.message_id;

  // Store session
  pendingEdits.set(fromId, { chatId, messageId, currentText });

  if (ctx.chat?.type === "private") {
    // Already in PM — show current text and ask for new one
    await ctx.reply(
      `✏️ <b>Current message text:</b>\n\n${escapeHtml(currentText)}\n\n<i>Send me the new text (HTML formatting supported). Or /cancel to abort.</i>`,
      { parse_mode: "HTML" },
    );
  } else {
    // In a group — try to DM the super admin with the current content
    await ctx.deleteMessage().catch(() => {});
    try {
      await ctx.api.sendMessage(
        fromId,
        `✏️ <b>Editing message in group <code>${chatId}</code>:</b>\n\n<b>Current text:</b>\n${escapeHtml(currentText)}\n\n<i>Send me the new text (HTML formatting supported). Or /cancel to abort.</i>`,
        { parse_mode: "HTML" },
      );
    } catch {
      // Couldn't DM — they haven't started the bot
      await ctx.api.sendMessage(chatId,
        `✏️ Start a PM with me first, then try again. The message to edit has been queued.`,
      ).catch(() => {});
    }
  }
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const fromId = ctx.from?.id ?? 0;
  if (pendingEdits.has(fromId)) {
    pendingEdits.delete(fromId);
    await ctx.reply("✅ Edit cancelled.");
  } else if (pendingPanelInput.has(fromId)) {
    pendingPanelInput.delete(fromId);
    await ctx.reply("✅ Action cancelled.");
  } else {
    await ctx.reply("Nothing to cancel.");
  }
});

// ── Token management ──────────────────────────────────────────────────────────

bot.command("genkey", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (args.length === 0) {
    await ctx.reply("Usage: /genkey [time] [uses]\nExamples:\n/genkey 7d 1 — 7 day, 1 use\n/genkey perm 5 — permanent, 5 uses\n/genkey 0 1 — permanent, 1 use");
    return;
  }
  const dur = parseDuration(args[0]);
  if (dur === null) { await ctx.reply("❌ Invalid time. Use: 1d, 7d, 1h, 0, perm."); return; }
  const uses = args[1] ? parseInt(args[1], 10) : 1;
  if (Number.isNaN(uses) || uses < 1) { await ctx.reply("❌ Uses must be at least 1."); return; }
  const key = await createAuthKey(dur, uses, ctx.from!.id);
  await ctx.reply(
    `🔑 <b>New Auth Token</b>\n\n<code>${key.key}</code>\n\nExpires: <b>${key.expiresAt ? key.expiresAt.toISOString().slice(0, 16) + " UTC" : "Never"}</b>\nUses: <b>0 / ${key.maxUses}</b>\n\nGroup admin redeems with:\n<code>/redeem ${key.key}</code>`,
    { parse_mode: "HTML" },
  );
});

// ── Log channel / group ───────────────────────────────────────────────────────

bot.command("setlog", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  let targetId: number | null = null;

  if (args.length > 0) {
    const id = parseUserId(args[0]);
    if (!id) {
      await ctx.reply("Usage: /setlog [channelId or groupId]\nBoth negative IDs (e.g. -1001234567890) and positive group IDs work.");
      return;
    }
    targetId = id;
  } else if ((ctx.message?.reply_to_message as any)?.forward_origin?.chat?.id) {
    targetId = (ctx.message!.reply_to_message as any).forward_origin.chat.id;
  }

  if (!targetId) {
    await ctx.reply("Usage: /setlog [channelId or groupId]\nOr forward a message from the target here and reply with /setlog");
    return;
  }

  // Test we can post there
  try {
    await ctx.api.sendMessage(targetId, `✅ Log target confirmed for @${botUsername}.`);
  } catch (err: any) {
    await ctx.reply(`❌ Cannot post to that chat: ${err?.description || err?.message}\nMake sure I'm an admin there.`);
    return;
  }

  await setLogChannel(targetId);

  // Try to create/recreate forum topics if it's a forum supergroup
  const args2 = splitArgs(ctx.message?.text);
  const forceRecreate = args2[1]?.toLowerCase() === "recreate";
  const created = forceRecreate
    ? await resetAndRecreateTopics(ctx.api, targetId)
    : await initLogTopics(ctx.api, targetId);

  if (created) {
    await ctx.reply(
      `✅ Log target set to <code>${targetId}</code>.\n\n📌 <b>5 log topics created:</b>\n🌐 General\n⚔️ Moderation\n🛡️ Security\n🔍 Filter\n🤖 Captcha\n\n<i>Use /setlog [id] recreate to force-rebuild topics.</i>`,
      { parse_mode: "HTML" },
    );
  } else {
    await ctx.reply(
      `✅ Log target set to <code>${targetId}</code>.\n<i>Tip: Use a Forum Supergroup to get 5 separate log topic categories automatically.</i>`,
      { parse_mode: "HTML" },
    );
  }
});

bot.command("clearlog", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  await setLogChannel(null);
  await ctx.reply("✅ Log channel disabled.");
});

// ── /id /me ───────────────────────────────────────────────────────────────────

bot.command(["id", "me"], async (ctx) => {
  const reply = ctx.message?.reply_to_message;
  const target = reply?.from ?? ctx.from;
  if (!target) return;
  const name = [target.first_name, target.last_name].filter(Boolean).join(" ") || target.username || String(target.id);
  const username = target.username ? `@${target.username}` : "—";
  await ctx.reply(
    `👤 <b>${escapeHtml(name)}</b>\n🆔 ID: <code>${target.id}</code>\n📛 Username: ${escapeHtml(username)}\n🤖 Bot: ${target.is_bot ? "Yes" : "No"}`,
    { parse_mode: "HTML" },
  );
});

// ── /ungban ───────────────────────────────────────────────────────────────────

bot.command("ungban", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /ungban [userId]"); return; }
  const ok = await removeGlobalBan(id);
  const groups = await listGroups();
  let count = 0;
  for (const g of groups) {
    if (g.banned) continue;
    try { await ctx.api.unbanChatMember(g.groupId, id, { only_if_banned: true }); count++; } catch {}
  }
  await ctx.reply(
    ok
      ? `✅ Global ban removed from <code>${id}</code>. Unbanned in ${count} group(s).`
      : `❌ No global ban found for <code>${id}</code>.`,
    { parse_mode: "HTML" },
  );
  if (ok) await logSecurity(ctx.api, `✅ <b>Global ban removed:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

// ── /gmute ────────────────────────────────────────────────────────────────────

bot.command("gmute", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  let durationSec = 0, targetArgs = args;
  if (args.length >= 1) { const d = parseDuration(args[0]); if (d !== null) { durationSec = d; targetArgs = args.slice(1); } }
  const id = parseUserId(targetArgs[0]);
  if (!id) { await ctx.reply("Usage: /gmute [time] [userId]"); return; }
  await setGlobalMute(id, durationSec);
  const groups = await listGroups();
  let count = 0;
  for (const g of groups) {
    if (g.banned) continue;
    try {
      const untilDate = durationSec > 0 ? Math.floor(Date.now() / 1000) + durationSec : 0;
      await ctx.api.restrictChatMember(g.groupId, id, {
        can_send_messages: false, can_send_audios: false, can_send_documents: false,
        can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
        can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
        can_add_web_page_previews: false,
      }, { until_date: untilDate || undefined });
      count++;
    } catch {}
  }
  await ctx.reply(`🔇 <code>${id}</code> globally muted for <b>${formatDuration(durationSec)}</b>. Applied in ${count} group(s).`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `🔇 <b>Global mute:</b> <code>${id}</code> (${formatDuration(durationSec)}) by ${fmtAdmin(ctx)}, applied to ${count} groups`);
});

// ── /ungmute ──────────────────────────────────────────────────────────────────

bot.command("ungmute", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /ungmute [userId]"); return; }
  const ok = await removeGlobalMute(id);
  const groups = await listGroups();
  let count = 0;
  for (const g of groups) {
    if (g.banned) continue;
    try {
      await ctx.api.restrictChatMember(g.groupId, id, {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
        can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
      count++;
    } catch {}
  }
  await ctx.reply(
    ok
      ? `✅ Global mute removed from <code>${id}</code>. Unmuted in ${count} group(s).`
      : `❌ No global mute found for <code>${id}</code>.`,
    { parse_mode: "HTML" },
  );
  if (ok) await logSecurity(ctx.api, `✅ <b>Global mute removed:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

// ── /broadcast ────────────────────────────────────────────────────────────────

bot.command("broadcast", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/broadcast(@\w+)?\s*/i, "").trim();
  if (!msg) { await ctx.reply("Usage: /broadcast [message]"); return; }
  const groups = await listGroups();
  let sent = 0, failed = 0;
  for (const g of groups) {
    if (g.banned || !g.authorized) continue;
    try {
      await ctx.api.sendMessage(g.groupId, msg, { parse_mode: "HTML" });
      sent++;
    } catch { failed++; }
  }
  await ctx.reply(`📢 <b>Broadcast done</b>\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `📢 <b>Broadcast</b> by ${fmtAdmin(ctx)}: sent to ${sent} groups, ${failed} failed`);
});

// ── /del ──────────────────────────────────────────────────────────────────────

bot.command("del", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_delete_messages"))) return;
  const args = splitArgs(ctx.message?.text);
  const chatId = ctx.chat!.id;
  const cmdMsgId = ctx.message!.message_id;

  await ctx.deleteMessage().catch(() => {});

  const raw = args[0]?.toLowerCase();

  if (!raw || raw === "all") {
    const reply = ctx.message?.reply_to_message;
    if (reply) {
      await ctx.api.deleteMessage(chatId, reply.message_id).catch(() => {});
      return;
    }
    await ctx.reply("❌ Reply to a message to delete it, or use /del [number].");
    return;
  }

  const count = parseInt(raw, 10);
  if (isNaN(count) || count < 1 || count > 200) {
    await ctx.reply("❌ Provide a number between 1 and 200. Example: /del 10");
    return;
  }

  let deleted = 0;
  const promises: Promise<void>[] = [];
  for (let i = 1; i <= count + 5; i++) {
    const id = cmdMsgId - i;
    if (id < 1) break;
    promises.push(
      ctx.api.deleteMessage(chatId, id).then(() => { deleted++; }).catch(() => {}),
    );
  }
  await Promise.all(promises);
  const note = await ctx.api.sendMessage(chatId, `🗑️ Deleted ~${deleted} message(s).`).catch(() => null);
  if (note) setTimeout(() => ctx.api.deleteMessage(chatId, note.message_id).catch(() => {}), 4000);
});

// ── /pin ──────────────────────────────────────────────────────────────────────

bot.command("pin", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_pin_messages"))) return;
  const reply = ctx.message?.reply_to_message;
  if (!reply) {
    await ctx.reply("Reply to a message with /pin to pin it.");
    return;
  }
  await ctx.deleteMessage().catch(() => {});
  try {
    await ctx.api.pinChatMessage(ctx.chat!.id, reply.message_id, { disable_notification: false });
    await logMod(ctx.api, `📌 <b>Pinned message</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)} — msg #${reply.message_id}`);
  } catch (err: any) {
    await ctx.reply(`❌ Could not pin: ${err?.description || err?.message}`);
  }
});

// Joinmust callback — user clicks "✅ I Joined"
bot.callbackQuery(/^jm_verify:(\d+):(\d+)$/, async (ctx) => {
  const groupId = parseInt(ctx.match[1]!, 10);
  const userId = ctx.from.id;
  if (userId !== parseInt(ctx.match[2]!, 10)) {
    await ctx.answerCallbackQuery({ text: "This button is not for you." });
    return;
  }
  const list = await getJoinMustList(groupId);
  const failed: string[] = [];
  for (const jm of list) {
    try {
      const member = await ctx.api.getChatMember(jm.targetId, userId);
      if (member.status === "left" || member.status === "kicked") {
        failed.push(jm.targetUsername ? `@${jm.targetUsername}` : String(jm.targetId));
      }
    } catch {
      failed.push(jm.targetUsername ? `@${jm.targetUsername}` : String(jm.targetId));
    }
  }
  if (failed.length > 0) {
    await ctx.answerCallbackQuery({ text: `❌ Please join: ${failed.join(", ")} first.`, show_alert: true });
    return;
  }
  try {
    await ctx.api.restrictChatMember(groupId, userId, {
      can_send_messages: true, can_send_audios: true, can_send_documents: true,
      can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
      can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
      can_add_web_page_previews: true,
    });
    await ctx.answerCallbackQuery({ text: "✅ Verified! You can now chat." });
    await ctx.editMessageText("✅ Verified! Welcome to the group.").catch(() => {});
    await logGeneral(ctx.api, `🔗 <b>Joinmust verified:</b> <code>${userId}</code> in <code>${groupId}</code>`);
  } catch {
    await ctx.answerCallbackQuery({ text: "❌ Could not unmute you. Please contact an admin." });
  }
});

// ── /gbl ──────────────────────────────────────────────────────────────────────

bot.command("gbl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  const s = await getGroupSettings(ctx.chat!.id);

  if (arg !== "y" && arg !== "n") {
    await ctx.reply(`⚙️ <b>Global Blacklist</b>: ${s.globalBlacklistEnabled ? "✅ Enabled" : "❌ Disabled"}\n\nUsage: /gbl y|n\nEnabling this applies super-admin global blacklist words to this group.`, { parse_mode: "HTML" });
    return;
  }
  await updateGroupSettings(ctx.chat!.id, { globalBlacklistEnabled: arg === "y" });
  await ctx.reply(`✅ Global blacklist sync ${arg === "y" ? "enabled" : "disabled"} for this group.`);
  await logSettings(ctx.api, `🌐 <b>Global blacklist:</b> ${arg === "y" ? "enabled" : "disabled"} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── /sync ─────────────────────────────────────────────────────────────────────

bot.command("sync", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply("🔄 Syncing all known groups…");
  const groups = await listGroups();
  let active = 0, failed = 0;
  const me = await ctx.api.getMe();
  for (const g of groups) {
    if (g.banned) continue;
    try {
      const member = await ctx.api.getChatMember(g.groupId, me.id);
      if (member.status === "administrator" || member.status === "creator") {
        const chat = await ctx.api.getChat(g.groupId);
        const title = "title" in chat ? chat.title || "" : "";
        await upsertGroup(g.groupId, title);
        active++;
      } else { failed++; }
    } catch { failed++; }
  }
  await ctx.reply(
    `✅ <b>Sync complete</b>\n\n📋 Total: ${groups.length}\n✅ Active: ${active}\n❌ Unreachable: ${failed}`,
    { parse_mode: "HTML" },
  );
});

// ── /backup ───────────────────────────────────────────────────────────────────

bot.command("backup", async (ctx) => {
  const chat = ctx.chat;
  const inGroup = chat?.type === "group" || chat?.type === "supergroup";

  if (inGroup) {
    if (!(await requireGroupAdmin(ctx))) return;
    const s = await getGroupSettings(chat!.id);
    const groups = await listGroups();
    const group = groups.find((g) => g.groupId === chat!.id);
    const title = group?.title ?? (("title" in chat!) ? (chat as any).title : "") ?? "";
    const payload = { version: 1, groupId: chat!.id, title, exportedAt: new Date().toISOString(), settings: s };
    const json = JSON.stringify(payload, null, 2);
    await ctx.reply(
      `📦 <b>Config backup for this group</b>\n\n<pre>${escapeHtml(json)}</pre>\n\n<b>To restore:</b> Reply to this message with <code>/restore</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gidArg = parseUserId(args[0]);
  if (!gidArg) { await ctx.reply("Usage: /backup [groupId]"); return; }
  const s = await getGroupSettings(gidArg);
  const groups = await listGroups();
  const group = groups.find((g) => g.groupId === gidArg);
  const payload = {
    version: 1,
    groupId: gidArg,
    title: group?.title ?? "",
    exportedAt: new Date().toISOString(),
    settings: s,
  };
  const json = JSON.stringify(payload, null, 2);
  await ctx.reply(
    `📦 <b>Config backup for group <code>${gidArg}</code></b>\n\n<pre>${escapeHtml(json)}</pre>\n\nUse /restore [json] to restore.`,
    { parse_mode: "HTML" },
  );
});

bot.command("restore", async (ctx) => {
  const chat = ctx.chat;
  const inGroup = chat?.type === "group" || chat?.type === "supergroup";

  if (inGroup) {
    if (!(await requireGroupAdmin(ctx))) return;
  } else {
    if (!(await requireSuperAdmin(ctx))) return;
  }

  let raw = "";

  // Primary path: reply to a /backup message → extract the JSON block from it
  const replyMsg = ctx.message?.reply_to_message;
  if (replyMsg) {
    const replyText = replyMsg.text || replyMsg.caption || "";
    const match = replyText.match(/\{[\s\S]*\}/);
    if (match) raw = match[0];
  }

  // Fallback: inline JSON after the command
  if (!raw) {
    const text = ctx.message?.text || "";
    raw = text.replace(/^\/restore(@\w+)?\s*/i, "").trim();
  }

  if (!raw) {
    await ctx.reply("Usage:\n• Reply to a /backup message with /restore\n• Or: /restore [json]");
    return;
  }

  // HTML-decode: some Telegram clients copy &amp; &lt; &gt; from code blocks verbatim
  raw = raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  let payload: any;
  try { payload = JSON.parse(raw); } catch { await ctx.reply("❌ Invalid JSON. Try replying directly to the /backup message with /restore instead of copy-pasting."); return; }
  const gid = payload?.groupId;
  const settings = payload?.settings;
  if (!gid || !settings) { await ctx.reply("❌ Invalid backup format. Missing groupId or settings."); return; }

  if (inGroup && Number(gid) !== chat!.id) {
    await ctx.reply("❌ You can only restore settings for the current group.");
    return;
  }

  const { groupId: _gid, ...patch } = settings;
  try {
    await updateGroupSettings(Number(gid), patch);
    await ctx.reply(`✅ Settings restored for group <code>${gid}</code>.`, { parse_mode: "HTML" });
    await logSettings(ctx.api, `♻️ <b>Config restored</b> for <code>${gid}</code> by ${fmtAdmin(ctx)}`);
  } catch (err: any) {
    await ctx.reply(`❌ Restore failed: ${err?.message}`);
  }
});

// ── /get [id|key] — super admin full info ─────────────────────────────────────

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "Never";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }) + " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function daysLeft(d: Date | null | undefined): string {
  if (!d) return "";
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return " (expired)";
  return ` (${Math.ceil(diff / 86400000)} days)`;
}

bot.command("get", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const raw = args[0];
  if (!raw) { await ctx.reply("Usage: /get [groupId | userId | token_key]"); return; }

  // Check if it's a token key (hex, 10-20 chars, no leading minus)
  const keyPattern = /^[A-Z0-9]{8,20}$/i;
  if (keyPattern.test(raw)) {
    const rows = await db.select().from(authKeysTable).where(eq(authKeysTable.key, raw.toUpperCase())).limit(1);
    if (rows.length === 0) {
      await ctx.reply(`❌ Token <code>${escapeHtml(raw.toUpperCase())}</code> not found.`, { parse_mode: "HTML" });
      return;
    }
    const k = rows[0]!;
    const now = Date.now();
    const expired = k.expiresAt && k.expiresAt.getTime() < now;
    const exhausted = k.usedCount >= k.maxUses;
    const status = expired ? "Expired ⚠️" : exhausted ? "Used up 🔴" : "Active ✅";
    const usedBy = await listGroups();
    const usingGroups = usedBy.filter((g) => g.authorizedKey?.toUpperCase() === raw.toUpperCase());
    const groupLines = usingGroups.length > 0
      ? usingGroups.map((g) => `  · ${escapeHtml(g.title || "Group")} — <code>${g.groupId}</code>`).join("\n")
      : "  (none)";
    await ctx.reply(
      `🔑 <b>Token Info</b>\n\n` +
      `Key: <code>${k.key}</code>\n` +
      `📊 Uses: <b>${k.usedCount} / ${k.maxUses}</b>\n` +
      `🏘 Groups:\n${groupLines}\n` +
      `⏳ Expires: ${fmtDate(k.expiresAt)}${daysLeft(k.expiresAt)}\n` +
      `Status: ${status}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Numeric ID — detect what type it is
  const id = parseUserId(raw);
  if (!id) { await ctx.reply("❌ Invalid ID or key."); return; }

  let chatInfo: any = null;
  try { chatInfo = await ctx.api.getChat(id); } catch {}

  if (!chatInfo) {
    await ctx.reply(`❌ Could not fetch info for <code>${id}</code>. The bot must be a member of that chat, or it's a user ID we haven't seen.`, { parse_mode: "HTML" });
    return;
  }

  const type = chatInfo.type;

  // ── Group / Supergroup ────────────────────────────────────────────────────
  if (type === "group" || type === "supergroup") {
    const title = chatInfo.title || "—";
    let ownerName = "—";
    let adminCount = 0, botCount = 0;
    try {
      const admins = await ctx.api.getChatAdministrators(id);
      adminCount = admins.length;
      botCount = admins.filter((a) => a.user.is_bot).length;
      const creator = admins.find((a) => a.status === "creator");
      if (creator) {
        ownerName = [creator.user.first_name, creator.user.last_name].filter(Boolean).join(" ") || creator.user.username || String(creator.user.id);
      }
    } catch {}
    let memberCount = 0;
    try { memberCount = await ctx.api.getChatMemberCount(id); } catch {}
    const bannedCount = await countGroupRestrictions(id, "ban");
    const mutedCount = await countGroupRestrictions(id, "mute");

    const groups = await listGroups();
    const gRow = groups.find((g) => g.groupId === id);
    const key = gRow?.authorizedKey ?? "—";
    const expires = gRow?.authorizedExpiresAt ?? null;
    let inviteLink = "—";
    try { inviteLink = chatInfo.invite_link || (await ctx.api.exportChatInviteLink(id)) || "—"; } catch {}

    await ctx.reply(
      `🏢 <b>${escapeHtml(title)}</b>\n\n` +
      `🆔 <code>${id}</code>  ·  ${type === "supergroup" ? "Supergroup" : "Group"}\n` +
      `👑 Owner: ${escapeHtml(ownerName)}\n` +
      `👥 Members: <b>${memberCount}</b>  ·  Admins: ${adminCount}  ·  Bots: ${botCount}\n` +
      `⛔ Banned: ${bannedCount}  ·  🔇 Muted: ${mutedCount}\n` +
      (key !== "—" ? `🔑 Key: <code>${key}</code>\n` : `🔑 Key: —\n`) +
      `⏳ Expires: ${fmtDate(expires)}${daysLeft(expires)}\n` +
      (inviteLink !== "—" ? `🔗 ${inviteLink}` : `🔗 No invite link`),
      { parse_mode: "HTML" },
    );
    return;
  }

  // ── Channel ───────────────────────────────────────────────────────────────
  if (type === "channel") {
    const title = chatInfo.title || "—";
    let ownerName = "—";
    let adminCount = 0, botCount = 0;
    try {
      const admins = await ctx.api.getChatAdministrators(id);
      adminCount = admins.length;
      botCount = admins.filter((a) => a.user.is_bot).length;
      const creator = admins.find((a) => a.status === "creator");
      if (creator) {
        ownerName = creator.user.username ? `@${creator.user.username}` : ([creator.user.first_name, creator.user.last_name].filter(Boolean).join(" ") || String(creator.user.id));
      }
    } catch {}
    let memberCount = 0;
    try { memberCount = await ctx.api.getChatMemberCount(id); } catch {}
    let inviteLink = chatInfo.invite_link || "—";

    await ctx.reply(
      `📢 <b>${escapeHtml(title)}</b>\n\n` +
      `🆔 <code>${id}</code>  ·  Channel\n` +
      `👑 Owner: ${escapeHtml(ownerName)}\n` +
      `👥 Subscribers: <b>${memberCount.toLocaleString()}</b>  ·  Admins: ${adminCount}  ·  Bots: ${botCount}\n` +
      (inviteLink !== "—" ? `🔗 ${inviteLink}` : `🔗 No invite link`),
      { parse_mode: "HTML" },
    );
    return;
  }

  // ── Private (user / bot) ──────────────────────────────────────────────────
  if (type === "private") {
    const isBot = chatInfo.is_bot ?? false;
    const name = [chatInfo.first_name, chatInfo.last_name].filter(Boolean).join(" ") || String(id);
    const username = chatInfo.username ? `@${chatInfo.username}` : "—";
    const tags = await getUserTags(id);
    const tagStr = tags.length > 0 ? tags.join(", ") : "—";
    const globalBan = await getGlobalBanRow(id);
    const globalMute = await getGlobalMuteRow(id);
    const activity = await getUserActivity(id);

    if (isBot) {
      await ctx.reply(
        `🤖 <b>${escapeHtml(name)}</b>\n\n` +
        `🆔 <code>${id}</code>  ·  Bot\n` +
        `📛 Username: ${username}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const joinedStr = activity?.firstSeen ? fmtDate(activity.firstSeen) : "Unknown";
    const lastSeenStr = activity?.lastSeen ? fmtDate(activity.lastSeen) : "Unknown";
    const groupCount = activity?.groupCount ?? 0;
    const warnRows = await db.select().from(warningsTable).where(eq(warningsTable.userId, id));
    const totalWarns = warnRows.reduce((s, r) => s + (r.count ?? 0), 0);

    await ctx.reply(
      `👤 <b>${escapeHtml(name)}</b>\n\n` +
      `🆔 <code>${id}</code>  ·  ${username !== "—" ? username : "No username"}\n` +
      `📅 First seen: ${joinedStr}\n` +
      `🏘 Groups: <b>${groupCount}</b>  ·  ⚠️ Warnings: <b>${totalWarns}</b>\n` +
      `🔇 Muted: ${globalMute ? "Yes" : "No"}  ·  ⛔ Banned: ${globalBan ? "Yes" : "No"}\n` +
      (tags.length > 0 ? `🏷 Tags: ${escapeHtml(tagStr)}\n` : ``) +
      `👁 Last seen: ${lastSeenStr}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await ctx.reply(`❌ Unrecognised chat type: ${type}`);
});

// ── /resetpass ────────────────────────────────────────────────────────────────

bot.command("resetpass", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const newPwd = Array.from({ length: 20 }, () => charset[Math.floor(Math.random() * charset.length)]).join("");
  await setAdminPanelPassword(newPwd);
  const who = ctx.from ? userLink(ctx.from.id, ctx.from.first_name) : "unknown";
  await logSettings(ctx.api, `🔐 Admin panel password reset by ${who}`);
  await ctx.reply(
    `🔐 <b>Admin Panel Password Reset</b>\n\n` +
    `New password:\n<code>${newPwd}</code>\n\n` +
    `✅ All existing sessions have been logged out.\n` +
    `⚠️ Share this only with trusted admins.\n\n` +
    `To restore the default password, use /resetpass default`,
    { parse_mode: "HTML" },
  );
});

bot.command("resetpassdefault", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  await setAdminPanelPassword(null);
  const who = ctx.from ? userLink(ctx.from.id, ctx.from.first_name) : "unknown";
  await logSettings(ctx.api, `🔐 Admin panel password reverted to default by ${who}`);
  await ctx.reply(
    `✅ <b>Password Reset to Default</b>\n\nThe admin panel password has been reverted to the default (derived from bot token). All custom sessions have been logged out.`,
    { parse_mode: "HTML" },
  );
});

// ── /filter /unfilter /filters ────────────────────────────────────────────────

bot.command("filter", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const body = text.replace(/^\/filter(@\w+)?\s*/i, "").trim();
  const spaceIdx = body.indexOf(" ");
  if (spaceIdx === -1 || !body) {
    await ctx.reply("Usage: /filter [keyword] [reply text]\nExample: /filter hello Hello there!");
    return;
  }
  const kw = body.slice(0, spaceIdx).toLowerCase();
  const reply = body.slice(spaceIdx + 1).trim();
  if (!reply) { await ctx.reply("Usage: /filter [keyword] [reply text]"); return; }
  await addFilter(ctx.chat!.id, kw, reply);
  await ctx.reply(`✅ Filter added: <code>${escapeHtml(kw)}</code> → ${escapeHtml(reply)}`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `💬 <b>Filter added:</b> <code>${escapeHtml(kw)}</code> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unfilter", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /unfilter [keyword]"); return; }
  const ok = await removeFilter(ctx.chat!.id, args[0].toLowerCase());
  await ctx.reply(ok ? `✅ Filter <code>${escapeHtml(args[0])}</code> removed.` : `❌ Filter not found.`, { parse_mode: "HTML" });
});

bot.command("filters", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const list = await listFilters(chat.id);
  if (list.length === 0) { await ctx.reply("📋 No filters set."); return; }
  const lines = list.map((f, i) => `${i + 1}. <code>${escapeHtml(f.word)}</code> → ${escapeHtml(f.reply)}`).join("\n");
  await ctx.reply(`💬 <b>Filters (${list.length})</b>\n\n${lines}`, { parse_mode: "HTML" });
});

// ── /addbl /rmbl /bl /resetbl ─────────────────────────────────────────────────

bot.command("addbl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /addbl [word]"); return; }
  await addBlacklistWord(ctx.chat!.id, args[0].toLowerCase());
  await ctx.reply(`✅ <code>${escapeHtml(args[0])}</code> added to blacklist.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `⛔ <b>BL word added:</b> <code>${escapeHtml(args[0])}</code> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("rmbl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmbl [word]"); return; }
  const ok = await removeBlacklistWord(ctx.chat!.id, args[0].toLowerCase());
  await ctx.reply(ok ? `✅ <code>${escapeHtml(args[0])}</code> removed from blacklist.` : `❌ Word not found.`, { parse_mode: "HTML" });
});

bot.command("bl", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const list = await listBlacklist(chat.id);
  if (list.length === 0) { await ctx.reply("📋 Blacklist is empty."); return; }
  const lines = list.map((b, i) => `${i + 1}. <code>${escapeHtml(b)}</code>`).join("\n");
  await ctx.reply(`⛔ <b>Blacklist (${list.length})</b>\n\n${lines}`, { parse_mode: "HTML" });
});

bot.command("resetbl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  await resetBlacklist(ctx.chat!.id);
  await ctx.reply("✅ Blacklist cleared.");
  await logSettings(ctx.api, `🗑️ <b>Blacklist cleared</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── /lock /unlock /locks ──────────────────────────────────────────────────────

bot.command("lock", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const type = args[0]?.toLowerCase() as LockType | undefined;
  if (!type || !LOCK_TYPES.includes(type as LockType)) {
    await ctx.reply(`Usage: /lock [type]\nTypes: ${LOCK_TYPES.join(", ")}`);
    return;
  }
  await addLock(ctx.chat!.id, type as LockType);
  await ctx.reply(`🔒 <b>${type}</b> locked.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🔒 <b>Locked:</b> ${type} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unlock", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const type = args[0]?.toLowerCase();
  if (!type || !LOCK_TYPES.includes(type as LockType)) {
    await ctx.reply(`Usage: /unlock [type]\nTypes: ${LOCK_TYPES.join(", ")}`);
    return;
  }
  await removeLock(ctx.chat!.id, type as LockType);
  await ctx.reply(`🔓 <b>${type}</b> unlocked.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🔓 <b>Unlocked:</b> ${type} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("locks", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const locksSet = await getLocks(chat.id);
  if (locksSet.size === 0) { await ctx.reply("🔓 No locks active."); return; }
  await ctx.reply(`🔒 <b>Active locks:</b> ${Array.from(locksSet).join(", ")}`, { parse_mode: "HTML" });
});

// ── /welcome /setwelcome ──────────────────────────────────────────────────────

bot.command("welcome", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  if (arg === "on" || arg === "y") {
    await updateGroupSettings(ctx.chat!.id, { welcomeEnabled: true });
    await ctx.reply("✅ Welcome message enabled.");
    await logSettings(ctx.api, `👋 <b>Welcome enabled</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } else if (arg === "off" || arg === "n") {
    await updateGroupSettings(ctx.chat!.id, { welcomeEnabled: false });
    await ctx.reply("✅ Welcome message disabled.");
    await logSettings(ctx.api, `👋 <b>Welcome disabled</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } else {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(
      `👋 Welcome: <b>${s.welcomeEnabled ? "On" : "Off"}</b>\n\nMessage:\n${escapeHtml(s.welcomeMessage || "(default)")}\n\nUsage: /welcome on|off\nSet text: /setwelcome [text]\nVars: {name} {group} {id} {username}`,
      { parse_mode: "HTML" },
    );
  }
});

bot.command("setwelcome", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/setwelcome(@\w+)?\s*/i, "").trim();
  if (!msg) { await ctx.reply("Usage: /setwelcome [message]\nVars: {name} {group} {id} {username}"); return; }
  await updateGroupSettings(ctx.chat!.id, { welcomeMessage: msg, welcomeEnabled: true });
  await ctx.reply(`✅ Welcome message set and enabled:\n\n${escapeHtml(msg)}`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `👋 <b>Welcome message set</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── /captcha /antibot /antichannel ────────────────────────────────────────────

bot.command("captcha", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  if (arg !== "on" && arg !== "off" && arg !== "y" && arg !== "n") {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(`🤖 Captcha: <b>${s.captchaEnabled ? "On" : "Off"}</b>\nUsage: /captcha on|off`, { parse_mode: "HTML" });
    return;
  }
  const enabled = arg === "on" || arg === "y";
  await updateGroupSettings(ctx.chat!.id, { captchaEnabled: enabled });
  await ctx.reply(`✅ Captcha ${enabled ? "enabled" : "disabled"}.`);
  await logSettings(ctx.api, `🤖 <b>Captcha ${enabled ? "on" : "off"}</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("antibot", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  if (arg !== "on" && arg !== "off" && arg !== "y" && arg !== "n") {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(`🤖 Antibot: <b>${s.antibot ? "On" : "Off"}</b>\nUsage: /antibot on|off`, { parse_mode: "HTML" });
    return;
  }
  const enabled = arg === "on" || arg === "y";
  await updateGroupSettings(ctx.chat!.id, { antibot: enabled });
  await ctx.reply(`✅ Antibot ${enabled ? "enabled" : "disabled"}.`);
  await logSettings(ctx.api, `🤖 <b>Antibot ${enabled ? "on" : "off"}</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("antichannel", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  if (arg !== "on" && arg !== "off" && arg !== "y" && arg !== "n") {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(`📛 Antichannel: <b>${s.antichannel ? "On" : "Off"}</b>\nUsage: /antichannel on|off`, { parse_mode: "HTML" });
    return;
  }
  const enabled = arg === "on" || arg === "y";
  await updateGroupSettings(ctx.chat!.id, { antichannel: enabled });
  await ctx.reply(`✅ Antichannel ${enabled ? "enabled" : "disabled"}.`);
  await logSettings(ctx.api, `📛 <b>Antichannel ${enabled ? "on" : "off"}</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── /flood /floodaction /warnlimit /warnaction ────────────────────────────────

bot.command("flood", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(
      `🌊 Flood limit: <b>${s.floodLimit || "Off"}</b>  Action: <b>${s.floodAction}</b>\n\nUsage: /flood [limit]  (0 = off, min 3)`,
      { parse_mode: "HTML" },
    );
    return;
  }
  const limit = parseInt(args[0], 10);
  if (isNaN(limit) || limit < 0) { await ctx.reply("❌ Use 0 to disable, or 3–100."); return; }
  await updateGroupSettings(ctx.chat!.id, { floodLimit: limit });
  await ctx.reply(limit === 0 ? "✅ Flood control disabled." : `✅ Flood limit set to <b>${limit}</b> messages.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🌊 <b>Flood limit:</b> ${limit} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("floodaction", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const action = args[0]?.toLowerCase();
  if (!action || !["ban", "mute", "kick"].includes(action)) {
    await ctx.reply("Usage: /floodaction ban|mute|kick");
    return;
  }
  await updateGroupSettings(ctx.chat!.id, { floodAction: action as "ban" | "mute" | "kick" });
  await ctx.reply(`✅ Flood action set to <b>${action}</b>.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🌊 <b>Flood action:</b> ${action} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("warnlimit", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(`⚠️ Warn limit: <b>${s.warnLimit}</b>\nUsage: /warnlimit [number]`, { parse_mode: "HTML" });
    return;
  }
  const n = parseInt(args[0], 10);
  if (isNaN(n) || n < 1) { await ctx.reply("❌ Must be at least 1."); return; }
  await updateGroupSettings(ctx.chat!.id, { warnLimit: n });
  await ctx.reply(`✅ Warn limit set to <b>${n}</b>.`, { parse_mode: "HTML" });
});

bot.command("warnaction", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const action = args[0]?.toLowerCase();
  if (!action || !["ban", "mute", "kick"].includes(action)) {
    await ctx.reply("Usage: /warnaction ban|mute|kick");
    return;
  }
  await updateGroupSettings(ctx.chat!.id, { warnAction: action as "ban" | "mute" | "kick" });
  await ctx.reply(`✅ Warn action set to <b>${action}</b>.`, { parse_mode: "HTML" });
});

// ── /note /getnote /delnote /notes ────────────────────────────────────────────

bot.command("note", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const body = text.replace(/^\/note(@\w+)?\s*/i, "").trim();
  const spaceIdx = body.indexOf(" ");
  if (spaceIdx === -1 || !body) {
    await ctx.reply("Usage: /note [name] [content]\nExample: /note rules 1. Be respectful");
    return;
  }
  const name = body.slice(0, spaceIdx).toLowerCase();
  const content = body.slice(spaceIdx + 1).trim();
  if (!content) { await ctx.reply("Usage: /note [name] [content]"); return; }
  await saveNote(ctx.chat!.id, name, content, ctx.from!.id);
  await ctx.reply(`✅ Note <code>#${escapeHtml(name)}</code> saved.`, { parse_mode: "HTML" });
});

bot.command("getnote", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /getnote [name]  or type #name in chat"); return; }
  const content = await getNote(chat.id, args[0].toLowerCase());
  if (!content) { await ctx.reply(`❌ Note <code>${escapeHtml(args[0])}</code> not found.`, { parse_mode: "HTML" }); return; }
  await ctx.reply(content, { parse_mode: "HTML" });
});

bot.command("delnote", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /delnote [name]"); return; }
  const ok = await removeNote(ctx.chat!.id, args[0].toLowerCase());
  await ctx.reply(ok ? `✅ Note <code>#${escapeHtml(args[0])}</code> deleted.` : `❌ Note not found.`, { parse_mode: "HTML" });
});

bot.command("notes", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const list = await listNotes(chat.id);
  if (list.length === 0) { await ctx.reply("📋 No notes saved."); return; }
  const lines = list.map((n, i) => `${i + 1}. <code>#${escapeHtml(n.name)}</code>`).join("\n");
  await ctx.reply(`📌 <b>Notes (${list.length})</b>\n\n${lines}\n\n<i>Type #name in chat to get.</i>`, { parse_mode: "HTML" });
});

// ── /approve /unapprove /approved /unapproveall ───────────────────────────────

bot.command("approve", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /approve — reply to user, or /approve [userId]"); return; }
  await approveUser(ctx.chat!.id, target.id, ctx.from!.id);
  await ctx.reply(`✅ <b>Approved</b> · ${userLink(target.id, target.name)}\n<i>Exempt from flood, locks, and blacklist.</i>`, { parse_mode: "HTML" });
  await logMod(ctx.api, `✅ <b>Approved:</b> ${userLink(target.id, target.name)} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unapprove", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /unapprove — reply to user, or /unapprove [userId]"); return; }
  await unapproveUser(ctx.chat!.id, target.id);
  await ctx.reply(`✅ <b>Unapproved</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
  await logMod(ctx.api, `🚫 <b>Unapproved:</b> ${userLink(target.id, target.name)} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("approved", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  if (!(await senderIsGroupAdmin(ctx))) { await ctx.reply("❌ Only group admins can view this."); return; }
  const list = await listApproved(chat.id);
  if (list.length === 0) { await ctx.reply("📋 No approved users."); return; }
  const lines = list.map((a, i) => `${i + 1}. ${userLink(a.userId, String(a.userId))}`).join("\n");
  await ctx.reply(`✅ <b>Approved users (${list.length})</b>\n\n${lines}`, { parse_mode: "HTML" });
});

bot.command("unapproveall", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  await unapproveAll(ctx.chat!.id);
  await ctx.reply("✅ All approvals cleared.");
  await logMod(ctx.api, `🗑️ <b>All approvals cleared</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── /joinmust /unjoinmust /joinmustlist ───────────────────────────────────────

bot.command("joinmust", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /joinmust @channel  or  /joinmust -100123456789"); return; }
  const raw = args[0];
  let targetId: number;
  let targetUsername: string | null = null;
  if (raw.startsWith("@")) {
    targetUsername = raw.slice(1);
    try {
      const ch = await ctx.api.getChat(raw);
      targetId = ch.id;
    } catch {
      await ctx.reply(`❌ Could not find ${raw}. Make sure the bot is a member of that channel.`);
      return;
    }
  } else {
    const id = parseUserId(raw);
    if (!id) { await ctx.reply("❌ Invalid. Use @username or numeric ID."); return; }
    targetId = id;
  }
  await addJoinMust(ctx.chat!.id, targetId, targetUsername);
  await ctx.reply(
    `✅ New members must join ${targetUsername ? `@${targetUsername}` : `<code>${targetId}</code>`} before chatting.`,
    { parse_mode: "HTML" },
  );
  await logSettings(ctx.api, `🔗 <b>Joinmust added:</b> ${targetUsername || targetId} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unjoinmust", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /unjoinmust @channel  or  /unjoinmust -100123456789"); return; }
  const raw = args[0];
  let targetId: number | null = null;
  if (raw.startsWith("@")) {
    try { const ch = await ctx.api.getChat(raw); targetId = ch.id; } catch {}
  } else {
    targetId = parseUserId(raw);
  }
  if (!targetId) { await ctx.reply("❌ Could not resolve that channel."); return; }
  await removeJoinMust(ctx.chat!.id, targetId);
  await ctx.reply(`✅ Joinmust requirement removed for <code>${targetId}</code>.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🔗 <b>Joinmust removed:</b> ${targetId} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("joinmustlist", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const list = await getJoinMustList(chat.id);
  if (list.length === 0) { await ctx.reply("📋 No joinmust requirements."); return; }
  const lines = list.map((jm, i) =>
    `${i + 1}. ${jm.targetUsername ? `@${jm.targetUsername}` : `<code>${jm.targetId}</code>`}`,
  ).join("\n");
  await ctx.reply(`🔗 <b>Joinmust (${list.length})</b>\n\n${lines}`, { parse_mode: "HTML" });
});

// ── /addsa /rmsa /listsa ──────────────────────────────────────────────────────

bot.command("addsa", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /addsa [userId]"); return; }
  if (isHardcodedSuper(id)) { await ctx.reply("⚠️ That user is already a hardcoded super admin."); return; }
  await addSuperAdmin(id);
  await ctx.reply(`✅ <code>${id}</code> added as Super Admin.`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `👑 <b>Super Admin added:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

bot.command("rmsa", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /rmsa [userId]"); return; }
  if (isHardcodedSuper(id)) { await ctx.reply("❌ Cannot remove a hardcoded super admin."); return; }
  await removeSuperAdmin(id);
  await ctx.reply(`✅ <code>${id}</code> removed from Super Admins.`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `👑 <b>Super Admin removed:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

bot.command("listsa", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const saSet = await getSuperAdmins();
  const saArr = Array.from(saSet);
  const lines = saArr.map((id, i) =>
    `${i + 1}. <code>${id}</code>${isHardcodedSuper(id) ? " 🔒" : ""}`,
  ).join("\n");
  await ctx.reply(
    `👑 <b>Super Admins (${saArr.length})</b>\n\n${saArr.length ? lines : "(none)"}\n\n🔒 = hardcoded`,
    { parse_mode: "HTML" },
  );
});

// ── /listgroups /bangroup /unbangroup ─────────────────────────────────────────

bot.command("listgroups", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const groups = await listGroups();
  if (groups.length === 0) { await ctx.reply("No groups registered."); return; }
  const lines = groups.map((g, i) =>
    `${i + 1}. <b>${escapeHtml(g.title || "—")}</b> <code>${g.groupId}</code>` +
    (g.banned ? " 🚫" : g.authorized ? " ✅" : " ⏳"),
  ).join("\n");
  await ctx.reply(
    `🏘️ <b>Groups (${groups.length})</b>\n✅ auth  ⏳ pending  🚫 banned\n\n${lines}`,
    { parse_mode: "HTML" },
  );
});

bot.command("bangroup", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /bangroup [groupId]"); return; }
  await setGroupBanned(id, true);
  try { await ctx.api.sendMessage(id, "🚫 This group has been banned from using this bot."); } catch {}
  try { await ctx.api.leaveChat(id); } catch {}
  await ctx.reply(`✅ Group <code>${id}</code> banned and left.`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `🚫 <b>Group banned:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

bot.command("unbangroup", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /unbangroup [groupId]"); return; }
  await setGroupBanned(id, false);
  await ctx.reply(`✅ Group <code>${id}</code> unbanned.`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `✅ <b>Group unbanned:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

// ── /listkeys /revokekey ──────────────────────────────────────────────────────

bot.command("listkeys", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const keys = await listAuthKeys();
  if (keys.length === 0) { await ctx.reply("No auth keys found."); return; }
  const now = Date.now();
  const lines = keys.map((k, i) => {
    const expired = k.expiresAt && k.expiresAt.getTime() < now;
    const exhausted = k.usedCount >= k.maxUses;
    const status = expired ? "⚠️" : exhausted ? "🔴" : "✅";
    const expStr = k.expiresAt ? k.expiresAt.toISOString().slice(0, 10) : "perm";
    return `${i + 1}. ${status} <code>${k.key}</code> — ${k.usedCount}/${k.maxUses}  exp: ${expStr}`;
  }).join("\n");
  await ctx.reply(`🔑 <b>Auth Keys (${keys.length})</b>\n✅ active  ⚠️ expired  🔴 used up\n\n${lines}`, { parse_mode: "HTML" });
});

bot.command("revokekey", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /revokekey [key]"); return; }
  await removeAuthKey(args[0].toUpperCase());
  await ctx.reply(`✅ Key <code>${escapeHtml(args[0].toUpperCase())}</code> revoked.`, { parse_mode: "HTML" });
  await logSecurity(ctx.api, `🗑️ <b>Auth key revoked:</b> <code>${escapeHtml(args[0].toUpperCase())}</code> by ${fmtAdmin(ctx)}`);
});

// ── /listgbans /listgmutes ────────────────────────────────────────────────────

bot.command("listgbans", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const list = await listGlobalBans();
  if (list.length === 0) { await ctx.reply("No global bans."); return; }
  const lines = list.map((b, i) =>
    `${i + 1}. <code>${b.userId}</code>${b.until ? ` — exp: ${b.until.toISOString().slice(0, 10)}` : " (perm)"}`,
  ).join("\n");
  await ctx.reply(`⛔ <b>Global Bans (${list.length})</b>\n\n${lines}`, { parse_mode: "HTML" });
});

bot.command("listgmutes", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const list = await listGlobalMutes();
  if (list.length === 0) { await ctx.reply("No global mutes."); return; }
  const lines = list.map((m, i) =>
    `${i + 1}. <code>${m.userId}</code>${m.until ? ` — exp: ${m.until.toISOString().slice(0, 10)}` : " (perm)"}`,
  ).join("\n");
  await ctx.reply(`🔇 <b>Global Mutes (${list.length})</b>\n\n${lines}`, { parse_mode: "HTML" });
});

// ── Error handler ─────────────────────────────────────────────────────────────

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) logger.warn({ desc: e.description }, "Grammy error");
  else if (e instanceof HttpError) logger.warn({ err: String(e) }, "HTTP error");
  else logger.error({ err: e }, "Unhandled bot error");
});

// ── Startup ───────────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  await loadAdminPasswordOverride();
  await ensureHardcodedSupers();
  registerPanelHandlers(bot);
  startScheduler(bot);
  startCaptchaWatcher(bot);
  startAuthExpiryWatcher(bot);
  void bot.start({
    allowed_updates: ["message", "edited_message", "callback_query", "chat_member", "my_chat_member"],
    onStart: (info) => {
      botUsername = info.username;
      logger.info({ username: info.username, hardcodedSupers: HARDCODED_SUPER_ADMINS }, "Telegram bot started");
    },
  });
}
