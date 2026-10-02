import { useEffect, useState } from 'react';

import { serverApi } from './serverApi';

/**
 * Username -> profile picture, the way a real social app does it.
 *
 * WHY THIS EXISTS
 * `resolveAvatar()` returns ONE shared "no photo" placeholder for every
 * account, so every screen that rendered `<Image source={resolveAvatar(u)}/>`
 * showed the SAME near-empty circle - including accounts that HAVE a photo.
 * That is the reported "PFP not showing at other users / on the store": the
 * picture was never asked for, it was replaced by a blank at render time.
 *
 * THE RULES
 * - Resolve through the server (the account's real `avatar`), never invent one.
 * - One request per username per device, shared by every screen that asks
 *   (the same seller appears in the feed, their storefront, the product page
 *   and the chat list - four lookups, one network call).
 * - An account with no picture resolves to `null` and the UI draws honest
 *   initials on a colour. A failed request does the same. Never a blank frame.
 * - Cached across screens and app restarts for the session; a `null` result is
 *   remembered too, so a photo-less account is asked about exactly once.
 */

type Entry = { url: string | null; at: number };

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();

/** A real, loadable image URL. Rejects the data-URI placeholder + junk. */
export function isRealAvatar(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

function cached(username: string): Entry | undefined {
  const hit = cache.get(username);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(username);
    return undefined;
  }
  return hit;
}

/** Warm the directory for a list of usernames without rendering anything. */
export function primeAvatars(usernames: Array<string | null | undefined>): void {
  usernames.forEach((u) => {
    const name = String(u ?? '').trim();
    if (name && !name.startsWith('local_') && !cached(name)) void resolveAvatarUrl(name);
  });
}

export function resolveAvatarUrl(username: string): Promise<string | null> {
  const name = String(username ?? '').trim();
  if (!name || name.startsWith('local_')) return Promise.resolve(null);
  const hit = cached(name);
  if (hit) return Promise.resolve(hit.url);
  const flying = inFlight.get(name);
  if (flying) return flying;
  const task = serverApi
    .getUserProfile(name)
    .then((res) => {
      const raw = res.ok && res.data ? (res.data as { user?: { avatar?: unknown } }).user?.avatar : null;
      const url = isRealAvatar(raw) ? raw.trim() : null;
      cache.set(name, { url, at: Date.now() });
      emit();
      return url;
    })
    .catch(() => {
      // A failed lookup must not poison the session forever: remember it only
      // for this TTL window, then allow a retry.
      cache.set(name, { url: null, at: Date.now() });
      return null;
    })
    .finally(() => {
      inFlight.delete(name);
    });
  inFlight.set(name, task);
  return task;
}

/**
 * Avatar URL for a username, or `null` when the account has no picture yet.
 * Renders initials until (or unless) the real photo arrives, so there is never
 * an empty frame.
 */
export function useAvatarUrl(username?: string | null): string | null {
  const name = String(username ?? '').trim();
  const [url, setUrl] = useState<string | null>(() => {
    const hit = name ? cached(name) : undefined;
    return hit ? hit.url : null;
  });

  useEffect(() => {
    if (!name || name.startsWith('local_')) {
      setUrl(null);
      return;
    }
    const hit = cached(name);
    if (hit) {
      setUrl(hit.url);
      return;
    }
    let alive = true;
    setUrl(null);
    void resolveAvatarUrl(name).then((next) => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [name]);

  useEffect(() => {
    // Another screen resolved this username while we were mounted.
    const onChange = () => {
      const hit = cached(name);
      setUrl(hit ? hit.url : null);
    };
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, [name]);

  return url;
}
