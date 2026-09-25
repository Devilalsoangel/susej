import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

const APP_API_KEY = process.env.APP_API_KEY ?? "";
// Previous key, accepted during rotation windows ONLY: set APP_API_KEY to the
// new value, keep APP_API_KEY_PREVIOUS until every installed build has moved
// (OTA-gated), then unset it. Without this, rotating the shared device secret
// bricks all field builds at once — which is why it was never rotated.
const APP_API_KEY_PREVIOUS = process.env.APP_API_KEY_PREVIOUS ?? "";

export function sha256Hex(s: string) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function checkAppKey(request: NextRequest) {
  // A missing APP_API_KEY always denies device calls. Local and hosted
  // environments must provide their own key explicitly.
  if (!APP_API_KEY) return false;
  const presented = request.headers.get("x-app-key") ?? "";
  if (presented === APP_API_KEY) return true;
  if (APP_API_KEY_PREVIOUS && presented === APP_API_KEY_PREVIOUS) return true;
  return false;
}

// Minted desk keys (hashed at rest, last-4 display only). A minted key that
// authenticates nothing is a credential leak dressed as access control, so
// the async gate below enforces hash match + non-expired. Sync checkAppKey
// stays for the env keys; routes that can await should prefer checkAppKeyAsync.
export interface MintedKeyScope {
  /** Key display name (audit). */
  name: string;
  /** Explicit scopes, or null for legacy rows minted before scopes existed
   *  (grandfathered to full scope — new keys always carry an array). */
  permissions: string[] | null;
}

export async function verifyMintedKeyWithEntry(presented: string): Promise<MintedKeyScope | null> {
  if (!presented) return null;
  try {
    const { getPrisma } = await import("@/lib/db");
    const prisma = await getPrisma();
    if (!prisma) return null;
    const row = await prisma.appSetting.findUnique({ where: { key: "apiKeys" } });
    const val = (row as { value?: unknown } | null)?.value;
    if (!Array.isArray(val)) return null;
    const digest = sha256Hex(presented);
    const now = Date.now();
    for (let i = 0; i < val.length; i++) {
      const e = val[i];
      if (!e || typeof e !== "object") continue;
      const entry = e as Record<string, unknown>;
      if (typeof entry.keyHash !== "string" || entry.keyHash !== digest) continue;
      if (typeof entry.expiresAt === "string" && entry.expiresAt) {
        const exp = Date.parse(entry.expiresAt);
        if (Number.isFinite(exp) && exp <= now) return null;
      }
      // lastUsed heartbeat (rotation signal): best-effort write-back, never
      // fails the auth when the write contends.
      try {
        const stamped = [...val];
        stamped[i] = { ...(entry as object), lastUsed: new Date(now).toISOString() };
        await (prisma as { appSetting: { update: (a: unknown) => Promise<unknown> } }).appSetting.update({
          where: { key: "apiKeys" },
          data: { value: stamped as never },
        });
      } catch {}
      const perms = Array.isArray(entry.permissions)
        ? (entry.permissions as unknown[]).filter((p): p is string => typeof p === "string")
        : null;
      return { name: typeof entry.name === "string" ? entry.name : "", permissions: perms };
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyMintedKey(presented: string): Promise<boolean> {
  return (await verifyMintedKeyWithEntry(presented)) !== null;
}

/**
 * Scope of the presented x-app-key: "env" for the shared env secrets (full
 * scope), the minted entry's scopes for desk keys, null when nothing valid
 * was presented. Write lanes deny minted keys without write/admin scope.
 */
export async function getMintedKeyScope(request: NextRequest): Promise<MintedKeyScope | "env" | null> {
  if (checkAppKey(request)) return "env";
  const presented = request.headers.get("x-app-key") ?? "";
  if (!presented) return null;
  return verifyMintedKeyWithEntry(presented);
}

export async function checkAppKeyAsync(request: NextRequest) {
  if (checkAppKey(request)) return true;
  const presented = request.headers.get("x-app-key") ?? "";
  return verifyMintedKey(presented);
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}