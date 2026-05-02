import type { Context } from "grammy";
import {
  db, warningsTable, globalBansTable, globalMutesTable,
  restrictionsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { scheduleTask } from "./scheduler";
import { getGroupSettings } from "./settings";
import { logger } from "../lib/logger";

export async function banUser(
  ctx: Context,
  groupId: number,
  userId: number,
  durationSec: number,
): Promise<void> {
  const untilDate =
    durationSec > 0 ? Math.floor(Date.now() / 1000) + durationSec : 0;
  await ctx.api.banChatMember(groupId, userId, {
    until_date: untilDate || undefined,
  });
}

export async function unbanUser(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  await ctx.api.unbanChatMember(groupId, userId, { only_if_banned: true });
}

export async function muteUser(
  ctx: Context,
  groupId: number,
  userId: number,
  durationSec: number,
): Promise<void> {
  const untilDate =
    durationSec > 0 ? Math.floor(Date.now() / 1000) + durationSec : 0;
  await ctx.api.restrictChatMember(
    groupId,
    userId,
    {
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
    },
    { until_date: untilDate || undefined },
  );
  if (durationSec > 0) {
    await scheduleTask("unmute", groupId, userId, durationSec);
  }
}

export async function unmuteUser(
  ctx: Context,
  groupId: number,
  userId: number,
): Promise<void> {
  await ctx.api.restrictChatMember(groupId, userId, {
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
}

export async function addWarning(
  groupId: number,
  userId: number,
): Promise<number> {
  await db
    .insert(warningsTable)
    .values({ groupId, userId, count: 1 })
    .onConflictDoUpdate({
      target: [warningsTable.groupId, warningsTable.userId],
      set: { count: sql`${warningsTable.count} + 1` },
    });
  const row = await db
    .select()
    .from(warningsTable)
    .where(
      and(
        eq(warningsTable.groupId, groupId),
        eq(warningsTable.userId, userId),
      ),
    )
    .limit(1);
  return row[0]?.count ?? 0;
}

export async function removeOneWarning(
  groupId: number,
  userId: number,
): Promise<number> {
  const row = await db
    .select()
    .from(warningsTable)
    .where(
      and(
        eq(warningsTable.groupId, groupId),
        eq(warningsTable.userId, userId),
      ),
    )
    .limit(1);
  const current = row[0]?.count ?? 0;
  const next = Math.max(0, current - 1);
  if (current === 0) return 0;
  await db
    .update(warningsTable)
    .set({ count: next })
    .where(
      and(
        eq(warningsTable.groupId, groupId),
        eq(warningsTable.userId, userId),
      ),
    );
  return next;
}

export async function resetWarnings(
  groupId: number,
  userId: number,
): Promise<void> {
  await db
    .delete(warningsTable)
    .where(
      and(
        eq(warningsTable.groupId, groupId),
        eq(warningsTable.userId, userId),
      ),
    );
}

export async function applyAutoActionIfNeeded(
  ctx: Context,
  groupId: number,
  userId: number,
  count: number,
): Promise<string | null> {
  const settings = await getGroupSettings(groupId);
  if (count < settings.warnLimit) return null;
  try {
    if (settings.warnAction === "ban") {
      await banUser(ctx, groupId, userId, settings.warnDurationSec);
      await resetWarnings(groupId, userId);
      return `auto-banned (${settings.warnDurationSec === 0 ? "permanent" : settings.warnDurationSec + "s"})`;
    } else {
      await muteUser(ctx, groupId, userId, settings.warnDurationSec);
      await resetWarnings(groupId, userId);
      return `auto-muted (${settings.warnDurationSec === 0 ? "permanent" : settings.warnDurationSec + "s"})`;
    }
  } catch (err) {
    logger.warn({ err }, "Auto-action failed");
    return null;
  }
}

// ── Global bans ───────────────────────────────────────────────────────────────

export async function setGlobalBan(
  userId: number,
  durationSec: number,
  reason = "",
): Promise<void> {
  const until = durationSec > 0 ? new Date(Date.now() + durationSec * 1000) : null;
  await db
    .insert(globalBansTable)
    .values({ userId, until, reason })
    .onConflictDoUpdate({
      target: globalBansTable.userId,
      set: { until, reason },
    });
}

export async function removeGlobalBan(userId: number): Promise<boolean> {
  const result = await db
    .delete(globalBansTable)
    .where(eq(globalBansTable.userId, userId))
    .returning();
  return result.length > 0;
}

export async function isGloballyBanned(userId: number): Promise<boolean> {
  const row = await db
    .select()
    .from(globalBansTable)
    .where(eq(globalBansTable.userId, userId))
    .limit(1);
  if (row.length === 0) return false;
  const r = row[0]!;
  if (r.until && r.until.getTime() < Date.now()) {
    await db.delete(globalBansTable).where(eq(globalBansTable.userId, userId));
    return false;
  }
  return true;
}

export async function getGlobalBanRow(userId: number): Promise<{ until: Date | null; reason: string } | null> {
  const row = await db
    .select()
    .from(globalBansTable)
    .where(eq(globalBansTable.userId, userId))
    .limit(1);
  if (row.length === 0) return null;
  const r = row[0]!;
  if (r.until && r.until.getTime() < Date.now()) {
    await db.delete(globalBansTable).where(eq(globalBansTable.userId, userId));
    return null;
  }
  return { until: r.until, reason: r.reason };
}

export async function listGlobalBans(): Promise<{ userId: number; until: Date | null; reason: string }[]> {
  const rows = await db.select().from(globalBansTable);
  const now = Date.now();
  return rows
    .filter((r) => !r.until || r.until.getTime() > now)
    .map((r) => ({ userId: Number(r.userId), until: r.until, reason: r.reason }));
}

// ── Global mutes ──────────────────────────────────────────────────────────────

export async function setGlobalMute(
  userId: number,
  durationSec: number,
  reason = "",
): Promise<void> {
  const until = durationSec > 0 ? new Date(Date.now() + durationSec * 1000) : null;
  await db
    .insert(globalMutesTable)
    .values({ userId, until, reason })
    .onConflictDoUpdate({
      target: globalMutesTable.userId,
      set: { until, reason },
    });
}

export async function removeGlobalMute(userId: number): Promise<boolean> {
  const result = await db
    .delete(globalMutesTable)
    .where(eq(globalMutesTable.userId, userId))
    .returning();
  return result.length > 0;
}

export async function isGloballyMuted(userId: number): Promise<boolean> {
  const row = await db
    .select()
    .from(globalMutesTable)
    .where(eq(globalMutesTable.userId, userId))
    .limit(1);
  if (row.length === 0) return false;
  const r = row[0]!;
  if (r.until && r.until.getTime() < Date.now()) {
    await db.delete(globalMutesTable).where(eq(globalMutesTable.userId, userId));
    return false;
  }
  return true;
}

export async function getGlobalMuteRow(userId: number): Promise<{ until: Date | null; reason: string } | null> {
  const row = await db
    .select()
    .from(globalMutesTable)
    .where(eq(globalMutesTable.userId, userId))
    .limit(1);
  if (row.length === 0) return null;
  const r = row[0]!;
  if (r.until && r.until.getTime() < Date.now()) {
    await db.delete(globalMutesTable).where(eq(globalMutesTable.userId, userId));
    return null;
  }
  return { until: r.until, reason: r.reason };
}

export async function listGlobalMutes(): Promise<{ userId: number; until: Date | null; reason: string }[]> {
  const rows = await db.select().from(globalMutesTable);
  const now = Date.now();
  return rows
    .filter((r) => !r.until || r.until.getTime() > now)
    .map((r) => ({ userId: Number(r.userId), until: r.until, reason: r.reason }));
}

// ── Per-group restriction tracking ────────────────────────────────────────────

export async function trackRestriction(
  groupId: number,
  userId: number,
  type: "ban" | "mute",
  durationSec: number,
): Promise<void> {
  try {
    const until = durationSec > 0 ? new Date(Date.now() + durationSec * 1000) : null;
    await db
      .insert(restrictionsTable)
      .values({ groupId, userId, type, until })
      .onConflictDoUpdate({
        target: [restrictionsTable.groupId, restrictionsTable.userId, restrictionsTable.type],
        set: { until, createdAt: new Date() },
      });
  } catch {
    // non-critical
  }
}

export async function removeRestriction(
  groupId: number,
  userId: number,
  type: "ban" | "mute",
): Promise<void> {
  try {
    await db
      .delete(restrictionsTable)
      .where(
        and(
          eq(restrictionsTable.groupId, groupId),
          eq(restrictionsTable.userId, userId),
          eq(restrictionsTable.type, type),
        ),
      );
  } catch {
    // non-critical
  }
}

export async function countGroupRestrictions(
  groupId: number,
  type: "ban" | "mute",
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select()
    .from(restrictionsTable)
    .where(
      and(
        eq(restrictionsTable.groupId, groupId),
        eq(restrictionsTable.type, type),
      ),
    );
  return rows.filter((r) => !r.until || r.until > now).length;
}

export async function listGroupRestrictions(
  groupId: number,
  type: "ban" | "mute",
): Promise<{ userId: number; until: Date | null }[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(restrictionsTable)
    .where(
      and(
        eq(restrictionsTable.groupId, groupId),
        eq(restrictionsTable.type, type),
      ),
    );
  return rows
    .filter((r) => !r.until || r.until > now)
    .map((r) => ({ userId: Number(r.userId), until: r.until }));
}
