import AsyncStorage from '@react-native-async-storage/async-storage';

export const AUTHENTICATED_SESSION_STORAGE_KEY =
  '@susej_authenticated_session';
export const LEGACY_SESSION_STORAGE_KEYS = ['app_tokens', 'app_user'] as const;

const SESSION_STORAGE_KEYS = [
  AUTHENTICATED_SESSION_STORAGE_KEY,
  ...LEGACY_SESSION_STORAGE_KEYS,
];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let mutationQueue: Promise<void> = Promise.resolve();
let sessionSnapshot: StoredAuthenticatedSession | null | undefined;

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  userId: number;
  expiresAt: number;
}

export interface AuthenticatedSession {
  user: any;
  session: StoredSession;
}

interface StoredAuthenticatedSession extends AuthenticatedSession {
  version: 1;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function isValidAccessToken(value: unknown): value is string {
  return (
    value === 'mock-token' ||
    (typeof value === 'string' && value.startsWith('susej_'))
  );
}

function parseStoredSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    !isValidAccessToken(record.accessToken) ||
    typeof record.refreshToken !== 'string' ||
    typeof record.userId !== 'number' ||
    !Number.isFinite(record.userId) ||
    typeof record.expiresAt !== 'number' ||
    !Number.isFinite(record.expiresAt)
  ) {
    return null;
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    userId: record.userId,
    expiresAt: record.expiresAt,
  };
}

function parseStoredUser(value: unknown): any | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const username = (value as Record<string, unknown>).username;
  return typeof username === 'string' && username.trim() ? value : null;
}

function parseStoredEnvelope(raw: string): StoredAuthenticatedSession | null {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || value.version !== 1) return null;
  const session = parseStoredSession(value.session);
  const user = parseStoredUser(value.user);
  return session && user ? { version: 1, user, session } : null;
}

function isExpired(session: StoredSession): boolean {
  return session.expiresAt <= Date.now();
}

function sameUser(left: any, right: any): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sameAuthenticatedSession(
  left: AuthenticatedSession | null,
  right: AuthenticatedSession | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.session.accessToken === right.session.accessToken &&
    left.session.refreshToken === right.session.refreshToken &&
    left.session.userId === right.session.userId &&
    left.session.expiresAt === right.session.expiresAt &&
    sameUser(left.user, right.user)
  );
}

async function verifyRemoved(keys: readonly string[]): Promise<void> {
  const remaining = await Promise.all(keys.map((key) => AsyncStorage.getItem(key)));
  if (remaining.some((value) => value !== null)) {
    throw new Error('Session storage clear was not persisted');
  }
}

async function removeAllSessionKeys(): Promise<void> {
  await AsyncStorage.multiRemove([...SESSION_STORAGE_KEYS]);
  await verifyRemoved(SESSION_STORAGE_KEYS);
}

async function removeLegacySessionKeys(): Promise<void> {
  await AsyncStorage.multiRemove([...LEGACY_SESSION_STORAGE_KEYS]);
  await verifyRemoved(LEGACY_SESSION_STORAGE_KEYS);
}

async function clearSessionNow(): Promise<void> {
  sessionSnapshot = null;
  await removeAllSessionKeys();
}

async function persistEnvelope(
  envelope: StoredAuthenticatedSession
): Promise<void> {
  const serialized = JSON.stringify(envelope);
  await AsyncStorage.setItem(AUTHENTICATED_SESSION_STORAGE_KEY, serialized);
  const persisted = await AsyncStorage.getItem(AUTHENTICATED_SESSION_STORAGE_KEY);
  if (persisted !== serialized) {
    throw new Error('Authenticated session write was not persisted');
  }
  sessionSnapshot = envelope;
}

async function readEnvelopeFromDisk(): Promise<StoredAuthenticatedSession | null> {
  const stored = await AsyncStorage.getItem(AUTHENTICATED_SESSION_STORAGE_KEY);
  if (stored !== null) {
    let envelope: StoredAuthenticatedSession | null = null;
    try {
      envelope = parseStoredEnvelope(stored);
    } catch {}
    if (!envelope || isExpired(envelope.session)) {
      await clearSessionNow();
      return null;
    }
    sessionSnapshot = envelope;
    try {
      await removeLegacySessionKeys();
    } catch {}
    return envelope;
  }

  const [legacyTokens, legacyUser] = await Promise.all([
    AsyncStorage.getItem('app_tokens'),
    AsyncStorage.getItem('app_user'),
  ]);
  if (legacyTokens === null) {
    if (legacyUser !== null) await clearSessionNow();
    return null;
  }

  let session: StoredSession | null = null;
  let user: any | null = null;
  try {
    session = parseStoredSession(JSON.parse(legacyTokens));
  } catch {}
  try {
    user = parseStoredUser(JSON.parse(legacyUser ?? ''));
  } catch {}
  if (!session || !user || isExpired(session)) {
    await clearSessionNow();
    return null;
  }

  const envelope: StoredAuthenticatedSession = { version: 1, user, session };
  await persistEnvelope(envelope);
  try {
    await removeLegacySessionKeys();
  } catch {}
  return envelope;
}

