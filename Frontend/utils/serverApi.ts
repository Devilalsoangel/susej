/**
 * Unified server API client — the app talks to the shared PostgreSQL backend
 * (admin panel Next.js server on :3000) for real multi-user data.
 * Offline-first: every call fails silently (6s timeout) and callers fall back
 * to their AsyncStorage cache. The token comes from the app session.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { sessionStorage } from './sessionStorage';
import { getAdminUrl, getAppKey } from './adminSync';

/**
 * Industry-standard transport classification (Instagram/WhatsApp pattern):
 * 'offline' ONLY when the device truly has no connectivity (NetInfo truth),
 * 'server-unreachable' when the network is fine but OUR server doesn't answer
 * (dead local preview server, outage, tunnel down). Never blame the user's
 * internet for our own server being down.
 */
async function classifyTransportError(): Promise<'offline' | 'server-unreachable'> {
  try {
    const state = await NetInfo.fetch();
    if (state.isConnected === false || state.isInternetReachable === false) return 'offline';
  } catch {
    // NetInfo itself failed — fail open to server-side; the retry will tell.
  }
  return 'server-unreachable';
}

/**
 * Honest user-facing copy for transport failures. Real offline blames the
 * connection (true); our server being down says so (never the user's fault).
 */
export function transportMessage(error: string | undefined, action: string): string {
  if (error === 'offline') return `You're offline. Check your connection and ${action}.`;
  if (error === 'server-unreachable') return `Couldn't reach the susej server. Please ${action}.`;
  if (error === 'session-expired') return `Your session expired. Please log in again and ${action}.`;
  // Raw HTTP fallbacks from the wire must never reach the user verbatim —
  // a red "HTTP 500" tells them nothing. Map to human copy.
  if (error === 'HTTP 500' || error === 'HTTP 502' || error === 'HTTP 503') {
    return `Our server had a hiccup. Please ${action}.`;
  }
  if (error === 'HTTP 429') return `Too many attempts. Wait a minute and ${action}.`;
  if (error && /^HTTP \d{3}$/.test(error)) return `Something went wrong. Please ${action}.`;
  return error || `Something went wrong. Please ${action}.`;
}

/**
 * Industry-style auth error copy: every failure tells the user WHAT happened
 * and WHAT to do next — never a raw code, never a red wall of jargon.
 * Falls back to transportMessage for wire-level errors.
 */
export function authErrorMessage(error: string | undefined, action: string): string {
  if (!error) return `Something went wrong. Please ${action}.`;
  if (error === 'offline' || error === 'server-unreachable' || error === 'session-expired' || error.startsWith('HTTP')) {
    return transportMessage(error, action);
  }
  const low = error.toLowerCase();
  if (low.includes('incorrect code')) return error; // already human ("Incorrect code", attempts shown beside it)
  if (low.includes('expired')) return 'That code expired. Tap Resend for a fresh one.';
  if (low.includes('no code requested') || low.includes('tap resend')) return 'No code was sent yet. Tap Send code first.';
  if (low.includes('too many attempts') || low.includes('too many codes')) return 'Too many tries. Wait a minute, then tap Resend.';
  if (low.includes('too many accounts')) return 'Too many accounts from this network. Try again later.';
  if (low.includes('already sent') || low.includes('wait before requesting')) return 'Code already on its way. Wait a few seconds, then Resend.';
  if (low.includes('valid 10-digit') || low.includes('valid phone') || low.includes('valid mobile')) return error;
  if (low.includes('only indian')) return 'Only Indian (+91) mobile numbers are supported right now.';
  if (low.includes('sms delivery') || low.includes('database unavailable')) return 'Our server stumbled. Try again in a moment.';
  if (low.includes('account disabled')) return 'This account is disabled. Contact support for help.';
  if (low.includes('hiccup')) return error;
  return error;
}

export interface ApiResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
  /** Set on 404 from OTP verify: unknown number, signup consent required. */
  needsSignup?: boolean;
  /** Tries remaining after a wrong OTP guess (verify 401). Surfaced in UI. */
  attemptsLeft?: number;
}

export interface ServerComment {
  id: string;
  author: string;
  username?: string | null;
  parentId?: string | null;
  text: string;
  likes?: number;
  likedByMe?: boolean;
  time: number;
}

export type SearchMode = 'suggest' | 'results';
export type SearchKind = 'user' | 'product' | 'category' | 'location';

export interface SearchUserHit {
  kind: 'user';
  username: string;
  name: string;
  businessName: string;
  displayName: string;
  avatar: string | null;
  location: string;
  category: string;
  isSeller: boolean;
  verified: boolean;
}

export interface SearchProductVariantValue {
  label: string;
  priceDelta?: number;
  stock?: number;
}

export interface SearchProductVariant {
  name: string;
  values: SearchProductVariantValue[];
}

export interface SearchProductHit {
  kind: 'product';
  id: string;
  title: string;
  description: string;
  sellerName: string;
  sellerUsername: string;
  sellerLocation: string;
  verified: boolean;
  price: number;
  mrp: number | null;
  category: string;
  subCategories: string[];
  type: 'product' | 'service' | 'food_item';
  hashtags: string[];
  likes: number;
  comments: number;
  createdAt: number;
  isSold: boolean;
  featured: boolean;
  condition: string | null;
  brand: string | null;
  variants: SearchProductVariant[] | null;
  stockLeft: number | null;
  negotiable: boolean | null;
  deliveryMode: string | null;
  images: string[];
  image: string;
}

