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
      await ctx.reply(
        "👋 Welcome, Super Admin!\n\nUse /help for the full command list.",
      );
    } else {
      // Regular user in PM
      await ctx.reply(
        `👋 Hi! I'm <b>@${botUsername}</b> — a group management bot.\n\nAdd me to your group as an admin and authorize the group with a token from a Super Admin to get started.`,
        { parse_mode: "HTML" },
      );
    }
  } else {
    await ctx.reply("Hi! Make sure I'm an admin and this group is authorized (/redeem).").catch(() => {});
  }
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

// ── /promote / /demote ────────────────────────────────────────────────────────

bot.command("promote", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_promote_members"))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /promote — reply to a user, or /promote [userid]"); return; }
  try {
    await ctx.api.promoteChatMember(ctx.chat!.id, target.id, {
      can_manage_chat: true,
      can_change_info: true,
      can_delete_messages: true,
      can_invite_users: true,
      can_restrict_members: true,
      can_pin_messages: true,
      can_manage_video_chats: true,
      is_anonymous: false,
    });
    await ctx.reply(`👑 <b>Promoted to Admin</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `👑 <b>Promoted:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not promote: ${err?.description || err?.message}`); }
});

bot.command("demote", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_promote_members"))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /demote — reply to a user, or /demote [userid]"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot demote a Super Admin."); return; }
  try {
    await ctx.api.promoteChatMember(ctx.chat!.id, target.id, {
      can_manage_chat: false,
      can_change_info: false,
      can_delete_messages: false,
      can_invite_users: false,
      can_restrict_members: false,
      can_pin_messages: false,
      can_manage_video_chats: false,
      is_anonymous: false,
    });
    await ctx.reply(`⬇️ <b>Demoted</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `⬇️ <b>Demoted:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not demote: ${err?.description || err?.message}`); }
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

// ── /warnsetting ──────────────────────────────────────────────────────────────

bot.command("warnsetting", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const s = await getGroupSettings(ctx.chat!.id);
  if (args.length < 2) {
    await ctx.reply(`⚙️ <b>Warn Settings</b>\nLimit: ${s.warnLimit} | Action: ${s.warnAction} | Duration: ${formatDuration(s.warnDurationSec)}\n\nUsage: /warnsetting [limit] [mute|ban|kick] [time]\nTime is optional — omit for permanent\nExample: /warnsetting 3 mute 24h`, { parse_mode: "HTML" });
    return;
  }
  const limit = parseInt(args[0]!, 10);
  const action = args[1]!.toLowerCase();
  const dur = args[2] ? (parseDuration(args[2]) ?? 0) : 0;
  if (Number.isNaN(limit) || limit < 1 || (action !== "mute" && action !== "ban" && action !== "kick")) {
    await ctx.reply("❌ Invalid. Example: /warnsetting 3 mute 24h"); return;
  }
  await updateGroupSettings(ctx.chat!.id, { warnLimit: limit, warnAction: action, warnDurationSec: dur });
  await ctx.reply(`✅ Warn settings: limit=${limit}, action=${action}, duration=${formatDuration(dur)}`);
  await logSettings(ctx.api, `⚠️ <b>Warn settings updated</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}: limit=${limit}, action=${action}, duration=${formatDuration(dur)}`);
});

// ── /flood ────────────────────────────────────────────────────────────────────

