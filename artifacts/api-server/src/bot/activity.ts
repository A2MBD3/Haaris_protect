import { db, userSeenTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function upsertUserSeen(
  userId: number,
  groupId: number,
  firstName: string,
  lastName: string,
  username: string | undefined,
): Promise<void> {
  try {
    await db
      .insert(userSeenTable)
      .values({
        userId,
        groupId,
        firstName,
        lastName,
        username: username ?? null,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userSeenTable.userId, userSeenTable.groupId],
        set: {
          firstName,
          lastName,
          username: username ?? null,
          lastSeenAt: new Date(),
        },
      });
  } catch {
    // non-critical; never crash the bot
  }
}

export interface UserActivity {
  groupCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  displayName: string;
  username: string | null;
}

export async function getUserActivity(userId: number): Promise<UserActivity | null> {
  const rows = await db
    .select()
    .from(userSeenTable)
    .where(eq(userSeenTable.userId, userId));

  if (rows.length === 0) return null;

  let firstSeen: Date | null = null;
  let lastSeen: Date | null = null;
  let displayName = "";
  let username: string | null = null;

  for (const r of rows) {
    if (!firstSeen || r.firstSeenAt < firstSeen) firstSeen = r.firstSeenAt;
    if (!lastSeen || r.lastSeenAt > lastSeen) {
      lastSeen = r.lastSeenAt;
      displayName = [r.firstName, r.lastName].filter(Boolean).join(" ") || String(userId);
      username = r.username ?? null;
    }
  }

  return { groupCount: rows.length, firstSeen, lastSeen, displayName, username };
}
