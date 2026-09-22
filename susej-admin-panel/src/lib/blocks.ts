/**
 * User-to-user blocks (server enforcement). New table in the one-shot
 * migration — every access is missing-table tolerant: pre-migration DBs
 * behave exactly as before (no blocks), never 503.
 */

const norm = (u: unknown): string => String(u ?? "").trim().toLowerCase();

/** Usernames this user blocked (lowercased). [] when the table is absent. */
export async function blockedBy(prisma: any, username: string): Promise<Set<string>> {
  try {
    const rows = await prisma.block.findMany({
      where: { blockerUsername: username },
      select: { blockedUsername: true },
    });
    return new Set((rows as Array<{ blockedUsername?: unknown }>).map((r) => norm(r.blockedUsername)));
  } catch {
    return new Set<string>();
  }
}

/** Usernames that blocked this user (lowercased). [] when absent. */
export async function blockedMe(prisma: any, username: string): Promise<Set<string>> {
  try {
    const rows = await prisma.block.findMany({
      where: { blockedUsername: username },
      select: { blockerUsername: true },
    });
    return new Set((rows as Array<{ blockerUsername?: unknown }>).map((r) => norm(r.blockerUsername)));
  } catch {
    return new Set<string>();
  }
}

/** True when either side blocked the other (message must not flow). */
export async function blockBetween(prisma: any, a: string, b: string): Promise<boolean> {
  const [na, nb] = [norm(a), norm(b)];
  if (!na || !nb || na === nb) return false;
  try {
    const hit = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerUsername: a, blockedUsername: b },
          { blockerUsername: b, blockedUsername: a },
        ],
      },
      select: { id: true },
    }).catch(() => null);
    if (hit) return true;
    // Case-insensitive fallback (usernames are stable-lowercase in practice;
    // covers legacy drift without a second index).
    const mine = await blockedBy(prisma, a);
    if (mine.has(nb)) return true;
    const theirs = await blockedMe(prisma, a);
    return theirs.has(nb);
  } catch {
    return false;
  }
}
