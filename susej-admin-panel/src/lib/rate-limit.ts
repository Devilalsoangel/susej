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