bot.command("flood", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const s = await getGroupSettings(ctx.chat!.id);

  if (args.length === 0) {
    await ctx.reply(
      `⚙️ <b>Flood Control</b>\nStatus: ${s.floodEnabled ? "✅ Enabled" : "❌ Disabled"}\nLimit: ${s.floodLimit} msgs / ${s.floodWindowSec}s\nAction: ${s.floodAction} (${formatDuration(s.floodActionDurationSec)})\n\nUsage:\n/flood off — disable\n/flood [limit] — enable (e.g. /flood 5)\n/flood [limit] [window_sec] [mute|ban|kick] [duration]`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (args[0]!.toLowerCase() === "off") {
    await updateGroupSettings(ctx.chat!.id, { floodEnabled: false });
    await ctx.reply("✅ Flood control disabled.");
    await logSettings(ctx.api, `🌊 <b>Flood control disabled</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
    return;
  }

  const limit = parseInt(args[0]!, 10);
  if (Number.isNaN(limit) || limit < 1) {
    await ctx.reply("❌ Invalid limit. Example: /flood 5  or  /flood 5 10 mute 10m"); return;
  }
  const windowSec = args[1] ? parseInt(args[1], 10) : s.floodWindowSec;
  const rawAction = args[2]?.toLowerCase();
  const action = rawAction === "ban" || rawAction === "kick" ? rawAction : "mute";
  const dur = args[3] ? parseDuration(args[3]) : s.floodActionDurationSec;

  await updateGroupSettings(ctx.chat!.id, {
    floodEnabled: true,
    floodLimit: limit,
    floodWindowSec: isNaN(windowSec) ? 5 : windowSec,
    floodAction: action,
    floodActionDurationSec: dur ?? 300,
  });
  await ctx.reply(`✅ Flood control enabled: max ${limit} messages per ${isNaN(windowSec) ? 5 : windowSec}s → ${action} (${action === "kick" ? "one-time" : formatDuration(dur ?? 300)})`);
});

// ── /floodaction ──────────────────────────────────────────────────────────────

bot.command("floodaction", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const s = await getGroupSettings(ctx.chat!.id);

  if (args.length === 0) {
    await ctx.reply(
      `⚙️ <b>Flood Action</b>\nCurrent: <b>${s.floodAction}</b> for <b>${formatDuration(s.floodActionDurationSec)}</b>\n\nUsage: /floodaction [mute|ban|kick] [duration]\nExamples:\n/floodaction mute 10m\n/floodaction ban 1d\n/floodaction kick`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const rawAction = args[0]!.toLowerCase();
  if (rawAction !== "mute" && rawAction !== "ban" && rawAction !== "kick") {
    await ctx.reply("❌ Invalid action. Use: mute, ban, or kick"); return;
  }

  const dur = args[1] ? parseDuration(args[1]) : s.floodActionDurationSec;
  await updateGroupSettings(ctx.chat!.id, {
    floodAction: rawAction,
    floodActionDurationSec: dur ?? 300,
  });
  await ctx.reply(
    `✅ Flood action set to <b>${rawAction}</b>` +
    (rawAction !== "kick" ? ` for <b>${formatDuration(dur ?? 300)}</b>` : "") + ".",
    { parse_mode: "HTML" },
  );
});

// ── /info ─────────────────────────────────────────────────────────────────────

bot.command("info", async (ctx) => {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    await ctx.reply("Use /info in a group by replying to a user.");
    return;
  }
  const reply = ctx.message?.reply_to_message;
  let targetUser: any = null;
  if (reply?.from) {
    targetUser = reply.from;
  } else {
    const args = splitArgs(ctx.message?.text);
    const id = parseUserId(args[0]);
    if (id) {
      try { const m = await ctx.api.getChatMember(ctx.chat.id, id); targetUser = m.user; }
      catch { await ctx.reply("❌ Could not find that user."); return; }
    }
  }
  if (!targetUser) { await ctx.reply("Usage: /info — reply to a user, or: /info [userid]"); return; }

  const chatId = ctx.chat.id;
  const userId = targetUser.id;
  let member: any = null;
  try { member = await ctx.api.getChatMember(chatId, userId); } catch {}

  const warnRow = await db.select().from(warningsTable)
    .where(and(eq(warningsTable.groupId, chatId), eq(warningsTable.userId, userId))).limit(1);
  const warnCount = warnRow[0]?.count ?? 0;
  const settings = await getGroupSettings(chatId);
  const globalBanned = await isGloballyBanned(userId);
  const superAdmin = await isSuperAdmin(userId);
  const approved = await isApproved(chatId, userId);
  const name = [targetUser.first_name, targetUser.last_name].filter(Boolean).join(" ") || targetUser.username || String(userId);
  const username = targetUser.username ? `@${targetUser.username}` : "—";
  const statusMap: Record<string, string> = { creator: "👑 Creator", administrator: "🛡️ Admin", member: "👤 Member", restricted: "🔒 Restricted", left: "🚪 Left", kicked: "⛔ Banned" };
  const memberStatus = member ? (statusMap[member.status] || member.status) : "❓ Unknown";
  const isAdmin = member?.status === "creator" || member?.status === "administrator";
  const isMuted = member?.status === "restricted" && member?.can_send_messages === false;

  await ctx.reply([
    `👤 <b>User Info</b>`,
    ``,
    `🔖 Name: <b>${escapeHtml(name)}</b>`,
    `📛 Username: ${escapeHtml(username)}`,
    `🆔 ID: <code>${userId}</code>`,
    `🤖 Bot: ${targetUser.is_bot ? "Yes" : "No"}`,
    ``,
    `📊 <b>Group Status</b>`,
    `Status: ${memberStatus}`,
    `Admin: ${isAdmin ? "✅ Yes" : "❌ No"}`,
    `Muted: ${isMuted ? "🔇 Yes" : "—"}`,
    `✅ Approved: ${approved ? "Yes" : "No"}`,
    `⚠️ Warnings: ${warnCount}/${settings.warnLimit}`,
    ``,
    `🌍 Global ban: ${globalBanned ? "🚨 YES" : "—"}`,
    `👑 Super Admin: ${superAdmin ? "✅ Yes" : "—"}`,
  ].join("\n"), { parse_mode: "HTML" });
});

// ── Locks ─────────────────────────────────────────────────────────────────────

bot.command("lock", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_delete_messages"))) return;
  const args = splitArgs(ctx.message?.text);
  const type = args[0]?.toLowerCase() as LockType | undefined;
  if (!type || !LOCK_TYPES.includes(type)) { await ctx.reply(`Usage: /lock [type]\nTypes: ${LOCK_TYPES.join(", ")}`); return; }
  await addLock(ctx.chat!.id, type);
  await ctx.reply(`🔒 <b>Locked</b> · <code>${type}</code>`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🔒 <b>Lock added:</b> ${type} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unlock", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const type = args[0]?.toLowerCase() as LockType | undefined;
  if (!type || !LOCK_TYPES.includes(type)) { await ctx.reply(`Usage: /unlock [type]\nTypes: ${LOCK_TYPES.join(", ")}`); return; }
  const ok = await removeLock(ctx.chat!.id, type);
  if (ok) await logSettings(ctx.api, `🔓 <b>Lock removed:</b> ${type} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  await ctx.reply(ok ? `🔓 <b>Unlocked</b> · <code>${type}</code>` : `❌ <code>${type}</code> was not locked.`, { parse_mode: "HTML" });
});

bot.command("locktypes", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const active = await getLocks(ctx.chat!.id);
  const lines = LOCK_TYPES.map((t) => `${active.has(t) ? "🔒" : "🔓"} ${t}`);
  await ctx.reply(`<b>Lock Types</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

// ── Filters ───────────────────────────────────────────────────────────────────

bot.command("filter", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const rest = text.replace(/^\/filter(@\w+)?\s*/i, "");
  const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) { await ctx.reply("Usage: /filter [keyword] [reply]\nExample: /filter hello Hello there!"); return; }
  await addFilter(ctx.chat!.id, m[1]!, m[2]!);
  await ctx.reply(`✅ <b>Filter set</b> · keyword: <code>${escapeHtml(m[1]!)}</code>`, { parse_mode: "HTML" });
});

bot.command("filters", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const filters = await listFilters(ctx.chat!.id);
  if (filters.length === 0) { await ctx.reply("No filters set."); return; }
  const lines = filters.map((f) => `• <b>${escapeHtml(f.word)}</b> → ${escapeHtml(f.reply)}`);
  await ctx.reply(`📋 <b>Active Filters</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

bot.command("rmfilter", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmfilter [keyword]"); return; }
  const ok = await removeFilter(ctx.chat!.id, args[0]);
  await ctx.reply(ok ? `✅ <b>Filter removed</b> · <code>${escapeHtml(args[0])}</code>` : `❌ Filter not found: <code>${escapeHtml(args[0])}</code>`, { parse_mode: "HTML" });
});

// ── Blacklist ─────────────────────────────────────────────────────────────────

bot.command("bl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /bl [word]"); return; }
  await addBlacklistWord(ctx.chat!.id, args[0]);
  await ctx.reply(`🚫 <b>Blacklisted</b> · <code>${escapeHtml(args[0])}</code>`, { parse_mode: "HTML" });
});

bot.command("rmbl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmbl [word]"); return; }
  const ok = await removeBlacklistWord(ctx.chat!.id, args[0]);
  await ctx.reply(ok ? `✅ <b>Removed from blacklist</b> · <code>${escapeHtml(args[0])}</code>` : `❌ Not in blacklist: <code>${escapeHtml(args[0])}</code>`, { parse_mode: "HTML" });
});

