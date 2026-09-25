import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sessionStorage } from '../utils/sessionStorage';
import { serverApi, onSessionExpired } from '../utils/serverApi';

const PENDING_REVOKE_KEY = '@susej_pending_revoke';

const ONBOARDED_KEY = '@susej_has_onboarded';
const ONBOARDED_PREFIX = '@susej_has_onboarded:';
const FEED_WELCOME_KEY_BASE = '@susej_feed_welcome_seen';
const FEED_WELCOME_KEY = FEED_WELCOME_KEY_BASE;
const FEED_WELCOME_PREFIX = '@susej_feed_welcome_seen:';
const ONBOARDING_STEP_KEY_BASE = '@susej_onboarding_step';
const ONBOARDING_STEP_KEY = ONBOARDING_STEP_KEY_BASE;

function hasLegacyProfile(user: User): boolean {
  const name = user.name.trim();
  return Boolean(user.avatar || user.bio || user.location || user.interests?.length) ||
    (name.length > 0 && !/^User \d{4}$/.test(name));
}

export interface User {
  name: string;
  username: string;
  phone?: string;
  email?: string;
  avatar?: string;
  bio?: string;
  location?: string;
  interests?: string[];
  role?: 'buyer' | 'seller' | 'both';
  isSeller?: boolean;
  businessName?: string;
  category?: string;
  verification?: 'none' | 'pending' | 'approved' | 'rejected';
}

