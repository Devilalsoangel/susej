import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sessionStorage } from '../utils/sessionStorage';
import { serverApi, onSessionMissing } from '../utils/serverApi';
import { trace } from '../utils/trace';

const PENDING_REVOKE_KEY = '@susej_pending_revoke';
const ONBOARDED_KEY = '@susej_has_onboarded';
const ONBOARDED_PREFIX = '@susej_has_onboarded:';
const FEED_WELCOME_KEY_BASE = '@susej_feed_welcome_seen';
const FEED_WELCOME_PREFIX = '@susej_feed_welcome_seen:';
const ONBOARDING_STEP_KEY_BASE = '@susej_onboarding_step';
const STALE_AUTH_ERROR = 'Your session changed. Please try again.';
const STORAGE_ERROR = 'Your session could not be saved. Please try again.';

export type AuthIntent = 'login' | 'signup';
type AuthMode = AuthIntent;

/**
 * Where a signed-out user belongs. 'welcome' is the first-ever guest (the
 * signup carousel), 'login' is anyone whose session just ended - logout,
 * switch account, or server-side expiry. Those are different intents: a
 * returning user must land on the sign-in form with the expiry notice, never
 * on "Get Started" as if they had never seen the app.
 */
export type GuestLanding = 'welcome' | 'login';
type LegacyServerLoginOptions = { create?: boolean };
type ServerLoginOptions = { intent: AuthIntent; create?: boolean };

type AuthResult = {
  ok: boolean;
  offline?: boolean;
  needsSignup?: boolean;
  attemptsLeft?: number;
  accountExists?: boolean;
  error?: string;
  mode?: AuthMode;
  created?: boolean;
  setupRequired?: boolean;
  authCode?: string;
  code?: string;
};

type ServerLogin = {
  (phone: string, code: string, opts: ServerLoginOptions): Promise<AuthResult>;
  (
    phone: string,
    code: string,
    opts?: LegacyServerLoginOptions
  ): Promise<AuthResult>;
};

type AuthServerData = {
  token?: unknown;
  user?: unknown;
  mode?: unknown;
  created?: unknown;
  setupRequired?: unknown;
  authCode?: unknown;
  code?: unknown;
};

type AuthApiResult = {
  ok: boolean;
  data: AuthServerData | null;
  error?: string;
  code?: string;
  needsSignup?: boolean;
  attemptsLeft?: number;
  accountExists?: boolean;
};

type CommitInput = {
  user: User;
  accessToken: string;
  epoch: number;
  requestId: number;
  migrateLegacy: boolean;
  mode: AuthMode;
  created: boolean;
  setupRequired: boolean;
  authCode?: string;
};

type CommitResult =
  | {
      ok: true;
      epoch: number;
      requestId: number;
      accessToken: string;
      mode: AuthMode;
      created: boolean;
      setupRequired: boolean;
      authCode?: string;
    }
  | { ok: false; error: string };

type LoginFlags = {
  hasOnboarded: boolean;
  hasSeenFeedWelcome: boolean;
  onboardingStep: number;
};

const CACHE_BASES = [
  '@susej_wallet',
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
  '@susej_feed_posts',
  '@susej_promotions',
  '@susej_communities',
  '@susej_community_messages',
  '@susej_followed_hashtags',
  '@susej_settings',
  '@susej_profile_settings',
  '@susej_auctions',
  '@susej_2fa_pref',
  '@susej_seller_applicants',
  '@susej_admin_verified',
  '@susej_admin_rejected',
  '@susej_mod_resolved',
  '@susej_home_rails_cache',
  '@susej_explore_meta',
  '@susej_store_categories',
  '@susej_store_location',
  '@susej_store_theme',
  '@susej_listing_draft',
  '@susej_seller_draft',
  '@susej_imageless_warned',
  '@susej_server_threads',
  '@susej_chat_threads',
];

const LEGACY_IDENTITY_KEYS = [
  '@susej_user',
  '@susej_current_user',
  '@susej_user_id',
  '@susej_username',
  '@susej_profile',
  '@susej_identity',
  '@susej_auth_user',
  '@susej_session_user',
  '@susej_user_cache',
  '@susej_user_settings',
  '@susej_welcome_seen',
  '@susej_onboarding',
];

function hasCompletedProfile(user: User): boolean {
  const name = user.name.trim();
  if (!name || /^User \d{4}$/.test(name)) return false;
  const avatar = typeof user.avatar === 'string' ? user.avatar.trim() : '';
  const bio = typeof user.bio === 'string' ? user.bio.trim() : '';
  const location = typeof user.location === 'string' ? user.location.trim() : '';
  const interests = Array.isArray(user.interests)
    ? user.interests.some(
        (interest) => typeof interest === 'string' && Boolean(interest.trim())
      )
    : false;
  return Boolean(avatar || bio || location || interests);
}

function toUser(value: unknown): User | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const username =
    typeof record.username === 'string' ? record.username.trim() : '';
  if (!username) return null;
  return {
    ...record,
    name: typeof record.name === 'string' ? record.name : username,
    username,
  } as unknown as User;
}

function clampOnboardingStep(value: unknown): 1 | 2 | 3 | 4 {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(4, Math.max(1, Math.trunc(parsed))) as 1 | 2 | 3 | 4;
}

function normalizeIntent(
  opts?: ServerLoginOptions | LegacyServerLoginOptions
): AuthIntent {
  if (
    opts &&
    'intent' in opts &&
    (opts.intent === 'login' || opts.intent === 'signup')
  ) {
    return opts.intent;
  }
  return opts && 'create' in opts && opts.create ? 'signup' : 'login';
}

function normalizeAuthData(
  value: unknown,
  fallbackMode: AuthMode = 'login',
  fallbackCreated = false
): {
  token: string;
  user: User;
  mode: AuthMode;
  created: boolean;
  setupRequired: boolean;
  authCode?: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const token = typeof record.token === 'string' ? record.token : '';
  const user = toUser(record.user);
  if (!token || !user) return null;
  const rawMode = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  if (rawMode && rawMode !== 'login' && rawMode !== 'signup') return null;
  const mode: AuthMode = rawMode === 'login' || rawMode === 'signup' ? rawMode : fallbackMode;
  const created =
    typeof record.created === 'boolean'
      ? record.created
      : rawMode
        ? mode === 'signup'
        : fallbackCreated || mode === 'signup';
  const setupRequired =
    typeof record.setupRequired === 'boolean'
      ? record.setupRequired
      : created || mode === 'signup';
  const authCode =
    typeof record.authCode === 'string' ? record.authCode : undefined;
  return { token, user, mode, created, setupRequired, authCode };
}

