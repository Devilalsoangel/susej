import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";

function canonicalUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username: rawUsername } = await params;
  const username = canonicalUsername(rawUsername);
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (!username) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const exactUser = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    orderBy: { joinedAt: "desc" },
  });
  const user = exactUser ?? await prisma.user.findFirst({
    where: {
      username: { not: null },
      OR: [
        { username: { contains: username, mode: "insensitive" } },
        { name: { contains: username, mode: "insensitive" } },
        { businessName: { contains: username, mode: "insensitive" } },
        { location: { contains: username, mode: "insensitive" } },
      ],
    },
    orderBy: [{ isSeller: "desc" }, { joinedAt: "desc" }],
  });
  if (!user || !user.username) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const storedUsername = user.username;
  const publicUsername = canonicalUsername(storedUsername);
  if (!publicUsername) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const [posts, followerCount, followingCount, reviewAgg, sellerOrders, storefrontReviews] = await Promise.all([
    prisma.post.findMany({
      where: { authorUsername: storedUsername, status: "published" },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.follow.count({ where: { followed: storedUsername } }),
    prisma.follow.count({ where: { follower: storedUsername } }),
    prisma.review.aggregate({
      where: { sellerUsername: storedUsername },
      _avg: { rating: true },
      _count: { id: true },
    }),
    prisma.order.findMany({
      where: { sellerUsername: storedUsername, status: "delivered" },
      select: { itemsList: true },
    }),
    // Real post-delivery buyer reviews shown on the public storefront.
    prisma.review.findMany({
      where: { sellerUsername: storedUsername, status: "approved" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, reviewerName: true, rating: true, text: true, productName: true, createdAt: true },
    }),
  ]);

  const avgRating = reviewAgg._avg.rating ? Math.round(reviewAgg._avg.rating * 10) / 10 : 0;
  const reviewCount = reviewAgg._count.id;
  let soldUnits = 0;
  for (const o of sellerOrders) {
    const items = Array.isArray(o.itemsList) ? (o.itemsList as { qty?: number; quantity?: number }[]) : [];
    for (const it of items) soldUnits += Number(it?.qty ?? it?.quantity ?? 1);
  }
  // Shop profile (one-shot columns; missing pre-migration → omitted).
  // Contact + hours are buyer-trust data the storefront renders cross-device.
  let shop: { tagline: string; hours: string; email: string; phone: string; address: string } | undefined;
  try {
    const sellerRow = await prisma.seller.findUnique({ where: { id: `app_${storedUsername}` } }).catch(() => null) as {
      tagline?: unknown; hours?: unknown; email?: unknown; phone?: unknown; address?: unknown; kycStatus?: unknown;
    } | null;
    if (sellerRow && String(sellerRow.kycStatus ?? "") === "approved") {
      shop = {
        tagline: String(sellerRow.tagline ?? ""),
        hours: String(sellerRow.hours ?? ""),
        email: String(sellerRow.email ?? ""),
        phone: String(sellerRow.phone ?? ""),
        address: String(sellerRow.address ?? ""),
      };
    }
  } catch {}

  return NextResponse.json({
    user: {
      name: user.name,
      username: publicUsername,
      avatar: user.avatar,
      bio: user.bio ?? "",
      location: user.location ?? "",
      isSeller: user.isSeller,
      businessName: user.businessName ?? "",
      category: user.category ?? "",
      verification: user.verification,
      joinedAt: user.joinedAt.toISOString(),
      followers: followerCount,
      following: followingCount,
      posts: posts.length,
      avgRating,
      reviewCount,
      soldUnits,
      ...(shop ? { shop } : {}),
    },
    posts: posts.map((p) => ({
      id: p.id,
      sellerName: p.authorName,
      sellerUsername: canonicalUsername(p.authorUsername),
      sellerLocation: p.sellerLocation ?? "",
      verified: p.verified,
      price: p.price ?? 0,
      description: p.description ?? "",
      category: p.category ?? "",
      type: p.type,
      hashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
      images: Array.isArray(p.images) ? p.images : [],
      likes: p.likes,
      comments: p.comments,
      createdAt: p.createdAt.getTime(),
      isSold: p.isSold,
      featured: p.featured,
    })),
    reviews: storefrontReviews.map((r) => ({
      id: r.id,
      reviewer: r.reviewerName,
      rating: r.rating,
      text: r.text,
      product: r.productName,
      createdAt: r.createdAt.getTime(),
    })),
  });
}