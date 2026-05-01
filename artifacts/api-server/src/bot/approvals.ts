import { db, approvalsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function approveUser(
  groupId: number,
  userId: number,
  approvedBy: number,
): Promise<void> {
  await db
    .insert(approvalsTable)
    .values({ groupId, userId, approvedBy })
    .onConflictDoUpdate({
      target: [approvalsTable.groupId, approvalsTable.userId],
      set: { approvedBy, approvedAt: new Date() },
    });
}

export async function unapproveUser(
  groupId: number,
  userId: number,
): Promise<boolean> {
  const r = await db
    .delete(approvalsTable)
    .where(
      and(
        eq(approvalsTable.groupId, groupId),
        eq(approvalsTable.userId, userId),
      ),
    )
    .returning();
  return r.length > 0;
}

export async function isApproved(
  groupId: number,
  userId: number,
): Promise<boolean> {
  const rows = await db
    .select({ userId: approvalsTable.userId })
    .from(approvalsTable)
    .where(
      and(
        eq(approvalsTable.groupId, groupId),
        eq(approvalsTable.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function listApproved(
  groupId: number,
): Promise<{ userId: number; approvedBy: number; approvedAt: Date }[]> {
  const rows = await db
    .select()
    .from(approvalsTable)
    .where(eq(approvalsTable.groupId, groupId));
  return rows.map((r) => ({
    userId: Number(r.userId),
    approvedBy: Number(r.approvedBy),
    approvedAt: r.approvedAt,
  }));
}

export async function unapproveAll(groupId: number): Promise<number> {
  const r = await db
    .delete(approvalsTable)
    .where(eq(approvalsTable.groupId, groupId))
    .returning();
  return r.length;
}
