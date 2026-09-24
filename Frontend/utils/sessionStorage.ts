/**
 * Secure session persistence using AsyncStorage
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKENS_KEY = 'app_tokens';
const USER_KEY = 'app_user';
let mutationQueue: Promise<void> = Promise.resolve();
let sessionSnapshot: StoredSession | null | undefined;
let userSnapshot: any;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  userId: number;
  expiresAt: number;
}

export const sessionStorage = {
  async saveSession(tokens: {accessToken: string; refreshToken: string}, userId: number): Promise<void> {
    return enqueue(async () => {
      try {
        const session: StoredSession = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userId,
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        };
        await AsyncStorage.setItem(TOKENS_KEY, JSON.stringify(session));
        sessionSnapshot = session;
      } catch (error) {
        console.error('Failed to save session:', error);
      }
    });
  },

  async getSession(): Promise<StoredSession | null> {
    if (sessionSnapshot !== undefined) {
      if (sessionSnapshot && sessionSnapshot.expiresAt < Date.now()) {
        await sessionStorage.clearSession();
        return null;
      }
      return sessionSnapshot;
    }
    try {
      const data = await AsyncStorage.getItem(TOKENS_KEY);
      if (!data) return null;
      const session = JSON.parse(data) as StoredSession;
      // Check expiration
      if (session.expiresAt < Date.now()) {
        await sessionStorage.clearSession();
        return null;
      }
      sessionSnapshot = session;
      return session;
    } catch (error) {
      console.error('Failed to get session:', error);
      return null;
    }
  },

  async clearSession(): Promise<void> {
    return enqueue(async () => {
      try {
        await AsyncStorage.multiRemove([TOKENS_KEY, USER_KEY]);
        sessionSnapshot = null;
        userSnapshot = null;
      } catch (error) {
        console.error('Failed to clear session:', error);
      }
    });
  },

  async saveUser(user: any): Promise<void> {
    return enqueue(async () => {
      try {
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
        userSnapshot = user;
      } catch (error) {
        console.error('Failed to save user:', error);
      }
    });
  },

  async saveAuthenticatedSession(user: any, accessToken: string, userId = 0): Promise<void> {
    return enqueue(async () => {
      const session: StoredSession = {
        accessToken,
        refreshToken: '',
        userId,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
       await AsyncStorage.multiSet([
         [USER_KEY, JSON.stringify(user)],
         [TOKENS_KEY, JSON.stringify(session)],
       ]);
       sessionSnapshot = session;
       userSnapshot = user;
    });
  },

  async clearSessionIfToken(token: string): Promise<boolean> {
    return enqueue(async () => {
      const data = await AsyncStorage.getItem(TOKENS_KEY);
      if (!data) return false;
      try {
        const session = JSON.parse(data) as StoredSession;
         if (session.accessToken !== token) return false;
         await AsyncStorage.multiRemove([TOKENS_KEY, USER_KEY]);
         sessionSnapshot = null;
         userSnapshot = null;
         return true;
      } catch {
        return false;
      }
    });
  },

  async getUser(): Promise<any> {
    if (userSnapshot !== undefined) return userSnapshot;
    try {
      const data = await AsyncStorage.getItem(USER_KEY);
      userSnapshot = data ? JSON.parse(data) : null;
      return userSnapshot;
    } catch (error) {
      console.error('Failed to get user:', error);
      return null;
    }
  },
};
