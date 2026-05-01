import { db, groupSettingsTable, groupsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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
  { groupId: number; title: string; banned: boolean }[]
> {
  const rows = await db.select().from(groupsTable);
  return rows.map((r) => ({
    groupId: Number(r.groupId),
    title: r.title,
    banned: r.banned,
  }));
}
