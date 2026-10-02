import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { cacheKey, cachedRead } from "@/lib/cache";

/**
 * Popular cities, DERIVED FROM THE DATABASE.
 *
 * The onboarding location screen used to offer a hardcoded list
 * (Bangalore / Mumbai / Delhi / Goa). That is fabricated data wearing a
 * "popular" label: it has no relationship to where anyone actually is, and it
 * will be wrong for every user outside those four. The list has to come from
 * the app's own rows.
 *
 * Two real sources of city, both written by the app itself:
 *   - User.location          - set by the onboarding screen (updateUser({ location }))
 *   - AddressBookEntry.city  - structured city the user typed into their address book
 *
 * Rules this route must never break:
 *   - NO seeded/fallback cities. If the DB is empty, the response is an empty
 *     list with `source: "db"` and the client shows the map + search only. A
 *     made-up "popular" list is exactly the bug this route replaces.
 *   - Never counts a row it did not read. Counts come from the same query.
 *   - Short labels only: a free-text field can contain "Koramangala, Bengaluru"
 *     or a whole sentence, so anything longer than a city-shaped label is not
 *     treated as a city.
 */

const MAX_LABEL = 40;
const LIMIT = 12;

type Bucket = { name: string; users: number; addresses: number };

/** Keep only labels that look like a city/place, not a sentence or a full address. */
function normaliseCity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // "Koramangala, Bengaluru" -> take the city, not the neighbourhood+city pair.
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const candidate = (parts.length > 1 ? parts[parts.length - 1] : parts[0]) || "";
  if (candidate.length < 2 || candidate.length > MAX_LABEL) return null;
  // Reject anything with digits or a URL-ish/label-ish shape: not a city.
  if (/[0-9]/.test(candidate)) return null;
  if (/[{}<>[\]]/.test(candidate)) return null;
  // Title case so "BANGALORE" and "bangalore" land in one bucket.
  return candidate
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
}

export async function GET() {
  try {
    const payload = await cachedRead(cacheKey("cities-popular", "v1"), async () => {
      const prisma = await getPrisma({ probe: false });
      if (!prisma) throw new Error("Database unavailable");

      const [userRows, addressRows] = await Promise.all([
        prisma.user
          .groupBy({
            by: ["location"],
            _count: { _all: true },
            // `{ not: "" }` compiles to SQL `location <> ''`, which is NULL
            // (therefore excluded) for rows with no location. Prisma's types
            // reject an explicit `{ not: null }` on a nullable String.
            where: { location: { not: "" } },
          })
          .catch(() => [] as Array<{ location: string | null; _count: { _all: number } }>),
        prisma.addressBookEntry
          .groupBy({
            by: ["city"],
            _count: { _all: true },
            where: { city: { not: "" } },
          })
          .catch(() => [] as Array<{ city: string | null; _count: { _all: number } }>),
      ]);

      const buckets = new Map<string, Bucket>();
      const bump = (label: string | null, field: "users" | "addresses") => {
        const name = normaliseCity(label);
        if (!name) return;
        const key = name.toLowerCase();
        const bucket = buckets.get(key) ?? { name, users: 0, addresses: 0 };
        bucket[field] += 1;
        buckets.set(key, bucket);
      };

      for (const row of userRows) bump(row.location, "users");
      for (const row of addressRows) bump(row.city, "addresses");

      const cities = [...buckets.values()]
        .map((b) => ({ name: b.name, users: b.users, addresses: b.addresses, signals: b.users + b.addresses }))
        // Ranked by how much of the app actually sits there. Ties break
        // alphabetically so the list is stable between requests.
        .sort((a, b) => b.signals - a.signals || a.name.localeCompare(b.name))
        .slice(0, LIMIT)
        .map(({ name, users, addresses }) => ({ name, users, addresses }));

      return { cities, source: "db" as const };
    });

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch {
    // Honest failure: the client shows map + search only. It must not fall back
    // to a hardcoded list, and it must not pretend the DB was empty on purpose.
    return NextResponse.json(
      { cities: [], source: "unavailable" as const },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