bot.command("blacklisted", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const words = await listBlacklist(ctx.chat!.id);
  if (words.length === 0) { await ctx.reply("Blacklist is empty."); return; }
  await ctx.reply(`🚫 <b>Blacklisted Words</b>\n${words.map((w) => `• ${escapeHtml(w)}`).join("\n")}`, { parse_mode: "HTML" });
});

bot.command("rmblacklist", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  await resetBlacklist(ctx.chat!.id);
  await ctx.reply("✅ Blacklist cleared.");
});

bot.command("blsetting", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const s = await getGroupSettings(ctx.chat!.id);
  if (args.length < 3) {
    await ctx.reply(`⚙️ <b>Blacklist Settings</b>\nThreshold: ${s.blacklistThreshold} | Duration: ${formatDuration(s.blacklistDurationSec)} | Action: ${s.blacklistAction}\n\nUsage: /blsetting [hits] [duration] [mute|ban]`, { parse_mode: "HTML" });
    return;
  }
  const threshold = parseInt(args[0]!, 10);
  const dur = parseDuration(args[1]);
  const action = args[2]!.toLowerCase();
  if (Number.isNaN(threshold) || threshold < 1 || dur === null || (action !== "mute" && action !== "ban" && action !== "kick")) {
    await ctx.reply("❌ Invalid. Example: /blsetting 3 1h mute"); return;
  }
  await updateGroupSettings(ctx.chat!.id, { blacklistThreshold: threshold, blacklistDurationSec: dur, blacklistAction: action });
  await ctx.reply(`✅ Blacklist settings: threshold=${threshold}, duration=${formatDuration(dur)}, action=${action}`);
  await logSettings(ctx.api, `🚫 <b>Blacklist settings updated</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}: threshold=${threshold}, duration=${formatDuration(dur)}, action=${action}`);
});

// ── Notes ─────────────────────────────────────────────────────────────────────

bot.command("save", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const rest = text.replace(/^\/save(@\w+)?\s*/i, "");
  const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) { await ctx.reply("Usage: /save [notename] [content]\nRetrieve with: #notename"); return; }
  await saveNote(ctx.chat!.id, m[1]!, m[2]!, ctx.from!.id);
  await ctx.reply(`📓 <b>Note saved</b> · <code>#${m[1]!.toLowerCase()}</code>`, { parse_mode: "HTML" });
});

bot.command("rmnote", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmnote [notename]"); return; }
  const ok = await removeNote(ctx.chat!.id, args[0]);
  await ctx.reply(ok ? `✅ <b>Note deleted</b> · <code>${escapeHtml(args[0])}</code>` : `❌ Note not found: <code>${escapeHtml(args[0])}</code>`, { parse_mode: "HTML" });
});

