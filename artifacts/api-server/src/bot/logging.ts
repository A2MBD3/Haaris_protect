import type { Api } from "grammy";
import { db, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

export type LogCategory = "general" | "moderation" | "security" | "filter" | "captcha" | "settings";

const ALL_CATEGORIES: LogCategory[] = ["general", "moderation", "security", "filter", "captcha", "settings"];

const CONFIG_KEYS: Record<string, string> = {
  channel:    "log_channel",
  general:    "log_topic_general",
  moderation: "log_topic_moderation",
  security:   "log_topic_security",
  filter:     "log_topic_filter",
  captcha:    "log_topic_captcha",
  settings:   "log_topic_settings",
};

const cache: Record<string, number | null | undefined> = {};

async function getConfig(key: string): Promise<string | null> {
  const rows = await db.select().from(botConfigTable).where(eq(botConfigTable.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function setConfig(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(botConfigTable).where(eq(botConfigTable.key, key));
  } else {
    await db.insert(botConfigTable).values({ key, value })
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
  for (const cat of ALL_CATEGORIES) delete cache[cat];
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
  general:    { name: "🌐 General",    icon_color: 0x6FB9F0 },
  moderation: { name: "⚔️ Moderation", icon_color: 0xFF5733 },
  security:   { name: "🛡️ Security",   icon_color: 0xFFD700 },
  filter:     { name: "🔍 Filter",     icon_color: 0xE65BCA },
  captcha:    { name: "🤖 Captcha",    icon_color: 0x40C057 },
  settings:   { name: "⚙️ Settings",   icon_color: 0x9B59B6 },
};

// ── In-memory log ring buffer ─────────────────────────────────────────────────

export interface LogEntry {
  id: number;
  ts: number;
  category: LogCategory;
  text: string;
}

const LOG_BUFFER_MAX = 600;
const _logBuf: LogEntry[] = [];
let _logSeq = 0;

function stripHtml(html: string): string {
  return html
    .replace(/<a[^>]*href="tg:\/\/user\?id=(\d+)"[^>]*>([^<]+)<\/a>/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

function pushLog(category: LogCategory, html: string): void {
  _logBuf.push({ id: ++_logSeq, ts: Date.now(), category, text: stripHtml(html) });
  if (_logBuf.length > LOG_BUFFER_MAX) _logBuf.shift();
}

export function getRecentLogs(limit = 150, category?: LogCategory): LogEntry[] {
  const src = category ? _logBuf.filter(e => e.category === category) : [..._logBuf];
  return src.slice(-limit).reverse();
}

// ── Topic management ──────────────────────────────────────────────────────────

export async function initLogTopics(api: Api, channelId: number): Promise<boolean> {
  let chat: any;
  try { chat = await api.getChat(channelId); } catch { return false; }
  if (!chat.is_forum) return false;
  for (const category of ALL_CATEGORIES) {
    const existing = await getTopicId(category);
    if (existing) continue;
    try {
      const cfg = TOPIC_CONFIG[category];
      const topic = await (api as any).createForumTopic(channelId, cfg.name, { icon_color: cfg.icon_color });
      await setTopicId(category, topic.message_thread_id);
      logger.info({ category, threadId: topic.message_thread_id }, "Log topic created");
    } catch (err) {
      logger.warn({ err, category }, "Failed to create log topic");
    }
  }
  return true;
}

async function ensureTopics(api: Api, channelId: number): Promise<void> {
  let chat: any;
  try { chat = await api.getChat(channelId); } catch { return; }
  if (!chat.is_forum) return;
  for (const category of ALL_CATEGORIES) {
    const existing = await getTopicId(category);
    if (existing) continue;
    try {
      const cfg = TOPIC_CONFIG[category];
      const topic = await (api as any).createForumTopic(channelId, cfg.name, { icon_color: cfg.icon_color });
      await setTopicId(category, topic.message_thread_id);
    } catch (err) {
      logger.warn({ err, category }, "Failed to auto-create log topic");
    }
  }
}

export async function resetAndRecreateTopics(api: Api, channelId: number): Promise<boolean> {
  for (const cat of ALL_CATEGORIES) await setTopicId(cat, null);
  return initLogTopics(api, channelId);
}

export async function logAction(api: Api, message: string, category: LogCategory = "general"): Promise<void> {
  pushLog(category, message);

  const channel = await getLogChannel();
  if (!channel) return;

  await ensureTopics(api, channel);
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

export const logGeneral  = (api: Api, msg: string) => logAction(api, msg, "general");
export const logMod      = (api: Api, msg: string) => logAction(api, msg, "moderation");
export const logSecurity = (api: Api, msg: string) => logAction(api, msg, "security");
export const logFilter   = (api: Api, msg: string) => logAction(api, msg, "filter");
export const logCaptcha  = (api: Api, msg: string) => logAction(api, msg, "captcha");
export const logSettings = (api: Api, msg: string) => logAction(api, msg, "settings");
