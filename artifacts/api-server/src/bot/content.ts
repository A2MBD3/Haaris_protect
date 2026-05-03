import type { Context } from "grammy";
import {
  db,
  filtersTable,
  blacklistTable,
  blacklistHitsTable,
  locksTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import type { LockType } from "./constants";

export async function addFilter(
  groupId: number,
  word: string,
  reply: string,
): Promise<void> {
  await db
    .insert(filtersTable)
    .values({ groupId, word: word.toLowerCase(), reply })
    .onConflictDoUpdate({
      target: [filtersTable.groupId, filtersTable.word],
      set: { reply },
    });
}

export async function removeFilter(
  groupId: number,
  word: string,
): Promise<boolean> {
  const r = await db
    .delete(filtersTable)
    .where(
      and(
        eq(filtersTable.groupId, groupId),
        eq(filtersTable.word, word.toLowerCase()),
      ),
    )
    .returning();
  return r.length > 0;
}

export async function listFilters(
  groupId: number,
): Promise<{ word: string; reply: string }[]> {
  return await db
    .select({ word: filtersTable.word, reply: filtersTable.reply })
    .from(filtersTable)
    .where(eq(filtersTable.groupId, groupId));
}

export async function findFilter(
  groupId: number,
  text: string,
): Promise<string | null> {
  const lower = text.toLowerCase();
  const filters = await listFilters(groupId);
  for (const f of filters) {
    const re = new RegExp(`\\b${escapeRegex(f.word)}\\b`, "i");
    if (re.test(lower)) return f.reply;
  }
  return null;
}

export async function addBlacklistWord(
  groupId: number,
  word: string,
): Promise<void> {
  await db
    .insert(blacklistTable)
    .values({ groupId, word: word.toLowerCase() })
    .onConflictDoNothing();
}

export async function removeBlacklistWord(
  groupId: number,
  word: string,
): Promise<boolean> {
  const r = await db
    .delete(blacklistTable)
    .where(
      and(
        eq(blacklistTable.groupId, groupId),
        eq(blacklistTable.word, word.toLowerCase()),
      ),
    )
    .returning();
  return r.length > 0;
}

export async function listBlacklist(groupId: number): Promise<string[]> {
  const rows = await db
    .select({ word: blacklistTable.word })
    .from(blacklistTable)
    .where(eq(blacklistTable.groupId, groupId));
  return rows.map((r) => r.word);
}

export async function resetBlacklist(groupId: number): Promise<void> {
  await db.delete(blacklistTable).where(eq(blacklistTable.groupId, groupId));
}

export async function findBlacklisted(
  groupId: number,
  text: string,
): Promise<string | null> {
  const lower = text.toLowerCase();
  const words = await listBlacklist(groupId);
  for (const w of words) {
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, "i");
    if (re.test(lower)) return w;
  }
  return null;
}

export async function bumpBlacklistHit(
  groupId: number,
  userId: number,
): Promise<number> {
  await db
    .insert(blacklistHitsTable)
    .values({ groupId, userId, count: 1 })
    .onConflictDoUpdate({
      target: [blacklistHitsTable.groupId, blacklistHitsTable.userId],
      set: { count: sql`${blacklistHitsTable.count} + 1` },
    });
  const row = await db
    .select()
    .from(blacklistHitsTable)
    .where(
      and(
        eq(blacklistHitsTable.groupId, groupId),
        eq(blacklistHitsTable.userId, userId),
      ),
    )
    .limit(1);
  return row[0]?.count ?? 0;
}

export async function resetBlacklistHits(
  groupId: number,
  userId: number,
): Promise<void> {
  await db
    .delete(blacklistHitsTable)
    .where(
      and(
        eq(blacklistHitsTable.groupId, groupId),
        eq(blacklistHitsTable.userId, userId),
      ),
    );
}

export async function addLock(
  groupId: number,
  type: LockType,
): Promise<void> {
  await db
    .insert(locksTable)
    .values({ groupId, type })
    .onConflictDoNothing();
}

export async function removeLock(
  groupId: number,
  type: LockType,
): Promise<boolean> {
  const r = await db
    .delete(locksTable)
    .where(and(eq(locksTable.groupId, groupId), eq(locksTable.type, type)))
    .returning();
  return r.length > 0;
}

export async function getLocks(groupId: number): Promise<Set<LockType>> {
  const rows = await db
    .select({ type: locksTable.type })
    .from(locksTable)
    .where(eq(locksTable.groupId, groupId));
  return new Set(rows.map((r) => r.type as LockType));
}

export async function violatesLock(
  groupId: number,
  ctx: Context,
): Promise<LockType | null> {
  const locks = await getLocks(groupId);
  if (locks.size === 0) return null;
  const m = ctx.message;
  if (!m) return null;
  if (locks.has("sticker") && m.sticker) return "sticker";
  if (locks.has("gif") && m.animation) return "gif";
  if (locks.has("photo") && m.photo) return "photo";
  if (locks.has("video") && m.video) return "video";
  if (locks.has("voice") && m.voice) return "voice";
  if (locks.has("audio") && m.audio) return "audio";
  if (locks.has("document") && m.document) return "document";
  if (locks.has("poll") && m.poll) return "poll";
  if (locks.has("game") && m.game) return "game";
  if (locks.has("contact") && m.contact) return "contact";
  if (locks.has("location") && (m.location || m.venue)) return "location";
  if (locks.has("forward") && m.forward_origin) return "forward";
  if (
    locks.has("media") &&
    (m.photo || m.video || m.animation || m.document || m.audio || m.voice)
  )
    return "media";
  if (locks.has("link")) {
    const text = m.text || m.caption || "";
    const entities = m.entities || m.caption_entities || [];
    if (
      /https?:\/\/|t\.me\/|telegram\.me\/|www\./i.test(text) ||
      entities.some(
        (e) =>
          e.type === "url" ||
          e.type === "text_link",
      )
    ) {
      return "link";
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
