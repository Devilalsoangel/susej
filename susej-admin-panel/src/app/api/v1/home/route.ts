import { NextRequest, NextResponse } from "next/server";
import { checkAppKeyAsync, unauthorized } from "@/lib/promotions/api-auth";
import { getPrisma } from "@/lib/db";
import { lazySweep } from "@/lib/promotions/activate";

const ACTIVE = "active";

// Warm-instance memo (30s): this route costs ~21 queries cold; Vercel
// reuses instances for seconds-minutes, so repeated hits within the window
// serve instantly with zero DB load. Cold instances recompute.
let homeMemo: { at: number; body: unknown } | null = null;

export async function GET(request: NextRequest) {
  if (!await checkAppKeyAsync(request)) return unauthorized();

  const memoNow = Date.now();
  if (homeMemo && memoNow - homeMemo.at < 30_000) {
    const memoRes = NextResponse.json(homeMemo.body);
    memoRes.headers.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    return memoRes;
  }
  await lazySweep();
  const prisma = await getPrisma();
  // FAIL HONEST: DB unreachable → empty payload + degraded flag. No mock data.
  if (!prisma) {
    return NextResponse.json(
      {
        topSellers: [],
        hotDeals: [],
        marketingBanners: [],
        featuredPosts: [],
        spotlight: null,
        spotlights: [],
        degraded: true,
      },
      { status: 200 }
    );
  }

  // A mid-read DB blip must degrade to partial rails, never a bare 500
  // (the app shows "HTTP 500" with zero rails otherwise). Model types stay
  // exact via ReturnType (no any-cast drift).
  let topSellers: Awaited<ReturnType<typeof prisma.topSeller.findMany>> = [];
  let hotDeals: Awaited<ReturnType<typeof prisma.hotDeal.findMany>> = [];
  let marketingBanners: Awaited<ReturnType<typeof prisma.storefrontBanner.findMany>> = [];
  let featuredPosts: Awaited<ReturnType<typeof prisma.featuredPost.findMany>> = [];
  let spotlight: Awaited<ReturnType<typeof prisma.spotlight.findMany>> = [];
  let sections: { name: string; isEnabled: boolean }[] = [];
  let degraded = false;
  try {
    [topSellers, hotDeals, marketingBanners, featuredPosts, spotlight, sections] = await Promise.all([
    // Rails serve at most 3 rows (the app + desk contract): extra active rows
    // wait their turn and expire naturally — the rail never overflows no
    // matter how many campaigns the engine sells.
    prisma.topSeller.findMany({ where: { status: ACTIVE }, orderBy: { position: "asc" }, take: 3 }),
    prisma.hotDeal.findMany({ where: { status: ACTIVE }, orderBy: { priority: "asc" }, take: 3 }),
    // Marketing banners: seller-uploaded banner images from the seller dashboard,
    // synced into storefrontBanner. Ordered by explicit position (lower first,
    // nulls last) then newest. Bounded like every other rail (the app hero
    // renders the first row with an image — an unbounded payload only burns
    // cold-start bytes after the first few rows).
    prisma.storefrontBanner.findMany({
      where: { status: ACTIVE },
      orderBy: [{ position: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 5,
    }),
    // Featured posts: paid promo placements (promo engine writes them on
    // purchase). Previously write-only — orphans rendered nowhere while money
    // was taken. Now a real home rail, ordered pinned-first then position.
    // Rail contract is 3 rows like every other rail (unbounded payloads broke
    // the app contract the moment the engine sold depth).
    prisma.featuredPost.findMany({
      where: { status: ACTIVE },
      orderBy: [{ isPinned: "desc" }, { position: "asc" }, { createdAt: "desc" }],
      take: 3,
    }),
    // Spotlight: paid position-1 feed pins (promo engine writes it on
    // purchase). Was write-only — money taken, rendered nowhere. Served here
    // so paid placements actually display; at most 3 concurrent (activation
    // refuses the 4th instead of selling an invisible slot), newest first.
    prisma.spotlight.findMany({
      where: { status: ACTIVE },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
    // Home-section visibility (admin "Show on home page" toggle): missing row
    // = ON (fresh prod renders), explicit isEnabled=false hides the rail.
    prisma.homeSection.findMany().catch(() => [] as { name: string; isEnabled: boolean }[]),
  ]);
  } catch {
    degraded = true;
  }
  const sectionOff = new Set(
    (sections as { name: string; isEnabled: boolean }[]).filter((s) => !s.isEnabled).map((s) => s.name)
  );

  // Serve-time expiry guard: string endDates in the past never render, even
  // in the window before the lazy sweep expires them (or when the sweep's
  // write contends and fails). Empty/unparseable = no expiry (pinned).
  const notExpired = (r: { endDate?: unknown }) => {
    const s = typeof r.endDate === "string" ? r.endDate : "";
    if (!s) return true;
    const t = Date.parse(s);
    return Number.isNaN(t) || t > Date.now();
  };
  const liveFeatured = featuredPosts.filter(notExpired);
  const liveSpotlight = spotlight.filter(notExpired);
  // Hot deals carry string start/end dates — never serve an expired or
  // not-yet-started row even when the sweep hasn't flipped its status yet.
  const liveHotDeals = hotDeals.filter((d) => {
    if (!notExpired(d as { endDate?: unknown })) return false;
    const s = typeof (d as { startDate?: unknown }).startDate === "string" ? (d as { startDate: string }).startDate : "";
    if (!s) return true;
    const t = Date.parse(s);
    return Number.isNaN(t) || t <= Date.now();
  });

  // Desk-wired hashtag moderation on paid rails: a blocked tag suppresses the
  // rail rows whose listing carries it (featured/spotlight/hotDeal). Without
  // this, blocking a tag left paid placements for blocked-tag posts on home.
  // HotDeal.productId is the `lst_<postId>` mirror id — strip the prefix.
  const normTag = (t: unknown) => String(t ?? "").replace(/^#+/, "").trim().toLowerCase();
  const blockedPostIds = new Set<string>();
  // No inner catches: any read failure must reach the LOUD handler below —
  // swallowed empties served blocked-tag paid rails with zero signal.
  try {
    const blocked = await prisma.hashtag.findMany({ where: { status: "blocked" }, select: { tag: true } });
    const blockedTags = new Set(
      (blocked as Array<{ tag?: unknown }>).map((h) => normTag(h.tag)).filter(Boolean)
    );
    if (blockedTags.size) {
      const postIds = new Set<string>();
      const collect = (v: unknown) => {
        const s = String(v ?? "").trim();
        if (!s) return;
        postIds.add(s.replace(/^lst_/, ""));
      };
      liveFeatured.forEach((p) => collect((p as { postId?: unknown }).postId));
      liveSpotlight.forEach((p) => {
        collect((p as { postId?: unknown }).postId);
        collect((p as { productId?: unknown }).productId);
      });
      liveHotDeals.forEach((d) => collect((d as { productId?: unknown }).productId));
      if (postIds.size) {
        const listings = await prisma.post
          .findMany({ where: { id: { in: [...postIds] } }, select: { id: true, hashtags: true } });
        for (const l of listings as Array<{ id: string; hashtags?: unknown }>) {
          const tags = Array.isArray(l.hashtags) ? (l.hashtags as unknown[]).map(normTag) : [];
          if (tags.some((t) => blockedTags.has(t))) blockedPostIds.add(String(l.id));
        }
      }
    }
  } catch (e) {
    // Fail-OPEN by design (a read blip must not blank paid rails), but LOUD.
    console.error("[home] blocked-hashtag suppression failed — serving unfiltered:", e instanceof Error ? e.message : e);
  }
  // Listing-liveness guard (paid impressions for dead items): a listing that
  // sold or left published mid-campaign suppresses its rail rows same-read
  // (the sweep only checks dates). Missing rows (deleted posts) suppress too
  // — fail-CLOSED here is correct: an impression that can't convert is pure
  // burn, and the seller's window keeps running. Fail-OPEN on read blips
  // (same doctrine as the hashtag block above).
  const deadPostIds = new Set<string>();
  try {
    const postIds = new Set<string>();
    const collect = (v: unknown) => {
      const s = String(v ?? "").trim();
      if (s) postIds.add(s.replace(/^lst_/, ""));
    };
    liveFeatured.forEach((p) => collect((p as { postId?: unknown }).postId));
    liveSpotlight.forEach((p) => {
      collect((p as { postId?: unknown }).postId);
      collect((p as { productId?: unknown }).productId);
    });
    liveHotDeals.forEach((d) => collect((d as { productId?: unknown }).productId));
    if (postIds.size) {
      const rows = await prisma.post.findMany({
        where: { id: { in: [...postIds] } },
        select: { id: true, status: true, isSold: true },
      });
      const seen = new Set((rows as Array<{ id: string }>).map((r) => String(r.id)));
      for (const pid of postIds) {
        if (!seen.has(pid)) {
          deadPostIds.add(pid);
          continue;
        }
        const row = (rows as Array<{ id: string; status?: unknown; isSold?: unknown }>).find((r) => String(r.id) === pid);
        if (!row || String(row.status ?? "") !== "published" || row.isSold === true) deadPostIds.add(pid);
      }
    }
  } catch (e) {
    console.error("[home] liveness suppression failed — serving unfiltered:", e instanceof Error ? e.message : e);
  }
  const postDead = (v: unknown) => deadPostIds.has(String(v ?? "").trim().replace(/^lst_/, ""));
  const postBlocked = (v: unknown) => blockedPostIds.has(String(v ?? "").trim().replace(/^lst_/, ""));
  const serveFeatured = liveFeatured.filter((p) => !postBlocked((p as { postId?: unknown }).postId) && !postDead((p as { postId?: unknown }).postId));
  const serveSpotlight = liveSpotlight.filter(
    (p) => !postBlocked((p as { postId?: unknown }).postId) && !postBlocked((p as { productId?: unknown }).productId) && !postDead((p as { postId?: unknown }).postId) && !postDead((p as { productId?: unknown }).productId)
  );
  const serveHotDeals = liveHotDeals.filter((d) => !postBlocked((d as { productId?: unknown }).productId) && !postDead((d as { productId?: unknown }).productId));

  // Seller identity for the app: TopSeller.sellerId is the Seller cuid on
  // legacy rows and the bare username on desk/engine-written rows — the app
  // navigates/follows by USERNAME (/seller/:u) either way. Cuid rows resolve
  // by phone digits first (exact KYC binding), unique display names only as
  // fallback; bare usernames resolve directly. A shared/colliding identity
  // never attributes (first-hit-wins served A's stats on B's card). Missing
  // mapping serves null — the app falls back to organic suggestions.
  const sellerIdToUsername = new Map<string, string>();
  try {
    const ids = Array.from(new Set(topSellers.map((t) => t.sellerId).filter(Boolean)));
    if (ids.length > 0) {
      const sellers = await prisma.seller.findMany({ where: { id: { in: ids } }, select: { id: true, businessName: true, ownerName: true, phone: true } });
      const users = await prisma.user.findMany({ select: { username: true, name: true, businessName: true, phone: true } });
      const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
      const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
      // EXACT identity first: Seller.phone <-> User.phone digits (the same
      // binding the KYC propagation lane uses) — but UNIQUE bindings only:
      // a family-shared phone hitting two User rows must not first-win any
      // more than a shared display name did. Display-name maps are unique-only
      // too. A colliding identity serves no username (snapshot fallback),
      // never the wrong seller's numbers.
      const phoneCount = new Map<string, number>();
      for (const u of users) {
        if (!u.username) continue;
        const d = digits((u as { phone?: unknown }).phone);
        if (d.length >= 4) phoneCount.set(d, (phoneCount.get(d) ?? 0) + 1);
      }
      const byPhone = new Map<string, string>();
      const bizCount = new Map<string, number>();
      const nameCount = new Map<string, number>();
      for (const u of users) {
        if (!u.username) continue;
        const d = digits((u as { phone?: unknown }).phone);
        if (d.length >= 4 && phoneCount.get(d) === 1 && !byPhone.has(d)) byPhone.set(d, u.username);
        if (u.businessName) bizCount.set(norm(u.businessName), (bizCount.get(norm(u.businessName)) ?? 0) + 1);
        if (u.name) nameCount.set(norm(u.name), (nameCount.get(norm(u.name)) ?? 0) + 1);
      }
      const byBusiness = new Map<string, string>();
      const byName = new Map<string, string>();
      for (const u of users) {
        if (!u.username) continue;
        if (u.businessName && bizCount.get(norm(u.businessName)) === 1 && !byBusiness.has(norm(u.businessName))) byBusiness.set(norm(u.businessName), u.username);
        if (u.name && nameCount.get(norm(u.name)) === 1 && !byName.has(norm(u.name))) byName.set(norm(u.name), u.username);
      }
      // Order-history fallback REMOVED (was first-hit-wins, then windowed-
      // unique): display names are not identity — phone + unique names cover
      // every real binding, anything else serves the honest snapshot fallback.
      for (const s of sellers) {
        const phoneHit = byPhone.get(digits((s as { phone?: unknown }).phone)) ?? null;
        const hit = phoneHit ?? byBusiness.get(norm(s.businessName)) ?? byName.get(norm(s.ownerName)) ?? null;
        if (hit) sellerIdToUsername.set(s.id, hit);
      }
      // Dual-shape sellerId: the desk/engine write bare usernames while legacy
      // rows carry Seller cuids — resolve direct username hits first so new
      // rows get live truth + navigation instead of snapshot-only.
      try {
        const unresolved = ids.filter((id) => !sellerIdToUsername.has(id));
        if (unresolved.length) {
          const direct = await prisma.user.findMany({
            where: { username: { in: unresolved } },
            select: { username: true },
          });
          for (const u of direct) {
            if (u.username) sellerIdToUsername.set(u.username, u.username);
          }
        }
      } catch {
        // Direct-username miss falls through to the cuid path / snapshot.
      }
    }
  } catch {
    // Mapping failure serves username-less rows (snapshot fallback below).
  }

  // Live sales truth: TopSeller snapshots go stale the moment the next
  // order delivers, so re-resolve delivered-order units + review aggregates
  // per row at serve time (max 3 rows — cheap). Snapshot stays as fallback.
  // Identity is server-resolved too: a hand-cloned "(Copy)" row can never
  // serve a fabricated name with real stats (intelligence guard).
  const liveStats = new Map<string, { totalSales: number; rating: number; reviewCount: number; sellerName: string }>();
  try {
    // Orders/reviews key by USERNAME — resolve through the cuid→username map
    // first (looking them up by Seller cuid silently matched nothing).
    const usernames = Array.from(new Set(topSellers.map((t) => sellerIdToUsername.get(t.sellerId)).filter(Boolean) as string[]));
    await Promise.all(
      usernames.map(async (u) => {
        try {
          const [delivered, agg, seller] = await Promise.all([
            prisma!.order.findMany({ where: { sellerUsername: u, status: "delivered" }, select: { itemsList: true } }),
            prisma!.review.aggregate({ where: { sellerUsername: u }, _avg: { rating: true }, _count: { id: true } }),
            (prisma as unknown as { user: { findUnique: (a: unknown) => Promise<{ businessName?: unknown; name?: unknown } | null> } }).user.findUnique({ where: { username: u }, select: { businessName: true, name: true } }).catch(() => null),
          ]);
          let units = 0;
          for (const o of delivered) {
            const items = Array.isArray((o as { itemsList?: unknown }).itemsList)
              ? ((o as { itemsList: { qty?: unknown; quantity?: unknown }[] }).itemsList)
              : [];
            for (const it of items) units += Math.max(1, Math.round(Number(it?.qty ?? it?.quantity ?? 1)));
          }
          liveStats.set(u, {
            totalSales: units,
            rating: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0,
            reviewCount: agg._count.id,
            sellerName: String((seller as { businessName?: unknown; name?: unknown } | null)?.businessName ?? (seller as { name?: unknown } | null)?.name ?? "").trim(),
          });
        } catch {
          // Per-seller fallback: snapshot below.
        }
      })
    );
  } catch {
    // Global fallback: snapshots below.
  }

  // Highest-traffic route (every app cold start): same payload for every
  // caller, serve-time resolve already tolerates staleness — client-cache
  // 30s. PRIVATE (never shared-edge): the gate is the x-app-key header and
  // edge keys are URL-only, so s-maxage served cached 200s to keyless
  // callers (fail-closed bypass) or cached 401s to legit ones. Payload is
  // non-personal, so per-client caching is the safe shape.
  const payload = {
    sections: {
      "top-sellers": !sectionOff.has("top-sellers"),
      "hot-deals": !sectionOff.has("hot-deals"),
      "storefront-banners": !sectionOff.has("storefront-banners"),
      // Paid rails have a kill-switch too (missing row = ON): an admin must
      // be able to hide a wrong/fraudulent paid placement immediately.
      "featured-posts": !sectionOff.has("featured-posts"),
      "spotlight": !sectionOff.has("spotlight"),
    },
    // Admin rail order (the desk drag-reorder persists position per section):
    // enabled sections, lowest position first, rows without a position last.
    // Fresh prod has zero rows (missing = ON everywhere): fall back to the
    // canonical rail order so the field is never an empty promise. Additive
    // — existing clients keep reading `sections` untouched.
    sectionOrder: (() => {
      const ordered = (sections as { name: string; isEnabled: boolean; position?: unknown }[])
        .filter((s) => s && s.isEnabled !== false && typeof s.name === "string")
        .sort((a, b) => {
          const pa = Number(a.position);
          const pb = Number(b.position);
          const va = Number.isFinite(pa) ? pa : Number.MAX_SAFE_INTEGER;
          const vb = Number.isFinite(pb) ? pb : Number.MAX_SAFE_INTEGER;
          return va - vb;
        })
        .map((s) => s.name);
      if (ordered.length) return ordered;
      return ["top-sellers", "hot-deals", "storefront-banners", "featured-posts", "spotlight"].filter(
        (k) => !sectionOff.has(k)
      );
    })(),
    degraded,
    topSellers: (sectionOff.has("top-sellers") || degraded ? [] : topSellers).map((t) => {
      const username = sellerIdToUsername.get(t.sellerId) ?? null;
      const live = username ? liveStats.get(username) : undefined;
      return {
        sellerId: t.sellerId,
        sellerUsername: username,
        sellerName: live?.sellerName || t.sellerName,
        sellerLogo: t.sellerLogo,
        totalSales: live?.totalSales ?? t.totalSales,
        rating: live?.rating ?? t.rating,
        reviewCount: live?.reviewCount ?? t.reviewCount,
        position: t.position,
        isPinned: t.isPinned,
      };
    }),
    hotDeals: (sectionOff.has("hot-deals") ? [] : serveHotDeals).map((d) => ({
      productId: d.productId,
      // HotDeal.productId is the lst_<postId> mirror id; the app matches bare
      // post ids — serve the stripped key so clients never string-surgery.
      postId: d.productId.replace(/^lst_/, ""),
      productName: d.productName,
      productImage: d.productImage,
      originalPrice: d.originalPrice,
      discountedPrice: d.discountedPrice,
      discountPercentage: d.discountPercentage,
      priority: d.priority,
    })),
    marketingBanners: (sectionOff.has("storefront-banners") ? [] : marketingBanners).map((b) => ({
      id: b.id,
      sellerUsername: b.sellerUsername,
      sellerName: b.sellerName,
      title: b.title,
      subtitle: b.subtitle,
      ctaLabel: b.ctaLabel,
      imageUrl: b.imageUrl,
      size: b.size,
      position: b.position,
    })),
    featuredPosts: (sectionOff.has("featured-posts") ? [] : serveFeatured).map((p) => ({
      id: p.id,
      postId: p.postId,
      title: p.title,
      excerpt: p.excerpt,
      imageUrl: p.imageUrl,
      position: p.position,
      isPinned: p.isPinned,
    })),
    spotlight: sectionOff.has("spotlight") || !serveSpotlight.length
      ? null
      : {
          id: serveSpotlight[0].id,
          postId: serveSpotlight[0].postId,
          productId: serveSpotlight[0].productId,
          sellerId: serveSpotlight[0].sellerId,
          sellerName: serveSpotlight[0].sellerName,
          sellerLogo: serveSpotlight[0].sellerLogo,
          title: serveSpotlight[0].title,
          imageUrl: serveSpotlight[0].imageUrl,
        },
    // All live spotlights (newest first): `spotlight` above stays the single
    // legacy reader; surfaces that pin every placement read this array.
    spotlights: sectionOff.has("spotlight")
      ? []
      : serveSpotlight.map((s) => ({
          id: s.id,
          postId: s.postId,
          productId: s.productId,
          sellerId: s.sellerId,
          sellerName: s.sellerName,
          sellerLogo: s.sellerLogo,
          title: s.title,
          imageUrl: s.imageUrl,
        })),
  };
  homeMemo = { at: Date.now(), body: payload };
  const response = NextResponse.json(payload);
  response.headers.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
  return response;
}
