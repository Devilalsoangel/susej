import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

const SEARCH_KINDS = ["user", "product", "category", "location"] as const;

type SearchKind = (typeof SEARCH_KINDS)[number];
type SearchMode = "suggest" | "results";
type ProductType = "product" | "service" | "food_item";

type PublicVariantValue = {
  label: string;
  priceDelta?: number;
  stock?: number;
};

type PublicVariant = {
  name: string;
  values: PublicVariantValue[];
};

type UserSearchHit = {
  kind: "user";
  username: string;
  name: string;
  businessName: string;
  displayName: string;
  avatar: string | null;
  location: string;
  category: string;
  isSeller: boolean;
  verified: boolean;
};

type ProductSearchHit = {
  kind: "product";
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
  type: ProductType;
  hashtags: string[];
  likes: number;
  comments: number;
  createdAt: number;
  isSold: boolean;
  featured: boolean;
  condition: string | null;
  brand: string | null;
  variants: PublicVariant[] | null;
  stockLeft: number | null;
  negotiable: boolean | null;
  deliveryMode: string | null;
  images: string[];
  image: string;
};

type CategoryChild = {
  id: string;
  name: string;
  slug: string;
};

type CategorySearchHit = {
  kind: "category";
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  bannerImage: string | null;
  featured: boolean;
  parentId: string | null;
  parentName: string | null;
  parentSlug: string | null;
  children: CategoryChild[];
};

type LocationSearchHit = {
  kind: "location";
  label: string;
  count: number;
  userCount: number;
  postCount: number;
};

type SearchHit = UserSearchHit | ProductSearchHit | CategorySearchHit | LocationSearchHit;
type SearchCounts = Record<SearchKind, number> & { total: number };

type SearchResponse = {
  query: string;
  mode: SearchMode;
  types: SearchKind[];
  limit: number;
  hits: SearchHit[];
  counts: SearchCounts;
  degraded: boolean;
  unavailable: SearchKind[];
  hasMore: boolean;
};

type SearchKindResult = {
  kind: SearchKind;
  hits: SearchHit[];
  hasMore: boolean;
  partial?: boolean;
};

type AuthorProfile = {
  username: string;
  name: string;
  businessName: string | null;
  verification: string;
};

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const LOCATION_NOISE = /\b(?:address|apartment|behind|block|building|compound|complex|door|flat|floor|gate|house|lane|landmark|near|no\.?|opposite|pincode|plot|postal|road|sector|shop|store|street)\b/i;

function canonicalUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
}

function normalizeSearchQuery(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function usernameHandles(values: Array<string | null | undefined>): string[] {
  const handles = values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const canonical = canonicalUsername(value);
    return canonical ? [value, canonical] : [];
  });
  return Array.from(new Set(handles));
}

function jsonLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function publicText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(EMAIL_PATTERN, "")
    .replace(PHONE_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function publicMedia(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("/"))) return null;
  return trimmed.slice(0, 2048);
}

function publicStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .filter((item): item is string => typeof item === "string")
    .map((item) => publicText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function publicMediaList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 10)
    .map((item) => publicMedia(item))
    .filter((item): item is string => !!item)
    .slice(0, 10);
}

function publicVariants(value: unknown): PublicVariant[] | null {
  if (!Array.isArray(value)) return null;
  const groups: PublicVariant[] = [];
  for (const rawGroup of value.slice(0, 20)) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const group = rawGroup as Record<string, unknown>;
    const name = publicText(group.name, 60);
    if (!name || !Array.isArray(group.values)) continue;
    const variants: PublicVariantValue[] = [];
    for (const rawValue of group.values.slice(0, 50)) {
      if (!rawValue || typeof rawValue !== "object") continue;
      const variant = rawValue as Record<string, unknown>;
      const label = publicText(variant.label, 60);
      if (!label) continue;
      const safeValue: PublicVariantValue = { label };
      if (typeof variant.priceDelta === "number" && Number.isFinite(variant.priceDelta) && Math.abs(variant.priceDelta) <= 10000000) {
        safeValue.priceDelta = Math.round(variant.priceDelta);
      }
      if (typeof variant.stock === "number" && Number.isFinite(variant.stock) && variant.stock >= 0 && variant.stock <= 100000) {
        safeValue.stock = Math.floor(variant.stock);
      }
      variants.push(safeValue);
    }
    if (variants.length) groups.push({ name, values: variants });
  }
  return groups.length ? groups : null;
}

