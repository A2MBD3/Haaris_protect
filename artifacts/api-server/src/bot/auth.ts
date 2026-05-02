import { db, authKeysTable, groupsTable, groupKeyHistoryTable } from "@workspace/db";
import { eq, lte, and, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Bot } from "grammy";
import { logger } from "../lib/logger";

export interface AuthKey {
  key: string;
  expiresAt: Date | null;
  maxUses: number;
  usedCount: number;
  createdBy: number;
  createdAt: Date;
}

function generateKey(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

export async function createAuthKey(
  durationSec: number,
  uses: number,
  createdBy: number,
): Promise<AuthKey> {
  const expiresAt =
    durationSec > 0 ? new Date(Date.now() + durationSec * 1000) : null;
  const key = generateKey();
  const inserted = await db
    .insert(authKeysTable)
    .values({ key, expiresAt, maxUses: Math.max(1, uses), usedCount: 0, createdBy })
    .returning();
  const r = inserted[0]!;
  return {
    key: r.key,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    createdBy: Number(r.createdBy),
    createdAt: r.createdAt,
  };
}

export async function listAuthKeys(): Promise<AuthKey[]> {
  const rows = await db.select().from(authKeysTable);
  return rows.map((r) => ({
    key: r.key,
    expiresAt: r.expiresAt,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    createdBy: Number(r.createdBy),
    createdAt: r.createdAt,
  }));
}

export async function removeAuthKey(key: string): Promise<boolean> {
  const r = await db
    .delete(authKeysTable)
    .where(eq(authKeysTable.key, key.toUpperCase()))
    .returning();
  return r.length > 0;
}

// ── Key-per-group history ─────────────────────────────────────────────────────

export async function addGroupKeyHistory(groupId: number, key: string): Promise<void> {
  await db
    .insert(groupKeyHistoryTable)
    .values({ groupId, key: key.toUpperCase() })
    .onConflictDoNothing();
}

export async function hasGroupUsedKey(groupId: number, key: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(groupKeyHistoryTable)
    .where(and(eq(groupKeyHistoryTable.groupId, groupId), eq(groupKeyHistoryTable.key, key.toUpperCase())))
    .limit(1);
  return rows.length > 0;
}

// ── consumeAuthKey ────────────────────────────────────────────────────────────

export async function consumeAuthKey(
  key: string,
  groupId?: number,
): Promise<{ ok: boolean; reason?: string; expiresAt?: Date | null }> {
  const upper = key.trim().toUpperCase();

  if (groupId !== undefined) {
    const used = await hasGroupUsedKey(groupId, upper);
    if (used) return { ok: false, reason: "This key has already been used for this group and cannot be reused." };
  }

  const rows = await db
    .select()
    .from(authKeysTable)
    .where(eq(authKeysTable.key, upper))
    .limit(1);
  if (rows.length === 0) return { ok: false, reason: "Invalid token." };
  const k = rows[0]!;
  if (k.expiresAt && k.expiresAt.getTime() < Date.now())
    return { ok: false, reason: "Token has expired." };
  if (k.usedCount >= k.maxUses)
    return { ok: false, reason: "Token has no uses remaining." };
  await db
    .update(authKeysTable)
    .set({ usedCount: sql`${authKeysTable.usedCount} + 1` })
    .where(eq(authKeysTable.key, upper));
  return { ok: true, expiresAt: k.expiresAt };
}

export async function isGroupAuthorized(groupId: number): Promise<boolean> {
  const rows = await db
    .select({ authorized: groupsTable.authorized, authorizedExpiresAt: groupsTable.authorizedExpiresAt })
    .from(groupsTable)
    .where(eq(groupsTable.groupId, groupId))
    .limit(1);
  if (rows.length === 0) return false;
  const r = rows[0]!;
  if (!r.authorized) return false;
  if (r.authorizedExpiresAt && r.authorizedExpiresAt.getTime() < Date.now()) {
    await db
      .update(groupsTable)
      .set({ authorized: false })
      .where(eq(groupsTable.groupId, groupId));
    return false;
  }
  return true;
}

export async function authorizeGroup(
  groupId: number,
  key: string,
  expiresAt: Date | null,
): Promise<void> {
  await db
    .update(groupsTable)
    .set({
      authorized: true,
      authorizedKey: key.toUpperCase(),
      authorizedExpiresAt: expiresAt,
    })
    .where(eq(groupsTable.groupId, groupId));
}

export async function deauthorizeGroup(groupId: number): Promise<void> {
  const rows = await db
    .select({ authorizedKey: groupsTable.authorizedKey })
    .from(groupsTable)
    .where(eq(groupsTable.groupId, groupId))
    .limit(1);
  const currentKey = rows[0]?.authorizedKey;
  if (currentKey) {
    await addGroupKeyHistory(groupId, currentKey);
  }
  await db
    .update(groupsTable)
    .set({ authorized: false, authorizedKey: null, authorizedExpiresAt: null })
    .where(eq(groupsTable.groupId, groupId));
}

/**
 * Background watcher: finds groups whose auth has expired and notifies them.
 */
export function startAuthExpiryWatcher(bot: Bot): void {
  const tick = async () => {
    try {
      const now = new Date();
      const expired = await db
        .select()
        .from(groupsTable)
        .where(
          and(
            eq(groupsTable.authorized, true),
            lte(groupsTable.authorizedExpiresAt, now),
          ),
        )
        .limit(50);

      for (const g of expired) {
        if (g.authorizedKey) {
          await addGroupKeyHistory(Number(g.groupId), g.authorizedKey);
        }
        await db
          .update(groupsTable)
          .set({ authorized: false })
          .where(eq(groupsTable.groupId, g.groupId));

        try {
          await bot.api.sendMessage(
            Number(g.groupId),
            `🔑 <b>Authorization expired</b>\n\nThis group's authorization token has expired. A group admin must redeem a new token to continue using the bot:\n\n<code>/redeem YOUR_TOKEN</code>\n\nContact a Super Admin to obtain one.`,
            { parse_mode: "HTML" },
          );
        } catch (err) {
          logger.warn({ err, groupId: g.groupId }, "Failed to notify group of auth expiry");
        }
      }
    } catch (err) {
      logger.error({ err }, "Auth expiry watcher error");
    }
  };
  setInterval(tick, 60_000);
  void tick();
}
