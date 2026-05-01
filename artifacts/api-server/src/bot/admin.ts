import { db, superAdminsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { HARDCODED_SUPER_ADMINS } from "./constants";

let cache: Set<number> | null = null;
let cacheLoadedAt = 0;
const TTL_MS = 30_000;

export async function getSuperAdmins(): Promise<Set<number>> {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < TTL_MS) return cache;
  const rows = await db.select().from(superAdminsTable);
  const set = new Set<number>(HARDCODED_SUPER_ADMINS);
  for (const r of rows) set.add(Number(r.userId));
  cache = set;
  cacheLoadedAt = now;
  return set;
}

export function invalidateSuperAdminCache() {
  cache = null;
}

export async function isSuperAdmin(userId: number | undefined): Promise<boolean> {
  if (!userId) return false;
  const admins = await getSuperAdmins();
  return admins.has(userId);
}

export function isHardcodedSuper(userId: number): boolean {
  return HARDCODED_SUPER_ADMINS.includes(userId);
}

export async function ensureHardcodedSupers(): Promise<void> {
  for (const id of HARDCODED_SUPER_ADMINS) {
    await db
      .insert(superAdminsTable)
      .values({ userId: id, hardcoded: true })
      .onConflictDoUpdate({
        target: superAdminsTable.userId,
        set: { hardcoded: true },
      });
  }
  invalidateSuperAdminCache();
}

export async function addSuperAdmin(userId: number): Promise<void> {
  await db
    .insert(superAdminsTable)
    .values({ userId, hardcoded: false })
    .onConflictDoNothing();
  invalidateSuperAdminCache();
}

export async function removeSuperAdmin(userId: number): Promise<boolean> {
  if (HARDCODED_SUPER_ADMINS.includes(userId)) return false;
  await db.delete(superAdminsTable).where(eq(superAdminsTable.userId, userId));
  invalidateSuperAdminCache();
  return true;
}
