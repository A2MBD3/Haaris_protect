import { db, groupSettingsTable, groupsTable, joinMustTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export type GroupSettings = typeof groupSettingsTable.$inferSelect;

export async function getGroupSettings(
  groupId: number,
): Promise<GroupSettings> {
  const existing = await db
    .select()
    .from(groupSettingsTable)
    .where(eq(groupSettingsTable.groupId, groupId))
    .limit(1);
  if (existing.length > 0) return existing[0]!;
  const inserted = await db
    .insert(groupSettingsTable)
    .values({ groupId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) return inserted[0]!;
  const after = await db
    .select()
    .from(groupSettingsTable)
    .where(eq(groupSettingsTable.groupId, groupId))
    .limit(1);
  return after[0]!;
}

export async function updateGroupSettings(
  groupId: number,
  patch: Partial<GroupSettings>,
): Promise<void> {
  await getGroupSettings(groupId);
  await db
    .update(groupSettingsTable)
    .set(patch)
    .where(eq(groupSettingsTable.groupId, groupId));
}

export async function upsertGroup(
  groupId: number,
  title: string,
): Promise<void> {
  await db
    .insert(groupsTable)
    .values({ groupId, title })
    .onConflictDoUpdate({
      target: groupsTable.groupId,
      set: { title, lastSeenAt: new Date() },
    });
}

export async function setGroupBanned(
  groupId: number,
  banned: boolean,
): Promise<void> {
  await db
    .update(groupsTable)
    .set({ banned })
    .where(eq(groupsTable.groupId, groupId));
}

export async function isGroupBanned(groupId: number): Promise<boolean> {
  const rows = await db
    .select({ banned: groupsTable.banned })
    .from(groupsTable)
    .where(eq(groupsTable.groupId, groupId))
    .limit(1);
  if (rows.length === 0) return false;
  return rows[0]!.banned;
}

export async function listGroups(): Promise<
  { groupId: number; title: string; banned: boolean; authorized: boolean; authorizedKey: string | null; authorizedExpiresAt: Date | null }[]
> {
  const rows = await db.select().from(groupsTable);
  return rows.map((r) => ({
    groupId: Number(r.groupId),
    title: r.title,
    banned: r.banned,
    authorized: r.authorized,
    authorizedKey: r.authorizedKey,
    authorizedExpiresAt: r.authorizedExpiresAt,
  }));
}

// ── JoinMust ──────────────────────────────────────────────────────────────────

export async function addJoinMust(
  groupId: number,
  targetId: number,
  targetUsername: string | null,
): Promise<void> {
  await db
    .insert(joinMustTable)
    .values({ groupId, targetId, targetUsername })
    .onConflictDoUpdate({
      target: [joinMustTable.groupId, joinMustTable.targetId],
      set: { targetUsername },
    });
}

export async function removeJoinMust(
  groupId: number,
  targetId: number,
): Promise<boolean> {
  const result = await db
    .delete(joinMustTable)
    .where(
      and(
        eq(joinMustTable.groupId, groupId),
        eq(joinMustTable.targetId, targetId),
      ),
    )
    .returning();
  return result.length > 0;
}

export async function clearJoinMust(groupId: number): Promise<void> {
  await db
    .delete(joinMustTable)
    .where(eq(joinMustTable.groupId, groupId));
}

export async function getJoinMustList(
  groupId: number,
): Promise<{ targetId: number; targetUsername: string | null }[]> {
  const rows = await db
    .select()
    .from(joinMustTable)
    .where(eq(joinMustTable.groupId, groupId));
  return rows.map((r) => ({
    targetId: Number(r.targetId),
    targetUsername: r.targetUsername,
  }));
}