export interface SearchCategoryHit {
  kind: 'category';
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  bannerImage: string | null;
  featured: boolean;
  parentId: string | null;
  parentName: string | null;
  parentSlug: string | null;
  children: Array<{ id: string; name: string; slug: string }>;
}

export interface SearchLocationHit {
  kind: 'location';
  label: string;
  count: number;
  userCount: number;
  postCount: number;
}

export type SearchHit = SearchUserHit | SearchProductHit | SearchCategoryHit | SearchLocationHit;
export type SearchCounts = Record<SearchKind, number> & { total: number };

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  types: SearchKind[];
  limit: number;
  hits: SearchHit[];
  counts: SearchCounts;
  degraded: boolean;
  unavailable: SearchKind[];
  hasMore: boolean;
}

async function getToken(): Promise<string | null> {
  const session = await sessionStorage.getSession();
  return session?.accessToken && session.accessToken.startsWith('susej_') ? session.accessToken : null;
}

/** Fired when a call proves the Bearer is dead (HTTP 401 on a non-auth lane).
 *  AuthContext registers the local-wipe handler; serverApi never imports it
 *  (import cycle). Auth lanes are excluded — a 401 there is a credential
 *  rejection (wrong OTP/password), not a session death. */
let expiredListener: (() => void) | null = null;
export function onSessionExpired(cb: () => void): void {
  expiredListener = cb;
}

async function expireIfCurrentToken(token: string): Promise<void> {
  const expired = await sessionStorage.clearSessionIfToken(token);
  if (!expired) return;
  try {
    expiredListener?.();
  } catch {}
}

const requestFlights = new Map<string, Promise<ApiResult<unknown>>>();
const appKeyRequestFlights = new Map<string, Promise<ApiResult<unknown>>>();
type ReadCacheEntry = { result: ApiResult<unknown>; freshUntil: number; staleUntil: number };
type ReadCacheSpec = { freshMs: number; staleMs: number };
const readCache = new Map<string, ReadCacheEntry>();
const readCacheFlights = new Map<string, Promise<ApiResult<unknown>>>();
const READ_CACHE_PREFIX = '@susej_server_read_v1:';
let readCacheGeneration = 0;