function coarseLocation(value: unknown, query?: string): string {
  const text = publicText(value, 240);
  if (!text) return "";
  const parts = text
    .split(/[,;|]/)
    .map((part) => part.split(/\s+/).filter((token) => !/\d/.test(token)).filter((token) => !LOCATION_NOISE.test(token)).join(" ").trim())
    .filter((part) => {
      if (!/[a-z\u0900-\u097f]/i.test(part)) return false;
      if (part.includes("@")) return false;
      return true;
    });
  if (query) {
    const matching = parts.filter((part) => part.toLowerCase().includes(query));
    if (matching.length) return matching.slice(0, 2).join(", ").slice(0, 120);
  }
  return parts.slice(0, 2).join(", ").slice(0, 120);
}

function productType(value: string): ProductType {
  return value === "service" || value === "food_item" ? value : "product";
}

function toUserHit(user: {
  name: string;
  username: string | null;
  avatar: string | null;
  location: string | null;
  isSeller: boolean;
  businessName: string | null;
  category: string | null;
  verification: string;
}): UserSearchHit | null {
  if (!user.username) return null;
  const username = canonicalUsername(user.username);
  if (!username) return null;
  const name = publicText(user.name, 80);
  const businessName = publicText(user.businessName, 120);
  return {
    kind: "user",
    username,
    name,
    businessName,
    displayName: businessName || name,
    avatar: publicMedia(user.avatar),
    location: coarseLocation(user.location),
    category: publicText(user.category, 60),
    isSeller: user.isSeller,
    verified: user.verification === "approved",
  };
}

function toProductHit(
  post: {
    id: string;
    title: string;
    description: string | null;
    authorName: string;
    authorUsername: string | null;
    sellerLocation: string | null;
    verified: boolean;
    price: number | null;
    mrp: number | null;
    category: string | null;
    subCategories: unknown;
    type: string;
    hashtags: unknown;
    likes: number;
    comments: number;
    isSold: boolean;
    featured: boolean;
    condition: string | null;
    brand: string | null;
    variants: unknown;
    stockLeft: number | null;
    negotiable: boolean | null;
    deliveryMode: string | null;
    images: unknown;
    createdAt: Date;
  },
  author: AuthorProfile | undefined,
): ProductSearchHit {
  const price = typeof post.price === "number" && Number.isFinite(post.price) ? Math.max(0, post.price) : 0;
  const images = publicMediaList(post.images);
  const description = publicText(post.description, 500);
  const title = publicText(post.title, 200) || description.split(" ")[0] || "Untitled listing";
  return {
    kind: "product",
    id: post.id,
    title,
    description,
    sellerName: publicText(author?.businessName || author?.name || post.authorName, 120),
    sellerUsername: canonicalUsername(post.authorUsername),
    sellerLocation: coarseLocation(post.sellerLocation),
    verified: author ? author.verification === "approved" : post.verified,
    price,
    mrp: typeof post.mrp === "number" && Number.isFinite(post.mrp) && post.mrp > price ? post.mrp : null,
    category: publicText(post.category, 60),
    subCategories: publicStringList(post.subCategories, 20, 60),
    type: productType(post.type),
    hashtags: publicStringList(post.hashtags, 30, 50),
    likes: Math.max(0, post.likes),
    comments: Math.max(0, post.comments),
    createdAt: post.createdAt.getTime(),
    isSold: post.isSold,
    featured: post.featured,
    condition: publicText(post.condition, 40) || null,
    brand: publicText(post.brand, 80) || null,
    variants: publicVariants(post.variants),
    stockLeft: typeof post.stockLeft === "number" && Number.isFinite(post.stockLeft) ? Math.max(0, Math.floor(post.stockLeft)) : null,
    negotiable: post.negotiable,
    deliveryMode: publicText(post.deliveryMode, 30) || null,
    images,
    image: images[0] ?? "",
  };
}

