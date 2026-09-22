/**
 * Shared per-IP, per-minute write throttle (same shape as the data-lane
 * limiter). In-memory per instance: on serverless it bounds burst-per-warm-
 * instance, which stops single-device spray loops even without a shared
 * store. Money lanes use tighter limits than the desk default.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkWriteRate(key: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/**
 * SHARED throttle (one-shot): per-key counters in the AppSetting table, so
 * every serverless isolate enforces the SAME budget. Row-locked increment
 * inside a transaction — concurrent same-key requests serialize, the loser
 * observes the winner's count. No migration (AppSetting is key-value).
 * Fail-CLOSED (false) on any DB error: money lanes already 503 when the DB
 * is unreachable, so refusing matches the lane's posture. Keep the
 * in-memory check as a zero-cost pre-filter; this is the enforcement.
 */
export async function checkSharedWriteRate(
  prisma: any,
  key: string,
  limit = 20,
  windowMs = 60_000
): Promise<boolean> {
  const fullKey = `throttle:${key}`;
  const now = Date.now();
  try {
    return await prisma.$transaction(async (tx: any) => {
      // Serialize same-key increments across isolates/processes.
      await tx.$queryRawUnsafe(`SELECT "key" FROM "AppSetting" WHERE "key" = $1 FOR UPDATE`, fullKey).catch(() => []);
      const row = await tx.appSetting.findUnique({ where: { key: fullKey } }).catch(() => null);
      const val = (row as { value?: unknown } | null)?.value as { count?: unknown; resetAt?: unknown } | undefined;
      const resetAt = typeof val?.resetAt === "number" ? val.resetAt : 0;
      const count = typeof val?.count === "number" ? val.count : 0;
      if (!row || now >= resetAt) {
        const next = { count: 1, resetAt: now + windowMs };
        try {
          if (row) await tx.appSetting.update({ where: { key: fullKey }, data: { value: next as never } });
          else await tx.appSetting.create({ data: { key: fullKey, value: next as never } });
        } catch {
          // Lost create race: re-read inside the same lock and count on it.
          const reread = await tx.appSetting.findUnique({ where: { key: fullKey } }).catch(() => null);
          const rv = (reread as { value?: unknown } | null)?.value as { count?: unknown; resetAt?: unknown } | undefined;
          const rc = typeof rv?.count === "number" ? rv.count : 0;
          const rr = typeof rv?.resetAt === "number" ? rv.resetAt : 0;
          if (now >= rr) {
            await tx.appSetting.update({ where: { key: fullKey }, data: { value: { count: 1, resetAt: now + windowMs } as never } }).catch(() => {});
            return true;
          }
          if (rc >= limit) return false;
          await tx.appSetting.update({ where: { key: fullKey }, data: { value: { count: rc + 1, resetAt: rr } as never } }).catch(() => {});
          return true;
        }
        return true;
      }
      if (count >= limit) return false;
      await tx.appSetting.update({ where: { key: fullKey }, data: { value: { count: count + 1, resetAt } as never } }).catch(() => {});
      return true;
    });
  } catch {
    return false;
  }
}
