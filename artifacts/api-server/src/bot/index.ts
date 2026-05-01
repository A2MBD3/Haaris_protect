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
  applyAutoActionIfNeeded, setGlobalBan, isGloballyBanned,
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
import { db, warningsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

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

function requireSuperPrivate(ctx: any): boolean {
  return ctx.chat?.type === "private";
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
    if (reply) await ctx.reply(reply).catch(() => {});

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

  const result = await consumeAuthKey(args[0]!);
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
  let durationSec = 0, targetArgs = args;
  if (args.length >= 1) { const d = parseDuration(args[0]); if (d !== null) { durationSec = d; targetArgs = args.slice(1); } }
  const target = await resolveTarget(ctx, targetArgs);
  if (!target) { await ctx.reply("Usage: /ban [duration] — reply to user, or /ban [duration] [userid]"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot ban a Super Admin."); return; }
  try {
    await banUser(ctx, ctx.chat!.id, target.id, durationSec);
    await ctx.reply(`🚫 ${userLink(target.id, target.name)} has been <b>banned</b> for <b>${formatDuration(durationSec)}</b>.`, { parse_mode: "HTML" });
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
    await ctx.reply(`✅ ${userLink(target.id, target.name)} has been <b>unbanned</b>.`, { parse_mode: "HTML" });
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
    await ctx.reply(`👢 ${userLink(target.id, target.name)} has been <b>kicked</b>.`, { parse_mode: "HTML" });
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
    await ctx.reply(`✅ ${userLink(target.id, target.name)} has been <b>promoted to admin</b>.`, { parse_mode: "HTML" });
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
    await ctx.reply(`✅ ${userLink(target.id, target.name)} has been <b>demoted</b>.`, { parse_mode: "HTML" });
    await logMod(ctx.api, `⬇️ <b>Demoted:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  } catch (err: any) { await ctx.reply(`❌ Could not demote: ${err?.description || err?.message}`); }
});

// ── /mute ─────────────────────────────────────────────────────────────────────

bot.command("mute", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  if (!(await requireBotCan(ctx, "can_restrict_members"))) return;
  const args = splitArgs(ctx.message?.text);
  let durationSec = 0, targetArgs = args;
  if (args.length >= 1) { const d = parseDuration(args[0]); if (d !== null) { durationSec = d; targetArgs = args.slice(1); } }
  const target = await resolveTarget(ctx, targetArgs);
  if (!target) { await ctx.reply("Usage: /mute [duration] — reply to user, or /mute [duration] [userid]"); return; }
  if (await isSuperAdmin(target.id)) { await ctx.reply("❌ Cannot mute a Super Admin."); return; }
  try {
    await muteUser(ctx, ctx.chat!.id, target.id, durationSec);
    await ctx.reply(`🔇 ${userLink(target.id, target.name)} has been <b>muted</b> for <b>${formatDuration(durationSec)}</b>.`, { parse_mode: "HTML" });
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
    await ctx.reply(`🔈 ${userLink(target.id, target.name)} can now speak again.`, { parse_mode: "HTML" });
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
    const extra = action ? ` Auto-action: <b>${action}</b>.` : "";
    await ctx.reply(`⚠️ ${link} has reached the warn limit! (<b>${count}/${settings.warnLimit}</b>)${extra}`, { parse_mode: "HTML" });
    await logMod(ctx.api, `⚠️ <b>Warn limit:</b> ${link} (${count}/${settings.warnLimit}) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}${action ? ` → ${action}` : ""}`);
  } else {
    await ctx.reply(`⚠️ ${link}, you have been warned — <b>${count}/${settings.warnLimit}</b>.`, { parse_mode: "HTML" });
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
  await ctx.reply(`✅ One warning removed from ${userLink(target.id, target.name)}. Now at <b>${count}/${settings.warnLimit}</b>.`, { parse_mode: "HTML" });
});

// ── /resetwarns ───────────────────────────────────────────────────────────────

bot.command("resetwarns", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /resetwarns — reply to user, or /resetwarns [userid]"); return; }
  await resetWarnings(ctx.chat!.id, target.id);
  await ctx.reply(`✅ All warnings cleared for ${userLink(target.id, target.name)}.`, { parse_mode: "HTML" });
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
  if (args.length < 3) {
    await ctx.reply(`⚙️ <b>Warn Settings</b>\nLimit: ${s.warnLimit} | Duration: ${formatDuration(s.warnDurationSec)} | Action: ${s.warnAction}\n\nUsage: /warnsetting [limit] [duration] [mute|ban]\nExample: /warnsetting 3 24h mute`, { parse_mode: "HTML" });
    return;
  }
  const limit = parseInt(args[0]!, 10);
  const dur = parseDuration(args[1]);
  const action = args[2]!.toLowerCase();
  if (Number.isNaN(limit) || limit < 1 || dur === null || (action !== "mute" && action !== "ban")) {
    await ctx.reply("❌ Invalid. Example: /warnsetting 3 24h mute"); return;
  }
  await updateGroupSettings(ctx.chat!.id, { warnLimit: limit, warnDurationSec: dur, warnAction: action });
  await ctx.reply(`✅ Warn settings: limit=${limit}, duration=${formatDuration(dur)}, action=${action}`);
  await logSettings(ctx.api, `⚠️ <b>Warn settings updated</b> in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}: limit=${limit}, duration=${formatDuration(dur)}, action=${action}`);
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
  await ctx.reply(`🔒 <b>${type}</b> locked.`, { parse_mode: "HTML" });
  await logSettings(ctx.api, `🔒 <b>Lock added:</b> ${type} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unlock", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  const type = args[0]?.toLowerCase() as LockType | undefined;
  if (!type || !LOCK_TYPES.includes(type)) { await ctx.reply(`Usage: /unlock [type]\nTypes: ${LOCK_TYPES.join(", ")}`); return; }
  const ok = await removeLock(ctx.chat!.id, type);
  if (ok) await logSettings(ctx.api, `🔓 <b>Lock removed:</b> ${type} in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
  await ctx.reply(ok ? `🔓 <b>${type}</b> unlocked.` : `<b>${type}</b> was not locked.`, { parse_mode: "HTML" });
});

bot.command("locktypes", async (ctx) => {
  const active = await getLocks(ctx.chat?.id ?? 0);
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
  await ctx.reply(`✅ Filter added for "<b>${escapeHtml(m[1]!)}</b>".`, { parse_mode: "HTML" });
});

bot.command("filters", async (ctx) => {
  if (!ctx.chat) return;
  const filters = await listFilters(ctx.chat.id);
  if (filters.length === 0) { await ctx.reply("No filters set."); return; }
  const lines = filters.map((f) => `• <b>${escapeHtml(f.word)}</b> → ${escapeHtml(f.reply)}`);
  await ctx.reply(`📋 <b>Active Filters</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

bot.command("rmfilter", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmfilter [keyword]"); return; }
  const ok = await removeFilter(ctx.chat!.id, args[0]);
  await ctx.reply(ok ? `✅ Filter "<b>${escapeHtml(args[0])}</b>" removed.` : "❌ Filter not found.", { parse_mode: "HTML" });
});

// ── Blacklist ─────────────────────────────────────────────────────────────────

bot.command("bl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /bl [word]"); return; }
  await addBlacklistWord(ctx.chat!.id, args[0]);
  await ctx.reply(`🚫 "<b>${escapeHtml(args[0])}</b>" added to blacklist.`, { parse_mode: "HTML" });
});

bot.command("rmbl", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmbl [word]"); return; }
  const ok = await removeBlacklistWord(ctx.chat!.id, args[0]);
  await ctx.reply(ok ? `✅ "<b>${escapeHtml(args[0])}</b>" removed from blacklist.` : "❌ Word not in blacklist.", { parse_mode: "HTML" });
});

