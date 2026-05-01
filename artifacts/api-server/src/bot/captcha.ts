import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { db, captchaSessionsTable } from "@workspace/db";
import { and, eq, lte } from "drizzle-orm";
import { getGroupSettings } from "./settings";
import { logger } from "../lib/logger";
import { escapeHtml } from "./utils";
import { randomBytes } from "node:crypto";

// ── Deduplication guard ────────────────────────────────────────────────────────
// Prevent double-triggering from chat_member + new_chat_members both firing
const pendingJoins = new Set<string>(); // `${groupId}:${userId}`

function markJoin(groupId: number, userId: number): boolean {
  const k = `${groupId}:${userId}`;
  if (pendingJoins.has(k)) return false; // already processing
  pendingJoins.add(k);
  setTimeout(() => pendingJoins.delete(k), 10_000); // clear after 10s
  return true;
}

// ── Challenge generators ───────────────────────────────────────────────────────

interface CaptchaChallenge {
  text: string;
  answer: string;
  keyboard?: InlineKeyboard;
}

function makeMathChallenge(): CaptchaChallenge {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  return {
    text: `🧮 Solve to verify you are human:\n\n<b>${a} + ${b} = ?</b>\n\nReply with the number in this chat.`,
    answer: String(a + b),
  };
}

function makeButtonChallenge(): CaptchaChallenge {
  const correct = Math.floor(Math.random() * 49) + 1; // 1-49
  const options = new Set<number>([correct]);
  while (options.size < 4) options.add(Math.floor(Math.random() * 49) + 1);
  const arr = Array.from(options).sort(() => Math.random() - 0.5);
  const kb = new InlineKeyboard();
  // 2×2 grid
  for (let i = 0; i < arr.length; i++) {
    kb.text(String(arr[i]), `cap_btn:${arr[i]}`);
    if (i % 2 === 1) kb.row();
  }
  return {
    text: `🔘 Tap the button that shows the number <b>${correct}</b> to verify.`,
    answer: String(correct),
    keyboard: kb,
  };
}

function buildChallenge(type: string): CaptchaChallenge {
  return type === "math" ? makeMathChallenge() : makeButtonChallenge();
}

function newSessionId(): string {
  return randomBytes(6).toString("hex");
}

// ── Start captcha for a new join ───────────────────────────────────────────────

export async function startCaptchaForJoin(
  ctx: Context,
  groupId: number,
  groupTitle: string,
  userId: number,
  userName: string,
): Promise<void> {
  const settings = await getGroupSettings(groupId);
  if (!settings.captchaEnabled) return;

  // Dedup guard: ignore if this join is already being processed
  if (!markJoin(groupId, userId)) return;

  // Mute the new user immediately
  try {
    await ctx.api.restrictChatMember(groupId, userId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    });
  } catch (err) {
    logger.warn({ err, userId, groupId }, "Could not mute new member for captcha");
    return;
  }

  const challenge = buildChallenge(settings.captchaType);
  const sessionId = newSessionId();
  const expiresAt = new Date(Date.now() + settings.captchaTimeoutSec * 1000);

  const inserted = await db
    .insert(captchaSessionsTable)
    .values({
      groupId,
      userId,
      answer: challenge.answer,
      privateMessageId: null,
      groupMessageId: null,
      expiresAt,
    })
    .returning();
  const sessionDbId = inserted[0]!.id;

  const me = await ctx.api.getMe();
  const verifyUrl = `https://t.me/${me.username}?start=cap_${sessionId}_${sessionDbId}`;
  const groupKb = new InlineKeyboard().url("🔐 Tap to Verify", verifyUrl);

  let groupMsgId: number | null = null;
  try {
    const gMsg = await ctx.api.sendMessage(
      groupId,
      `👋 Welcome <a href="tg://user?id=${userId}">${escapeHtml(userName)}</a>!\n\n` +
        `Please verify you are human within <b>${settings.captchaTimeoutSec}s</b> or you'll be removed.\n` +
        `Tap the button below to start.`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: groupKb,
      },
    );
    groupMsgId = gMsg.message_id;
    await db
      .update(captchaSessionsTable)
      .set({ groupMessageId: groupMsgId })
      .where(eq(captchaSessionsTable.id, sessionDbId));
  } catch (err) {
    logger.warn({ err }, "Failed to send group captcha message");
  }

  // Best-effort PM delivery (works if user has started the bot before)
  try {
    const pmText =
      `🔐 <b>Verification required</b>\n` +
      `Group: <b>${escapeHtml(groupTitle)}</b>\n\n` +
      challenge.text;
    const pMsg = await ctx.api.sendMessage(userId, pmText, {
      parse_mode: "HTML",
      reply_markup: challenge.keyboard,
    });
    await db
      .update(captchaSessionsTable)
      .set({ privateMessageId: pMsg.message_id })
      .where(eq(captchaSessionsTable.id, sessionDbId));
  } catch {
    /* user hasn't started bot – they'll use the deep link */
  }
}

