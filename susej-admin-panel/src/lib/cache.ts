import { revalidateTag, unstable_cache } from "next/cache";

type RedisConfig = { url: string; token: string };
type CacheRecord<T> = { value: T; freshUntil: number; staleUntil: number };
type CacheOptions = { freshMs?: number; staleMs?: number; maxBytes?: number };
type Loader<T> = () => Promise<T>;

type RedisEnvelope<T> = { result?: T; error?: string };

const localCache = new Map<string, CacheRecord<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const nextLoaders = new Map<string, () => Promise<unknown>>();
const cacheEpochs = new Map<string, number>();

function redisConfig(): RedisConfig | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function tagFor(key: string): string {
  return `susej-cache:${key.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180)}`;
}

async function redisCommand<T>(config: RedisConfig, command: unknown[]): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as RedisEnvelope<T>;
    if (body.error) return null;
    return body.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readRedis<T>(key: string): Promise<CacheRecord<T> | null> {
  const config = redisConfig();
  if (!config) return null;
  const raw = await redisCommand<string>(config, ["GET", key]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheRecord<T>;
    if (!parsed || typeof parsed.freshUntil !== "number" || typeof parsed.staleUntil !== "number") return null;
    return parsed;
  } catch {
    await redisCommand(config, ["DEL", key]);
    return null;
  }
}

async function writeRedis<T>(key: string, record: CacheRecord<T>, staleMs: number): Promise<void> {
  const config = redisConfig();
  if (!config) return;
  await redisCommand(config, ["SET", key, JSON.stringify(record), "EX", String(Math.max(1, Math.ceil(staleMs / 1000)))]);
}

async function deleteRedis(key: string): Promise<void> {
  const config = redisConfig();
  if (config) await redisCommand(config, ["DEL", key]);
}

function nextLoader<T>(key: string, loader: Loader<T>, epoch: number): () => Promise<T> {
  const loaderKey = `${key}@${epoch}`;
  const existing = nextLoaders.get(loaderKey);
  if (existing) return existing as () => Promise<T>;
  const cached = unstable_cache(loader, ["susej-db-cache-v2", loaderKey], {
    revalidate: 60,
    tags: [tagFor(key)],
  });
  nextLoaders.set(loaderKey, cached as () => Promise<unknown>);
  return cached as () => Promise<T>;
}

async function refresh<T>(key: string, loader: Loader<T>, options: Required<CacheOptions>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const epoch = cacheEpochs.get(key) ?? 0;
  let promise: Promise<T>;
  promise = (async () => {
    let value: T;
    try {
      value = await nextLoader(key, loader, epoch)();
    } catch (error) {
      if (error instanceof Error && error.message.includes("incrementalCache missing")) value = await loader();
      else throw error;
    }
    if ((cacheEpochs.get(key) ?? 0) !== epoch) return value;
    // A loader that resolves to `undefined` is a contract violation, and it used
    // to take the whole request down: `JSON.stringify(undefined)` returns
    // undefined (NOT a string), so `serialized.length` threw
    // "Cannot read properties of undefined (reading 'length')" and every caller
    // got an opaque 500 with an empty body. It is exactly what killed the chat
    // inbox in production (GET /api/app/chat/threads, 8/8 requests, 500) while
    // the write path and the per-thread read kept working.
    //
    // `undefined` also cannot round-trip: the Data Cache (KV/Redis-backed on
    // Vercel) stores JSON, and a stored `undefined` comes back as `undefined`
    // forever, so one bad run poisons every later request on the same key.
    // Normalize to `null` (an honest "no value", which IS valid JSON) and never
    // read `.length` off a possibly-absent serialization.
    if (value === undefined) value = null as T;
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string" && serialized.length <= options.maxBytes) {
      const now = Date.now();
      const record: CacheRecord<T> = {
        value,
        freshUntil: now + options.freshMs,
        staleUntil: now + options.staleMs,
      };
      localCache.set(key, record as CacheRecord<unknown>);
      await writeRedis(key, record, options.staleMs);
      if ((cacheEpochs.get(key) ?? 0) !== epoch) {
        localCache.delete(key);
        await deleteRedis(key);
      }
    }
    return value;
  })().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise as Promise<unknown>);
  return promise;
}

export async function cachedRead<T>(key: string, loader: Loader<T>, input: CacheOptions = {}): Promise<T> {
  const options: Required<CacheOptions> = {
    freshMs: input.freshMs ?? 30_000,
    staleMs: input.staleMs ?? 300_000,
    maxBytes: input.maxBytes ?? 512_000,
  };
  const now = Date.now();
  const local = localCache.get(key) as CacheRecord<T> | undefined;
  // A cache HIT is a promise about the value, and a poisoned one used to
  // outlive every repair: `undefined` (or a non-object) is returned straight to
  // the caller, the loader never runs again, and the endpoint is dead for good.
  // That is exactly how the production chat inbox stopped returning threads
  // while every other chat route kept working. A hit that cannot serve the
  // caller is not a hit - drop it and reload.
  const serves = (record: CacheRecord<T> | undefined): record is CacheRecord<T> =>
    !!record && record.value !== undefined && record.value !== null;
  if (serves(local) && now < local.freshUntil) return local.value;
  if (serves(local) && now < local.staleUntil) {
    void refresh(key, loader, options).catch(() => undefined);
    return local.value;
  }
  if (local && !serves(local)) localCache.delete(key);

  const readEpoch = cacheEpochs.get(key) ?? 0;
  const remote = await readRedis<T>(key);
  if (remote && readEpoch === (cacheEpochs.get(key) ?? 0)) {
    if (serves(remote)) {
      localCache.set(key, remote as CacheRecord<unknown>);
      if (now < remote.freshUntil) return remote.value;
      if (now < remote.staleUntil) {
        void refresh(key, loader, options).catch(() => undefined);
        return remote.value;
      }
    } else {
      // Poisoned remote entry: evict it so the fresh write below replaces it.
      await deleteRedis(key);
    }
  }

  try {
    return await refresh(key, loader, options);
  } catch (error) {
    const fallback = localCache.get(key) as CacheRecord<T> | undefined;
    if (serves(fallback) && now < fallback.staleUntil) return fallback.value;
    throw error;
  }
}

export async function invalidateCache(...keys: string[]): Promise<void> {
  const config = redisConfig();
  await Promise.all(keys.map(async (key) => {
    cacheEpochs.set(key, (cacheEpochs.get(key) ?? 0) + 1);
    localCache.delete(key);
    inFlight.delete(key);
    for (const loaderKey of nextLoaders.keys()) {
      if (loaderKey.startsWith(`${key}@`)) nextLoaders.delete(loaderKey);
    }
    revalidateTag(tagFor(key), { expire: 0 });
    if (config) await redisCommand(config, ["DEL", key]);
  }));
}

export function cacheKey(namespace: string, ...parts: Array<string | number | boolean | null | undefined>): string {
  return [namespace, ...parts].map((part) => encodeURIComponent(String(part ?? ""))).join(":");
}
