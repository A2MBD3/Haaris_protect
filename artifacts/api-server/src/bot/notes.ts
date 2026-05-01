import { db, notesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function saveNote(
  groupId: number,
  name: string,
  content: string,
  createdBy: number,
): Promise<void> {
  await db
    .insert(notesTable)
    .values({ groupId, name: name.toLowerCase(), content, createdBy })
    .onConflictDoUpdate({
      target: [notesTable.groupId, notesTable.name],
      set: { content, createdBy },
    });
}

export async function getNote(
  groupId: number,
  name: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(notesTable)
    .where(and(eq(notesTable.groupId, groupId), eq(notesTable.name, name.toLowerCase())))
    .limit(1);
  return rows[0]?.content ?? null;
}

export async function removeNote(
  groupId: number,
  name: string,
): Promise<boolean> {
  const r = await db
    .delete(notesTable)
    .where(and(eq(notesTable.groupId, groupId), eq(notesTable.name, name.toLowerCase())))
    .returning();
  return r.length > 0;
}

export async function listNotes(
  groupId: number,
): Promise<{ name: string; content: string }[]> {
  const rows = await db
    .select({ name: notesTable.name, content: notesTable.content })
    .from(notesTable)
    .where(eq(notesTable.groupId, groupId))
    .orderBy(notesTable.name);
  return rows;
}