bot.command("notes", async (ctx) => {
  if (!ctx.chat) return;
  const notes = await listNotes(ctx.chat.id);
  if (notes.length === 0) { await ctx.reply("No notes saved yet."); return; }
  const lines = notes.map((n) => `• <b>${escapeHtml(n.name)}</b> → <code>#${n.name}</code>`);
  await ctx.reply(`📓 <b>Notes (${notes.length})</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

// ── Welcome message ───────────────────────────────────────────────────────────

bot.command("setwelcome", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const text = ctx.message?.text || "";
  const rest = text.replace(/^\/setwelcome(@\w+)?\s*/i, "").trim();
  if (!rest) {
    await ctx.reply(
      `Usage: /setwelcome [message]\n\nPlaceholders:\n{name} — user's name\n{username} — @username\n{id} — user ID\n{group} — group name\n\nHTML formatting supported.\nExample:\n<code>/setwelcome Welcome, {name}! Read the rules and enjoy 🎉</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }
  await updateGroupSettings(ctx.chat!.id, { welcomeEnabled: true, welcomeMessage: rest });
  await logSettings(ctx.api, `👋 <b>Welcome message set</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  await ctx.reply(`✅ Welcome message set and enabled!\n\n<b>Preview:</b>\n${rest.replace(/\{name\}/gi, "John").replace(/\{username\}/gi, "@john").replace(/\{id\}/gi, "123456").replace(/\{group\}/gi, ctx.chat?.title || "Group")}`, { parse_mode: "HTML" });
});

bot.command("resetwelcome", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  await updateGroupSettings(ctx.chat!.id, { welcomeEnabled: false, welcomeMessage: null });
  await ctx.reply("✅ Welcome message disabled and reset.");
  await logSettings(ctx.api, `👋 <b>Welcome message disabled</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("welcome", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const s = await getGroupSettings(ctx.chat!.id);
  if (!s.welcomeEnabled) {
    await ctx.reply("❌ Welcome message is <b>disabled</b>.\n\nEnable it with:\n<code>/setwelcome [message]</code>", { parse_mode: "HTML" });
    return;
  }
  const template = s.welcomeMessage || `👋 Welcome, <b>{name}</b>, to <b>{group}</b>! Please read the group rules.`;
  await ctx.reply(`✅ Welcome is <b>enabled</b>.\n\n<b>Current template:</b>\n${template}\n\n<b>Preview (with placeholders):</b>\n${template.replace(/\{name\}/gi, "John").replace(/\{username\}/gi, "@john").replace(/\{id\}/gi, "123456").replace(/\{group\}/gi, ctx.chat?.title || "Group")}`, { parse_mode: "HTML" });
});

// ── Approvals ─────────────────────────────────────────────────────────────────

bot.command("approve", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /approve — reply to a user, or /approve [userid]"); return; }
  await approveUser(ctx.chat!.id, target.id, ctx.from!.id);
  await ctx.reply(`✅ <b>Approved</b> · ${userLink(target.id, target.name)}\n<i>Bypasses locks, blacklist &amp; antiflood.</i>`, { parse_mode: "HTML" });
  await logMod(ctx.api, `✅ <b>Approved:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unapprove", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /unapprove — reply to a user, or /unapprove [userid]"); return; }
  const ok = await unapproveUser(ctx.chat!.id, target.id);
  await ctx.reply(ok
    ? `🔓 <b>Approval revoked</b> · ${userLink(target.id, target.name)}\n<i>Normal rules apply again.</i>`
    : `❌ ${userLink(target.id, target.name)} was not approved.`, { parse_mode: "HTML" });
  if (ok) await logMod(ctx.api, `❌ <b>Unapproved:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("approval", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  const userId = target?.id ?? ctx.from?.id;
  const name = target?.name ?? ([ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || String(userId));
  if (!userId) return;
  const approved = await isApproved(chat.id, userId);
  await ctx.reply(
    approved
      ? `✅ ${userLink(userId, name)} is <b>approved</b> in this chat. Locks, blacklist, and antiflood don't apply to them.`
      : `❌ ${userLink(userId, name)} is <b>not approved</b> in this chat.`,
    { parse_mode: "HTML" },
  );
});

bot.command("approved", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const list = await listApproved(ctx.chat!.id);
  if (list.length === 0) { await ctx.reply("No approved users in this chat."); return; }
  const lines = await Promise.all(list.map(async (a) => {
    const name = await getMemberName(ctx.api, ctx.chat!.id, a.userId);
    return `• ${userLink(a.userId, name)} (<code>${a.userId}</code>)`;
  }));
  await ctx.reply(`✅ <b>Approved Users (${list.length})</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

bot.command("unapproveall", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const count = await unapproveAll(ctx.chat!.id);
  await ctx.reply(`✅ Removed approval from <b>${count}</b> user(s). All users are now subject to normal rules.`, { parse_mode: "HTML" });
  await logMod(ctx.api, `🗑️ <b>Unapprove all:</b> ${count} users cleared in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── Captcha / Antibot / Antichannel ───────────────────────────────────────────

bot.command("captcha", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const s = await getGroupSettings(ctx.chat!.id);

  if (args.length === 0) {
    await ctx.reply(
      `⚙️ <b>Captcha</b>\nStatus: ${s.captchaEnabled ? "✅ Enabled" : "❌ Disabled"} | Type: <b>${s.captchaType}</b> | Timeout: ${s.captchaTimeoutSec}s\n\nUsage:\n/captcha y math — enable with math challenge\n/captcha y button — enable with button challenge\n/captcha n — disable`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const toggle = args[0]!.toLowerCase();
  if (toggle !== "y" && toggle !== "n") {
    await ctx.reply("Usage: /captcha [y|n] [math|button]\nExample: /captcha y math"); return;
  }

  const enabled = toggle === "y";
  const type = args[1]?.toLowerCase();
  const patch: any = { captchaEnabled: enabled };
  if (type === "math" || type === "button") patch.captchaType = type;

  await updateGroupSettings(ctx.chat!.id, patch);
  const finalType = type === "math" || type === "button" ? type : s.captchaType;
  await ctx.reply(`✅ Captcha ${enabled ? `enabled (type: <b>${finalType}</b>)` : "disabled"}.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🤖 <b>Captcha:</b> ${enabled ? `enabled (${finalType})` : "disabled"} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("antibot", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  if (arg !== "y" && arg !== "n") {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(`⚙️ <b>Antibot</b>: ${s.antibot ? "✅ Enabled" : "❌ Disabled"}\n\nUsage: /antibot y|n`, { parse_mode: "HTML" });
    return;
  }
  await updateGroupSettings(ctx.chat!.id, { antibot: arg === "y" });
  await ctx.reply(`✅ Antibot ${arg === "y" ? "enabled — bots that join will be kicked automatically" : "disabled"}.`);
  await logSettings(ctx.api, `🤖 <b>Antibot:</b> ${arg === "y" ? "enabled" : "disabled"} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("antichannel", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const arg = args[0]?.toLowerCase();
  if (arg !== "y" && arg !== "n") {
    const s = await getGroupSettings(ctx.chat!.id);
    await ctx.reply(`⚙️ <b>Antichannel</b>: ${s.antichannel ? "✅ Enabled" : "❌ Disabled"}\n\nUsage: /antichannel y|n`, { parse_mode: "HTML" });
    return;
  }
  await updateGroupSettings(ctx.chat!.id, { antichannel: arg === "y" });
  await ctx.reply(`✅ Antichannel ${arg === "y" ? "enabled — channel-posted messages will be removed" : "disabled"}.`);
  await logSettings(ctx.api, `📛 <b>Antichannel:</b> ${arg === "y" ? "enabled" : "disabled"} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

// ── /help ─────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  if (ctx.chat?.type === "private") {
    const fromId = ctx.from?.id;
    if (fromId && await isSuperAdmin(fromId)) {
      await ctx.reply(
        `👑 <b>Super Admin Commands</b>\n\n` +
        `<b>🔑 Keys:</b> /genkey · /keys · /rmkey\n` +
        `<b>📋 Groups:</b> /groups · /bangroup · /unbangroup · /leave · /invite · /destroy · /backup · /restore · /sync · /resync\n` +
        `<b>🌍 Global mod:</b> /gban · /ungban · /gmute · /ungmute · /gbans · /resetrestriction\n` +
        `<b>📢 Broadcast:</b> /broadcast\n` +
        `<b>👑 Supers:</b> /addsuper · /rmsuper · /supers · /setadmin\n` +
        `<b>📡 Logging:</b> /setlog · /clearlog · /logstatus\n` +
        `<b>🔍 Info:</b> /get · /edit\n` +
        `<b>🔐 Panel:</b> /adminpanel · /resetpass · /resetpassdefault`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        `🤖 <b>@${botUsername}</b>\n\n` +
        `/info · /warns · /id · /me · /approval\n` +
        `<i>Send #notename to view a saved note</i>`,
        { parse_mode: "HTML" },
      );
    }
  } else {
    const isAdmin = await senderIsGroupAdmin(ctx);
    if (isAdmin) {
      await ctx.reply(
        `🤖 <b>@${botUsername} — Admin Commands</b>\n\n` +
        `<b>👮 Mod:</b> /ban · /unban · /kick · /mute · /unmute · /promote · /demote · /warn · /unwarn · /resetwarns · /del · /pin\n` +
        `<b>🏷️ Tags:</b> /tag · /untag · /tags\n` +
        `<b>🌊 Flood:</b> /flood · /floodaction\n` +
        `<b>🔒 Locks:</b> /lock · /unlock · /locktypes · /lockaction\n` +
        `<b>🚫 Blacklist:</b> /bl · /rmbl · /blacklisted · /rmblacklist · /blsetting · /gbl\n` +
        `<b>💬 Filters:</b> /filter · /rmfilter · /filters\n` +
        `<b>📓 Notes:</b> /save · /rmnote · /notes\n` +
        `<b>👋 Welcome:</b> /setwelcome · /resetwelcome · /welcome\n` +
        `<b>🚪 Joinmust:</b> /joinmust · /rmjoinmust\n` +
        `<b>✅ Approvals:</b> /approve · /unapprove · /approved · /unapproveall\n` +
        `<b>⚙️ Settings:</b> /warnsetting · /captcha · /antibot · /antichannel\n` +
        `<b>🔑 Auth:</b> /redeem\n` +
        `<b>ℹ️ Info:</b> /info · /id · /me · /warns · /bans · /approval · /backup · /restore`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        `🤖 <b>@${botUsername}</b>\n\n/info · /warns · /id · /me · /approval\n<i>Send #notename to view a saved note</i>`,
        { parse_mode: "HTML" },
      );
    }
  }
});

// ── Super Admin Commands (Private) ────────────────────────────────────────────

bot.command("addsuper", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /addsuper [userId]"); return; }
  await addSuperAdmin(id);
  await ctx.reply(`✅ <code>${id}</code> is now a Super Admin.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `👑 <b>New Super Admin:</b> <code>${id}</code> added by ${fmtAdmin(ctx)}`);
});

bot.command("rmsuper", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /rmsuper [userId]"); return; }
  if (isHardcodedSuper(id)) { await ctx.reply("❌ Cannot remove a hardcoded Super Admin."); return; }
  await removeSuperAdmin(id);
  await ctx.reply(`✅ <code>${id}</code> removed from Super Admins.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `👑 <b>Super Admin removed:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

bot.command("groups", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const groups = await listGroups();
  if (groups.length === 0) { await ctx.reply("No groups recorded yet."); return; }
  const lines = groups.map((g) => `• <code>${g.groupId}</code> — ${escapeHtml(g.title || "(no title)")} — ${g.banned ? "🚫 banned" : "✅ active"}`);
  await ctx.reply(`📋 <b>Groups (${groups.length})</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
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

bot.command("destroy", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /destroy [groupId]"); return; }
  try { await ctx.api.setChatTitle(gid, "DISCONTINUED!"); } catch (err: any) {
    await ctx.reply(`⚠️ Could not rename: ${err?.description || err?.message}`);
  }
  let admins: any[] = [];
  try { admins = await ctx.api.getChatAdministrators(gid); } catch {}
  const me = await ctx.api.getMe();
  const supers = await getSuperAdmins();
  let banned = 0;
  for (const a of admins) {
    if (a.user.id === me.id || supers.has(a.user.id)) continue;
    try { await ctx.api.banChatMember(gid, a.user.id); banned++; } catch {}
  }
  await setGroupBanned(gid, true);
  await deauthorizeGroup(gid);
  await ctx.reply(`💥 Group <code>${gid}</code> destroyed. Renamed, banned ${banned} admins, marked banned.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `💥 <b>Destroy:</b> group <code>${gid}</code> by ${fmtAdmin(ctx)} — banned ${banned} admins`);
});

bot.command("bangroup", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /bangroup [groupId]"); return; }
  await upsertGroup(gid, "");
  await setGroupBanned(gid, true);
  await deauthorizeGroup(gid);
  try { await ctx.api.sendMessage(gid, "🚫 This group has been banned."); } catch {}
  try { await ctx.api.leaveChat(gid); } catch {}
  await ctx.reply(`✅ Group <code>${gid}</code> banned and left.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `🚫 <b>Group banned:</b> <code>${gid}</code> by ${fmtAdmin(ctx)}`);
});

bot.command("unbangroup", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /unbangroup [groupId]"); return; }
  await setGroupBanned(gid, false);
  await ctx.reply(`✅ Group <code>${gid}</code> unbanned. Add bot back + /redeem to reauthorize.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `✅ <b>Group unbanned:</b> <code>${gid}</code> by ${fmtAdmin(ctx)}`);
});

// ── /resync ───────────────────────────────────────────────────────────────────

bot.command("resync", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  await ctx.reply("🔄 Resyncing all known groups…");

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
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  await ctx.reply(
    `✅ <b>Resync complete</b>\n\n📋 Total groups: ${groups.length}\n✅ Bot active: ${active}\n❌ Bot removed/missing: ${failed}\n\n<i>Groups where the bot is missing will need it re-added as admin + /redeem to reauthorize.</i>`,
    { parse_mode: "HTML" },
  );
});

// ── /leave (super admin) ──────────────────────────────────────────────────────

bot.command("leave", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /leave [groupId]"); return; }
  await deauthorizeGroup(gid);
  try { await ctx.api.sendMessage(gid, "👋 Bot is leaving this group and authorization has been revoked."); } catch {}
  try { await ctx.api.leaveChat(gid); } catch (err: any) {
    await ctx.reply(`⚠️ Could not leave: ${err?.description || err?.message}`); return;
  }
  await ctx.reply(`✅ Left group <code>${gid}</code> and revoked authorization.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `🚪 <b>Bot left group:</b> <code>${gid}</code> by super admin <code>${ctx.from!.id}</code> — authorization revoked`);
});

bot.command("invite", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /invite [groupId]"); return; }
  try {
    const link = await ctx.api.exportChatInviteLink(gid);
    await ctx.reply(`🔗 Invite link for <code>${gid}</code>:\n${link}`, { parse_mode: "HTML" });
  } catch (err: any) { await ctx.reply(`❌ Failed: ${err?.description || err?.message}`); }
});

bot.command("setadmin", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /setadmin [groupId] [userId?]"); return; }
  const targetId = args[1] ? parseUserId(args[1]) : ctx.from!.id;
  if (!targetId) { await ctx.reply("❌ Invalid user ID."); return; }
  try {
    await ctx.api.promoteChatMember(gid, targetId, {
      can_manage_chat: true, can_change_info: true, can_delete_messages: true,
      can_invite_users: true, can_restrict_members: true, can_pin_messages: true,
      can_promote_members: true, can_manage_video_chats: true,
      can_post_stories: true, can_edit_stories: true, can_delete_stories: true,
      is_anonymous: false,
    });
    await ctx.reply(`✅ Promoted <code>${targetId}</code> to admin in <code>${gid}</code>.`, { parse_mode: "HTML" });
  } catch (err: any) { await ctx.reply(`❌ Failed: ${err?.description || err?.message}`); }
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

bot.command("keys", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const keys = await listAuthKeys();
  if (keys.length === 0) { await ctx.reply("No tokens yet."); return; }
  const now = Date.now();
  const lines = keys.map((k) => {
    const expired = k.expiresAt && k.expiresAt.getTime() < now;
    const exhausted = k.usedCount >= k.maxUses;
    const status = expired ? "❌ expired" : exhausted ? "✅ used" : "🟢 active";
    const exp = k.expiresAt ? k.expiresAt.toISOString().slice(0, 16) + " UTC" : "never";
    return `<code>${k.key}</code> — ${k.usedCount}/${k.maxUses} — ${status}\n  Exp: ${exp}`;
  });
  await ctx.reply(`🔑 <b>Tokens (${keys.length})</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
});

bot.command("rmkey", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmkey [key]"); return; }
  const ok = await removeAuthKey(args[0]);
  await ctx.reply(ok ? `✅ Token <code>${args[0].toUpperCase()}</code> revoked.` : "❌ Token not found.", { parse_mode: "HTML" });
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

bot.command("logstatus", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const ch = await getLogChannel();
  await ctx.reply(ch ? `📡 Log target: <code>${ch}</code>` : "📡 No log target set.", { parse_mode: "HTML" });
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

// ── /bans ─────────────────────────────────────────────────────────────────────

bot.command("bans", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("Use /bans in a group.");
    return;
  }
  if (!(await senderIsGroupAdmin(ctx))) {
    await ctx.reply("❌ Only group admins can use this command.");
    return;
  }
  const [banned, muted] = await Promise.all([
    listGroupRestrictions(chat.id, "ban"),
    listGroupRestrictions(chat.id, "mute"),
  ]);
  const lines: string[] = [];
  if (banned.length > 0) {
    lines.push(`⛔ <b>Banned (${banned.length})</b>`);
    for (const r of banned.slice(0, 20)) {
      const exp = r.until ? ` until ${r.until.toISOString().slice(0, 16)} UTC` : " (permanent)";
      lines.push(`• <code>${r.userId}</code>${exp}`);
    }
  }
  if (muted.length > 0) {
    if (lines.length) lines.push("");
    lines.push(`🔇 <b>Muted (${muted.length})</b>`);
    for (const r of muted.slice(0, 20)) {
      const exp = r.until ? ` until ${r.until.toISOString().slice(0, 16)} UTC` : " (permanent)";
      lines.push(`• <code>${r.userId}</code>${exp}`);
    }
  }
  if (lines.length === 0) {
    await ctx.reply("✅ No active bans or mutes tracked in this group.");
    return;
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// ── /gbans ────────────────────────────────────────────────────────────────────

bot.command("gbans", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const [bans, mutes] = await Promise.all([listGlobalBans(), listGlobalMutes()]);
  const lines: string[] = [];
  if (bans.length > 0) {
    lines.push(`🌍 <b>Global Bans (${bans.length})</b>`);
    for (const b of bans.slice(0, 20)) {
      const exp = b.until ? ` until ${b.until.toISOString().slice(0, 16)} UTC` : " (permanent)";
      lines.push(`• <code>${b.userId}</code>${exp}${b.reason ? ` — ${escapeHtml(b.reason)}` : ""}`);
    }
  }
  if (mutes.length > 0) {
    if (lines.length) lines.push("");
    lines.push(`🔇 <b>Global Mutes (${mutes.length})</b>`);
    for (const m of mutes.slice(0, 20)) {
      const exp = m.until ? ` until ${m.until.toISOString().slice(0, 16)} UTC` : " (permanent)";
      lines.push(`• <code>${m.userId}</code>${exp}${m.reason ? ` — ${escapeHtml(m.reason)}` : ""}`);
    }
  }
  if (lines.length === 0) {
    await ctx.reply("✅ No active global bans or mutes.");
    return;
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// ── /supers ───────────────────────────────────────────────────────────────────

bot.command("supers", async (ctx) => {
  if (!(await requireSuperAdmin(ctx))) return;
  const supers = await getSuperAdmins();
  const lines = [...supers].map((id) => `• <code>${id}</code>${isHardcodedSuper(id) ? " 🔒 hardcoded" : ""}`);
  await ctx.reply(`👑 <b>Super Admins (${supers.size})</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
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

// ── /tag · /untag · /tags ─────────────────────────────────────────────────────

bot.command("tag", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const target = await resolveTarget(ctx, args);
  if (!target) { await ctx.reply("Usage: /tag [userId] [tagname] — or reply to a user with /tag [tagname]"); return; }
  const tagArg = args.find((a) => parseUserId(a) === null && a !== String(target.id));
  if (!tagArg) { await ctx.reply("Usage: /tag [userId] [tagname]\nReply to a user: /tag [tagname]\nUse /untag to remove."); return; }
  // SET behaviour: clear existing tag and assign the new one
  await clearUserTags(target.id);
  await addTag(target.id, tagArg, ctx.from!.id);
  await ctx.reply(`🏷️ Tag set: <b>${escapeHtml(tagArg)}</b> → ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
  await logMod(ctx.api, `🏷️ <b>Tag set:</b> "${escapeHtml(tagArg)}" → ${userLink(target.id, target.name)} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("untag", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const target = await resolveTarget(ctx, args);
  if (!target) { await ctx.reply("Usage: /untag — reply to a user, or /untag [userId]"); return; }
  await clearUserTags(target.id);
  await ctx.reply(`🗑️ <b>Tags cleared</b> · ${userLink(target.id, target.name)}`, { parse_mode: "HTML" });
  await logMod(ctx.api, `🗑️ <b>Tags cleared:</b> ${userLink(target.id, target.name)} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("tags", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const target = await resolveTarget(ctx, args);
  if (!target) { await ctx.reply("Usage: /tags — reply to a user, or /tags [userId]"); return; }
  const tags = await getUserTags(target.id);
  if (tags.length === 0) {
    await ctx.reply(`🏷️ No tags set for ${userLink(target.id, target.name)}.`, { parse_mode: "HTML" });
    return;
  }
  await ctx.reply(`🏷️ <b>Tags for ${userLink(target.id, target.name)}</b>\n${tags.map(t => `• ${escapeHtml(t)}`).join("\n")}`, { parse_mode: "HTML" });
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

// ── /joinmust ─────────────────────────────────────────────────────────────────

bot.command("joinmust", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const chat = ctx.chat!;
  const args = splitArgs(ctx.message?.text);

  if (args.length === 0) {
    const list = await getJoinMustList(chat.id);
    if (list.length === 0) {
      await ctx.reply("📋 No joinmust channels/groups set.\n\nUsage:\n/joinmust [channel_username_or_id] — add requirement\n/rmjoinmust [channel_username_or_id] — remove");
      return;
    }
    const lines = list.map((j) => `• ${j.targetUsername ? `@${j.targetUsername}` : ""} <code>${j.targetId}</code>`);
    await ctx.reply(`📋 <b>Joinmust Requirements (${list.length})</b>\nNew members must join all of these:\n${lines.join("\n")}`, { parse_mode: "HTML" });
    return;
  }

  const raw = args[0]!;
  let targetId: number | null = null;
  let targetUsername: string | null = null;

  if (raw.startsWith("@") || !/^\-?\d+$/.test(raw)) {
    const uname = raw.replace(/^@/, "");
    targetUsername = uname;
    try {
      const chatInfo = await ctx.api.getChat(`@${uname}` as any);
      targetId = chatInfo.id;
    } catch {
      await ctx.reply(`❌ Could not find @${uname}. Make sure the bot is a member of that channel.`);
      return;
    }
  } else {
    targetId = parseUserId(raw);
    if (!targetId) { await ctx.reply("❌ Invalid ID."); return; }
  }

  // Warn if bot is not an admin in the target channel (needed to verify member status)
  const me = await ctx.api.getMe().catch(() => null);
  if (me) {
    try {
      const m = await ctx.api.getChatMember(targetId, me.id);
      if (m.status !== "administrator" && m.status !== "creator") {
        await ctx.reply(
          `⚠️ <b>Warning:</b> The bot is not an admin in that channel/group.\n\nWithout admin rights there, it <b>cannot verify</b> whether new members have subscribed.\nPlease add @${botUsername} as an admin in the target channel first.\n\n<i>The requirement has been saved anyway — fix the channel permissions before relying on this.</i>`,
          { parse_mode: "HTML" },
        );
      }
    } catch {
      await ctx.reply(
        `⚠️ <b>Warning:</b> Could not verify bot's admin status in that channel/group.\n\nMake sure @${botUsername} is added as an admin there for membership verification to work.\n\n<i>The requirement has been saved anyway.</i>`,
        { parse_mode: "HTML" },
      );
    }
  }

  await addJoinMust(chat.id, targetId, targetUsername);
  await ctx.reply(
    `✅ <b>Joinmust added:</b> ${targetUsername ? `@${targetUsername}` : ""} <code>${targetId}</code>\n\nNew members will be muted until they join that chat.`,
    { parse_mode: "HTML" },
  );
  await logSettings(ctx.api, `🔗 <b>Joinmust added:</b> <code>${targetId}</code> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("rmjoinmust", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmjoinmust [channel_username_or_id]"); return; }

  const raw = args[0]!;
  let targetId: number | null = null;

  if (raw.startsWith("@") || !/^\-?\d+$/.test(raw)) {
    const uname = raw.replace(/^@/, "");
    try {
      const chatInfo = await ctx.api.getChat(`@${uname}` as any);
      targetId = chatInfo.id;
    } catch {
      await ctx.reply(`❌ Could not resolve @${uname}.`);
      return;
    }
  } else {
    targetId = parseUserId(raw);
  }

  if (!targetId) { await ctx.reply("❌ Invalid ID."); return; }
  const ok = await removeJoinMust(ctx.chat!.id, targetId);
  await ctx.reply(ok ? `✅ Joinmust removed for <code>${targetId}</code>.` : `❌ Not found in joinmust list.`, { parse_mode: "HTML" });
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

// ── /lockaction ───────────────────────────────────────────────────────────────

bot.command("lockaction", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const s = await getGroupSettings(ctx.chat!.id);

  if (args.length === 0) {
    await ctx.reply(
      `⚙️ <b>Lock Action</b>\nCurrent: action=<b>${s.lockAction}</b>, limit=<b>${s.lockActionLimit}</b>, duration=<b>${formatDuration(s.lockActionDurationSec)}</b>\n\nUsage: /lockaction [limit] [ban|mute|warn|kick|none] [duration]\nExample: /lockaction 3 mute 10m`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const limit = parseInt(args[0]!, 10);
  const action = args[1]?.toLowerCase() ?? "none";
  const dur = args[2] ? parseDuration(args[2]) : 0;

  if (isNaN(limit) || limit < 1) { await ctx.reply("❌ Invalid limit."); return; }
  if (!["ban", "mute", "warn", "kick", "none"].includes(action)) { await ctx.reply("❌ Action must be: ban, mute, warn, kick, or none"); return; }

  await updateGroupSettings(ctx.chat!.id, {
    lockActionLimit: limit,
    lockAction: action,
    lockActionDurationSec: dur ?? 0,
  });
  await ctx.reply(`✅ Lock action: after <b>${limit}</b> violation(s) → <b>${action}</b>${action !== "none" ? ` (${formatDuration(dur ?? 0)})` : ""}.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🔒 <b>Lock action set:</b> limit=${limit}, action=${action} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
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
