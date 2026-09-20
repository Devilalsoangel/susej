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
 *  Server-side enforcement is still open (cross-device block needs an API);
 *  until then every listing surface hides blocked sellers locally. */
export async function loadBlockedUsernames(username: string | null): Promise<Set<string>> {
  try {
    const key = username ? `${BLOCKED_KEY_BASE}:${username}` : BLOCKED_KEY_BASE;
    let data = await AsyncStorage.getItem(key);
    if (!data && key !== BLOCKED_KEY_BASE) {
      data = await AsyncStorage.getItem(BLOCKED_KEY_BASE);
    }
    if (!data) return new Set();
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      (parsed as BlockedEntry[])
        .filter((b) => b && typeof b.username === 'string' && b.username)
        .map((b) => b.username.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

/** Lowercased blocked-username set, reloaded on every focus (block/unblock
 *  on another screen applies the moment you return — no stale grids). */
export function useBlockedSellers(): { blockedSet: Set<string> } {
  const { user } = useAuth();
  const username = user?.username ?? null;
  const [blockedSet, setBlockedSet] = useState<Set<string>>(new Set());
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      loadBlockedUsernames(username).then((s) => {
        if (alive) setBlockedSet(s);
      });
      return () => {
        alive = false;
      };
    }, [username])
  );
  return { blockedSet };
}
