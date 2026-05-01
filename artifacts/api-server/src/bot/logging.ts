import type { Api } from "grammy";
import { db, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type LogCategory = "general" | "moderation" | "security" | "filter" | "captcha";

const ALL_CATEGORIES: LogCategory[] = ["general", "moderation", "security", "filter", "captcha"];

const CONFIG_KEYS: Record<string, string> = {
  channel:    "log_channel",
  general:    "log_topic_general",
  moderation: "log_topic_moderation",
  security:   "log_topic_security",
  filter:     "log_topic_filter",
  captcha:    "log_topic_captcha",
};

// Simple in-memory cache
const cache: Record<string, number | null | undefined> = {};

async function getConfig(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(botConfigTable)
    .where(eq(botConfigTable.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function setConfig(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(botConfigTable).where(eq(botConfigTable.key, key));
  } else {
    await db
      .insert(botConfigTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: botConfigTable.key, set: { value } });
  }
}

export async function getLogChannel(): Promise<number | null> {
  if (cache["channel"] !== undefined) return cache["channel"] as number | null;
  const v = await getConfig(CONFIG_KEYS["channel"]!);
  cache["channel"] = v ? Number(v) : null;
  return cache["channel"] as number | null;
}

export async function setLogChannel(channelId: number | null): Promise<void> {
  await setConfig(CONFIG_KEYS["channel"]!, channelId !== null ? String(channelId) : null);
  cache["channel"] = channelId;
  // Reset all topic caches when target changes
  for (const cat of ALL_CATEGORIES) {
    delete cache[cat];
  }
}

async function getTopicId(category: LogCategory): Promise<number | null> {
  if (cache[category] !== undefined) return cache[category] as number | null;
  const v = await getConfig(CONFIG_KEYS[category]!);
  cache[category] = v ? Number(v) : null;
  return cache[category] as number | null;
}

async function setTopicId(category: LogCategory, threadId: number | null): Promise<void> {
  await setConfig(CONFIG_KEYS[category]!, threadId !== null ? String(threadId) : null);
  cache[category] = threadId;
}

const TOPIC_CONFIG: Record<LogCategory, { name: string; icon_color: number }> = {
  general:    { name: "🌐 General",    icon_color: 0x6FB9F0 }, // blue
  moderation: { name: "⚔️ Moderation", icon_color: 0xFF5733 }, // red-orange
  security:   { name: "🛡️ Security",   icon_color: 0xFFD700 }, // gold
  filter:     { name: "🔍 Filter",     icon_color: 0xE65BCA }, // pink
  captcha:    { name: "🤖 Captcha",    icon_color: 0x40C057 }, // green
};

/**
 * Called when a log channel/group is set.
 * Works for channels, regular supergroups, and forum supergroups.
 * For forum supergroups, auto-creates 5 topics:
 *   🌐 General | ⚔️ Moderation | 🛡️ Security | 🔍 Filter | 🤖 Captcha
 * Returns true if forum topics were created.
 */
export async function initLogTopics(api: Api, channelId: number): Promise<boolean> {
  let chat: any;
  try {
    chat = await api.getChat(channelId);
  } catch {
    return false;
  }
  if (!chat.is_forum) return false;

  for (const category of ALL_CATEGORIES) {
    const existing = await getTopicId(category);
    if (existing) continue; // already created — reuse
    try {
      const cfg = TOPIC_CONFIG[category];
      const topic = await (api as any).createForumTopic(channelId, cfg.name, {
        icon_color: cfg.icon_color,
      });
      await setTopicId(category, topic.message_thread_id);
      logger.info({ category, threadId: topic.message_thread_id }, "Log topic created");
    } catch (err) {
      logger.warn({ err, category }, "Failed to create log topic");
    }
  }
  return true;
}

/**
 * Force-recreate all topics (e.g. when re-running /setlog on same forum group).
 */
export async function resetAndRecreateTopics(api: Api, channelId: number): Promise<boolean> {
  // Clear all stored topic IDs first
  for (const cat of ALL_CATEGORIES) {
    await setTopicId(cat, null);
  }
  return initLogTopics(api, channelId);
}

/**
 * Log a message to the appropriate topic (or flat stream if no topics).
 */
export async function logAction(
  api: Api,
  message: string,
  category: LogCategory = "general",
): Promise<void> {
  const channel = await getLogChannel();
  if (!channel) return;

  const threadId = await getTopicId(category);

  try {
    await api.sendMessage(channel, message, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to send log message");
  }
}

/** Convenience wrappers */
export const logGeneral    = (api: Api, msg: string) => logAction(api, msg, "general");
export const logMod        = (api: Api, msg: string) => logAction(api, msg, "moderation");
export const logSecurity   = (api: Api, msg: string) => logAction(api, msg, "security");
export const logFilter     = (api: Api, msg: string) => logAction(api, msg, "filter");
export const logCaptcha    = (api: Api, msg: string) => logAction(api, msg, "captcha");