async function readAuthenticatedSession(): Promise<StoredAuthenticatedSession | null> {
  if (sessionSnapshot !== undefined) {
    if (sessionSnapshot && isExpired(sessionSnapshot.session)) {
      await clearSessionNow();
      return null;
    }
    return sessionSnapshot;
  }
  const envelope = await readEnvelopeFromDisk();
  sessionSnapshot = envelope;
  return envelope;
}

async function restoreAuthenticatedSession(
  previous: AuthenticatedSession | null,
  attemptedToken: string
): Promise<boolean> {
  const current = await readEnvelopeFromDisk();
  if (current?.session.accessToken !== attemptedToken) return false;
  if (previous) {
    await persistEnvelope({ version: 1, ...previous });
  } else {
    await clearSessionNow();
  }
  return true;
}

async function replaceAuthenticatedSession(
  user: any,
  accessToken: string,
  userId: number,
  refreshToken: string,
  expectedCurrent: AuthenticatedSession | null,
  shouldCommit: () => boolean
): Promise<boolean> {
  const storedUser = parseStoredUser(user);
  if (!storedUser) throw new Error('Authenticated session requires a valid user');
  if (!isValidAccessToken(accessToken)) {
    throw new Error('Authenticated session requires a valid access token');
  }

  const current = await readAuthenticatedSession();
  if (!sameAuthenticatedSession(current, expectedCurrent)) return false;
  if (!shouldCommit()) return false;

  const next: StoredAuthenticatedSession = {
    version: 1,
    user: storedUser,
    session: {
      accessToken,
      refreshToken,
      userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    },
  };

  try {
    const serialized = JSON.stringify(next);
    await AsyncStorage.setItem(AUTHENTICATED_SESSION_STORAGE_KEY, serialized);
    const persisted = await AsyncStorage.getItem(AUTHENTICATED_SESSION_STORAGE_KEY);
    if (persisted !== serialized) {
      throw new Error('Authenticated session write was not persisted');
    }
    if (!shouldCommit()) {
      await restoreAuthenticatedSession(expectedCurrent, accessToken);
      return false;
    }
    sessionSnapshot = next;
    return true;
  } catch (error) {
    try {
      await restoreAuthenticatedSession(expectedCurrent, accessToken);
    } catch {}
    throw error;
  }
}

export const sessionStorage = {
  async saveSession(
    tokens: { accessToken: string; refreshToken: string },
    userId: number
  ): Promise<void> {
    return enqueue(async () => {
      const current = await readAuthenticatedSession();
      if (!current) throw new Error('Authenticated session requires a stored user');
      await replaceAuthenticatedSession(
        current.user,
        tokens.accessToken,
        userId,
        tokens.refreshToken,
        current,
        () => true
      );
    });
  },

  async getSession(): Promise<StoredSession | null> {
    return enqueue(async () => {
      const current = await readAuthenticatedSession();
      return current ? { ...current.session } : null;
    });
  },

  async clearSession(): Promise<void> {
    return enqueue(async () => {
      sessionSnapshot = null;
      await removeAllSessionKeys();
    });
  },

  async saveUser(user: any): Promise<void> {
    return enqueue(async () => {
      const current = await readAuthenticatedSession();
      if (!current) throw new Error('Authenticated session requires a stored session');
      const nextUser = parseStoredUser(user);
      if (!nextUser) throw new Error('Stored user requires a username');
      try {
        await persistEnvelope({ version: 1, user: nextUser, session: current.session });
      } catch (error) {
        sessionSnapshot = { version: 1, user: current.user, session: current.session };
        throw error;
      }
    });
  },

  async getUser(): Promise<any> {
    return enqueue(async () => {
      const current = await readAuthenticatedSession();
      return current ? current.user : null;
    });
  },

  async getAuthenticatedSession(): Promise<AuthenticatedSession | null> {
    return enqueue(async () => {
      const current = await readAuthenticatedSession();
      return current
        ? { user: current.user, session: { ...current.session } }
        : null;
    });
  },

  async commitAuthenticatedSession(
    user: any,
    accessToken: string,
    expectedCurrent: AuthenticatedSession | null,
    shouldCommit: () => boolean,
    userId = 0,
    refreshToken = ''
  ): Promise<boolean> {
    return enqueue(() =>
      replaceAuthenticatedSession(
        user,
        accessToken,
        userId,
        refreshToken,
        expectedCurrent,
        shouldCommit
      )
    );
  },

  async saveAuthenticatedSession(
    user: any,
    accessToken: string,
    userId = 0,
    refreshToken = ''
  ): Promise<void> {
    return enqueue(async () => {
      const current = await readAuthenticatedSession();
      const committed = await replaceAuthenticatedSession(
        user,
        accessToken,
        userId,
        refreshToken,
        current,
        () => true
      );
      if (!committed) throw new Error('Authenticated session changed during save');
    });
  },

  async clearSessionIfToken(token: string): Promise<boolean> {
    return enqueue(async () => {
      let matches = false;
      try {
        const current = await readAuthenticatedSession();
        if (!current || current.session.accessToken !== token) return false;
        matches = true;
        sessionSnapshot = null;
        await removeAllSessionKeys();
        return true;
      } finally {
        if (matches) sessionSnapshot = null;
      }
    });
  },
};