function responseCode(res: AuthApiResult): string | undefined {
  if (typeof res.code === 'string') return res.code;
  const data = res.data as Record<string, unknown> | null;
  return data && typeof data.code === 'string' ? data.code : undefined;
}

function authFailure(res: AuthApiResult): AuthResult {
  const code = responseCode(res);
  if (res.error && res.error !== 'offline') {
    return {
      ok: false,
      error: res.error,
      authCode: code,
      code,
      ...(res.needsSignup || code === 'SIGNUP_REQUIRED'
        ? { needsSignup: true }
        : {}),
      ...(typeof res.attemptsLeft === 'number'
        ? { attemptsLeft: res.attemptsLeft }
        : {}),
      ...(res.accountExists || code === 'ACCOUNT_EXISTS'
        ? { accountExists: true }
        : {}),
    };
  }
  return { ok: false, offline: true, authCode: code, code };
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
  sessionSeq: number;
  tokenSeq: number;
  login: (
    user: User,
    accessToken?: string,
    requestId?: number,
    migrateLegacy?: boolean
  ) => Promise<boolean>;
  serverLogin: ServerLogin;
  serverEmailLogin: (
    action: 'login' | 'register',
    email: string,
    password: string,
    name?: string
  ) => Promise<AuthResult>;
  serverGoogleLogin: (
    idToken: string,
    devBypass?: { email: string; name?: string }
  ) => Promise<AuthResult>;
  logout: () => Promise<void>;
  logoutAndReset: (expired?: boolean) => Promise<void>;
  cancelAuthAttempt: () => void;
  expiredNotice: boolean;
  clearExpiredNotice: () => void;
  guestLanding: GuestLanding;
  setGuestLanding: (landing: GuestLanding) => void;
  setOnboardingStep: (step: number) => Promise<boolean>;
  completeOnboarding: () => Promise<boolean>;
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
  const [expiredNotice, setExpiredNotice] = useState(false);
  const [guestLanding, setGuestLanding] = useState<GuestLanding>('welcome');
  const authTransitionRef = useRef<Promise<void> | null>(null);
  const authEpochRef = useRef(0);
  const loginRequestRef = useRef(0);
  const providerAliveRef = useRef(true);
  const userRef = useRef<User | null>(null);
  const isLoggedInRef = useRef(false);
  const authHandoffRef = useRef(false);
  const loginGraceUntilRef = useRef(0);
  const keepExpiredNoticeRef = useRef(false);
  const pendingRevokeRef = useRef<string[]>([]);
  const startupRevokeStartedRef = useRef(false);
  userRef.current = user;

  const clearExpiredNotice = useCallback(() => {
    keepExpiredNoticeRef.current = false;
    setExpiredNotice(false);
  }, []);

  const isAuthCurrent = useCallback(
    (epoch: number, requestId: number) =>
      providerAliveRef.current &&
      authEpochRef.current === epoch &&
      loginRequestRef.current === requestId,
    []
  );

  const waitForAuthTransition = useCallback(async () => {
    const pending = authTransitionRef.current;
    if (pending) await pending.catch(() => undefined);
  }, []);

  useEffect(() => {
    providerAliveRef.current = true;
    return () => {
      providerAliveRef.current = false;
    };
  }, []);

  /**
   * Adopt the server's copy of the current user.
   *
   * The stored session envelope is a CACHE, but it was treated as truth forever:
   * nothing ever re-read the user after login, so a stale local copy decided
   * everything. The visible symptom was a profile picture that the server had
   * saved but the app still demanded - "I selected it, pressed Continue, and it
   * asked me again" - because the local envelope never learned about it. The
   * same staleness hid a username claimed on another device.
   *
   * Fire-and-forget by design: the UI must never block on it, and a failed sync
   * simply leaves the cached copy in place.
   */
  const syncProfileFromServer = useCallback(async () => {
    try {
      const res = await serverApi.getMe();
      const remote = toUser((res as { data?: { user?: unknown } })?.data?.user);
      if (!remote) return;
      const current = userRef.current;
      if (
        current &&
        current.username === remote.username &&
        current.name === remote.name &&
        (current.avatar ?? '') === (remote.avatar ?? '') &&
        (current.bio ?? '') === (remote.bio ?? '') &&
        (current.location ?? '') === (remote.location ?? '')
      ) {
        return; // already current - no storage churn
      }
      await sessionStorage.saveUser(remote);
      userRef.current = remote;
      setUser(remote);
    } catch {
      // offline / server down: the cached identity stays usable
    }
  }, []);

  useEffect(() => {
    let active = true;
    const epoch = authEpochRef.current;
    const requestId = loginRequestRef.current;
    const canApply = () => {
      const current = active && isAuthCurrent(epoch, requestId);
      if (!current && active) setIsLoading(false);
      return current;
    };
    let restoredSession = false;
    let storedUser: User | null = null;
    (async () => {
      try {
        const [userRecord, session] = await Promise.all([
          sessionStorage.getUser(),
          sessionStorage.getSession(),
        ]);
        if (!canApply()) return;
        storedUser = toUser(userRecord);
        if (storedUser && session) {
          restoredSession = true;
          userRef.current = storedUser;
          isLoggedInRef.current = true;
          setUser(storedUser);
          setIsLoggedIn(true);
          const username = storedUser.username.trim();
          const [perUser, legacyOnboarded, welcomePerUser, legacyWelcome] =
            await Promise.all([
              AsyncStorage.getItem(ONBOARDED_PREFIX + username),
              AsyncStorage.getItem(ONBOARDED_KEY),
              AsyncStorage.getItem(FEED_WELCOME_PREFIX + username),
              AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
            ]);
          if (!canApply()) return;
          const completedProfile = hasCompletedProfile(storedUser);
          const nextHasOnboarded =
            perUser === 'true' ||
            (perUser === null &&
              (legacyOnboarded === 'true' || completedProfile));
          const nextHasSeenWelcome =
            welcomePerUser === 'true' ||
            (welcomePerUser === null && legacyWelcome === 'true');
          if (perUser === null && nextHasOnboarded) {
            try {
              await AsyncStorage.setItem(ONBOARDED_PREFIX + username, 'true');
            } catch {}
            if (!canApply()) return;
            if (legacyOnboarded === 'true') {
              try {
                await AsyncStorage.removeItem(ONBOARDED_KEY);
              } catch {}
              if (!canApply()) return;
            }
          }
          if (welcomePerUser === null && legacyWelcome === 'true') {
            try {
              await AsyncStorage.setItem(
                FEED_WELCOME_PREFIX + username,
                'true'
              );
            } catch {}
            if (!canApply()) return;
            try {
              await AsyncStorage.removeItem(FEED_WELCOME_KEY_BASE);
            } catch {}
            if (!canApply()) return;
          }
          setHasOnboarded(nextHasOnboarded);
          setHasSeenFeedWelcomeState(nextHasSeenWelcome);
          trace('auth boot (session restored)', {
            username,
            hasOnboarded: nextHasOnboarded,
            hasSeenFeedWelcome: nextHasSeenWelcome,
            perUserFlag: perUser,
            legacyFlag: legacyOnboarded,
            completedProfile: completedProfile,
          });
        } else if (storedUser) {
          const username = storedUser.username.trim();
          const [perUser, legacyOnboarded, welcomePerUser, legacyWelcome] =
            await Promise.all([
              AsyncStorage.getItem(ONBOARDED_PREFIX + username),
              AsyncStorage.getItem(ONBOARDED_KEY),
              AsyncStorage.getItem(FEED_WELCOME_PREFIX + username),
              AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
            ]);
          if (!canApply()) return;
          const completedProfile = hasCompletedProfile(storedUser);
          const nextHasOnboarded =
            perUser === 'true' ||
            (perUser === null &&
              (legacyOnboarded === 'true' || completedProfile));
          const nextHasSeenWelcome =
            welcomePerUser === 'true' ||
            (welcomePerUser === null && legacyWelcome === 'true');
          setHasOnboarded(nextHasOnboarded);
          setHasSeenFeedWelcomeState(nextHasSeenWelcome);
        } else {
          const [global, welcome] = await Promise.all([
            AsyncStorage.getItem(ONBOARDED_KEY),
            AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
          ]);
          if (!canApply()) return;
          setHasOnboarded(global === 'true');
          setHasSeenFeedWelcomeState(welcome === 'true');
        }
      } catch {
        if (canApply()) {
          setHasOnboarded(false);
          setHasSeenFeedWelcomeState(false);
        }
      }
      try {
        const uForStep = storedUser?.username ?? null;
        const stepKey = uForStep
          ? `${ONBOARDING_STEP_KEY_BASE}:${uForStep}`
          : ONBOARDING_STEP_KEY_BASE;
        const legacyStepKey = ONBOARDING_STEP_KEY_BASE;
        const [step, legacyStep] = await Promise.all([
          AsyncStorage.getItem(stepKey),
          stepKey !== legacyStepKey
            ? AsyncStorage.getItem(legacyStepKey)
            : Promise.resolve(null),
        ]);
        if (!canApply()) return;
        let rawStep: string | null = step;
        if (rawStep === null && legacyStep !== null) {
          rawStep = legacyStep;
          if (uForStep) {
            try {
              await AsyncStorage.setItem(stepKey, legacyStep);
            } catch {}
            if (!canApply()) return;
          }
        }
        setOnboardingStepState(clampOnboardingStep(rawStep));
      } catch {
        if (canApply()) setOnboardingStepState(1);
      } finally {
        if (active) setIsLoading(false);
      }
      // A cold start with a cached session re-reads the authoritative profile
      // once loading finishes. Until this existed the cached envelope was the
      // only source of truth, so anything the server knew and the cache did not
      // (a saved photo, a handle claimed elsewhere) was invisible for the whole
      // session - and the mandatory-avatar gate then demanded a photo the user
      // had already saved.
      if (active && restoredSession) void syncProfileFromServer();
    })();
    return () => {
      active = false;
    };
  }, [isAuthCurrent, syncProfileFromServer]);

  const clearMoneyCache = useCallback(async (username?: string) => {
    const keys = [...CACHE_BASES, ...LEGACY_IDENTITY_KEYS];
    const normalizedUsername = username?.trim();
    if (normalizedUsername) {
      for (const base of CACHE_BASES)
        keys.push(`${base}:${normalizedUsername}`);
      const allKeys = await AsyncStorage.getAllKeys();
      for (const key of allKeys) {
        if (
          key.endsWith(`:${normalizedUsername}`) &&
          CACHE_BASES.some(
            (base) => key === base || key.startsWith(`${base}:`)
          )
        ) {
          keys.push(key);
        }
      }
    }
    await AsyncStorage.multiRemove(Array.from(new Set(keys)));
  }, []);

  const clearEphemeralStorage = useCallback(async () => {
    await AsyncStorage.multiRemove([
      ONBOARDED_KEY,
      FEED_WELCOME_KEY_BASE,
      ONBOARDING_STEP_KEY_BASE,
      '@susej_welcome_seen',
      '@susej_onboarding',
    ]);
  }, []);

  const readPendingRevokes = useCallback(async (): Promise<string[]> => {
    let diskTokens: string[] = [];
    try {
      const raw = await AsyncStorage.getItem(PENDING_REVOKE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            diskTokens = parsed.filter(
              (token): token is string =>
                typeof token === 'string' && token.length > 0
            );
          } else if (typeof parsed === 'string' && parsed) {
            diskTokens = [parsed];
          }
        } catch {
          diskTokens = [raw];
        }
      }
    } catch {}
    const tokens = Array.from(
      new Set([...pendingRevokeRef.current, ...diskTokens])
    );
    pendingRevokeRef.current = tokens;
    return tokens;
  }, []);

  const writePendingRevokes = useCallback(
    async (tokens: string[]): Promise<boolean> => {
      const unique = Array.from(
        new Set(
          tokens.filter(
            (token) => typeof token === 'string' && token.length > 0
          )
        )
      );
      const previous = pendingRevokeRef.current;
      pendingRevokeRef.current = unique;
      try {
        if (unique.length === 1) {
          await AsyncStorage.setItem(PENDING_REVOKE_KEY, unique[0]);
        } else if (unique.length > 1) {
          await AsyncStorage.setItem(
            PENDING_REVOKE_KEY,
            JSON.stringify(unique)
          );
        } else {
          await AsyncStorage.removeItem(PENDING_REVOKE_KEY);
        }
        return true;
      } catch {
        pendingRevokeRef.current = previous;
        return false;
      }
    },
    []
  );

  const addPendingRevoke = useCallback(
    async (token: string) => {
      const pending = await readPendingRevokes();
      if (!(await writePendingRevokes([...pending, token]))) {
        throw new Error(STORAGE_ERROR);
      }
    },
    [readPendingRevokes, writePendingRevokes]
  );

  const removePendingRevoke = useCallback(
    async (token: string) => {
      const pending = await readPendingRevokes();
      await writePendingRevokes(
        pending.filter((pendingToken) => pendingToken !== token)
      );
    },
    [readPendingRevokes, writePendingRevokes]
  );

  const resetAuthState = useCallback((expired = false) => {
    loginGraceUntilRef.current = 0;
    userRef.current = null;
    isLoggedInRef.current = false;
    setUser(null);
    setIsLoggedIn(false);
    setHasOnboarded(false);
    setHasSeenFeedWelcomeState(false);
    setOnboardingStepState(1);
    setExpiredNotice(expired || keepExpiredNoticeRef.current);
    // The session died mid-app: the guest lands on the sign-in form, not on
    // the first-run carousel.
    setGuestLanding('login');
  }, []);

  const readLoginFlags = useCallback(
    async (
      nextUser: User,
      forceIncomplete: boolean,
      setupRequired: boolean,
      migrateLegacy: boolean,
      epoch: number,
      requestId: number
    ): Promise<LoginFlags | null> => {
      const username = nextUser.username.trim();
      if (!isAuthCurrent(epoch, requestId)) return null;
      let hasOnboardedValue = false;
      if (!forceIncomplete) {
        const [perUser, legacyOnboarded] = await Promise.all([
          AsyncStorage.getItem(ONBOARDED_PREFIX + username),
          AsyncStorage.getItem(ONBOARDED_KEY),
        ]);
        if (!isAuthCurrent(epoch, requestId)) return null;
        hasOnboardedValue = perUser === 'true';
        if (perUser === null && migrateLegacy && legacyOnboarded === 'true') {
          hasOnboardedValue = true;
        }
        if (perUser === null && !hasOnboardedValue) {
          hasOnboardedValue = hasCompletedProfile(nextUser);
        }
        if (perUser === null && hasOnboardedValue) {
          try {
            await AsyncStorage.setItem(ONBOARDED_PREFIX + username, 'true');
          } catch {}
          if (!isAuthCurrent(epoch, requestId)) return null;
          if (legacyOnboarded === 'true' && migrateLegacy) {
            try {
              await AsyncStorage.removeItem(ONBOARDED_KEY);
            } catch {}
            if (!isAuthCurrent(epoch, requestId)) return null;
          }
        }
      }
      if (setupRequired) hasOnboardedValue = false;
      const stepKey = `${ONBOARDING_STEP_KEY_BASE}:${username}`;
      const [welcomePerUser, legacyWelcome, perUserStep, legacyStep] =
        await Promise.all([
          forceIncomplete
            ? Promise.resolve(null)
            : AsyncStorage.getItem(FEED_WELCOME_PREFIX + username),
          forceIncomplete
            ? Promise.resolve(null)
            : AsyncStorage.getItem(FEED_WELCOME_KEY_BASE),
          forceIncomplete
            ? Promise.resolve(null)
            : AsyncStorage.getItem(stepKey),
          forceIncomplete || !migrateLegacy
            ? Promise.resolve(null)
            : AsyncStorage.getItem(ONBOARDING_STEP_KEY_BASE),
        ]);
      if (!isAuthCurrent(epoch, requestId)) return null;
      let hasSeenWelcomeValue = forceIncomplete
        ? false
        : welcomePerUser === 'true';
      if (!forceIncomplete && welcomePerUser === null && migrateLegacy) {
        hasSeenWelcomeValue = legacyWelcome === 'true';
        if (hasSeenWelcomeValue) {
          try {
            await AsyncStorage.setItem(FEED_WELCOME_PREFIX + username, 'true');
          } catch {}
          if (!isAuthCurrent(epoch, requestId)) return null;
          try {
            await AsyncStorage.removeItem(FEED_WELCOME_KEY_BASE);
          } catch {}
          if (!isAuthCurrent(epoch, requestId)) return null;
        }
      }
      let stepValue = 1;
      let rawStep = perUserStep;
      if (rawStep === null && legacyStep !== null) {
        rawStep = legacyStep;
        try {
          await AsyncStorage.setItem(stepKey, legacyStep);
        } catch {}
        if (!isAuthCurrent(epoch, requestId)) return null;
      }
      if (rawStep) stepValue = clampOnboardingStep(rawStep);
      return {
        hasOnboarded: hasOnboardedValue,
        hasSeenFeedWelcome: hasSeenWelcomeValue,
        onboardingStep: stepValue,
      };
    },
    [isAuthCurrent]
  );

  const commitLogin = useCallback(
    async (input: CommitInput): Promise<CommitResult> => {
      if (!isAuthCurrent(input.epoch, input.requestId)) {
        return { ok: false, error: STALE_AUTH_ERROR };
      }
      // Purge with the INCOMING account's namespace too. Passing no username
      // left every per-user key (wallet, cart, orders, addresses, chat) from
      // the previous account on the device, and the rejection was swallowed -
      // so a storage hiccup handed the new user the old user's data.
      await clearMoneyCache(input.user.username).catch(() => undefined);
      if (!isAuthCurrent(input.epoch, input.requestId)) {
        return { ok: false, error: STALE_AUTH_ERROR };
      }
      const forceIncomplete =
        input.created || input.setupRequired || input.mode === 'signup';
      let flags: LoginFlags | null;
      try {
        flags = await readLoginFlags(
          input.user,
          forceIncomplete,
          input.setupRequired,
          input.migrateLegacy,
          input.epoch,
          input.requestId
        );
      } catch {
        return { ok: false, error: STORAGE_ERROR };
      }
      if (!flags || !isAuthCurrent(input.epoch, input.requestId)) {
        return { ok: false, error: STALE_AUTH_ERROR };
      }
      // The routing decision (feed vs onboarding) is made HERE, from a
      // device-local flag plus a profile heuristic - there is no server-side
      // "onboarded" truth. Without this trace a wrong turn is invisible: the
      // user is silently dumped into the funnel with no explanation.
      trace('login flags resolved', {
        username: input.user.username,
        mode: input.mode,
        created: input.created,
        setupRequired: input.setupRequired,
        forceIncomplete,
        migrateLegacy: input.migrateLegacy,
        hasOnboarded: flags.hasOnboarded,
        onboardingStep: flags.onboardingStep,
        completedProfile: hasCompletedProfile(input.user),
      });
      let previousSession: Awaited<
        ReturnType<typeof sessionStorage.getAuthenticatedSession>
      > = null;
      try {
        previousSession =
          await sessionStorage.getAuthenticatedSession();
      } catch {
        return { ok: false, error: STORAGE_ERROR };
      }
      if (!isAuthCurrent(input.epoch, input.requestId)) {
        return { ok: false, error: STALE_AUTH_ERROR };
      }
      const committedEpoch = authEpochRef.current + 1;
      authEpochRef.current = committedEpoch;
      authHandoffRef.current = true;
      const commitGuard = () =>
        isAuthCurrent(committedEpoch, input.requestId);
      let committed = false;
      try {
        committed =
          input.accessToken === 'mock-token'
            ? await sessionStorage.commitAuthenticatedSession(
                input.user,
                input.accessToken,
                previousSession,
                commitGuard,
                1,
                'mock-refresh'
              )
            : await sessionStorage.commitAuthenticatedSession(
                input.user,
                input.accessToken,
                previousSession,
                commitGuard
              );
      } catch {
        authHandoffRef.current = false;
        if (isAuthCurrent(committedEpoch, input.requestId)) {
          await sessionStorage
            .clearSessionIfToken(input.accessToken)
            .catch(() => false);
          resetAuthState(false);
          setSessionSeq((n) => n + 1);
        }
        return { ok: false, error: STORAGE_ERROR };
      }
      authHandoffRef.current = false;
      if (!committed) {
        return { ok: false, error: STALE_AUTH_ERROR };
      }
      if (!isAuthCurrent(committedEpoch, input.requestId)) {
        return { ok: false, error: STALE_AUTH_ERROR };
      }
      userRef.current = input.user;
      isLoggedInRef.current = true;
      keepExpiredNoticeRef.current = false;
      setGuestLanding('welcome');
      setUser(input.user);
      setIsLoggedIn(true);
      setHasOnboarded(flags.hasOnboarded);
      setHasSeenFeedWelcomeState(flags.hasSeenFeedWelcome);
      setOnboardingStepState(flags.onboardingStep);
       setExpiredNotice(false);
       loginGraceUntilRef.current = Date.now() + 15000;
       setSessionSeq((n) => n + 1);
      return {
        ok: true,
        epoch: committedEpoch,
        requestId: input.requestId,
        accessToken: input.accessToken,
        mode: input.mode,
        created: input.created,
        setupRequired: input.setupRequired,
        authCode: input.authCode,
      };
    },
    [clearMoneyCache, isAuthCurrent, readLoginFlags, resetAuthState]
  );

  const activateCommittedLogin = useCallback(
    async (commit: Extract<CommitResult, { ok: true }>) => {
      if (!isAuthCurrent(commit.epoch, commit.requestId)) return false;
      let session: Awaited<ReturnType<typeof sessionStorage.getSession>>;
      try {
        session = await sessionStorage.getSession();
      } catch {
        return false;
      }
      if (!session || session.accessToken !== commit.accessToken) return false;
      if (!isAuthCurrent(commit.epoch, commit.requestId)) return false;
      setTokenSeq((n) => n + 1);
      return true;
    },
    [isAuthCurrent]
  );

  const login = useCallback(
    async (
      nextUser: User,
      accessToken = 'mock-token',
      suppliedRequestId?: number,
      migrateLegacy = false
    ) => {
      if (!nextUser?.username || String(nextUser.username).trim().length < 2) {
        throw new Error('login requires valid username');
      }
      await waitForAuthTransition();
      const requestId = suppliedRequestId ?? ++loginRequestRef.current;
      const epoch = authEpochRef.current;
      const result = await commitLogin({
        user: nextUser,
        accessToken,
        epoch,
        requestId,
        migrateLegacy,
        mode: 'login',
        created: false,
        setupRequired: false,
      });
      if (!result.ok) return false;
      return activateCommittedLogin(result);
    },
    [activateCommittedLogin, commitLogin, waitForAuthTransition]
  );

  const cancelAuthAttempt = useCallback(() => {
    // A screen that unmounts BECAUSE the session just committed is not
    // cancelling anything - it is the success path tearing down. Cancelling
    // there aborted serverLogin between commitLogin and
    // activateCommittedLogin: the tree had already swapped to the
    // authenticated navigator, yet the activation never ran, so the app was
    // "logged in" on a stale sign-in screen with no token activation and no
    // pending-revoke retry - the OTP auth-tree loop. Only an attempt that has
    // NOT produced a live session may be cancelled.
    if (isLoggedInRef.current) return;
    authEpochRef.current += 1;
    loginRequestRef.current += 1;
  }, []);

  const retryPendingRevokes = useCallback(
    async (epoch: number, requestId: number): Promise<boolean> => {
      const pending = await readPendingRevokes();
      if (!isAuthCurrent(epoch, requestId)) return false;
      const failed: string[] = [];
      for (const pendingToken of pending) {
        if (!isAuthCurrent(epoch, requestId)) return false;
        let revoked = false;
        try {
          const result = await serverApi.revokeSession(false, pendingToken);
          revoked = result.ok;
        } catch {}
        if (!isAuthCurrent(epoch, requestId)) return false;
        if (!revoked) failed.push(pendingToken);
      }
      if (!isAuthCurrent(epoch, requestId)) return false;
      await writePendingRevokes(failed);
      return isAuthCurrent(epoch, requestId);
    },
    [isAuthCurrent, readPendingRevokes, writePendingRevokes]
  );

  useEffect(() => {
    if (startupRevokeStartedRef.current) return;
    startupRevokeStartedRef.current = true;
    const epoch = authEpochRef.current;
    const requestId = loginRequestRef.current;
    void (async () => {
      if (!isAuthCurrent(epoch, requestId)) return;
      await retryPendingRevokes(epoch, requestId);
    })();
  }, [isAuthCurrent, retryPendingRevokes]);

  const serverLogin = useCallback(
    async (
      phone: string,
      code: string,
      opts?: ServerLoginOptions | LegacyServerLoginOptions
    ): Promise<AuthResult> => {
      await waitForAuthTransition();
      const epoch = authEpochRef.current;
      const requestId = ++loginRequestRef.current;
      const intent = normalizeIntent(opts);
      let res: AuthApiResult;
      try {
        res = await serverApi.verifyOtp(phone.replace(/\D/g, ''), code, intent);
      } catch {
        if (!isAuthCurrent(epoch, requestId))
          return { ok: false, error: STALE_AUTH_ERROR };
        return { ok: false, offline: true };
      }
      if (!isAuthCurrent(epoch, requestId))
        return { ok: false, error: STALE_AUTH_ERROR };
      if (res.ok) {
        const normalized = normalizeAuthData(
          res.data,
          intent,
          intent === 'signup'
        );
        if (!normalized) {
          return {
            ok: false,
            error: 'Sign-in response was incomplete. Please try again.',
          };
        }
        trace('serverLogin verify ok', {
          mode: normalized.mode,
          created: normalized.created,
          setupRequired: normalized.setupRequired,
          username: normalized.user.username,
        });
        const result = await commitLogin({
          user: normalized.user,
          accessToken: normalized.token,
          epoch,
          requestId,
          migrateLegacy:
            !normalized.created &&
            normalized.mode === 'login' &&
            hasCompletedProfile(normalized.user),
          mode: normalized.mode,
          created: normalized.created,
          setupRequired: normalized.setupRequired,
          authCode: normalized.authCode,
        });
        if (!result.ok) {
          trace('serverLogin commit failed', result.error);
          return { ok: false, error: result.error };
        }
        if (
          !(await retryPendingRevokes(
            result.epoch,
            result.requestId
          ))
        ) {
          trace('serverLogin revoke-retry stale', {
            epoch: result.epoch,
            requestId: result.requestId,
          });
          return { ok: false, error: STALE_AUTH_ERROR };
        }
        if (!(await activateCommittedLogin(result))) {
          trace('serverLogin activation FAILED', {
            epoch: result.epoch,
            requestId: result.requestId,
          });
          return { ok: false, error: STALE_AUTH_ERROR };
        }
        trace('serverLogin COMPLETE', { mode: result.mode, created: result.created });
        // The server is the source of truth for the profile. Without this the
        // cached envelope decides what the app believes about the user, which
        // is how a saved photo or a claimed handle could be "forgotten".
        void syncProfileFromServer();
        return {
          ok: true,
          mode: result.mode,
          created: result.created,
          setupRequired: result.setupRequired,
          authCode: result.authCode,
        };
      }
      return authFailure(res);
    },
    [
      activateCommittedLogin,
      commitLogin,
      isAuthCurrent,
      retryPendingRevokes,
      waitForAuthTransition,
    ]
  );

  const serverEmailLogin = useCallback(
    async (
      action: 'login' | 'register',
      email: string,
      password: string,
      name?: string
    ): Promise<AuthResult> => {
      await waitForAuthTransition();
      const epoch = authEpochRef.current;
      const requestId = ++loginRequestRef.current;
      let res: AuthApiResult;
      try {
        res = (await serverApi.emailAuth(
          action,
          email.trim().toLowerCase(),
          password,
          name
        )) as AuthApiResult;
      } catch {
        if (!isAuthCurrent(epoch, requestId))
          return { ok: false, error: STALE_AUTH_ERROR };
        return { ok: false, offline: true };
      }
      if (!isAuthCurrent(epoch, requestId))
        return { ok: false, error: STALE_AUTH_ERROR };
      if (res.ok) {
        const normalized = normalizeAuthData(
          res.data,
          action === 'register' ? 'signup' : 'login',
          action === 'register'
        );
        if (!normalized) {
          return {
            ok: false,
            error: 'Sign-in response was incomplete. Please try again.',
          };
        }
        const result = await commitLogin({
          user: normalized.user,
          accessToken: normalized.token,
          epoch,
          requestId,
          migrateLegacy:
            action === 'login' && hasCompletedProfile(normalized.user),
          mode: normalized.mode,
          created: normalized.created,
          setupRequired: normalized.setupRequired,
          authCode: normalized.authCode,
        });
        if (!result.ok) return { ok: false, error: result.error };
        if (
          !(await retryPendingRevokes(
            result.epoch,
            result.requestId
          ))
        ) {
          return { ok: false, error: STALE_AUTH_ERROR };
        }
        if (!(await activateCommittedLogin(result)))
          return { ok: false, error: STALE_AUTH_ERROR };
        return {
          ok: true,
          mode: result.mode,
          created: result.created,
          setupRequired: result.setupRequired,
          authCode: result.authCode,
        };
      }
      return authFailure(res);
    },
    [
      activateCommittedLogin,
      commitLogin,
      isAuthCurrent,
      retryPendingRevokes,
      waitForAuthTransition,
    ]
  );

  const serverGoogleLogin = useCallback(
    async (
      idToken: string,
      devBypass?: { email: string; name?: string }
    ): Promise<AuthResult> => {
      await waitForAuthTransition();
      const epoch = authEpochRef.current;
      const requestId = ++loginRequestRef.current;
      let res: AuthApiResult;
      try {
        res = (await serverApi.googleAuth(idToken, devBypass)) as AuthApiResult;
      } catch {
        if (!isAuthCurrent(epoch, requestId))
          return { ok: false, error: STALE_AUTH_ERROR };
        return { ok: false, offline: true };
      }
      if (!isAuthCurrent(epoch, requestId))
        return { ok: false, error: STALE_AUTH_ERROR };
      if (res.ok) {
        const normalized = normalizeAuthData(res.data);
        if (!normalized) {
          return {
            ok: false,
            error: 'Sign-in response was incomplete. Please try again.',
          };
        }
        const result = await commitLogin({
          user: normalized.user,
          accessToken: normalized.token,
          epoch,
          requestId,
          migrateLegacy: !devBypass && hasCompletedProfile(normalized.user),
          mode: normalized.mode,
          created: normalized.created,
          setupRequired: normalized.setupRequired,
          authCode: normalized.authCode,
        });
        if (!result.ok) return { ok: false, error: result.error };
        if (
          !(await retryPendingRevokes(
            result.epoch,
            result.requestId
          ))
        ) {
          return { ok: false, error: STALE_AUTH_ERROR };
        }
        if (!(await activateCommittedLogin(result)))
          return { ok: false, error: STALE_AUTH_ERROR };
        return {
          ok: true,
          mode: result.mode,
          created: result.created,
          setupRequired: result.setupRequired,
          authCode: result.authCode,
        };
      }
      return authFailure(res);
    },
    [
      activateCommittedLogin,
      commitLogin,
      isAuthCurrent,
      retryPendingRevokes,
      waitForAuthTransition,
    ]
  );

  const logout = useCallback(async () => {
    const existing = authTransitionRef.current;
    if (existing) return existing;
    const username = userRef.current?.username?.trim() || undefined;
    const run = (async () => {
      const logoutEpoch = authEpochRef.current + 1;
      const logoutRequest = loginRequestRef.current + 1;
       authEpochRef.current = logoutEpoch;
       loginRequestRef.current = logoutRequest;
       loginGraceUntilRef.current = 0;
      const session = await sessionStorage.getSession().catch(() => null);
      const token = session?.accessToken?.startsWith('susej_')
        ? session.accessToken
        : null;
      let accountUsername = username;
      if (!accountUsername) {
        const storedUser = await sessionStorage.getUser().catch(() => null);
        accountUsername = storedUser?.username?.trim() || undefined;
      }
      const isCurrent = () =>
        authEpochRef.current === logoutEpoch &&
        loginRequestRef.current === logoutRequest;

      // Everything below the live-session clear is ANCILLARY: revoking the
      // token, wiping onboarding scratch flags and purging cached money/social
      // data. None of it may decide whether the user gets signed out - a
      // storage hiccup on any of these used to abort logout before the reset
      // ran, leaving the app "logged in" with an unusable session and an
      // unhandled rejection at the call site (the tap looked dead).
      if (token) {
        await addPendingRevoke(token).catch(() => undefined);
      }
      if (!isCurrent()) return;
      await clearEphemeralStorage().catch(() => undefined);
      if (!isCurrent()) return;
      await clearMoneyCache(accountUsername).catch(() => undefined);
      if (!isCurrent()) return;
      let clearFailure: unknown = null;
      // The live flag has to go BEFORE the credential does. While the envelope
      // was cleared but `isLoggedInRef` was still true, any 401 landing in that
      // window passed the token branch (there was no stored session left to
      // compare against), took the expiry path, and a DELIBERATE logout showed
      // the user "Your session expired. Please log in again." on the login form.
      isLoggedInRef.current = false;
      userRef.current = null;
      try {
        await sessionStorage.clearSession();
      } catch (error) {
        clearFailure = error;
      }
      if (isCurrent()) {
        resetAuthState(false);
        setSessionSeq((n) => n + 1);
        setTokenSeq((n) => n + 1);
      }
      if (token) {
        try {
          const revoked = await serverApi.revokeSession(false, token);
          if (revoked.ok) await removePendingRevoke(token);
        } catch {}
      }
      if (clearFailure) throw clearFailure;
    })();
    authTransitionRef.current = run;
    try {
      await run;
    } finally {
      if (authTransitionRef.current === run) authTransitionRef.current = null;
    }
  }, [
    addPendingRevoke,
    clearEphemeralStorage,
    clearMoneyCache,
    removePendingRevoke,
    resetAuthState,
  ]);

  const logoutAndReset = useCallback(
    async (expired = false) => {
      const beforeEpoch = authEpochRef.current;
      keepExpiredNoticeRef.current = expired;
      try {
        await logout();
      } finally {
        // The notice must survive a failed teardown too: if the epoch still
        // advanced, the user IS signed out and the login screen must say why.
        if (expired && authEpochRef.current === beforeEpoch + 1) {
          setExpiredNotice(true);
        }
        keepExpiredNoticeRef.current = false;
      }
    },
    [logout]
  );

  const setOnboardingStep = useCallback(
    async (step: number): Promise<boolean> => {
      const epoch = authEpochRef.current;
      const requestId = loginRequestRef.current;
      const expectedUsername = userRef.current?.username?.trim() ?? null;
      if (!isAuthCurrent(epoch, requestId) || !expectedUsername) return false;
      const nextStep = clampOnboardingStep(step);
      const key = `${ONBOARDING_STEP_KEY_BASE}:${expectedUsername}`;
      try {
        await AsyncStorage.setItem(key, String(nextStep));
      } catch {
        return false;
      }
      if (
        !isAuthCurrent(epoch, requestId) ||
        userRef.current?.username?.trim() !== expectedUsername
      ) {
        return false;
      }
      setOnboardingStepState(nextStep);
      return true;
    },
    [isAuthCurrent]
  );

  const completeOnboarding = useCallback(async (): Promise<boolean> => {
    const epoch = authEpochRef.current;
    const requestId = loginRequestRef.current;
    const expectedUsername = userRef.current?.username?.trim() ?? null;
    if (!isAuthCurrent(epoch, requestId) || !expectedUsername) return false;
    try {
      const currentUser = await sessionStorage.getUser();
      if (!isAuthCurrent(epoch, requestId)) return false;
      const currentUsername = currentUser?.username?.trim() ?? null;
      if (!currentUsername || currentUsername !== expectedUsername) return false;
      await AsyncStorage.multiSet([
        [ONBOARDED_PREFIX + currentUsername, 'true'],
        [FEED_WELCOME_PREFIX + currentUsername, 'true'],
        [`${ONBOARDING_STEP_KEY_BASE}:${currentUsername}`, '4'],
      ]);
    } catch {
      return false;
    }
    if (
      !isAuthCurrent(epoch, requestId) ||
      userRef.current?.username?.trim() !== expectedUsername
    ) {
      return false;
    }
    setHasOnboarded(true);
    setHasSeenFeedWelcomeState(true);
    setOnboardingStepState(4);
    return true;
  }, [isAuthCurrent]);

  const updateUser = useCallback(
    async (patch: Partial<User>): Promise<true | string> => {
      const epoch = authEpochRef.current;
      const requestId = loginRequestRef.current;
      const previousUser = userRef.current;
      const expectedUsername = previousUser?.username?.trim() ?? null;
      const nextUser = { ...(previousUser ?? ({} as User)), ...patch } as User;
      if (!isAuthCurrent(epoch, requestId)) return STALE_AUTH_ERROR;
      const applyUser = (value: User | null) => {
        if (!isAuthCurrent(epoch, requestId)) return;
        if (
          expectedUsername &&
          userRef.current?.username?.trim() !== expectedUsername
        )
          return;
        userRef.current = value;
        setUser((current) => {
          if (!isAuthCurrent(epoch, requestId)) return current;
          if (
            expectedUsername &&
            current?.username?.trim() !== expectedUsername
          )
            return current;
          return value;
        });
      };
      const rollback = async () => {
        if (!isAuthCurrent(epoch, requestId)) return;
        applyUser(previousUser);
        if (previousUser) {
          try {
            await sessionStorage.saveUser(previousUser);
          } catch {}
        }
      };
      applyUser(nextUser);
      let session: Awaited<ReturnType<typeof sessionStorage.getSession>>;
      try {
        session = await sessionStorage.getSession();
      } catch {
        await rollback();
        return 'Could not verify your session. Please try again.';
      }
      if (!isAuthCurrent(epoch, requestId)) return STALE_AUTH_ERROR;
      const accessToken = session?.accessToken?.startsWith('susej_')
        ? session.accessToken
        : null;
      // `avatar` is a HARD-confirmation field: a profile picture is now
      // mandatory, so "we saved it" must mean the server has it. Both of the
      // fallbacks below used to write the value to the local envelope and
      // return TRUE with no server write at all - the photo then looked saved on
      // that one device (the local copy satisfied the avatar gate) while the
      // database never had it, so every other device and every later sign-in
      // asked for the photo again. That is the "I picked one, pressed Continue,
      // and it didn't save" report.
      const avatarMustPersist = Object.prototype.hasOwnProperty.call(
        patch as Record<string, unknown>,
        'avatar'
      );
      if (!accessToken) {
        try {
          await sessionStorage.saveUser(nextUser);
        } catch {
          await rollback();
          return STORAGE_ERROR;
        }
        return avatarMustPersist
          ? 'Could not reach the server to save your photo. Check your connection and try again.'
          : isAuthCurrent(epoch, requestId)
            ? true
            : STALE_AUTH_ERROR;
      }
      const {
        phone: _phone,
        username: _username,
        verification: _verification,
        ...serverPatchRaw
      } = patch as Record<string, unknown>;
      const serverPatch = serverPatchRaw;
      if (!Object.keys(serverPatch).length) {
        try {
          await sessionStorage.saveUser(nextUser);
        } catch {
          await rollback();
          return STORAGE_ERROR;
        }
        return isAuthCurrent(epoch, requestId) ? true : STALE_AUTH_ERROR;
      }
      try {
        const response = await serverApi.updateProfile(
          serverPatch,
          accessToken
        );
        if (!isAuthCurrent(epoch, requestId)) return STALE_AUTH_ERROR;
        if (!response.ok) {
          if (
            response.error === 'offline' ||
            response.error === 'server-unreachable'
          ) {
            try {
              await sessionStorage.saveUser(nextUser);
            } catch {
              await rollback();
              return STORAGE_ERROR;
            }
            // Same rule as above: a photo that only exists on this device is not
            // saved. Offline bio/location edits stay optimistic, because nothing
            // downstream depends on them; the mandatory avatar does.
            if (avatarMustPersist) {
              await rollback();
              return 'Could not save your photo — you appear to be offline. Reconnect and try again.';
            }
            return isAuthCurrent(epoch, requestId) ? true : STALE_AUTH_ERROR;
          }
          await rollback();
          return typeof response.error === 'string' && response.error
            ? response.error
            : 'Could not save your profile. Please try again.';
        }
        const savedUser = (response.data?.user ?? nextUser) as unknown as User;
        applyUser(savedUser);
        if (!isAuthCurrent(epoch, requestId)) return STALE_AUTH_ERROR;
        try {
          await sessionStorage.saveUser(savedUser);
        } catch {
          return STORAGE_ERROR;
        }
        return isAuthCurrent(epoch, requestId) ? true : STALE_AUTH_ERROR;
      } catch {
        if (!isAuthCurrent(epoch, requestId)) return STALE_AUTH_ERROR;
        await rollback();
        return 'Could not save your profile. Please try again.';
      }
    },
    [isAuthCurrent]
  );

  useEffect(() => {
     onSessionMissing(async (token) => {
       if (Date.now() < loginGraceUntilRef.current) return;
       if (authHandoffRef.current || !isLoggedInRef.current) return;
      const epoch = authEpochRef.current;
      const requestId = loginRequestRef.current;
      let current: Awaited<
        ReturnType<typeof sessionStorage.getAuthenticatedSession>
      > = null;
      try {
        current = await sessionStorage.getAuthenticatedSession();
      } catch {
        return;
      }
      if (
        authHandoffRef.current ||
        !isLoggedInRef.current ||
        !isAuthCurrent(epoch, requestId)
      ) {
        return;
      }
      if (token) {
        if (current && current.session.accessToken !== token) return;
      } else if (current) {
        return;
      }
      trace('auth KILL: session considered dead', {
        token: token ? `${token.slice(0, 14)}…` : null,
        hadSession: Boolean(current),
      });
      const accountUsername = userRef.current?.username?.trim() || undefined;
      if (current) {
        await sessionStorage
          .clearSessionIfToken(current.session.accessToken)
          .catch(() => false);
      }
      if (
        authHandoffRef.current ||
        !isAuthCurrent(epoch, requestId) ||
        !isLoggedInRef.current
      ) {
        return;
      }
      const expiredEpoch = epoch + 1;
      const expiredRequest = requestId + 1;
      authEpochRef.current = expiredEpoch;
      loginRequestRef.current = expiredRequest;
      resetAuthState(true);
      setSessionSeq((n) => n + 1);
      setTokenSeq((n) => n + 1);
      if (
        authEpochRef.current === expiredEpoch &&
        loginRequestRef.current === expiredRequest
      ) {
        await clearEphemeralStorage().catch(() => undefined);
      }
      if (
        authEpochRef.current === expiredEpoch &&
        loginRequestRef.current === expiredRequest
      ) {
        await clearMoneyCache(accountUsername).catch(() => undefined);
      }
    });
  }, [clearEphemeralStorage, clearMoneyCache, isAuthCurrent, resetAuthState]);

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
        cancelAuthAttempt,
        expiredNotice,
        clearExpiredNotice,
        guestLanding,
        setGuestLanding,
        setOnboardingStep,
        completeOnboarding,
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
