/**
 * Date helpers for cached reads.
 *
 * `cachedRead` persists its value with `JSON.stringify` (Upstash/Redis) and
 * Next's Data Cache does the same, so a `Date` stored in a cache entry comes
 * back as an ISO STRING on the next hit. A mapper that runs AFTER the cached
 * read and calls `row.someDate.getTime()` therefore throws
 * "TypeError: x.startsAt.getTime is not a function" and the endpoint answers
 * 500 with an empty body - which is exactly how production
 * GET /api/app/promotions died (Vercel log 14:16-14:19, 2026-09-27).
 *
 * Rule: never call a date method on a cached value. Use `toMillis`.
 */
export function toMillis(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