function tokenFingerprint(token: string | null): string {
  if (!token) return 'anonymous';
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readCacheKey(path: string, token: string | null): string {
  return `${READ_CACHE_PREFIX}${readCacheGeneration}:${tokenFingerprint(token)}:${path}`;
}

function readCacheSpec(path: string): ReadCacheSpec | null {
  if (path === '/posts' || path.startsWith('/posts/') || path.startsWith('/search') || path === '/stories' || path === '/promotions' || path === '/bundles' || path === '/reels' || path === '/live' || path === '/broadcasts' || path === '/communities' || path === '/auctions' || path.startsWith('/auctions/') || path.startsWith('/categories') || path.startsWith('/storefront-banners') || path === '/coupons' || /^\/users\/[^/]+$/.test(path)) {
    return { freshMs: 15_000, staleMs: 120_000 };
  }
  if (path === '/chat/threads' || (path.startsWith('/chat/threads/') && path.endsWith('/messages')) || path === '/notifications' || path === '/follows' || path === '/blocks' || path === '/watches' || path === '/sellers/me' || (path.startsWith('/communities/') && (path.endsWith('/messages') || path.endsWith('/polls')))) {
    return { freshMs: 3_000, staleMs: 20_000 };
  }
  if (path === '/api/v1/home' || path === '/api/v1/config' || path === '/api/app/categories') {
    return { freshMs: 15_000, staleMs: 120_000 };
  }
  return null;
}

function bumpReadCacheGeneration(): void {
  readCacheGeneration += 1;
  readCache.clear();
  readCacheFlights.clear();
}

async function readStoredReadCache(key: string): Promise<ReadCacheEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReadCacheEntry;
    if (!parsed?.result || typeof parsed.freshUntil !== 'number' || typeof parsed.staleUntil !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeReadCache(key: string, entry: ReadCacheEntry): Promise<void> {
  if (JSON.stringify(entry).length > 512_000) return;
  readCache.set(key, entry);
  try { await AsyncStorage.setItem(key, JSON.stringify(entry)); } catch {}
}

async function cachedReadRequest<T>(key: string, spec: ReadCacheSpec, load: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const now = Date.now();
  let entry = readCache.get(key) ?? await readStoredReadCache(key);
  if (entry) {
    readCache.set(key, entry);
    if (now < entry.freshUntil) return entry.result as ApiResult<T>;
    if (now < entry.staleUntil) {
      void refreshReadCache(key, spec, load);
      return entry.result as ApiResult<T>;
    }
  }
  return refreshReadCache(key, spec, load);
}

async function refreshReadCache<T>(key: string, spec: ReadCacheSpec, load: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const existing = readCacheFlights.get(key);
  if (existing) return existing as Promise<ApiResult<T>>;
  let flight: Promise<ApiResult<T>>;
  flight = load().then(async (result) => {
    if (result.ok) await writeReadCache(key, { result, freshUntil: Date.now() + spec.freshMs, staleUntil: Date.now() + spec.staleMs });
    return result;
  }).finally(() => {
    if (readCacheFlights.get(key) === flight) readCacheFlights.delete(key);
  });
  readCacheFlights.set(key, flight as Promise<ApiResult<unknown>>);
  try {
    return await flight;
  } catch (error) {
    const stale = readCache.get(key);
    if (stale && Date.now() < stale.staleUntil) return stale.result as ApiResult<T>;
    throw error;
  }
}


async function performRequest<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number; retry?: boolean; authToken?: string } = {}, attempt = 0): Promise<ApiResult<T>> {
  try {
    const base = await getAdminUrl();
    // Explicit authToken (pending-revoke of a previous session) bypasses the
    // live-session filter — the token comes from storage, already susej_.
    const token = options.authToken ?? await getToken();
    const controller = new AbortController();
    // Neon cold queries outlast tight budgets: profile lanes carry 20s.
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
    const res = await fetch(`${base}/api/app${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      const needsSignup = (json as { needsSignup?: boolean } | null)?.needsSignup;
      const attemptsLeft = (json as { attemptsLeft?: number } | null)?.attemptsLeft;
      // Dead Bearer (revoked server-side, rotated, or forged): never present
      // cache as live. Wipe the token and tell the app to force re-auth.
      if (res.status === 401 && token && !path.startsWith('/auth')) {
        await expireIfCurrentToken(token);
        return { ok: false, data: null, error: 'session-expired' };
      }
      return { ok: false, data: null, error: err, ...(needsSignup ? { needsSignup: true } : {}), ...(typeof attemptsLeft === 'number' ? { attemptsLeft } : {}) };
    }
    return { ok: true, data: json };
  } catch {
    const err = await classifyTransportError();
    // One automatic retry for safe lanes: a cold Neon/Vercel hop eats the
    // first budget; the retry lands warm and succeeds (Instagram pattern).
    // GETs always; profile PATCH (last-write-wins) explicitly. Never POST —
    // orders/promotions/payouts would double-apply.
    const method = options.method ?? 'GET';
    const safeLane = method === 'GET' || (method === 'PATCH' && path === '/users/me');
    if (err === 'server-unreachable' && options.retry !== false && safeLane && attempt < 1) {
      await new Promise((r) => setTimeout(r, 800));
       return performRequest<T>(path, options, attempt + 1);
    }
    return { ok: false, data: null, error: err };
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number; retry?: boolean; authToken?: string } = {}): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  if (method !== 'GET') {
    const result = await performRequest<T>(path, options);
    if (result.ok) bumpReadCacheGeneration();
    return result;
  }
  if (options.authToken !== undefined) return performRequest<T>(path, options);
  const token = await getToken();
  const spec = readCacheSpec(path);
  if (spec) return cachedReadRequest(readCacheKey(path, token), spec, () => performRequest<T>(path, { ...options, authToken: token ?? '' }));
  const key = `${token || ''}|${path}|${options.timeoutMs ?? ''}|${options.retry === false ? '0' : '1'}|${JSON.stringify(options.body ?? null)}`;
  const existing = requestFlights.get(key) as Promise<ApiResult<T>> | undefined;
  if (existing) return existing;
  const flight = performRequest<T>(path, { ...options, authToken: token ?? '' });
  requestFlights.set(key, flight as Promise<ApiResult<unknown>>);
  try {
    return await flight;
  } finally {
    if (requestFlights.get(key) === flight) requestFlights.delete(key);
  }
}

// App-key request against the admin /api/v1/* surface (platform-curated home
// content). Carries BOTH x-app-key AND a Bearer token so the server's
// parseWriteSession can resolve the real user identity.
async function performRequestWithAppKey<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number; retry?: boolean; authToken?: string } = {}, attempt = 0): Promise<ApiResult<T>> {
  try {
    const [base, key, currentToken] = await Promise.all([getAdminUrl(), getAppKey(), getToken()]);
    const token = options.authToken ?? currentToken;
    const controller = new AbortController();
    // Uploads carry multi-MB base64 bodies: the default 6s budget aborts
    // them mid-flight and misreports "couldn't reach the server".
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-app-key': key,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      // Dead-Bearer kill-switch — ONLY on Bearer-gated /api/app/* lanes
      // (getAppUser rejects dead tokens there, so 401 proves session death).
      // /api/v1/* is key-gated (bad APP_API_KEY 401s with a perfectly valid
      // Bearer — wiping there logged users out over a server-config problem)
      // and /api/data/* checks the key first (ambiguous). No /auth exclusion:
      // this lane carries no auth routes.
      if (res.status === 401 && token && path.startsWith("/api/app/")) {
        await expireIfCurrentToken(token);
        return { ok: false, data: null, error: 'session-expired' };
      }
      return { ok: false, data: null, error: err };
    }
    return { ok: true, data: json };
  } catch {
    const err = await classifyTransportError();
    // Same safe-lane retry as request(): GETs only (address POSTs, payout
    // PUTs and banner syncs must never double-apply).
    if (err === 'server-unreachable' && options.retry !== false && (options.method ?? 'GET') === 'GET' && attempt < 1) {
      await new Promise((r) => setTimeout(r, 800));
       return performRequestWithAppKey<T>(path, options, attempt + 1);
    }
    return { ok: false, data: null, error: err };
  }
}

async function requestWithAppKey<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number; retry?: boolean; authToken?: string } = {}): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  if (method !== 'GET') {
    const result = await performRequestWithAppKey<T>(path, options);
    if (result.ok) bumpReadCacheGeneration();
    return result;
  }
  const token = options.authToken ?? await getToken();
  const spec = readCacheSpec(path);
  if (spec) return cachedReadRequest(readCacheKey(path, token), spec, () => performRequestWithAppKey<T>(path, { ...options, authToken: token ?? '' }));
  const key = `${token || ''}|${path}|${options.timeoutMs ?? ''}|${options.retry === false ? '0' : '1'}|${JSON.stringify(options.body ?? null)}`;
  const existing = appKeyRequestFlights.get(key) as Promise<ApiResult<T>> | undefined;
  if (existing) return existing;
  const flight = performRequestWithAppKey<T>(path, { ...options, authToken: token ?? '' });
  appKeyRequestFlights.set(key, flight as Promise<ApiResult<unknown>>);
  try {
    return await flight;
  } finally {
    if (appKeyRequestFlights.get(key) === flight) appKeyRequestFlights.delete(key);
  }
}

export const serverApi = {
  // ── Auth ─────────────────────────────────────────────────────────────────
  sendOtp: (phone: string) => request<{ ok: boolean; message?: string; devCode?: string; error?: string }>('/auth', { method: 'POST', body: { phone } }),
  /** Sign-in existence probe: does this number have an account? Boolean only,
   *  throttled server-side. Lets login redirect unknown numbers to signup. */
  checkPhone: (phone: string) => request<{ exists: boolean }>('/auth/check', { method: 'POST', body: { phone } }),
  // create:true = explicit signup intent (signup screens only). Sign-in
  // screens omit it, so a typo'd number gets 404 needsSignup instead of a
  // silently minted ghost account + welcome money.
  verifyOtp: (phone: string, code: string, create?: boolean) =>
    request<{ token: string; user: Record<string, unknown>; needsSignup?: boolean; attemptsLeft?: number }>('/auth/verify', { method: 'POST', body: create ? { phone, code, create: true } : { phone, code } }),
  emailAuth: (action: 'login' | 'register', email: string, password: string, name?: string) =>
    request<{ token: string; user: Record<string, unknown> }>('/auth/email', { method: 'POST', body: { action, email, password, name } }),
  googleAuth: (idToken: string, devBypass?: { email: string; name?: string }) =>
    // Dev backdoor is DEV-ONLY: prod builds must never send devBypass (server
    // also rejects it unless GOOGLE_DEV_BYPASS=on AND not production). Without
    // this gate a prod client could mint sessions with any chosen email.
    __DEV__ && devBypass
      ? request<{ token: string; user: Record<string, unknown> }>('/auth/google', { method: 'POST', body: { devBypass: true, email: devBypass.email, name: devBypass.name } })
      : request<{ token: string; user: Record<string, unknown> }>('/auth/google', { method: 'POST', body: { idToken } }),
  /** Authoritative profile for the current token - used to self-heal identity after login. */
  getMe: () => request<{ user: Record<string, unknown> }>('/users/me', { timeoutMs: 20000 }),
  /** Revoke the current session token server-side (logout). all=true burns every session on the account. token= revokes a PREVIOUS session (pending offline-logout retry). */
  revokeSession: (all = false, token?: string) =>
    request<{ ok: boolean }>(`/auth${all ? '?all=1' : ''}`, { method: 'DELETE', ...(token ? { authToken: token } : {}) }),


  // ── Posts / feed ─────────────────────────────────────────────────────────
  getPosts: (params: { seller?: string; category?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.seller) qs.set('seller', params.seller);
    if (params.category) qs.set('category', params.category);
    if (params.q) qs.set('q', params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ posts: any[] }>(`/posts${suffix}`);
  },
  searchMarketplace: (params: { q: string; mode?: SearchMode; types?: SearchKind[]; limit?: number }) => {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    if (params.mode) qs.set('mode', params.mode);
    if (params.types?.length) qs.set('types', params.types.join(','));
    if (typeof params.limit === 'number') qs.set('limit', String(params.limit));
    return request<SearchResponse>(`/search?${qs.toString()}`, { timeoutMs: 10000 });
  },
  createPost: (post: Record<string, unknown>) => request<{ post: any }>('/posts', { method: 'POST', body: post }),
  getPost: (id: string) => request<{ post: any }>(`/posts/${encodeURIComponent(id)}`),
  updatePost: (id: string, patch: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deletePost: (id: string) => request<{ ok: boolean }>(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  toggleLike: (id: string) => request<{ liked: boolean; likes: number }>(`/posts/${encodeURIComponent(id)}/like`, { method: 'POST' }),
  getComments: (id: string) => request<{ comments: ServerComment[] }>(`/posts/${encodeURIComponent(id)}/comments`),
  addComment: (id: string, text: string, parentId?: string, displayName?: string) =>
    request<{ comment: any }>(`/posts/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: { text, ...(parentId ? { parentId } : {}), ...(displayName ? { displayName } : {}) },
    }),
  likeComment: (id: string, cid: string) =>
    request<{ likes: number; likedByMe: boolean }>(`/posts/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}/like`, { method: 'POST' }),
  getLikers: (id: string) =>
    request<{ likes: Array<{ username: string; name: string }> }>(`/posts/${encodeURIComponent(id)}/like`),
  // ── Reels (server-distributed; device cache is offline mirror only) ──
  getReels: (seller?: string) => {
    const qs = seller ? `?seller=${encodeURIComponent(seller)}` : '';
    return request<{
      reels: Array<{
        id: string; title: string; caption: string; mediaUrl: string;
        creatorName: string; creatorUsername: string; views: number; likes: number; createdAt: number;
      }>;
    }>(`/reels${qs}`);
  },
  createReel: (body: { mediaUrl: string; caption?: string }) =>
    request<{ reel: { id: string } }>('/reels', { method: 'POST', body }),
  /** Count one watch (server increments; throttled per IP). Fire-and-forget. */
  viewReel: (id: string) =>
    request<{ ok: boolean }>('/reels', { method: 'PATCH', body: { id, action: 'view' } }),
  /** Explicit-state reel like (server toggle row + counter). Fire-and-forget:
   *  the local animation stays on failure (offline), reconciling on next load. */
  likeReel: (id: string, liked: boolean) =>
    request<{ ok: boolean; liked: boolean; likes: number }>('/reels', { method: 'PATCH', body: { id, action: 'like', value: liked } }),

  // ── Price watches (server bell on drops; local banner logic stays) ──────
  getWatches: () => request<{ watches: { listingId: string; priceAtWatch: number }[] }>('/watches'),
  watchPrice: (listingId: string) =>
    request<{ ok: boolean }>('/watches', { method: 'POST', body: { listingId } }),
  unwatchPrice: (listingId: string) =>
    request<{ ok: boolean }>('/watches', { method: 'DELETE', body: { listingId } }),
  endPromotion: (id: string, postId?: string) =>
    request<{ ok: boolean; status: string }>('/promotions', {
      method: 'PATCH',
      body: { id, ...(postId ? { postId } : {}) },
    }),
  reportPost: (postId: string, reason: string) =>
    request<{ ok: boolean; id: string; reports: number }>('/reports', {
      method: 'POST',
      body: { postId, reason },
    }),

  // ── Follows ──────────────────────────────────────────────────────────────
  getFollows: () =>
    request<{ followed: string[]; followerCounts?: Record<string, number>; followers?: string[] }>('/follows'),
  follow: (followed: string, unfollow = false) =>
    request<{ following: boolean }>('/follows', { method: 'POST', body: { followed, unfollow } }),

  // ── Orders ───────────────────────────────────────────────────────────────
  getOrders: (mine?: 'buyer' | 'seller' | 'all') =>
    request<{ orders: any[] }>(`/orders${mine ? `?mine=${mine}` : ''}`),
  /** Ownership-scoped single order (deep links, cold cache). 404 when the
   *  row doesn't exist OR isn't yours — same shape, no existence oracle. */
  getOrder: (id: string) => request<{ order: any }>(`/orders/${encodeURIComponent(id)}`),
  placeOrder: (order: Record<string, unknown>) => request<{ order: any }>('/orders', { method: 'POST', body: order }),
  updateOrder: (id: string, patch: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  /** Seller refund decision — settles real money server-side (single writer).
   *  Rejects when the caller isn't the seller or no request is pending. */
  respondRefund: (id: string, decision: 'approved' | 'rejected', note?: string) =>
    request<{ ok: boolean }>(`/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { refundDecision: decision, ...(note ? { decisionNote: note } : {}) } }),

  // ── Wallet ───────────────────────────────────────────────────────────────
  getWallet: () => request<{ balance: number; loyaltyPoints: number; transactions: any[] }>('/wallet'),
  // Positive amounts are only accepted as gated top-ups (type: 'topup');
  // debits (negative) mirror real spend from checkout/promotions/payouts.
  walletTx: (amount: number, title: string, detail: string, type?: string, ref?: string) =>
    request<{ balance: number }>('/wallet', { method: 'POST', body: { amount, title, detail, ...(type ? { type } : {}), ...(ref ? { ref } : {}) } }),

  // ── Chat ─────────────────────────────────────────────────────────────────
  getThreads: () => request<{ threads: any[] }>('/chat/threads'),
  createThread: (participant: string) =>
    request<{ thread: any }>('/chat/threads', { method: 'POST', body: { participant } }),
  getMessages: (threadId: string) =>
    request<{ threadId: string; messages: any[] }>(`/chat/threads/${encodeURIComponent(threadId)}/messages`),
  sendMessage: (threadId: string, body: string, offer?: { amount: number; productId: string; productName: string }) =>
    request<{ message: any }>(`/chat/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      body: offer ? { body, offer } : { body },
    }),
  /** Seller hero banners (public read): the cross-device truth. The editor
   *  syncs here; per-device AsyncStorage is fallback only. */
  getStorefrontBanners: (seller: string) =>
    request<{ banners: { id: string; title: string; subtitle?: string | null; ctaLabel?: string | null; imageUrl?: string | null; size?: string | null }[] }>(
      `/storefront-banners?seller=${encodeURIComponent(seller)}`
    ),
  /** My own seller application (server truth — survives reopen/relogin).
   *  null = never applied or withdrawn. */
  getSellerApplication: () =>
    request<{ application: {
      id: string; businessName: string; category: string; status: string;
      submittedAt: number; docCount: number; verifiedDocs: number;
      lastDecision: { action: string; note: string; at: number } | null;
    } | null }>('/sellers/me'),
  /** Withdraw my own pending application (owner only, pending only). */
  withdrawSellerApplication: () =>
    request<{ ok: boolean; withdrawn: boolean }>('/sellers/me', { method: 'DELETE' }),
  /** Shop profile extras (Seller row — cross-device truth; localOnly when the
   *  server predates the columns, so the app keeps its device copy honestly). */
  updateShopProfile: (body: { tagline?: string; email?: string; phone?: string; hours?: string; address?: string }) =>
    request<{ ok: boolean; localOnly?: boolean; shop?: { tagline: string; hours: string } }>('/sellers/me', { method: 'PATCH', body }),
  /** My disputes (raised by or against me) — cross-device truth. */
  getDisputes: () => request<{ disputes: any[] }>('/disputes'),
  /** Raise a dispute on my order (server row — the desk sees it). Idempotent
   *  per open dispute: re-raising returns the existing row. */
  createDispute: (dispute: { orderRef: string; reason: string; description?: string }) =>
    request<{ dispute: any }>('/disputes', { method: 'POST', body: dispute }),
  /** Server-owned campaign purchase: debit + ACTIVE placement in one tx.
   *  Idempotent on checkoutRef — safe to retry after a timeout. */
  purchasePromotion: (order: { packageId: string; postId?: string; checkoutRef: string; discountedPrice?: number }) =>
    request<{ purchase: any }>('/promotions', { method: 'POST', body: order }),
  /** Accept / decline / counter a pending offer (either participant). */
  updateOfferStatus: (threadId: string, messageId: string, status: 'accepted' | 'declined' | 'countered') =>
    request<{ ok: boolean }>(`/chat/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'PATCH',
      body: { messageId, status },
    }),
  /** Pinned-chat VAS: the SERVER owns the debit (atomic debit + pin, server
   *  price). The client must not pre-debit — doing both charged 2x per pin. */
  pinThread: (threadId: string, days: number, ref?: string) =>
    request<{ pinnedUntil: number; days: number }>(`/chat/threads/${encodeURIComponent(threadId)}/pin`, {
      method: 'POST',
      body: { days, ...(ref ? { ref } : {}) },
    }),

  // ── Stories (REAL 24h stories, not post-derived) ──────────────────────────
  getStories: () => request<{ stories: any[] }>('/stories'),
  createStory: (payload: {
    image: string;
    caption?: string;
    durationMs?: number;
    overlays?: { text: string; zone: 'top' | 'middle' | 'bottom' }[];
    productRef?: { id: string; title: string; image?: string; price?: number };
  }) => request<{ story: any }>('/stories', { method: 'POST', body: payload }),

  // ── Paid promotion placements (feed source of truth; read-only) ──────────
  getPromotions: () => request<{ promotions: any[] }>('/promotions'),

  // ── Live shopping (REAL LiveStream rows; video broadcasting arrives with a
  //    streaming backend — rooms, lifecycle and listing are real) ─────────────
  getLiveStreams: () => request<{ streams: any[] }>('/live'),
  startLiveStream: (title: string) =>
    request<{ stream: any }>('/live', { method: 'POST', body: { title } }),
  endLiveStream: (id: string) =>
    request<{ ok: boolean }>(`/live/${encodeURIComponent(id)}`, { method: 'PATCH' }),

  // ── Auctions ─────────────────────────────────────────────────────────────
  getAuctions: () => request<{ auctions: any[] }>('/auctions'),
  /** Single auction with server-resolved top bid (winner truth — the local
   *  thread never sees rival phones' bids). */
  getAuction: (auctionId: string) =>
    request<{ auction: any }>(`/auctions/${encodeURIComponent(auctionId)}`),
  placeBid: (auctionId: string, amount: number) =>
    request<{ bid: any; currentBid: number }>('/auctions', { method: 'POST', body: { auctionId, amount } }),
  /** Seller creates a live auction (server row — every device sees it). */
  createAuction: (payload: { title: string; startPrice: number; durationHours?: number; imageKey?: string }) =>
    request<{ auction: any }>('/auctions', { method: 'POST', body: payload }),

  // ── Bundle deals (server catalog; legacy rows without items link shop) ───
  getBundles: () => request<{ bundles: any[] }>('/bundles'),
  /** Seller composes a combo from own live listings (server validates). */
  createBundle: (body: { title: string; items: string[]; price: number }) =>
    request<{ ok: boolean; bundle: { id: string } }>('/bundles', { method: 'POST', body }),

  // ── Broadcast channels (server directory; joins stay local prefs) ─────────
  getBroadcasts: () => request<{ broadcasts: any[] }>('/broadcasts'),

  // ── Communities ──────────────────────────────────────────────────────────
  getCommunities: () => request<{ communities: any[] }>('/communities'),
  toggleCommunityJoin: (communityId: string, joined: boolean) =>
    request<{ ok: boolean }>(`/communities/${encodeURIComponent(communityId)}/join`, { method: 'POST', body: { joined } }),
  sendCommunityMessage: (communityId: string, text: string) =>
    request<{ message: any }>('/communities', { method: 'POST', body: { communityId, text } }),
  /** Room history (server truth — every member sees every message). */
  getCommunityMessages: (communityId: string) =>
    request<{ messages: any[] }>(`/communities/${encodeURIComponent(communityId)}/messages`),
  /** Create a shared community (server row — everyone sees it). Offline falls
   *  back to a local-only row in the caller. */
  createCommunity: (community: { name: string; description?: string; type?: string }) =>
    request<{ community: any }>('/communities', { method: 'POST', body: community }),
  /** Shared polls (server vote truth; localOnly fallback pre-migration). */
  getPolls: (communityId: string) =>
    request<{ polls: { id: string; question: string; options: { id: string; text: string }[]; votes: number[]; votedOption: string | null; createdBy: string; createdAt: number }[] }>(`/communities/${encodeURIComponent(communityId)}/polls`),
  createPoll: (communityId: string, question: string, options: string[]) =>
    request<{ ok: boolean; localOnly?: boolean; poll?: { id: string } }>(`/communities/${encodeURIComponent(communityId)}/polls`, { method: 'POST', body: { question, options } }),
  votePoll: (communityId: string, pollId: string, optionId: string) =>
    request<{ ok: boolean; localOnly?: boolean }>(`/communities/${encodeURIComponent(communityId)}/polls`, { method: 'POST', body: { pollId, optionId } }),

  // ── User blocks (server enforcement; local list stays as offline mirror) ─
  getBlocks: () => request<{ blocked: string[] }>('/blocks'),
  blockUser: (username: string) =>
    request<{ ok: boolean }>('/blocks', { method: 'POST', body: { username } }),
  unblockUser: (username: string) =>
    request<{ ok: boolean }>('/blocks', { method: 'DELETE', body: { username } }),

  // ── Notifications ────────────────────────────────────────────────────────
  getNotifications: (before?: number) =>
    request<{ notifications: any[]; unreadCount: number }>(
      typeof before === 'number' && Number.isFinite(before) ? `/notifications?before=${before}` : '/notifications'
    ),
  markNotificationsRead: (id?: string) =>
    request<{ ok: boolean }>('/notifications', { method: 'POST', body: id ? { id } : {} }),

  // ── Users ────────────────────────────────────────────────────────────────
  getUserProfile: (username: string) =>
    request<{
      user: any;
      posts: any[];
      reviews?: Array<{ id: string; reviewer: string; rating: number; text?: string; product?: string; createdAt: number }>;
    }>(`/users/${encodeURIComponent(username)}`),
  updateProfile: (patch: Record<string, unknown>) =>
    request<{ user: Record<string, unknown> }>('/users/me', { method: 'PATCH', body: patch, timeoutMs: 20000 }),
  /** Live DB availability probe for a signup handle (debounced by caller). */
  checkUsername: (username: string) =>
    request<{ available: boolean; reason?: string; mine?: boolean }>(
      `/users/check-username?u=${encodeURIComponent(username)}`,
      { timeoutMs: 20000 }
    ),
  /** One-time handle claim for fresh accounts (409 taken, 403 active). */
  claimUsername: (username: string) =>
    request<{ user: Record<string, unknown> }>('/users/claim-username', {
      method: 'POST',
      body: { username },
      timeoutMs: 20000,
    }),

  // ─── Platform-curated home content (admin home-management) ─────────────
  getHome: () =>
    requestWithAppKey<{
      topSellers: Array<{ sellerId: string; sellerUsername?: string | null; sellerName: string; sellerLogo?: string | null; totalSales?: number; rating?: number; reviewCount?: number; position?: number; isPinned?: boolean | null }>;
      hotDeals: Array<{ productId: string; postId?: string | null; productName: string; productImage?: string | null; originalPrice?: number; discountedPrice?: number; discountPercentage?: number; priority?: number }>;
      marketingBanners: Array<{
        id: string;
        sellerUsername: string;
        sellerName: string;
        title: string;
        subtitle?: string | null;
        ctaLabel?: string | null;
        imageUrl?: string | null;
        size?: string | null;
        position?: number | null;
      }>;
      featuredPosts?: Array<{
        id: string;
        postId: string;
        title: string;
        excerpt?: string | null;
        imageUrl?: string | null;
        position?: number | null;
        isPinned?: boolean | null;
      }>;
      spotlight?: {
        id: string;
        postId?: string | null;
        productId?: string | null;
        sellerId: string;
        sellerName: string;
        sellerLogo?: string | null;
        title: string;
        imageUrl?: string | null;
      } | null;
      // Admin rail visibility ("Show on home page"). Missing key = ON —
      // the server defaults every rail on; OFF hides the rail client-side.
      sections?: Record<string, boolean>;
      degraded?: boolean;
      // Highest fan-out route (serve-time reads): 15s budget + safe GET
      // retry so one cold hop doesn't poison the feed banner.
    }>('/api/v1/home', { timeoutMs: 15000 }),

  // ── Address book (server truth, cross-device; device cache is offline mirror)
  getAddresses: () =>
    requestWithAppKey<{ addresses: { id: string; type: string; name: string; street: string; city: string; phone: string; isDefault: boolean }[] }>('/api/app/addresses'),
  addAddress: (body: { type: string; street: string; city: string; phone: string; isDefault?: boolean }) =>
    requestWithAppKey<{ address: { id: string } }>('/api/app/addresses', { method: 'POST', body }),
  /** Edit an owned address (server validates + persists; owner-checked). */
  updateAddress: (body: { id: string; type?: string; street?: string; city?: string; phone?: string }) =>
    requestWithAppKey<{ ok: boolean }>('/api/app/addresses', { method: 'PATCH', body }),
  /** Delete an owned address (server re-homes the default). */
  deleteAddress: (id: string) =>
    requestWithAppKey<{ ok: boolean }>(`/api/app/addresses?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ─── Marketing banners (seller dashboard → admin sync) ─────────────────
  // Upload a banner image picked in the seller dashboard. Returns a
  // root-relative URL served by the admin panel (prefix with getAdminUrl()).
  // ── Wallet payouts (read-your-records; ownership enforced server-side) ────
  getWithdrawals: () => requestWithAppKey<{ withdrawals: { id: string; amount: number; status: string; requestedAt: string; respondedAt: string | null }[] }>('/api/app/withdrawals'),

  // Submit a payout request. TRANSACTIONAL on the server: the wallet debit
  // (amount + payout fee) and the desk row (status "requested") commit in one
  // database transaction — the client never orchestrates two-phase money moves.
  // method travels to the server so the desk pays the chosen rail (bank/UPI).
  // ref is a per-tap idempotency key (reused across timeout-retries): the
  // server mints a deterministic walletTx title per ref so a retry collides
  // instead of double-debiting.
  // feePreview is the fee the gate showed: the server 400s when the live fee
  // moved since (fail-closed reconfirm, never a surprise debit).
  requestPayout: (amount: number, method: 'bank' | 'upi' = 'bank', ref?: string, destination?: string, feePreview?: number) =>
    requestWithAppKey<{ ok: boolean; withdrawalId: string; deduped?: boolean; destination?: string }>('/api/app/wallet/payout', { method: 'PUT', body: { amount, method, ...(ref ? { ref } : {}), ...(destination ? { destination } : {}), ...(typeof feePreview === 'number' ? { feePreview } : {}) } }),

  // Upload a local image and get back a hosted /uploads/... URL (root-relative
  // — prefix with getAdminUrl()). 60s budget: photo bodies are megabytes.
  uploadBannerImage: (dataUrl: string) =>
    requestWithAppKey<{ ok: boolean; url: string }>('/api/app/upload', { method: 'POST', body: { dataUrl }, timeoutMs: 60000 }),

  // Sync one marketing banner to the admin (POST=create with flat payload,
  // PATCH=update with { id, data } wrapper).
  syncStorefrontBanner: (banner: {
    id: string;
    sellerUsername: string;
    sellerName: string;
    title: string;
    subtitle?: string;
    ctaLabel?: string;
    imageUrl?: string;
    imageIndex?: number;
    size?: string;
    status?: string;
  }, method: 'POST' | 'PATCH' = 'POST') =>
    method === 'POST'
      ? requestWithAppKey<{ row?: Record<string, unknown> }>('/api/data/storefront-banners', { method, body: banner })
      : requestWithAppKey<{ row?: Record<string, unknown> }>('/api/data/storefront-banners', {
          method,
          // PATCH contract is { id, data } — and `data` must NOT carry the id
          // itself (Prisma update payload).
          body: (() => {
            const { id: _stripped, ...rest } = banner;
            void _stripped;
            return { id: banner.id, data: rest };
          })(),
        }),

  // Remove a marketing banner from the admin.
  deleteStorefrontBanner: (id: string) =>
    requestWithAppKey<{ ok?: boolean }>('/api/data/storefront-banners', { method: 'DELETE', body: { id } }),

  // ─── Asset upload (dedicated area for entire app, later S3 bucket) ──────
  // ─── Coupons (live from DB, replaces hardcoded client values) ───────
  getCoupons: () =>
    request<{ coupons: Array<{ code: string; type: string; value: number; expiresAt: string }> }>('/coupons'),

  // ─── Categories (admin-owned catalog: name/slug/banner image/tree) ──────
  getCategories: () =>
    requestWithAppKey<{
      categories: Array<{ id: string; name: string; slug: string; icon?: string | null; bannerImage?: string | null; featured?: boolean; productCount?: number; children?: Array<{ name: string; slug: string }> }>;
    }>('/api/app/categories'),
};