async function searchUsers(db: PrismaClient, q: string, limit: number): Promise<SearchKindResult> {
  const rows = await db.user.findMany({
    where: {
      status: "active",
      username: { not: null },
      OR: [
        { username: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { businessName: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      name: true,
      username: true,
      avatar: true,
      location: true,
      isSeller: true,
      businessName: true,
      category: true,
      verification: true,
    },
    orderBy: [{ isSeller: "desc" }, { joinedAt: "desc" }],
    take: limit + 1,
  });
  return {
    kind: "user",
    hits: rows.slice(0, limit).map(toUserHit).filter((hit): hit is UserSearchHit => !!hit),
    hasMore: rows.length > limit,
  };
}

async function searchProducts(db: PrismaClient, q: string, limit: number): Promise<SearchKindResult> {
  let partial = false;
  let authorUsernames: string[] = [];
  try {
    const authors = await db.user.findMany({
      where: {
        status: "active",
        username: { not: null },
        OR: [
          { username: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { businessName: { contains: q, mode: "insensitive" } },
          { location: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { username: true },
      take: 50,
    });
    authorUsernames = usernameHandles(authors.map((author) => author.username));
  } catch {
    partial = true;
  }

  let jsonMatchIds: string[] = [];
  try {
    const pattern = jsonLikePattern(q);
    const jsonRows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Post"
      WHERE "status" = 'published'
        AND ("subCategories"::text ILIKE ${pattern} OR "hashtags"::text ILIKE ${pattern})
      ORDER BY "createdAt" DESC
      LIMIT ${limit + 1}
    `);
    jsonMatchIds = jsonRows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  } catch {
    partial = true;
  }

  const or: Prisma.PostWhereInput[] = [
    { title: { contains: q, mode: "insensitive" } },
    { description: { contains: q, mode: "insensitive" } },
    { category: { contains: q, mode: "insensitive" } },
    { brand: { contains: q, mode: "insensitive" } },
    { authorName: { contains: q, mode: "insensitive" } },
    { authorUsername: { contains: q, mode: "insensitive" } },
    { sellerLocation: { contains: q, mode: "insensitive" } },
    { listingLocation: { contains: q, mode: "insensitive" } },
  ];
  if (authorUsernames.length) {
    or.push(...authorUsernames.map((username) => ({ authorUsername: { equals: username, mode: "insensitive" as const } })));
  }
  if (jsonMatchIds.length) or.push({ id: { in: jsonMatchIds } });

  const rows = await db.post.findMany({
    where: { status: "published", OR: or },
    select: {
      id: true,
      title: true,
      description: true,
      authorName: true,
      authorUsername: true,
      sellerLocation: true,
      verified: true,
      price: true,
      mrp: true,
      category: true,
      subCategories: true,
      type: true,
      hashtags: true,
      likes: true,
      comments: true,
      isSold: true,
      featured: true,
      condition: true,
      brand: true,
      variants: true,
      stockLeft: true,
      negotiable: true,
      deliveryMode: true,
      images: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const authorNames = usernameHandles(page.map((post) => post.authorUsername));
  const authors = new Map<string, AuthorProfile>();
  if (authorNames.length) {
    try {
      const profiles = await db.user.findMany({
        where: {
          status: "active",
          OR: authorNames.map((username) => ({ username: { equals: username, mode: "insensitive" as const } })),
        },
        select: { username: true, name: true, businessName: true, verification: true },
      });
      for (const profile of profiles) {
        const username = canonicalUsername(profile.username);
        if (username) authors.set(username, { username, name: profile.name, businessName: profile.businessName, verification: profile.verification });
      }
    } catch {
      partial = true;
    }
  }

  return {
    kind: "product",
    hits: page.map((post) => toProductHit(post, post.authorUsername ? authors.get(canonicalUsername(post.authorUsername)) : undefined)),
    hasMore: rows.length > limit,
    ...(partial ? { partial: true } : {}),
  };
}

async function searchCategories(db: PrismaClient, q: string, limit: number): Promise<SearchKindResult> {
  const categoryText: Prisma.CategoryWhereInput[] = [
    { name: { contains: q, mode: "insensitive" } },
    { slug: { contains: q, mode: "insensitive" } },
    { description: { contains: q, mode: "insensitive" } },
  ];
  const rows = await db.category.findMany({
    where: {
      status: "active",
      OR: [
        ...categoryText,
        { children: { some: { status: "active", OR: categoryText } } },
      ],
    },
    include: {
      parent: { select: { id: true, name: true, slug: true, status: true } },
      children: {
        where: { status: "active" },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        take: 50,
        select: { id: true, name: true, slug: true },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: limit + 1,
  });

  return {
    kind: "category",
    hits: rows.slice(0, limit).map((row) => {
      const parent = row.parent?.status === "active" ? row.parent : null;
      return {
        kind: "category" as const,
        id: row.id,
        name: publicText(row.name, 80),
        slug: publicText(row.slug, 100),
        icon: publicText(row.icon, 80) || null,
        bannerImage: publicMedia(row.bannerImage),
        featured: row.featured,
        parentId: parent?.id ?? null,
        parentName: parent ? publicText(parent.name, 80) || null : null,
        parentSlug: parent ? publicText(parent.slug, 100) || null : null,
        children: row.children.map((child) => ({ id: child.id, name: publicText(child.name, 80), slug: publicText(child.slug, 100) })),
      };
    }),
    hasMore: rows.length > limit,
  };
}

async function searchLocations(db: PrismaClient, q: string, limit: number): Promise<SearchKindResult> {
  const windowSize = Math.min(99, Math.max(20, limit * 4));
  const [userResult, postResult] = await Promise.allSettled([
    db.user.findMany({
      where: { status: "active", location: { contains: q, mode: "insensitive" } },
      select: { location: true },
      orderBy: { joinedAt: "desc" },
      take: windowSize + 1,
    }),
    db.post.findMany({
      where: {
        status: "published",
        OR: [
          { sellerLocation: { contains: q, mode: "insensitive" } },
          { listingLocation: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { sellerLocation: true, listingLocation: true },
      orderBy: { createdAt: "desc" },
      take: windowSize + 1,
    }),
  ]);

  if (userResult.status === "rejected" && postResult.status === "rejected") throw new Error("Location search unavailable");
  const userRows = userResult.status === "fulfilled" ? userResult.value : [];
  const postRows = postResult.status === "fulfilled" ? postResult.value : [];
  const grouped = new Map<string, { label: string; userCount: number; postCount: number }>();
  const add = (raw: unknown, source: "user" | "post") => {
    const label = coarseLocation(raw, q);
    if (!label) return;
    const key = label.toLocaleLowerCase();
    const entry = grouped.get(key) ?? { label, userCount: 0, postCount: 0 };
    if (source === "user") entry.userCount += 1;
    else entry.postCount += 1;
    grouped.set(key, entry);
  };
  for (const row of userRows) add(row.location, "user");
  for (const row of postRows) {
    add(row.sellerLocation, "post");
    add(row.listingLocation, "post");
  }
  const ordered = Array.from(grouped.values()).sort((a, b) => b.userCount + b.postCount - (a.userCount + a.postCount) || a.label.localeCompare(b.label));
  return {
    kind: "location",
    hits: ordered.slice(0, limit).map((entry) => ({
      kind: "location" as const,
      label: entry.label,
      count: entry.userCount + entry.postCount,
      userCount: entry.userCount,
      postCount: entry.postCount,
    })),
    hasMore: ordered.length > limit || userRows.length > windowSize || postRows.length > windowSize,
    ...((userResult.status === "rejected" || postResult.status === "rejected") ? { partial: true } : {}),
  };
}

async function searchKind(db: PrismaClient, kind: SearchKind, q: string, limit: number): Promise<SearchKindResult> {
  if (kind === "user") return searchUsers(db, q, limit);
  if (kind === "product") return searchProducts(db, q, limit);
  if (kind === "category") return searchCategories(db, q, limit);
  return searchLocations(db, q, limit);
}

function emptyCounts(): SearchCounts {
  return { user: 0, product: 0, category: 0, location: 0, total: 0 };
}

function responseFor(query: string, mode: SearchMode, types: SearchKind[], limit: number, unavailable: SearchKind[], degraded: boolean, hits: SearchHit[] = [], counts: SearchCounts = emptyCounts(), hasMore = false): SearchResponse {
  return { query, mode, types, limit, hits, counts, degraded, unavailable, hasMore };
}

function parseTypes(params: URLSearchParams): SearchKind[] | null {
  const raw = params.getAll("types").flatMap((value) => value.split(","));
  const values = raw.map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!values.length) return [...SEARCH_KINDS];
  if (values.includes("all")) return [...SEARCH_KINDS];
  if (values.some((value) => !SEARCH_KINDS.includes(value as SearchKind))) return null;
  const selected = SEARCH_KINDS.filter((kind) => values.includes(kind));
  return selected.length ? selected : null;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const rawQuery = params.get("q") ?? "";
  const query = normalizeSearchQuery(rawQuery);
  if (rawQuery.trim().length > 100) return NextResponse.json({ error: "q must be 100 characters or fewer" }, { status: 400 });
  if (!query) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const modeValue = (params.get("mode") ?? "suggest").trim().toLowerCase();
  if (modeValue !== "suggest" && modeValue !== "results") return NextResponse.json({ error: "mode must be suggest or results" }, { status: 400 });
  const mode: SearchMode = modeValue;

  const types = parseTypes(params);
  if (!types) return NextResponse.json({ error: "types must contain user, product, category, or location" }, { status: 400 });

  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 10 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return NextResponse.json({ error: "limit must be between 1 and 20" }, { status: 400 });

  const prisma = await getPrisma({ probe: false });
  if (!prisma) return NextResponse.json(responseFor(query, mode, types, limit, types, true));

  const settled = await Promise.allSettled(types.map((kind) => searchKind(prisma, kind, query, limit)));
  const counts = emptyCounts();
  const hits: SearchHit[] = [];
  const unavailable: SearchKind[] = [];
  let degraded = false;
  let hasMore = false;

  for (let index = 0; index < settled.length; index += 1) {
    const kind = types[index];
    const result = settled[index];
    if (result.status === "rejected") {
      unavailable.push(kind);
      degraded = true;
      console.error(`[app-search] ${kind} unavailable`, result.reason instanceof Error ? result.reason.message : result.reason);
      continue;
    }
    const value = result.value;
    hits.push(...value.hits);
    counts[value.kind] = value.hits.length;
    counts.total += value.hits.length;
    hasMore ||= value.hasMore;
    if (value.partial) degraded = true;
  }

  return NextResponse.json(responseFor(query, mode, types, limit, unavailable, degraded, hits, counts, hasMore));
}
