import { getAdminUrl } from './adminSync';
import { serverApi } from './serverApi';

/**
 * Media upload pipeline (industry standard: upload FIRST, reference the
 * hosted URL everywhere).
 *
 * Fixes the carry-over bug where create-post/create-story persisted the
 * local file:// or content:// URI as the image — unviewable on every other
 * device and rejected by the hardened backend. Local media now goes through
 * /api/app/upload (auth + MIME allow-list + 5MB cap) and only the returned
 * /uploads/... URL is stored.
 */

const UPLOAD_MAX_DIM = 1280;
const UPLOAD_QUALITY = 0.75;

/** True when the URL is already hosted (http/https) — safe to persist. */
export function isHostedImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(String(url ?? '').trim());
}

/** Read a local file/content URI and encode it as a base64 data URL.
 *  Android labels gallery files application/octet-stream even for plain
 *  JPEG/PNG — callers pass the picker's real mimeType so the label is TRUE.
 *  FileReader would otherwise stamp the wrong (or octet-stream) label and
 *  the server would persist HEIC bytes as .jpg, skipping its rescue path. */
export async function uriToDataUrl(uri: string, mime = 'image/jpeg'): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const clean = String(mime || 'image/jpeg').trim() || 'image/jpeg';
  return raw.replace(/^data:[^;]+;base64,/, `data:${clean};base64,`);
}

/**
 * Downscale a local image so uploads stay under the server's 5MB cap.
 * Uses expo-image-manipulator when installed (1280px/JPEG) — the old
 * expo-image-picker.ImageManipulator path never existed and silently
 * shipped full camera originals. Falls back to a straight encode.
 */
export async function shrinkForUpload(
  uri: string,
  mime = 'image/jpeg',
  maxDim = UPLOAD_MAX_DIM,
  quality = UPLOAD_QUALITY
): Promise<string> {
  try {
    const manipModule = require('expo-image-manipulator') as {
      manipulateAsync?: (
        u: string,
        actions: unknown[],
        opts: { compress: number; format: unknown; base64?: boolean }
      ) => Promise<{ base64?: string; uri?: string }>;
      SaveFormat?: { JPEG: unknown };
    };
    const manipulateAsync = manipModule?.manipulateAsync?.bind(manipModule);
    if (manipulateAsync) {
      const out = await manipulateAsync(
        uri,
        [{ resize: { width: maxDim } }],
        { compress: quality, format: manipModule.SaveFormat?.JPEG, base64: true }
      );
      if (out?.base64) return `data:${mime};base64,${out.base64}`;
      if (out?.uri) return uriToDataUrl(out.uri, mime);
    }
  } catch {
    // manipulator not installed / failed — fall through to plain encode
  }
  return uriToDataUrl(uri, mime);
}

/** Resolve a stored image reference to an absolute URL for <Image source>. */
export function resolveImageUrl(url: string, base: string): string {
  const u = String(url ?? '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  return `${base.replace(/\/$/, '')}${u.startsWith('/') ? u : `/${u}`}`;
}

/**
 * Upload one local image to the admin panel and return the ABSOLUTE hosted
 * URL (uploadBannerImage returns a root-relative /uploads/... path).
 * Throws on failure — callers decide the UX (block post, or offline fallback).
 */
export async function uploadToServer(localUri: string, mime = 'image/jpeg'): Promise<string> {
  const dataUrl = await shrinkForUpload(String(localUri ?? '').trim(), mime);
  const res = await serverApi.uploadBannerImage(dataUrl);
  if (!res.ok || !res.data?.url) throw new Error(res.error || 'Upload failed');
  const base = await getAdminUrl();
  return resolveImageUrl(res.data.url, base);
}

/**
 * Upload every local URI in a media list; already-hosted URLs pass through
 * unchanged. Returns per-item results so callers can REPORT partial failure
 * (a silently dropped 3rd photo is discovered by the buyer, not the seller).
 */
export async function uploadAllToServer(uris: (string | number)[]): Promise<{ urls: string[]; failed: number }> {
  const out: string[] = [];
  let failed = 0;
  for (const raw of uris) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const u = raw.trim();
    if (isHostedImageUrl(u)) {
      out.push(u);
      continue;
    }
    try {
      out.push(await uploadToServer(u));
    } catch {
      failed += 1;
    }
  }
  return { urls: out, failed };
}

/** Legacy tuple wrapper (prefer the { urls, failed } shape for new callers). */
export async function uploadAllToServerList(uris: (string | number)[]): Promise<string[]> {
  return (await uploadAllToServer(uris)).urls;
}