bot.command("blacklisted", async (ctx) => {
  if (!ctx.chat) return;
  const words = await listBlacklist(ctx.chat.id);
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
  if (Number.isNaN(threshold) || threshold < 1 || dur === null || (action !== "mute" && action !== "ban")) {
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
  await ctx.reply(`✅ Note "<b>${escapeHtml(m[1]!)}</b>" saved. Retrieve with: <code>#${m[1]!.toLowerCase()}</code>`, { parse_mode: "HTML" });
});

bot.command("rmnote", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmnote [notename]"); return; }
  const ok = await removeNote(ctx.chat!.id, args[0]);
  await ctx.reply(ok ? `✅ Note "<b>${escapeHtml(args[0])}</b>" removed.` : "❌ Note not found.", { parse_mode: "HTML" });
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
  await ctx.reply(`✅ ${userLink(target.id, target.name)} is now <b>approved</b>. Locks, blacklist, and antiflood won't apply to them.`, { parse_mode: "HTML" });
  await logMod(ctx.api, `✅ <b>Approved:</b> ${userLink(target.id, target.name)} (<code>${target.id}</code>) in ${fmtGroupCtx(ctx)} by ${fmtAdmin(ctx)}`);
});

bot.command("unapprove", async (ctx) => {
  if (!(await requireGroupAdmin(ctx))) return;
  const target = await resolveTarget(ctx, splitArgs(ctx.message?.text));
  if (!target) { await ctx.reply("Usage: /unapprove — reply to a user, or /unapprove [userid]"); return; }
  const ok = await unapproveUser(ctx.chat!.id, target.id);
  await ctx.reply(ok
    ? `✅ ${userLink(target.id, target.name)} is now <b>unapproved</b>. Normal rules apply again.`
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
    await ctx.reply(
      `👑 <b>Super Admin Commands</b>\n<i>(Used in private chat with the bot)</i>\n\n` +
      `<b>🔑 Tokens</b>\n/genkey [time] [uses] — Create auth token\n/keys — List all tokens\n/rmkey [key] — Revoke a token\n\n` +
      `<b>📋 Groups</b>\n/groups — List all groups\n/bangroup [id] — Ban a group\n/unbangroup [id] — Unban a group\n/destroy [id] — Rename + ban all admins\n/invite [id] — Get invite link\n/leave [id] — Bot leaves + revokes auth\n\n` +
      `<b>🌍 Global Mod</b>\n/gban [time] [userId] — Ban from all groups\n/resetrestriction [id] — Clear super admin restrictions in group\n\n` +
      `<b>👑 Supers</b>\n/addsuper [id] — Add super admin\n/rmsuper [id] — Remove super admin\n/setadmin [groupId] [userId?] — Promote to admin\n\n` +
      `<b>✏️ Edit</b>\n/edit — Reply to a bot message to queue edit\n\n` +
      `<b>📡 Logs</b>\n/setlog [id] — Set log channel or group (forum → auto-creates topics)\n/setlog [id] recreate — Force-rebuild all 5 forum topics\n/clearlog — Disable log channel\n/logstatus — Show current log target\n\n` +
      `<b>🔄 Sync</b>\n/resync — Check all groups for bot admin status`,
      { parse_mode: "HTML" },
    );
  } else {
    const isAdmin = await senderIsGroupAdmin(ctx);
    await ctx.reply(
      `🤖 <b>@${botUsername} Commands</b>\n\n` +
      (isAdmin ? (
        `<b>👮 Moderation</b>\n` +
        `/ban [time] — Ban user\n/unban — Unban user\n/kick — Kick user\n/promote — Promote to admin\n/demote — Demote admin\n` +
        `/mute [time] — Mute user\n/unmute — Unmute user\n` +
        `/warn — Warn user\n/unwarn — Remove one warning\n/resetwarns — Clear all warnings\n/warns — Check warn count\n/warnsetting [limit] [time] [mute|ban]\n\n` +
        `<b>🌊 Flood</b>\n/flood [limit] — Enable flood control\n/flood off — Disable\n/floodaction [mute|ban|kick] [time] — Change flood action\n\n` +
        `<b>🔒 Locks</b>\n/lock [type] | /unlock [type] | /locktypes\n\n` +
        `<b>🚫 Blacklist</b>\n/bl [word] | /rmbl [word] | /blacklisted | /rmblacklist\n/blsetting [hits] [time] [mute|ban]\n\n` +
        `<b>💬 Filters</b>\n/filter [word] [reply] | /filters | /rmfilter [word]\n\n` +
        `<b>📓 Notes</b>\n/save [name] [text] | /notes | /rmnote [name]\n#notename — show note in chat\n\n` +
        `<b>👋 Welcome</b>\n/setwelcome [msg] — Set join welcome (placeholders: {name} {username} {id} {group})\n/resetwelcome — Disable welcome\n/welcome — Check current welcome\n\n` +
        `<b>✅ Approvals</b>\n/approve — Exempt user from locks/blacklist/flood\n/unapprove — Revoke approval\n/approved — List approved users\n/unapproveall — Clear all approvals\n\n` +
        `<b>🛡️ Protection</b>\n/captcha [y|n] [math|button]\n/antibot y|n | /antichannel y|n\n\n` +
        `<b>🔑 Auth</b>\n/redeem [token]\n\n` +
        `<b>ℹ️ Info</b>\n/info — User details\n/approval — Check approval status\n`
      ) : (
        `<b>ℹ️ Info</b>\n/info — User details (reply to message)\n/warns — Check your warnings\n/approval — Check your approval status\n` +
        `\n<i>Tip: #notename to view a saved note</i>`
      )),
      { parse_mode: "HTML" },
    );
  }
});

