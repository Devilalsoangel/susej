/**
 * Durable order facts (kind/slot/fee/discount/promo): COLUMNS when the
 * one-shot migration has landed, Json settled-lines stamp otherwise.
 * Pre-migration DBs run the Json path only — column writes are skipped
 * instead of 503ing, and reads fall back silently.
 */

export interface OrderFacts {
  kind: string;
  bookingDate: string;
  bookingTime: string;
  deliveryFee?: number;
  discount: number;
  promoCode: string;
}

let factsCols: boolean | null = null;
export async function hasOrderFactsCols(db: any): Promise<boolean> {
  if (factsCols !== null) return factsCols;
  try {
    await db.$queryRawUnsafe(`SELECT "kind" FROM "Order" LIMIT 0`);
    factsCols = true;
  } catch {
    factsCols = false;
  }
  return factsCols;
}

/** Column facts for order.create — {} pre-migration (Json stamp carries them). */
export async function orderFactsData(
  tx: any,
  facts: { kind: string; bookingDate: string; bookingTime: string; deliveryFee: number; discount: number; promoCode: string }
): Promise<Record<string, unknown>> {
  try {
    if (!(await hasOrderFactsCols(tx))) return {};
    return { ...facts };
  } catch {
    return {};
  }
}

type FactsRow = {
  kind?: unknown; bookingDate?: unknown; bookingTime?: unknown;
  deliveryFee?: unknown; discount?: unknown; promoCode?: unknown;
  itemsList?: unknown;
};

/** Preferred read: columns when present (non-default), else the Json stamp. */
export function orderFactsOf(o: FactsRow): OrderFacts {
  const lines = Array.isArray(o.itemsList) ? (o.itemsList as Array<Record<string, unknown>>) : [];
  const head = lines.length > 0 ? lines[0] : null;
  const colKind = String(o.kind ?? "");
  const lineKind = String(head?.kind ?? "");
  const kind = colKind === "booking" || colKind === "food" || colKind === "order"
    ? colKind
    : lineKind === "booking" || lineKind === "food" || lineKind === "order" ? lineKind : "order";
  const pickStr = (v: unknown, lv: unknown): string =>
    typeof v === "string" && v ? v : typeof lv === "string" && lv ? lv : "";
  const pickNum = (v: unknown, lv: unknown): number | undefined => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
    const m = Number(lv);
    return Number.isFinite(m) && m >= 0 ? m : undefined;
  };
  const fee = pickNum(o.deliveryFee, head?.deliveryFee);
  const discRaw = pickNum(o.discount, head?.discount);
  const linePromo = lines.map((l) => String(l?.promoCode ?? "").trim()).find((c) => !!c) ?? "";
  return {
    kind,
    bookingDate: pickStr(o.bookingDate, head?.bookingDate),
    bookingTime: pickStr(o.bookingTime, head?.bookingTime),
    ...(fee !== undefined ? { deliveryFee: Math.round(fee) } : {}),
    discount: discRaw !== undefined ? Math.round(discRaw) : 0,
    promoCode: typeof o.promoCode === "string" && (o.promoCode as string).trim() ? (o.promoCode as string).trim() : linePromo,
  };
}