// ── Deep-link delivery (/start cap_xxx_dbId) ──────────────────────────────────

export async function deliverCaptchaToPrivate(
  ctx: Context,
  sessionDbId: number,
): Promise<boolean> {
  const userId = ctx.from!.id;
  const rows = await db
    .select()
    .from(captchaSessionsTable)
    .where(eq(captchaSessionsTable.id, sessionDbId))
    .limit(1);
  if (rows.length === 0) {
    await ctx.reply("❌ This verification link is invalid or has already been used.");
    return false;
  }
  const s = rows[0]!;
  if (Number(s.userId) !== userId) {
    await ctx.reply("❌ This verification link belongs to a different user.");
    return false;
  }
  if (s.solved) {
    await ctx.reply("✅ You are already verified!");
    return true;
  }
  if (s.expiresAt.getTime() < Date.now()) {
    await ctx.reply("⏰ This captcha has expired. You may have been removed from the group.");
    return false;
  }

  // Build a fresh challenge (to avoid stale answer from group-side attempt)
  const settings = await getGroupSettings(Number(s.groupId));
  const challenge = buildChallenge(settings.captchaType);

  // Update stored answer to this fresh challenge
  await db
    .update(captchaSessionsTable)
    .set({ answer: challenge.answer })
    .where(eq(captchaSessionsTable.id, sessionDbId));

  let groupTitle = String(s.groupId);
  try {
    const chat: any = await ctx.api.getChat(Number(s.groupId));
    groupTitle = chat.title || groupTitle;
  } catch {}

  try {
    const pMsg = await ctx.api.sendMessage(
      userId,
      `🔐 <b>Verification required</b>\nGroup: <b>${escapeHtml(groupTitle)}</b>\n\n${challenge.text}`,
      { parse_mode: "HTML", reply_markup: challenge.keyboard },
    );
    await db
      .update(captchaSessionsTable)
      .set({ privateMessageId: pMsg.message_id })
      .where(eq(captchaSessionsTable.id, sessionDbId));
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to deliver captcha PM");
    return false;
  }
}

// ── Verify an answer (text or button) ────────────────────────────────────────

export async function checkCaptchaAnswer(
  ctx: Context,
  userId: number,
  answer: string,
): Promise<{ ok: boolean; groupId?: number } | null> {
  const sessions = await db
    .select()
    .from(captchaSessionsTable)
    .where(
      and(
        eq(captchaSessionsTable.userId, userId),
        eq(captchaSessionsTable.solved, false),
      ),
    )
    .orderBy(captchaSessionsTable.id)
    .limit(1);

  if (sessions.length === 0) return null;
  const session = sessions[0]!;

  if (session.expiresAt.getTime() < Date.now()) {
    return { ok: false, groupId: Number(session.groupId) };
  }

  const ok = session.answer.trim() === answer.trim();

  if (ok) {
    await db
      .update(captchaSessionsTable)
      .set({ solved: true })
      .where(eq(captchaSessionsTable.id, session.id));

    // Unmute in group
    try {
      await ctx.api.restrictChatMember(Number(session.groupId), userId, {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
    } catch (err) {
      logger.warn({ err }, "Failed to unmute on captcha success");
    }

    // Clean up group message
    if (session.groupMessageId) {
      await ctx.api
        .deleteMessage(Number(session.groupId), session.groupMessageId)
        .catch(() => {});
    }

    // Clear dedup guard
    pendingJoins.delete(`${session.groupId}:${userId}`);
  }

  return { ok, groupId: Number(session.groupId) };
}

// ── Timeout watcher ───────────────────────────────────────────────────────────

export function startCaptchaWatcher(bot: Bot): void {
  const tick = async () => {
    try {
      const now = new Date();
      const expired = await db
        .select()
        .from(captchaSessionsTable)
        .where(
          and(
            eq(captchaSessionsTable.solved, false),
            lte(captchaSessionsTable.expiresAt, now),
          ),
        )
        .limit(50);

      for (const s of expired) {
        try {
          await bot.api.banChatMember(Number(s.groupId), Number(s.userId));
          await bot.api.unbanChatMember(Number(s.groupId), Number(s.userId));
        } catch (err) {
          logger.warn({ err }, "Failed to kick captcha timeout user");
        }
        if (s.groupMessageId) {
          await bot.api
            .deleteMessage(Number(s.groupId), s.groupMessageId)
            .catch(() => {});
        }
        if (s.privateMessageId) {
          await bot.api
            .editMessageText(
              Number(s.userId),
              s.privateMessageId,
              "⏰ Verification timed out. You have been removed from the group. You may rejoin and try again.",
            )
            .catch(() => {});
        }
        await db
          .delete(captchaSessionsTable)
          .where(eq(captchaSessionsTable.id, s.id));
        pendingJoins.delete(`${s.groupId}:${s.userId}`);
      }
    } catch (err) {
      logger.error({ err }, "Captcha watcher error");
    }
  };
  setInterval(tick, 5_000);
  void tick();
}
