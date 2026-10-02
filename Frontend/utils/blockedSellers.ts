import { useCallback, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../contexts/AuthContext';

const BLOCKED_KEY_BASE = '@susej_blocked';

export interface BlockedEntry {
  username: string;
  name?: string;
  at?: number;
}

/** Device-local block list (same key shape as /blocked, chat inbox, PDP,
 *  and seller profile — one reader so every surface filters identically).
 *  The server Block table enforces messaging cross-device; this list stays
 *  as the offline mirror and the listing filter. Loads merge server truth
 *  (union) whenever reachable; writes push fire-and-forget (local stays on
 *  failure). */
export async function loadBlockedUsernames(username: string | null): Promise<Set<string>> {
  try {
    const key = username ? `${BLOCKED_KEY_BASE}:${username}` : BLOCKED_KEY_BASE;
    let data = await AsyncStorage.getItem(key);
    if (!data && key !== BLOCKED_KEY_BASE) {
      data = await AsyncStorage.getItem(BLOCKED_KEY_BASE);
    }
    const local: BlockedEntry[] = [];
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          for (const b of parsed as BlockedEntry[]) {
            if (b && typeof b.username === 'string' && b.username) local.push(b);
          }
        }
      } catch {}
    }
    // Server merge (union by lowercase): cross-device blocks land here.
    // Missing table / offline → local stands.
    try {
      const { serverApi } = await import('./serverApi');
      const res = await serverApi.getBlocks().catch(() => null);
      const remote = Array.isArray(res?.data?.blocked) ? res.data.blocked : null;
      if (remote) {
        const seen = new Set(local.map((b) => b.username.toLowerCase()));
        let changed = false;
        for (const u of remote) {
          const name = String(u ?? '').trim();
          if (name && !seen.has(name.toLowerCase())) {
            local.push({ username: name, at: Date.now() });
            seen.add(name.toLowerCase());
            changed = true;
          }
        }
        if (changed) {
          await AsyncStorage.setItem(key, JSON.stringify(local)).catch(() => {});
        }
      }
    } catch {}
    return new Set(local.map((b) => b.username.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Push a block to the server (fire-and-forget; local list is already updated). */
export async function pushBlockRemote(username: string): Promise<boolean> {
  const name = String(username ?? '').trim();
  if (!name) return false;
  try {
    const { serverApi } = await import('./serverApi');
    const res = await serverApi.blockUser(name);
    return res.ok === true;
  } catch {
    return false;
  }
}

/** Push an unblock to the server (fire-and-forget). */
export async function pushUnblockRemote(username: string): Promise<boolean> {
  const name = String(username ?? '').trim();
  if (!name) return false;
  try {
    const { serverApi } = await import('./serverApi');
    const res = await serverApi.unblockUser(name);
    return res.ok === true;
  } catch {
    return false;
  }
}

/**
 * Pull server blocks into an arbitrary block-list key (chat inbox + /blocked
 * screen keep their own loaders over the same key shape). Returns the merged
 * list. Missing table / offline → local stands.
 */
export async function pullServerBlocks<T extends { username: string }>(key: string, local: T[]): Promise<T[]> {
  try {
    const { serverApi } = await import('./serverApi');
    const res = await serverApi.getBlocks().catch(() => null);
    const remote = Array.isArray(res?.data?.blocked) ? res.data.blocked : null;
    if (!remote) return local;
    const seen = new Set(local.map((b) => String(b.username ?? '').toLowerCase()));
    let changed = false;
    const next = [...local];
    for (const u of remote) {
      const name = String(u ?? '').trim();
      if (name && !seen.has(name.toLowerCase())) {
        next.push({ username: name, at: Date.now() } as unknown as T);
        seen.add(name.toLowerCase());
        changed = true;
      }
    }
    if (changed) {
      await AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
    }
    return next;
  } catch {
    return local;
  }
}

/** Lowercased blocked-username set, reloaded on every focus (block/unblock
 *  on another screen applies the moment you return — no stale grids). */
export function useBlockedSellers(): { blockedSet: Set<string>; reload: () => void } {
  const { user } = useAuth();
  const username = user?.username ?? null;
  const [blockedSet, setBlockedSet] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((value) => value + 1), []);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadBlockedUsernames(username).then((s) => {
        if (alive) setBlockedSet(s);
      });
      return () => {
        alive = false;
      };
    }, [username, reloadKey])
  );
  return { blockedSet, reload };
}