interface AuthContextType {
  user: User | null;
  isLoggedIn: boolean;
  isLoading: boolean;
  hasOnboarded: boolean;
  hasSeenFeedWelcome: boolean;
  onboardingStep: number;
  /** Bumps on every login/logout — contexts use it to refetch server data
   *  even when the new account has the SAME username (POV re-switch). */
  sessionSeq: number;
  /** Bumps AFTER the real susej_ token is persisted — safe trigger for
   *  authenticated fetches (sessionSeq can fire while token is still mock). */
  tokenSeq: number;
  login: (user: User, accessToken?: string, requestId?: number, migrateLegacy?: boolean) => Promise<boolean>;
  /** Real server login via OTP — falls back to local demo identity when offline.
   *  opts.create:true = explicit signup (signup screens only); sign-in omits
   *  it so unknown numbers get needsSignup instead of a ghost account. */
  serverLogin: (phone: string, code: string, opts?: { create?: boolean }) => Promise<{ ok: boolean; offline?: boolean; needsSignup?: boolean; attemptsLeft?: number; error?: string }>;
  serverEmailLogin: (action: 'login' | 'register', email: string, password: string, name?: string) => Promise<{ ok: boolean; offline?: boolean; error?: string }>;
  serverGoogleLogin: (idToken: string, devBypass?: { email: string; name?: string }) => Promise<{ ok: boolean; offline?: boolean; error?: string }>;
  logout: () => Promise<void>;
  /**
   * Industry-standard logout (Instagram/WhatsApp): await the FULL wipe
   * (server revoke with offline retry, disk, memory, per-user cache sweep).
   * NO navigation call — the root navigator swaps the whole tree on the
   * isLoggedIn flip, so there is no transition to race and no history for
   * back to walk. expired=true raises the session-expired notice on login.
   */
  logoutAndReset: (expired?: boolean) => Promise<void>;
  /** True after a 401 session-death until the next keystroke/success. */
  expiredNotice: boolean;
  clearExpiredNotice: () => void;
  setOnboardingStep: (step: number) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  setHasSeenFeedWelcome: () => Promise<void>;
  // Returns true when saved (or optimistically kept through a transport
  // blip, which reconciles on next login). Returns the SERVER's rejection
  // reason string on validation failure so screens show the truth instead
  // of a generic line — industry standard: errors name the cause.
  updateUser: (patch: Partial<User>) => Promise<true | string>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasOnboarded, setHasOnboarded] = useState(false);
  const [hasSeenFeedWelcome, setHasSeenFeedWelcomeState] = useState(false);
  const [onboardingStep, setOnboardingStepState] = useState(1);
  const [sessionSeq, setSessionSeq] = useState(0);
  const [tokenSeq, setTokenSeq] = useState(0);
  // Raised on 401 session-death; login shows it until keystroke/success.
  const [expiredNotice, setExpiredNotice] = useState(false);
  const authTransitionRef = useRef<Promise<void> | null>(null);
  const authEpochRef = useRef(0);
  const loginRequestRef = useRef(0);
  const loginGraceUntilRef = useRef(0);
  const clearExpiredNotice = useCallback(() => setExpiredNotice(false), []);
  const waitForAuthTransition = useCallback(async () => {
    const pending = authTransitionRef.current;
    if (pending) await pending;
  }, []);

  useEffect(() => {
    let active = true;
    let storedUser: User | null = null;
    (async () => {
      try {
        const [userRecord, session] = await Promise.all([
          sessionStorage.getUser(),
          sessionStorage.getSession(),
        ]);
        if (!active) return;
        if (userRecord && session) {
          storedUser = userRecord as User;
          setUser(storedUser);
          setIsLoggedIn(true);
          const username = storedUser.username.trim();
          const [perUser, legacyOnboarded, welcomePerUser, legacyWelcome] = await Promise.all([
            AsyncStorage.getItem(ONBOARDED_PREFIX + username),
            AsyncStorage.getItem(ONBOARDED_KEY),
            AsyncStorage.getItem(FEED_WELCOME_PREFIX + username),
            AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
          ]);
          if (!active) return;
          const nextHasOnboarded = perUser === 'true' || (perUser === null && legacyOnboarded === 'true');
          const nextHasSeenWelcome = welcomePerUser === 'true' || (welcomePerUser === null && legacyWelcome === 'true');
          if (perUser === null && legacyOnboarded === 'true') {
            await AsyncStorage.setItem(ONBOARDED_PREFIX + username, 'true').catch(() => {});
            await AsyncStorage.removeItem(ONBOARDED_KEY).catch(() => {});
          }
          if (welcomePerUser === null && legacyWelcome === 'true') {
            await AsyncStorage.setItem(FEED_WELCOME_PREFIX + username, 'true').catch(() => {});
            await AsyncStorage.removeItem(FEED_WELCOME_KEY_BASE).catch(() => {});
          }
          setHasOnboarded(nextHasOnboarded);
          setHasSeenFeedWelcomeState(nextHasSeenWelcome);
        } else if (userRecord) {
          const username = String((userRecord as User).username ?? '').trim();
          const [perUser, legacyOnboarded, welcomePerUser, legacyWelcome] = await Promise.all([
            AsyncStorage.getItem(ONBOARDED_PREFIX + username),
            AsyncStorage.getItem(ONBOARDED_KEY),
            AsyncStorage.getItem(FEED_WELCOME_PREFIX + username),
            AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
          ]);
          if (!active) return;
          const nextHasOnboarded = perUser === 'true' || (perUser === null && legacyOnboarded === 'true');
          const nextHasSeenWelcome = welcomePerUser === 'true' || (welcomePerUser === null && legacyWelcome === 'true');
          if (perUser === null && legacyOnboarded === 'true') {
            await AsyncStorage.setItem(ONBOARDED_PREFIX + username, 'true').catch(() => {});
            await AsyncStorage.removeItem(ONBOARDED_KEY).catch(() => {});
          }
          if (welcomePerUser === null && legacyWelcome === 'true') {
            await AsyncStorage.setItem(FEED_WELCOME_PREFIX + username, 'true').catch(() => {});
            await AsyncStorage.removeItem(FEED_WELCOME_KEY_BASE).catch(() => {});
          }
          setHasOnboarded(nextHasOnboarded);
          setHasSeenFeedWelcomeState(nextHasSeenWelcome);
        } else {
          const [global, welcome] = await Promise.all([
            AsyncStorage.getItem(ONBOARDED_KEY),
            AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
          ]);
          if (!active) return;
          setHasOnboarded(global === 'true');
          setHasSeenFeedWelcomeState(welcome === 'true');
        }
      } catch {
        if (active) {
          setHasOnboarded(false);
          setHasSeenFeedWelcomeState(false);
        }
      }
      try {
        const uForStep = storedUser?.username ?? null;
        const stepKey = uForStep ? `${ONBOARDING_STEP_KEY_BASE}:${uForStep}` : ONBOARDING_STEP_KEY_BASE;
        const legacyStepKey = ONBOARDING_STEP_KEY_BASE;
        const [step, legacyStep] = await Promise.all([
          AsyncStorage.getItem(stepKey),
          stepKey !== legacyStepKey ? AsyncStorage.getItem(legacyStepKey) : Promise.resolve(null),
        ]);
        if (!active) return;
        let rawStep: string | null = step;
        if (rawStep === null && legacyStep !== null) {
          rawStep = legacyStep;
          if (uForStep) await AsyncStorage.setItem(stepKey, legacyStep);
        }
        const parsedStep = rawStep ? parseInt(rawStep, 10) : 1;
        setOnboardingStepState(Number.isNaN(parsedStep) ? 1 : parsedStep);
      } catch {
        if (active) setOnboardingStepState(1);
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const login = useCallback(async (nextUser: User, accessToken = 'mock-token', requestId?: number, migrateLegacy = false) => {
    if (!nextUser?.username || String(nextUser.username).trim().length < 2) {
      throw new Error('login requires valid username');
    }
    const activeRequestId = requestId ?? ++loginRequestRef.current;
    if (accessToken === 'mock-token') {
      await sessionStorage.saveUser(nextUser);
      await sessionStorage.saveSession({ accessToken, refreshToken: 'mock-refresh' }, 1);
    } else {
      await sessionStorage.saveAuthenticatedSession(nextUser, accessToken);
    }
    const abandonIfStale = async () => {
      if (activeRequestId === loginRequestRef.current) return false;
      await sessionStorage.clearSessionIfToken(accessToken);
      return true;
    };
    if (await abandonIfStale()) return false;
    const perUser = await AsyncStorage.getItem(ONBOARDED_PREFIX + nextUser.username);
    let nextHasOnboarded = perUser === 'true';
    if (perUser === null && migrateLegacy) {
      const legacyOnboarded = await AsyncStorage.getItem(ONBOARDED_KEY);
      if (await abandonIfStale()) return false;
      nextHasOnboarded = legacyOnboarded === 'true';
      if (nextHasOnboarded) {
        await AsyncStorage.setItem(ONBOARDED_PREFIX + nextUser.username, 'true').catch(() => {});
        if (await abandonIfStale()) return false;
      }
    }
    const wPer = await AsyncStorage.getItem(FEED_WELCOME_PREFIX + nextUser.username);
    let nextHasSeenFeedWelcome = wPer === 'true';
    if (wPer === null && migrateLegacy) {
      const legacyWelcome = await AsyncStorage.getItem(FEED_WELCOME_KEY_BASE);
      if (await abandonIfStale()) return false;
      nextHasSeenFeedWelcome = legacyWelcome === 'true';
      if (nextHasSeenFeedWelcome) {
        await AsyncStorage.setItem(FEED_WELCOME_PREFIX + nextUser.username, 'true').catch(() => {});
        if (await abandonIfStale()) return false;
      }
    }
    if (await abandonIfStale()) return false;
    setHasOnboarded(nextHasOnboarded);
    setHasSeenFeedWelcomeState(nextHasSeenFeedWelcome);
    setUser(nextUser);
    setIsLoggedIn(true);
    setExpiredNotice(false);
    if (accessToken.startsWith('susej_')) loginGraceUntilRef.current = Date.now() + 15000;
    setSessionSeq((n) => n + 1);
    return true;
  }, []);

  // Identity-bound state must never render as another account's truth when
  // the server sync lags or fails (wallet lesson Aug 22; cart/draft/saves
  // family found during the Aug 26 tester walk). Called on logout AND on any
  // identity switch. Per-account keyed storage (@key:<username>) is NOT
  // listed here - it cannot leak across accounts by construction.
  const clearMoneyCache = useCallback(async () => {
    const bases = [
      '@susej_wallet', // WALLET_KEY (utils/walletStore) - kept literal to avoid an import cycle
      '@susej_withdrawals',
      '@susej_cart',
      '@susej_orders',
      '@susej_addresses',
      '@susej_selected_address',
      '@susej_shop_profile',
      '@susej_bookmarked_products',
      '@susej_saved_collections',
      '@susej_saved_for_later',
      '@susej_liked_posts',
      '@susej_hidden_posts',
      '@susej_muted_sellers',
      '@susej_deleted_post_ids',
      '@susej_followed_sellers',
      '@susej_recently_viewed',
      '@susej_recent_searches',
      '@susej_saved_searches',
      '@susej_notifications',
      '@susej_my_story',
      '@susej_my_reels',
      '@susej_tickets',
      '@susej_disputes',
      '@susej_referrals',
      '@susej_loyalty',
      '@susej_applied_promo',
      '@susej_redeemed_coupons',
      '@susej_blocked',
      '@susej_chat_unread',
      '@susej_chat_thread_messages',
      '@susej_community_polls',
      '@susej_reports',
      '@susej_broadcast_joined',
      '@susej_broadcast_posts',
      '@susej_payment',
      '@susej_feed_posts', // legacy global feed cache — now per-user, must not leak
      '@susej_promotions', // legacy global promotions cache
      '@susej_communities',
      '@susej_community_messages',
      '@susej_followed_hashtags',
      '@susej_settings',
    ];
    await AsyncStorage.multiRemove(bases);
  }, []);

  // Identity reconciliation: once the real token is on disk, pull the
  // authoritative /users/me row and replace the stored snapshot. This heals
  // any partial/stale login payload (older server build, KYC verdict racing
  // the verify response) so isSeller/businessName/verification always reflect
  // server truth - role-based nav reads user.isSeller directly. Silent on
  // failure: the verify payload already stored stays authoritative offline.
  const reconcileIdentity = useCallback(async (expectedToken?: string) => {
    const me = await serverApi.getMe();
    if (!me.ok || !me.data?.user) return;
    // Apply only if the session that requested this refresh is still current
    // (a logout or account switch must never resurrect stale identity).
    const session = await sessionStorage.getSession();
    if (!session?.accessToken.startsWith('susej_')) return;
    if (expectedToken && session.accessToken !== expectedToken) return;
    setUser(me.data.user as unknown as User);
    await sessionStorage.saveUser(me.data.user);
  }, []);

  const serverLogin = useCallback(
    async (phone: string, code: string, opts?: { create?: boolean }): Promise<{ ok: boolean; error?: string; needsSignup?: boolean; attemptsLeft?: number; offline?: boolean }> => {
      await waitForAuthTransition();
      const epoch = authEpochRef.current;
      const requestId = ++loginRequestRef.current;
      const digits = phone.replace(/\D/g, '');
      // 1. Try the real server first - logs in a REAL user row, or (signup
      //    screens only) creates one with explicit consent. Sign-in typos get
      //    404 needsSignup, never a ghost account.
      const res = await serverApi.verifyOtp(digits, code, opts?.create);
      if (epoch !== authEpochRef.current || requestId !== loginRequestRef.current) return { ok: false, error: 'Account changed. Please try again.' };
      if (res.ok && res.data?.token) {
        // Identity is about to change - drop the outgoing account's cached
        // money state so it can never flash as the new account's truth.
         // Guarded: a storage throw here must never break the login handoff.
          await clearMoneyCache().catch(() => {});
          if (epoch !== authEpochRef.current || requestId !== loginRequestRef.current) return { ok: false, error: 'Account changed. Please try again.' };
          const migrateLegacy = !opts?.create && hasLegacyProfile(res.data.user as unknown as User);
          const loggedIn = await login(res.data.user as unknown as User, res.data.token, requestId, migrateLegacy);
         if (!loggedIn) return { ok: false, error: 'Account changed. Please try again.' };
        // Retry a revoke left pending by an offline logout: that old Bearer
        // is still live server-side until this kills it (new session proves
        // connectivity, so the retry is meaningful now).
        try {
          const pending = await AsyncStorage.getItem(PENDING_REVOKE_KEY);
           if (pending && pending !== res.data.token) {
             const revoked = await serverApi.revokeSession(false, pending).catch(() => ({ ok: false, data: null, error: 'server-unreachable' }));
             if (revoked.ok) await AsyncStorage.removeItem(PENDING_REVOKE_KEY).catch(() => {});
             else await AsyncStorage.setItem(PENDING_REVOKE_KEY, pending).catch(() => {});
           } else if (pending === res.data.token) {
             await AsyncStorage.removeItem(PENDING_REVOKE_KEY).catch(() => {});
           }
        } catch {}
        // Signal contexts AFTER the real token is on disk so their refetch
        // actually authenticates.
         setTokenSeq((n) => n + 1);
         return { ok: true };
      }
      // 2. Server reachable but rejected -> surface the reason (wrong code,
      //    expired, throttled, unknown-number needsSignup). Only a network
      //    failure is reported as offline.
      if (res.error && res.error !== 'offline') {
        return { ok: false, error: res.error, ...(res.needsSignup ? { needsSignup: true } : {}), ...(typeof res.attemptsLeft === 'number' ? { attemptsLeft: res.attemptsLeft } : {}) };
      }
      // 3. Offline fallback: NO local identity exists for an unknown number -
      //    sign-in simply fails honestly until connectivity returns.
      return { ok: false, offline: true };
    },
    [login, clearMoneyCache, reconcileIdentity, waitForAuthTransition]
  );

  const serverEmailLogin = useCallback(
    async (action: 'login' | 'register', email: string, password: string, name?: string) => {
      await waitForAuthTransition();
      const epoch = authEpochRef.current;
      const requestId = ++loginRequestRef.current;
      const res = await serverApi.emailAuth(action, email.trim().toLowerCase(), password, name);
      if (epoch !== authEpochRef.current || requestId !== loginRequestRef.current) return { ok: false, error: 'Account changed. Please try again.' };
      if (res.ok && res.data?.token) {
         await clearMoneyCache();
         if (epoch !== authEpochRef.current || requestId !== loginRequestRef.current) return { ok: false, error: 'Account changed. Please try again.' };
         const migrateLegacy = action === 'login' && hasLegacyProfile(res.data.user as unknown as User);
         const loggedIn = await login(res.data.user as unknown as User, res.data.token, requestId, migrateLegacy);
         if (!loggedIn) return { ok: false, error: 'Account changed. Please try again.' };
         setTokenSeq((n) => n + 1);
         return { ok: true };
      }
      if (res.error && res.error !== 'offline') return { ok: false, error: res.error };
      return { ok: false, offline: true };
    },
    [login, clearMoneyCache, reconcileIdentity, waitForAuthTransition]
  );

  const serverGoogleLogin = useCallback(
    async (idToken: string, devBypass?: { email: string; name?: string }) => {
      await waitForAuthTransition();
      const epoch = authEpochRef.current;
      const requestId = ++loginRequestRef.current;
      const res = await serverApi.googleAuth(idToken, devBypass);
      if (epoch !== authEpochRef.current || requestId !== loginRequestRef.current) return { ok: false, error: 'Account changed. Please try again.' };
      if (res.ok && res.data?.token) {
         await clearMoneyCache();
         if (epoch !== authEpochRef.current || requestId !== loginRequestRef.current) return { ok: false, error: 'Account changed. Please try again.' };
         const migrateLegacy = !devBypass && hasLegacyProfile(res.data.user as unknown as User);
         const loggedIn = await login(res.data.user as unknown as User, res.data.token, requestId, migrateLegacy);
         if (!loggedIn) return { ok: false, error: 'Account changed. Please try again.' };
         setTokenSeq((n) => n + 1);
         return { ok: true };
      }
      if (res.error && res.error !== 'offline') return { ok: false, error: res.error };
      return { ok: false, offline: true };
    },
    [login, clearMoneyCache, reconcileIdentity, waitForAuthTransition]
  );

  const logout = useCallback(async () => {
    const existing = authTransitionRef.current;
    if (existing) return existing;

    const run = (async () => {
      authEpochRef.current += 1;
      loginRequestRef.current += 1;
      loginGraceUntilRef.current = 0;
      const session = await sessionStorage.getSession().catch(() => null);
      const token = session?.accessToken && session.accessToken.startsWith('susej_') ? session.accessToken : null;

      setUser(null);
      setIsLoggedIn(false);
      setHasOnboarded(false);
      setSessionSeq((n) => n + 1);
      setTokenSeq((n) => n + 1);
      await sessionStorage.clearSession();
      await AsyncStorage.removeItem(ONBOARDED_KEY).catch(() => {});
      await AsyncStorage.multiRemove([ONBOARDING_STEP_KEY_BASE, FEED_WELCOME_KEY_BASE]).catch(() => {});

      if (token) {
        try {
          const revoked = await serverApi.revokeSession(false, token);
          if (!revoked.ok) await AsyncStorage.setItem(PENDING_REVOKE_KEY, token).catch(() => {});
        } catch {
          await AsyncStorage.setItem(PENDING_REVOKE_KEY, token).catch(() => {});
        }
      }

      await clearMoneyCache().catch(() => {});
    })();

    authTransitionRef.current = run;
    try {
      await run;
    } finally {
      if (authTransitionRef.current === run) authTransitionRef.current = null;
    }
  }, [clearMoneyCache]);

  /**
   * Full logout (see type docs). Wipe ONLY — the root navigator swaps the
   * whole tree the moment isLoggedIn flips, so no navigation call exists to
   * race, corrupt, or blue-screen. Re-entry safe: a second concurrent call
   * simply re-runs an idempotent wipe.
   */
  const logoutAndReset = useCallback(async (expired = false) => {
    if (expired) setExpiredNotice(true);
    await logout();
  }, [logout]);

  const setOnboardingStep = useCallback(async (step: number) => {
    setOnboardingStepState(step);
    const u = (await sessionStorage.getUser())?.username?.trim();
    const key = u ? `${ONBOARDING_STEP_KEY_BASE}:${u}` : ONBOARDING_STEP_KEY_BASE;
    await AsyncStorage.setItem(key, String(step)).catch(() => {});
    // No global mirror: it leaked the step into the next account's login
    // migration. Logged-out reads fall back to step 1, which is correct.
  }, []);

  const completeOnboarding = useCallback(async () => {
    // Bookkeeping must NEVER break login: a storage throw here used to land
    // the user on a permanent "Signing you in…" overlay with the session
    // saved but the handoff dead.
    setHasOnboarded(true);
    try {
      const u = await sessionStorage.getUser();
      if (u?.username) {
        await AsyncStorage.setItem(ONBOARDED_PREFIX + u.username, 'true');
      }
    } catch {}
    // No global write: it fed the next account's login migration
    // (cross-account completion leak). Legacy global residue is read only
    // for a profile-gated migration and is never removed during login.
  }, []);

  const setHasSeenFeedWelcome = useCallback(async () => {
    setHasSeenFeedWelcomeState(true);
    // Storage guarded like completeOnboarding: bookkeeping never breaks flow.
    try {
      const u = await sessionStorage.getUser();
      const key = u?.username ? FEED_WELCOME_PREFIX + u.username : FEED_WELCOME_KEY_BASE;
      await AsyncStorage.setItem(key, 'true');
    } catch {}
    // No global mirror: same cross-account leak class as the onboarding step.
  }, []);

  const updateUser = useCallback(
    async (patch: Partial<User>): Promise<true | string> => {
      const epoch = authEpochRef.current;
      const prevUser = user;
      const nextUser = { ...(prevUser ?? ({} as User)), ...patch };
      setUser(nextUser);
      const session = await sessionStorage.getSession();
      const accessToken = session?.accessToken?.startsWith('susej_') ? session.accessToken : null;
      if (!accessToken) {
        if (epoch === authEpochRef.current) await sessionStorage.saveUser(nextUser);
        return true;
      }
      try {
        const { phone: _phone, username: _username, verification: _verification, ...serverPatch } =
          patch as Record<string, unknown>;
        if (!Object.keys(serverPatch).length) {
          if (epoch === authEpochRef.current) await sessionStorage.saveUser(nextUser);
          return true;
        }
        const res = await serverApi.updateProfile(serverPatch, accessToken);
        if (epoch !== authEpochRef.current) return true;
        if (!res.ok) {
          if (res.error === 'offline' || res.error === 'server-unreachable') {
            await sessionStorage.saveUser(nextUser);
            return true;
          }
          setUser(prevUser ?? null);
          if (prevUser) await sessionStorage.saveUser(prevUser);
          return typeof res.error === 'string' && res.error
            ? res.error
            : 'Something went wrong. Please try again.';
        }
        const savedUser = (res.data?.user ?? nextUser) as unknown as User;
        setUser(savedUser);
        await sessionStorage.saveUser(savedUser);
        return true;
      } catch {
        if (epoch !== authEpochRef.current) return true;
        setUser(prevUser ?? null);
        if (prevUser) await sessionStorage.saveUser(prevUser);
        return 'Something went wrong. Please try again.';
      }
    },
    [user]
  );

  // Dead-Bearer kill-switch: any non-auth lane proving a 401 means the token
  // is revoked/rotated server-side. Wipe + raise the notice; the root
  // navigator swaps trees on the flip — no navigation call, nothing to race.
  useEffect(() => {
    onSessionExpired(async (token) => {
      if (Date.now() < loginGraceUntilRef.current) return;
      const session = await sessionStorage.getSession().catch(() => null);
      if (!session || session.accessToken !== token) return;
      const requestId = loginRequestRef.current;
      const epoch = authEpochRef.current;
      const cleared = await sessionStorage.clearSessionIfToken(token);
      if (!cleared) return;
      const current = await sessionStorage.getSession().catch(() => null);
      if (requestId !== loginRequestRef.current || epoch !== authEpochRef.current) return;
      if (current && current.accessToken !== token) return;
      authEpochRef.current += 1;
      loginRequestRef.current += 1;
      setExpiredNotice(true);
      setUser(null);
      setIsLoggedIn(false);
      setSessionSeq((n) => n + 1);
      setTokenSeq((n) => n + 1);
      await clearMoneyCache().catch(() => {});
    });
  }, [clearMoneyCache]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoggedIn,
        isLoading,
        hasOnboarded,
        hasSeenFeedWelcome,
        onboardingStep,
        sessionSeq,
        tokenSeq,
        login,
        serverLogin,
    serverEmailLogin,
    serverGoogleLogin,
        logout,
        logoutAndReset,
        expiredNotice,
        clearExpiredNotice,
        setOnboardingStep,
        completeOnboarding,
        setHasSeenFeedWelcome,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
