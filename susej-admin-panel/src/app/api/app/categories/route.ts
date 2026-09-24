import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { cacheKey, cachedRead } from "@/lib/cache";

// App-facing category catalog. The ADMIN PANEL owns categories (name, slug,
// banner image, ordering) - the app renders whatever admins configured here.
// No hardcoded assets on the app side; tiles without a bannerImage render a
// neutral letter tile instead of an injected image.
export async function GET() {
  try {
    const payload = await cachedRead(cacheKey("categories"), async () => {
      const prisma = await getPrisma({ probe: false });
      if (!prisma) throw new Error("Database unavailable");

      const [rows, childRows, counts] = await Promise.all([
        prisma.category.findMany({
          where: { status: "active" },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        prisma.category.findMany({
          where: { status: "active", parentId: { not: null } },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true, name: true, slug: true, parentId: true },
        }),
        prisma.product.groupBy({ by: ["category"], _count: { _all: true } }).catch(() => []),
      ]);
      const childrenByParent = new Map<string, Array<{ name: string; slug: string }>>();
      for (const ch of childRows) {
        if (!ch.parentId) continue;
        const list = childrenByParent.get(ch.parentId) ?? [];
        list.push({ name: ch.name, slug: ch.slug });
        childrenByParent.set(ch.parentId, list);
      }
      const countMap = new Map<string, number>();
      for (const g of counts) countMap.set(String(g.category).toLowerCase(), g._count._all);

      return {
        categories: rows.map((c) => {
          const name = c.name.toLowerCase();
          const slug = c.slug.toLowerCase();
          const computed = (countMap.get(name) ?? 0) + (name !== slug ? countMap.get(slug) ?? 0 : 0);
          return {
            id: c.id,
            name: c.name,
            slug: c.slug,
            icon: c.icon,
            bannerImage: c.bannerImage || null,
            featured: c.featured,
            productCount: computed,
            children: childrenByParent.get(c.id) ?? [],
          };
        }),
      };
    }, { freshMs: 30_000, staleMs: 600_000 });
    return NextResponse.json(payload, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}
