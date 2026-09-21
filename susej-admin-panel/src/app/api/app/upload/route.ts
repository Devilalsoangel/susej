import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import sharp from "sharp";
import { checkAppKeyAsync, getMintedKeyScope, unauthorized } from "@/lib/promotions/api-auth";
import { getAppUser } from "@/lib/app-auth";
import { getPrisma } from "@/lib/db";

// Banner image upload for the seller dashboard (marketing banners).
// Accepts a base64 data URL from expo-image-picker, writes the file into
// public/uploads/ and returns a root-relative URL that both the app
// (prefixed with the admin base URL) and this panel can render.

const MAX_BYTES = 5 * 1024 * 1024; // 5MB fail-closed default

// Admin-configured cap (Settings → Storage → maxUploadSize, MB): the desk
// promise is honored here instead of 413ing above the configured limit.
// Fail-closed to 5MB when the setting is missing or garbage; clamped 1–50MB.
async function resolveMaxBytes(): Promise<number> {
  try {
    const prisma = await getPrisma();
    if (!prisma) return MAX_BYTES;
    const row = await (prisma as any).appSetting.findUnique({ where: { key: "maxUploadSize" } });
    const mb = Number((row as { value?: unknown } | null)?.value);
    if (!Number.isFinite(mb) || mb <= 0) return MAX_BYTES;
    return Math.min(50, Math.max(1, Math.floor(mb))) * 1024 * 1024;
  } catch {
    return MAX_BYTES;
  }
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Magic-number sniffing: Android labels many gallery files
 * application/octet-stream even when the bytes are plain images. */
function sniffImageExt(buf: Uint8Array): string | null {
  const b = (i: number) => (i < buf.length ? buf[i] : -1);
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpg";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "png";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return "gif";
  if (
    b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
    b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50
  ) return "webp";
  return null;
}

export async function POST(request: NextRequest) {
  if (!await checkAppKeyAsync(request)) return unauthorized();
  // Minted-key scopes bind here too (read-only desk keys upload nothing —
  // the data-lane parseWriteSession already denies them; this lane never
  // inherited the check). Env keys keep full scope; legacy scope-less rows
  // are grandfathered.
  const scope = await getMintedKeyScope(request).catch((): null => null);
  if (scope !== "env" && scope !== null && Array.isArray(scope.permissions)) {
    if (!scope.permissions.includes("write") && !scope.permissions.includes("admin")) {
      return NextResponse.json({ error: "Read-only API key — uploads need write scope." }, { status: 403 });
    }
  }
  const auth = await getAppUser(request);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { dataUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const dataUrl = body.dataUrl ?? "";
  const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return NextResponse.json({ error: "Expected a base64 image data URL." }, { status: 400 });
  }

  const [, mime, base64] = match;
  let ext = MIME_EXT[mime];
  let buffer: Uint8Array = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    return NextResponse.json({ error: "Empty image payload." }, { status: 400 });
  }
  const maxBytes = await resolveMaxBytes();
  if (buffer.length > maxBytes) {
    return NextResponse.json({ error: `Image too large (max ${Math.round(maxBytes / 1048576)}MB).` }, { status: 413 });
  }

  // Industry pattern (accept broadly, store standard): phones send HEIC/HEIF
  // and other camera formats the allow-list never heard of. Convert anything
  // decodable to JPEG instead of rejecting the user's photo. sharp throws for
  // truly undecodable bytes — only then do we 415 with the mime named.
  if (!ext) {
    // Android often labels gallery files application/octet-stream even when
    // the bytes are plain JPEG/PNG — sniff magic numbers, never trust labels.
    const sniffed = sniffImageExt(buffer);
    if (sniffed) {
      ext = sniffed;
    } else if (mime.startsWith("image/") || mime === "application/octet-stream") {
      try {
        buffer = await sharp(buffer).rotate().jpeg({ quality: 82 }).toBuffer();
        ext = "jpg";
      } catch {
        return NextResponse.json(
          { error: `Unsupported image type: ${mime}. Try a JPEG or PNG photo.` },
          { status: 415 }
        );
      }
    } else {
      return NextResponse.json({ error: `Unsupported image type: ${mime}` }, { status: 415 });
    }
    if (buffer.length > maxBytes) {
      return NextResponse.json({ error: `Image too large (max ${Math.round(maxBytes / 1048576)}MB).` }, { status: 413 });
    }
  }

  // Industry shelf (free tier): Cloudinary when CLOUDINARY_URL is configured —
  // survives every deploy on every platform, served over CDN. Vercel
  // serverless disk is EPHEMERAL (redeploy/hop wipes public/uploads), so prod
  // without a durable host must fail HONEST (503) rather than return a URL
  // that 404s tomorrow. Local disk stays for dev machines / volume mounts.
  if (process.env.CLOUDINARY_URL) {
    try {
      const { v2: cloudinary } = await import("cloudinary");
      const up = await cloudinary.uploader.upload(`data:image/${ext};base64,${Buffer.from(buffer).toString("base64")}`, {
        folder: "susej",
        resource_type: "image",
      });
      if (up?.secure_url) return NextResponse.json({ ok: true, url: up.secure_url as string });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Image host rejected the upload (${msg.slice(0, 120)}).` }, { status: 502 });
    }
  }

  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Image host not configured. Uploads are disabled until the server has durable storage." },
      { status: 503 }
    );
  }

  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadsDir, { recursive: true });

  const filename = `banner-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  await writeFile(path.join(uploadsDir, filename), buffer);

  return NextResponse.json({ ok: true, url: `/uploads/${filename}` });
}
