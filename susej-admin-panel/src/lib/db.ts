import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

let clientPromise: Promise<PrismaClient | null> | null = null;

function runtimeDatabaseUrl(): string | undefined {
  const value = process.env.DATABASE_URL;
  if (!value) return value;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.endsWith(".neon.tech") && !parsed.hostname.includes("-pooler.")) {
      parsed.hostname = parsed.hostname.replace(/^([^.]+)(?=\.)/, "$1-pooler");
      return parsed.toString();
    }
  } catch {}
  return value;
}

function createAdapter(): unknown {
  const url = runtimeDatabaseUrl();
  if (!url || !url.startsWith("postgres")) {
    // No silent SQLite fallback - a missing/bad DATABASE_URL must be loud,
    // not quietly spin up an empty demo database.
    throw new Error(
      "[db] DATABASE_URL is missing or not a postgres:// connection string. Configure PostgreSQL (see .env) before starting the server."
    );
  }
  // Serverless-tuned pool (Vercel + Neon pooler): a small ceiling (function
  // instances fan out, the pooler multiplexes), a LONG connect timeout so a
  // suspended Neon compute can wake instead of instantly failing, and short
  // idle eviction (frozen instances leave dead sockets behind).
  return new PrismaPg(
    { connectionString: url },
    {
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 20000,
    } as never
  );
}

let probePromise: Promise<PrismaClient | null> | null = null;

async function getClient(): Promise<PrismaClient | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        return new PrismaClient({ adapter: createAdapter() as never });
      } catch (err) {
        clientPromise = null;
        console.error("[db] client initialization failed:", err);
        return null;
      }
    })();
  }
  return clientPromise;
}

export function getPrisma(options: { probe?: boolean } = {}): Promise<PrismaClient | null> {
  if (options.probe === false) return getClient();
  if (!probePromise) {
    probePromise = (async () => {
      const client = await getClient();
      if (!client) return null;
      try {
        await client.user.count();
        return client;
      } catch (err) {
        probePromise = null;
        console.error("[db] probe failed, will retry on next request:", err);
        return null;
      }
    })();
  }
  return probePromise;
}
