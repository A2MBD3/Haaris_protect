import { db, tagsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function addTag(userId: number, tag: string, addedBy: number): Promise<void> {
  const normalized = tag.trim().toLowerCase();
  await db
    .insert(tagsTable)
    .values({ userId, tag: normalized, addedBy })
    .onConflictDoNothing();
}

export async function removeTag(userId: number, tag: string): Promise<boolean> {
  const normalized = tag.trim().toLowerCase();
  const result = await db
    .delete(tagsTable)
    .where(and(eq(tagsTable.userId, userId), eq(tagsTable.tag, normalized)))
    .returning();
  return result.length > 0;
}

export async function getUserTags(userId: number): Promise<string[]> {
  const rows = await db.select().from(tagsTable).where(eq(tagsTable.userId, userId));
  return rows.map((r) => r.tag);
}

export async function clearUserTags(userId: number): Promise<void> {
  await db.delete(tagsTable).where(eq(tagsTable.userId, userId));
}