// ── Super Admin Commands (Private) ────────────────────────────────────────────

bot.command("addsuper", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /addsuper [userId]"); return; }
  await addSuperAdmin(id);
  await ctx.reply(`✅ <code>${id}</code> is now a Super Admin.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `👑 <b>New Super Admin:</b> <code>${id}</code> added by ${fmtAdmin(ctx)}`);
});

bot.command("rmsuper", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
  const args = splitArgs(ctx.message?.text);
  const id = parseUserId(args[0]);
  if (!id) { await ctx.reply("Usage: /rmsuper [userId]"); return; }
  if (isHardcodedSuper(id)) { await ctx.reply("❌ Cannot remove a hardcoded Super Admin."); return; }
  await removeSuperAdmin(id);
  await ctx.reply(`✅ <code>${id}</code> removed from Super Admins.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `👑 <b>Super Admin removed:</b> <code>${id}</code> by ${fmtAdmin(ctx)}`);
});

bot.command("groups", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
  const groups = await listGroups();
  if (groups.length === 0) { await ctx.reply("No groups recorded yet."); return; }
  const lines = groups.map((g) => `• <code>${g.groupId}</code> — ${escapeHtml(g.title || "(no title)")} — ${g.banned ? "🚫 banned" : "✅ active"}`);
  await ctx.reply(`📋 <b>Groups (${groups.length})</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

bot.command("gban", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /unbangroup [groupId]"); return; }
  await setGroupBanned(gid, false);
  await ctx.reply(`✅ Group <code>${gid}</code> unbanned. Add bot back + /redeem to reauthorize.`, { parse_mode: "HTML" });
  await logGeneral(ctx.api, `✅ <b>Group unbanned:</b> <code>${gid}</code> by ${fmtAdmin(ctx)}`);
});

// ── /resync ───────────────────────────────────────────────────────────────────

bot.command("resync", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
  const args = splitArgs(ctx.message?.text);
  const gid = parseUserId(args[0]);
  if (!gid) { await ctx.reply("Usage: /invite [groupId]"); return; }
  try {
    const link = await ctx.api.exportChatInviteLink(gid);
    await ctx.reply(`🔗 Invite link for <code>${gid}</code>:\n${link}`, { parse_mode: "HTML" });
  } catch (err: any) { await ctx.reply(`❌ Failed: ${err?.description || err?.message}`); }
});

bot.command("setadmin", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
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
  if (!requireSuperPrivate(ctx)) return;
  const args = splitArgs(ctx.message?.text);
  if (!args[0]) { await ctx.reply("Usage: /rmkey [key]"); return; }
  const ok = await removeAuthKey(args[0]);
  await ctx.reply(ok ? `✅ Token <code>${args[0].toUpperCase()}</code> revoked.` : "❌ Token not found.", { parse_mode: "HTML" });
});

// ── Log channel / group ───────────────────────────────────────────────────────

bot.command("setlog", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
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
    await ctx.api.sendMessage(targetId, "✅ Log target confirmed for @noobeibot.");
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
  if (!requireSuperPrivate(ctx)) return;
  await setLogChannel(null);
  await ctx.reply("✅ Log channel disabled.");
});

bot.command("logstatus", async (ctx) => {
  if (!requireSuperPrivate(ctx)) return;
  const ch = await getLogChannel();
  await ctx.reply(ch ? `📡 Log target: <code>${ch}</code>` : "📡 No log target set.", { parse_mode: "HTML" });
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
