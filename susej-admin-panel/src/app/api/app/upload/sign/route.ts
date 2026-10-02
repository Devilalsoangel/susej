import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";
import { checkAppKeyAsync, getMintedKeyScope, unauthorized } from "@/lib/promotions/api-auth";

export async function POST(request: NextRequest) {
  if (!await checkAppKeyAsync(request)) return unauthorized();
  const scope = await getMintedKeyScope(request).catch((): null => null);
  if (scope !== "env" && scope !== null && Array.isArray(scope.permissions) && !scope.permissions.includes("write") && !scope.permissions.includes("admin")) {
    return NextResponse.json({ error: "Read-only API key — video uploads need write scope." }, { status: 403 });
  }
  const auth = await getAppUser(request);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!auth.user.isSeller || auth.user.verification !== "approved") {
    return NextResponse.json({ error: "Only approved sellers can upload reels" }, { status: 403 });
  }
  const prisma = await getPrisma({ probe: false });
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const cloudinaryUrl = process.env.CLOUDINARY_URL;
  if (!cloudinaryUrl) return NextResponse.json({ error: "Video host not configured" }, { status: 503 });
  try {
    const { v2: cloudinary } = await import("cloudinary");
    cloudinary.config({ secure: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "susej/reels";
    const parsed = new URL(cloudinaryUrl);
     const signature = cloudinary.utils.api_sign_request({ timestamp, folder, resource_type: "video", allowed_formats: "mp4,mov,webm" }, decodeURIComponent(parsed.password));
    return NextResponse.json({
      ok: true,
      cloudName: parsed.pathname.replace(/^\//, ""),
      apiKey: parsed.username,
      timestamp,
       folder,
       resourceType: "video",
       allowedFormats: ["mp4", "mov", "webm"],
       signature,
    });
  } catch {
    return NextResponse.json({ error: "Video host configuration is invalid" }, { status: 503 });
  }
}
