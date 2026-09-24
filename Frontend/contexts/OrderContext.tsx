import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CartItem, DELIVERY_FEES } from './CartContext';
import { serverApi } from '../utils/serverApi';
import { useAuth } from './AuthContext';
import { usePosts } from './PostContext';

const ORDERS_KEY_BASE = '@susej_orders';
const ORDERS_KEY = ORDERS_KEY_BASE;

/** Transport failures where the server may have committed before the reply
 *  was lost (commit-then-response-loss). These must NEVER trigger an
 *  optimistic rollback — the money may have moved. Keep local state; the
 *  next pull reconciles server-wins. Explicit server rejections (validation,
 *  funds, state-machine) DO roll back. */
function isAmbiguousTransport(error: unknown): boolean {
  return error === 'offline' || error === 'server-unreachable';
}

export type OrderStatus =
  | 'placed'
  | 'confirmed'
  | 'preparing'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export type OrderKind = 'order' | 'booking' | 'food';

export interface OrderItem {
  listingId: string;
  name: string;
  price: number;
  quantity: number;
  /** Canonical listing image captured at checkout so every surface (buyer,
   * seller, admin) renders the SAME product picture for this order. */
  imageUrl?: string;
  /** Variant selection at purchase time (e.g. "Size:M") — the server
   * re-checks availability at placement; the receipt shows what was bought. */
  variantLabel?: string;
  /** Bundle row id for combo lines — the server re-prices from the Bundle
   * row at placement; the cart split is preview-only. */
  bundleId?: string;
  /** Settled per-line facts persisted by the server at placement (net unit
   * price after coupon share + commission rupees, category-aware). Earnings
   * displays sum these — never re-derived — so client/admin can never
   * disagree with what was actually credited. Absent on legacy rows. */
  netPrice?: number;
  commission?: number;
  category?: string;
}

export interface TrackingStep {
  label: string;
  time: string;
  done: boolean;
}

export type RefundStatus = 'requested' | 'approved' | 'rejected' | 'refunded';

export type RefundTimelineAuthor = 'you' | 'seller' | 'platform';

export interface RefundTimelineEntry {
  author: RefundTimelineAuthor;
  text: string;
  time: number;
}

export interface Refund {
  id: string;
  reason: string;
  status: RefundStatus;
  timeline: RefundTimelineEntry[];
  requestedAt: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  kind: OrderKind;
  sellerName: string;
  sellerUsername: string;
  /** Buyer identity (server truth, needed by sellers to fulfill + contact).
   *  Absent on pre-sync local rows — UI falls back gracefully. */
  buyerName?: string;
  buyerUsername?: string;
  items: OrderItem[];
  total: number;
  /** Amount actually charged to the buyer (items + delivery − discount). Falls back to total. */
  chargedTotal?: number;
  /** Settled coupon discount (server-stamped at placement, served on pulls).
   *  Receipt savings render this instead of re-deriving fee deltas. */
  discount?: number;
  status: OrderStatus;
  placedAt: number;
  reviewed: boolean;
  rating?: number;
  reviewComment?: string;
  /** Buyer chose "Post Anonymously" - storefront shows Anonymous, never the name. */
  reviewAnonymous?: boolean;
  tracking: TrackingStep[];
  address?: string;
  /** Real Postgres row id (cuid) returned by POST /api/app/orders. All server
   * mutations (status/review/cancel) MUST target this, never the local id. */
  serverId?: string;
  /** Delivery fee charged on this order (validated server-side). Stored so a
   * failed sync can be retried with the exact same payload (idempotent). */
  deliveryFee?: number;
  /** Promo code forwarded for server validation (discount settles server-side). */
  promoCode?: string;
  /** True when the order exists locally but the server never acknowledged it
   * (network failure after optimistic create). Kept — never ghost-deleted —
   * until retryOrderSync succeeds or the server explicitly rejects it. */
  syncPending?: boolean;
  /** Server explicitly rejected this order (bad coupon, OOS, funds). Kept —
   * never ghost-deleted — so the buyer sees WHY instead of a not-found page. */
  syncFailed?: string;
  paymentMethod?: string;
  bookingDate?: string;
  bookingTime?: string;
  /** Accepted-offer lock carried for sync retries (server re-verifies). */
  offer?: { threadId: string; messageId: string };
  refund?: Refund;
  /** Dispute-ruling wallet credit (server-attached, no Refund row): the
   *  refunds tab + detail card render this so credited buyers see money the
   *  Refund table never recorded. */
  disputeCredit?: { amount: number; kind: 'full' | 'split' };
  /** Settlement stamp ("" = pre-hold era = matured). Seller earnings unlock
   *  7 days after this date (payout hold); every surface reads the same value. */
  actualDelivery?: string;
  /** Server settlement state: 'refunded' rows were clawed back (never
   *  earnings — headlines must exclude them, exactly like the server guard). */
  paymentStatus?: string;
  /** True while an open/under_review dispute freezes this order's net (unlocks
   *  on ruling — withdrawable-truth, mirrors the server payout guard). */
  disputeFrozen?: boolean;
  /** Proof-of-delivery entries (seller handover claims: tracking ID / receiver
   *  name). Buyer tracking renders the latest; server wins on pull. */
  deliveryLog?: Array<{ at?: string; by?: string; note?: string }>;
}

export interface PlaceOrderOptions {
  bookingDate?: string;
  bookingTime?: string;
  // Delivery fee charged on the first order of the checkout (validated
  // server-side against the allowed fee set so totals stay trustworthy).
  deliveryFee?: number;
  // Promo code applied in cart — forwarded to server for validation so
  // cart coupon drift cannot create a client-only discount mismatch.
  promoCode?: string;
  // Server-mirror discount estimate (previewDiscount) so the local receipt
  // shows the discounted figure the server will charge — not the full price.
  // The server re-validates and settles the real discount; this never prices.
  discountEstimate?: number;
  // Accepted-offer lock (chat deal → checkout): the server prices this order
  // from the verified accepted offer row, not the listing mirror. Single-item
  // only, never combinable with coupons (server enforces both).
  offer?: { threadId: string; messageId: string };
  // Structured shipping fields — the server canonicalizes these into a clean
  // address string, so garbage can never be serialized into the Order row.
  addressParts?: {
    label?: string;
    name?: string;
    phone?: string;
    street?: string;
    city?: string;
  };
}

interface OrderContextType {
  orders: Order[];
  placeOrders: (
    cart: CartItem[],
    address?: string,
    paymentMethod?: string,
    options?: PlaceOrderOptions
  ) => Order[];
  getOrder: (id: string) => Order | undefined;
  /** Re-POST a syncPending order with its original payload (server is
   * idempotent on orderNumber, so a lost-ack retry can never double-charge).
   * Returns true when the server acknowledges the order. */
  retryOrderSync: (id: string) => Promise<boolean>;
  /** Returns true when the server acknowledged the transition (false = local
   *  refusal or server rollback — callers must surface it, never silent). */
  updateOrderStatus: (id: string, status: OrderStatus, podNote?: string) => Promise<boolean>;
  markReviewed: (id: string, rating: number, comment?: string, anonymous?: boolean) => Promise<boolean>;
  requestRefund: (orderId: string, reason: string) => Promise<boolean>;
  /** Seller decisions await the server ack (false = rolled back, surface it);
   *  plain timeline notes resolve true immediately (no server round-trip). */
  respondRefund: (
    orderId: string,
    author: RefundTimelineAuthor,
    text: string,
    newStatus?: RefundStatus,
    /** Seller decision reason — forwarded to the server for the Refund row. */
    note?: string
  ) => Promise<boolean>;
  /**
   * Cancels an order. Contract: awaits the server ack — returns true only
   * when the server confirmed the cancel (false = local refusal or server
   * rollback — callers must surface it, never silent).
   */
  cancelOrder: (orderId: string, reason?: string) => Promise<boolean>;
  /**
   * True once the first load cycle settled (cache read + first server pull
   * attempt, success or fail). Screens must show a loader — never a
   * "No orders yet" empty state — while this is false.
   */
  loaded: boolean;
}

export const ORDER_STATUS_FLOW: OrderStatus[] = [
  'placed',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
];

const STATUS_LABELS: Record<OrderStatus, string> = {
  placed: 'Order Placed',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  refunded: 'Refunded',
};

/**
 * Shared server-row → Order mapper (second-device truth): order/[id] grew a
 * 100-line inline version while track-order, rate-review and refund/[id]
 * stayed local-only and 404ed rows the receipt resolves. Every order screen
 * uses this — one mapping, no divergent children.
 */
export function toOrderFromServer(hit: any): Order | null {
  if (!hit || typeof hit !== 'object' || !hit.id) return null;
  const flowIdx = ORDER_STATUS_FLOW.indexOf((hit.status as Order['status']) ?? 'placed');
  const labels = ['Order Placed', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered'];
  return {
    id: String(hit.id),
    orderNumber: String(hit.orderNumber ?? hit.id),
    kind: (hit.kind as Order['kind']) ?? 'order',
    sellerName: String(hit.sellerName ?? ''),
    sellerUsername: String(hit.sellerUsername ?? ''),
    buyerName: hit.buyerName ? String(hit.buyerName) : undefined,
    buyerUsername: typeof hit.buyerUsername === 'string' && hit.buyerUsername ? String(hit.buyerUsername) : undefined,
    items: Array.isArray(hit.items)
      ? hit.items.map((i: any) => ({
          listingId: String(i.listingId ?? i.postId ?? ''),
          name: String(i.name ?? 'Item'),
          price: Number(i.price ?? 0),
          quantity: Number(i.quantity ?? 1),
          ...(i.imageUrl ? { imageUrl: String(i.imageUrl) } : {}),
          ...(typeof i.variantLabel === 'string' && i.variantLabel ? { variantLabel: i.variantLabel } : {}),
          ...(typeof i.bundleId === 'string' && i.bundleId ? { bundleId: i.bundleId } : {}),
          ...(typeof i.netPrice === 'number' && Number.isFinite(i.netPrice) ? { netPrice: i.netPrice } : {}),
          ...(typeof i.commission === 'number' && Number.isFinite(i.commission) ? { commission: i.commission } : {}),
          ...(typeof i.category === 'string' && i.category ? { category: i.category } : {}),
        }))
      : [],
    total: Number(hit.total ?? 0),
    chargedTotal: Number(hit.chargedTotal ?? hit.total ?? 0),
    status: (hit.status as Order['status']) ?? 'placed',
    placedAt: typeof hit.placedAt === 'string' ? Date.parse(hit.placedAt) : Number(hit.placedAt ?? Date.now()),
    reviewed: Boolean(hit.reviewed),
    rating: hit.rating ? Number(hit.rating) : undefined,
    reviewComment: hit.reviewComment ? String(hit.reviewComment) : undefined,
    address: hit.address ? String(hit.address) : undefined,
    paymentMethod: hit.paymentMethod ? String(hit.paymentMethod) : undefined,
    ...(typeof hit.actualDelivery === 'string' && hit.actualDelivery ? { actualDelivery: hit.actualDelivery } : {}),
    ...(Array.isArray(hit.deliveryLog) && hit.deliveryLog.length ? { deliveryLog: hit.deliveryLog } : {}),
    ...(hit.deliveryFee !== undefined ? { deliveryFee: Number(hit.deliveryFee) || 0 } : {}),
    ...(typeof hit.promoCode === 'string' && hit.promoCode ? { promoCode: hit.promoCode } : {}),
    ...(typeof hit.paymentStatus === 'string' && hit.paymentStatus ? { paymentStatus: hit.paymentStatus } : {}),
    ...(hit.disputeFrozen !== undefined ? { disputeFrozen: Boolean(hit.disputeFrozen) } : {}),
    ...(hit.disputeCredit && typeof hit.disputeCredit === 'object' && Number((hit.disputeCredit as { amount?: unknown }).amount ?? 0) > 0
      ? {
          disputeCredit: {
            amount: Number((hit.disputeCredit as { amount?: unknown }).amount ?? 0),
            kind: (hit.disputeCredit as { kind?: unknown }).kind === 'split' ? 'split' as const : 'full' as const,
          },
        }
      : {}),
    ...(hit.refund && typeof hit.refund === 'object'
      ? (() => {
          const sr = hit.refund as Partial<Refund> & { timeline?: Array<Partial<RefundTimelineEntry>> };
          const st: RefundStatus =
            sr.status === 'approved' || sr.status === 'rejected' || sr.status === 'refunded' ? sr.status : 'requested';
          return {
            refund: {
              id: String(sr.id ?? ''),
              reason: String(sr.reason ?? ''),
              status: st,
              timeline: Array.isArray(sr.timeline)
                ? sr.timeline.map((t, i) => ({
                    author: t.author === 'seller' || t.author === 'platform' ? t.author : ('you' as const),
                    text: String(t.text ?? ''),
                    time: Number(t.time ?? Date.now()),
                  }))
                : [],
              requestedAt: Number(sr.requestedAt ?? Date.now()),
            } as Refund,
          };
        })()
      : {}),
    serverId: String(hit.id),
    tracking: labels.map((label, i) => ({
      label,
      time: i === 0 ? new Date(typeof hit.placedAt === 'string' ? Date.parse(hit.placedAt) : Number(hit.placedAt ?? Date.now())).toLocaleString() : '—',
      done: flowIdx < 0 ? i === 0 : i <= flowIdx,
    })),
  };
}

const OrderContext = createContext<OrderContextType | null>(null);

export function OrderProvider({ children }: { children: React.ReactNode }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { user, tokenSeq } = useAuth();
  const { decrementStock } = usePosts();
  // Acked orders whose lines already decremented local cache stock (exactly-
  // once: ack + retry-ack + refocus-pull must never double-decrement).
  const decrementedRef = useRef(new Set<string>());
  const reserveLocalStock = useCallback(
    (o: Order) => {
      if (decrementedRef.current.has(o.id)) return;
      decrementedRef.current.add(o.id);
      decrementStock(
        o.items.map((i) => ({ listingId: i.listingId, quantity: i.quantity, variantLabel: i.variantLabel }))
      );
    },
    [decrementStock]
  );
  const ordersKey = user?.username ? `${ORDERS_KEY_BASE}:${user.username}` : ORDERS_KEY_BASE;
  const serverAuthoritative = useRef(false);
  const ordersRef = useRef<Order[]>([]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  useEffect(() => {
    let cancelled = false;
    const key = user?.username ? `${ORDERS_KEY_BASE}:${user.username}` : ORDERS_KEY_BASE;
    // Reset authority when switching identities so new user's cache can load.
    serverAuthoritative.current = false;
    setLoaded(false);
    AsyncStorage.getItem(key)
      .then((data) => {
        if (cancelled) return;
        if (data) {
          try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
              if (serverAuthoritative.current) return;
              const real = (parsed as Order[]).filter(
                (o) => o && !String(o.id).startsWith('seed_')
              );
              setOrders(real);
              // Cached rows render instantly — no loader flash for returners.
              if (real.length > 0) setLoaded(true);
              return;
            }
          } catch {}
        }
        if (!cancelled) setOrders([]);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => { cancelled = true; };
  }, [user?.username]);

  // Server sync: pull MY real orders from the shared backend (so the same
  // account sees the same orders on any device). A successful pull REPLACES
  // the cache — stale local/demo rows can never masquerade as real orders.
  const loadedOrdersFor = useRef('');
  useEffect(() => {
    if (!user?.username) {
      setLoaded(true);
      return;
    }
    const key = `${user.username}:${tokenSeq}`;
    let cancelled = false;
    if (loadedOrdersFor.current === key) return;
    loadedOrdersFor.current = key;
    // mine=all: one pull returns BOTH purchase history and sales — every
    // screen (buyer orders, seller dashboard/orders) filters locally.
     serverApi.getOrders('all').then((res) => {
       if (cancelled) return;
       if (!res.ok || !res.data?.orders) {
         setLoaded(true);
         return;
       }
      serverAuthoritative.current = true;
      // Merge, never wholesale replace: the server row lacks client-side
      // fields (deliveryFee/promoCode/booking/reviewAnonymous) that have no
      // server column yet — dropping them on every pull emptied the Refunds
      // tab and re-offered refunds after every restart. Match by server id,
      // else by order number (idempotent echo), else treat as a new row.
      // Unmatched local rows that are still syncing (or in-flight) are kept.
      const priorByServerId = new Map<string, Order>();
      const priorByNumber = new Map<string, Order>();
      for (const o of ordersRef.current) {
        if (o.serverId) priorByServerId.set(o.serverId, o);
        if (o.orderNumber) priorByNumber.set(o.orderNumber, o);
      }
      const seenLocalIds = new Set<string>();
      const serverOrders = res.data.orders
        .filter((o) => o && o.id)
        .map((o) => {
          const sid = String(o.id);
          const tracking = String(o.orderNumber ?? o.id);
          const prior = priorByServerId.get(sid) ?? priorByNumber.get(tracking);
          if (prior) seenLocalIds.add(prior.id);
          const serverRefund = (o as { refund?: { id: string; status: string; reason: string; requestedAt: number } }).refund;
          const priorItemsByListing = new Map((prior?.items ?? []).map((i) => [i.listingId, i]));
          const merged: Order = {
            id: prior?.id ?? sid,
            orderNumber: tracking,
            kind: (o.kind as Order['kind']) ?? 'order',
            sellerName: String(o.sellerName ?? ''),
            sellerUsername: String(o.sellerUsername ?? ''),
            buyerName: (o as { buyerName?: unknown }).buyerName ? String((o as { buyerName?: unknown }).buyerName) : prior?.buyerName,
            buyerUsername: (o as { buyerUsername?: unknown }).buyerUsername ? String((o as { buyerUsername?: unknown }).buyerUsername) : prior?.buyerUsername,
            items: Array.isArray(o.items)
              ? o.items.map((i: any) => ({
                  listingId: String(i.listingId ?? i.postId ?? ''),
                  name: String(i.name ?? 'Item'),
                  price: Number(i.price ?? 0),
                  quantity: Number(i.quantity ?? 1),
                  ...(i.imageUrl ? { imageUrl: String(i.imageUrl) } : {}),
                  ...(typeof i.bundleId === 'string' && i.bundleId ? { bundleId: i.bundleId } : {}),
                  ...((typeof i.variantLabel === 'string' && i.variantLabel
                    ? { variantLabel: i.variantLabel }
                    : priorItemsByListing.get(String(i.listingId ?? i.postId ?? ''))?.variantLabel
                      ? { variantLabel: priorItemsByListing.get(String(i.listingId ?? i.postId ?? ''))!.variantLabel }
                      : {})),
                  // Settled legs ride through untouched — earnings displays
                  // must sum server facts, never re-derive them.
                  ...(typeof i.netPrice === 'number' && Number.isFinite(i.netPrice) ? { netPrice: i.netPrice } : {}),
                  ...(typeof i.commission === 'number' && Number.isFinite(i.commission) ? { commission: i.commission } : {}),
                  ...(typeof i.category === 'string' && i.category ? { category: i.category } : {}),
                }))
              : [],
            total: Number(o.total ?? 0),
            chargedTotal: Number(o.chargedTotal ?? o.total ?? 0),
            status: (o.status as Order['status']) ?? 'placed',
            placedAt: typeof o.placedAt === 'string' ? Date.parse(o.placedAt) : Number(o.placedAt ?? Date.now()),
            reviewed: Boolean(o.reviewed),
            rating: o.rating ? Number(o.rating) : undefined,
            reviewComment: o.reviewComment ? String(o.reviewComment) : undefined,
            // Server has no reviewAnonymous column yet: keep the local choice.
            ...(prior?.reviewAnonymous !== undefined ? { reviewAnonymous: prior.reviewAnonymous } : {}),
            address: o.address ? String(o.address) : undefined,
            paymentMethod: o.paymentMethod ? String(o.paymentMethod) : undefined,
            serverId: sid,
            // Settlement stamp rides through like the other server facts —
            // the payout hold reads it, so it must survive pulls.
            ...((o as { actualDelivery?: unknown }).actualDelivery
              ? { actualDelivery: String((o as { actualDelivery?: unknown }).actualDelivery) }
              : prior?.actualDelivery
                ? { actualDelivery: prior.actualDelivery }
                : {}),
            // Settlement state rides through too — refunded rows are clawed
            // back (never earnings) and frozen rows unlock on ruling. Server
            // wins when present; prior survives pulls from older builds.
            ...(typeof (o as { paymentStatus?: unknown }).paymentStatus === 'string' && (o as { paymentStatus?: string }).paymentStatus
              ? { paymentStatus: (o as { paymentStatus?: string }).paymentStatus }
              : prior?.paymentStatus
                ? { paymentStatus: prior.paymentStatus }
                : {}),
            ...((o as { disputeFrozen?: unknown }).disputeFrozen !== undefined
              ? { disputeFrozen: Boolean((o as { disputeFrozen?: unknown }).disputeFrozen) }
              : prior?.disputeFrozen !== undefined
                ? { disputeFrozen: prior.disputeFrozen }
                : {}),
            // POD log rides through like the other server facts (buyer
            // tracking renders the latest entry; server wins when present).
            ...(((o as { deliveryLog?: unknown }).deliveryLog as Array<{ at?: string; by?: string; note?: string }> | undefined)?.length
              ? { deliveryLog: (o as { deliveryLog?: Array<{ at?: string; by?: string; note?: string }> }).deliveryLog }
              : prior?.deliveryLog?.length
                ? { deliveryLog: prior.deliveryLog }
                : {}),
            // Server refund row wins (cross-device truth); else keep local.
            ...(serverRefund
              ? {
                  refund: {
                    id: String(serverRefund.id),
                    reason: String(serverRefund.reason ?? ''),
                    status: serverRefund.status as RefundStatus,
                    timeline: prior?.refund?.timeline ?? [],
                    requestedAt: Number(serverRefund.requestedAt ?? Date.now()),
                  },
                }
              : prior?.refund
                ? { refund: prior.refund }
                : {}),
            // Settled fee/promo/slot/discount are server columns now (stamped
            // at placement, served on every pull): server wins when present,
            // local survives pulls from older builds that omit them.
            ...(Number.isFinite(Number((o as { deliveryFee?: unknown }).deliveryFee)) && Number((o as { deliveryFee?: unknown }).deliveryFee) >= 0
              ? { deliveryFee: Number((o as { deliveryFee?: unknown }).deliveryFee) }
              : prior?.deliveryFee !== undefined
                ? { deliveryFee: prior.deliveryFee }
                : {}),
            ...((o as { discount?: unknown }).discount !== undefined && Number.isFinite(Number((o as { discount?: unknown }).discount))
              ? { discount: Number((o as { discount?: unknown }).discount) }
              : prior?.discount !== undefined
                ? { discount: prior.discount }
                : {}),
            // Dispute-credit leg rides through like the refund row (server
            // wins when present; no local equivalent to preserve).
            ...((o as { disputeCredit?: { amount?: unknown; kind?: unknown } }).disputeCredit &&
            Number((o as { disputeCredit?: { amount?: unknown } }).disputeCredit?.amount ?? 0) > 0
              ? {
                  disputeCredit: {
                    amount: Number((o as { disputeCredit?: { amount?: unknown } }).disputeCredit?.amount ?? 0),
                    kind: (o as { disputeCredit?: { kind?: unknown } }).disputeCredit?.kind === 'split' ? 'split' as const : 'full' as const,
                  },
                }
              : {}),
            ...(typeof (o as { promoCode?: unknown }).promoCode === 'string' && (o as { promoCode?: string }).promoCode
              ? { promoCode: (o as { promoCode?: string }).promoCode as string }
              : prior?.promoCode !== undefined
                ? { promoCode: prior.promoCode }
                : {}),
            ...(typeof (o as { bookingDate?: unknown }).bookingDate === 'string' && (o as { bookingDate?: string }).bookingDate
              ? { bookingDate: (o as { bookingDate?: string }).bookingDate as string }
              : prior?.bookingDate !== undefined
                ? { bookingDate: prior.bookingDate }
                : {}),
            ...(typeof (o as { bookingTime?: unknown }).bookingTime === 'string' && (o as { bookingTime?: string }).bookingTime
              ? { bookingTime: (o as { bookingTime?: string }).bookingTime as string }
              : prior?.bookingTime !== undefined
                ? { bookingTime: prior.bookingTime }
                : {}),
            // Timeline done-flags derive from the SERVER status, not a default
            // placed-only template — otherwise pulled orders render stale state.
            tracking: (() => {
              const flowIdx = ORDER_STATUS_FLOW.indexOf((o.status as Order['status']) ?? 'placed');
              const labels = ['Order Placed', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered'];
              return labels.map((label, i) => ({
                label,
                time: i === 0 ? new Date(typeof o.placedAt === 'string' ? Date.parse(o.placedAt) : Number(o.placedAt ?? Date.now())).toLocaleString() : '—',
                done: flowIdx < 0 ? i === 0 : i <= flowIdx,
              }));
            })(),
          };
          return merged;
        });
      // Keep unmatched locals that are still syncing (or freshly created and
      // possibly in-flight): dropping them orphans orders the server may
      // already hold under a different id. Rejected rows (syncFailed) are
      // kept too — they carry the WHY plus the retry path, and deleting them
      // on the next pull ghost-deletes the receipt.
      const now = Date.now();
      for (const o of ordersRef.current) {
        if (seenLocalIds.has(o.id)) continue;
        if (o.syncPending || o.syncFailed || now - o.placedAt < 120000) serverOrders.push(o);
      }
      // Server is the single source of truth — replace instead of merge so
      // stale pre-wipe local rows (demo orders) can never resurface.
      setOrders(serverOrders);
      persist(serverOrders);
      setLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [user?.username, tokenSeq]);

  const persist = useCallback((next: Order[]) => {
    AsyncStorage.setItem(ordersKey, JSON.stringify(next)).catch(() => {});
  }, [ordersKey]);

  // Server-wins adoption shared by placement-ack AND explicit retry: the ack
  // carries settled chargedTotal/deliveryFee/discount (absent on older builds,
  // where the optimistic preview stands until the next pull). Invalid figures
  // are ignored, never written.
  const adoptSettledFigures = useCallback((id: string, so: { chargedTotal?: unknown; deliveryFee?: unknown; discount?: unknown } | undefined) => {
    if (!so) return;
    const settledTotal = Number(so.chargedTotal);
    const settledFee = Number(so.deliveryFee);
    const settledDiscount = Number(so.discount);
    const hasTotal = Number.isFinite(settledTotal) && settledTotal >= 0;
    const hasFee = Number.isFinite(settledFee) && settledFee >= 0;
    const hasDiscount = Number.isFinite(settledDiscount) && settledDiscount >= 0;
    if (!hasTotal && !hasFee && !hasDiscount) return;
    setOrders((prev) => {
      const next = prev.map((x) =>
        x.id === id
          ? {
              ...x,
              ...(hasTotal ? { chargedTotal: settledTotal } : {}),
              ...(hasFee ? { deliveryFee: settledFee } : {}),
              ...(hasDiscount ? { discount: settledDiscount } : {}),
            }
          : x
      );
      persist(next);
      return next;
    });
  }, [persist]);

  const placeOrders = useCallback(
    (cart: CartItem[], address?: string, paymentMethod?: string, options?: PlaceOrderOptions) => {
      const sellers = new Map<string, CartItem[]>();
      for (const item of cart) {
        const key = item.sellerUsername;
        sellers.set(key, [...(sellers.get(key) ?? []), item]);
      }
      const now = Date.now();
      const created: Order[] = [];
      let index = ordersRef.current.length;
      const discount = Math.max(0, Math.round(Number(options?.discountEstimate ?? 0)));
      let first = true;
      for (const [sellerUsername, items] of sellers) {
        // Rounded like the cart subtotal AND the server's Math.round charge:
        // unrounded paise here drifted ≤₹1 vs both preview and receipt.
        const total = Math.round(items.reduce((sum, i) => sum + i.price * i.quantity, 0));
        // Per-slice fee (server charges its fee PER order row, one row per
        // seller here): the old first-takes-all preview understated multi-
        // seller checkouts by (sellers-1)x fee vs the settled charge. Each
        // slice prices its own types with the same rule the server enforces.
        const fee = items.length > 0
          ? items.every((i) => i.type === 'service')
            ? 0
            : items.some((i) => i.type === 'food_item')
              ? DELIVERY_FEES.food_item
              : DELIVERY_FEES.product
          : 0;
        const disc = first ? discount : 0;
        const chargedTotal = Math.max(0, total + fee - disc);
        const isFood = items.some((i) => i.type === 'food_item');
        index += 1;
        // Random suffix: two devices in the same ms with the same cart size
        // used to mint identical orderNumbers, and the server treats
        // orderNumber as idempotent — two buyers' orders conflated as one.
        const randSuffix = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
        const order: Order = {
          id: `order_${now}_${index}`,
          orderNumber: `#SJ-${String(now).slice(-6)}${index}-${randSuffix}`,
          kind: items.some((i) => i.type === 'service')
            ? 'booking'
            : isFood
              ? 'food'
              : 'order',
          sellerName: items[0].seller,
          sellerUsername,
          // Buyer identity stamped optimistically (server is truth on pull):
          // without it the Orders Rate CTA and rate-review buyer gate can't
          // recognize own rows before the first sync.
          ...(user?.username ? { buyerUsername: user.username } : {}),
          ...(user?.name ? { buyerName: user.name } : {}),
          items: items.map((i) => ({
            listingId: i.listingId,
            name: i.name,
            price: i.price,
            quantity: i.quantity,
            ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
            ...(i.variantLabel ? { variantLabel: i.variantLabel } : {}),
            ...(i.bundleId ? { bundleId: i.bundleId } : {}),
          })),
          total,
          chargedTotal,
          status: 'placed',
          placedAt: now,
          reviewed: false,
          address,
          paymentMethod,
          deliveryFee: fee,
          ...(options?.promoCode ? { promoCode: options.promoCode } : {}),
          ...(options?.bookingDate ? { bookingDate: options.bookingDate } : {}),
          ...(options?.bookingTime ? { bookingTime: options.bookingTime } : {}),
          ...(options?.offer ? { offer: options.offer } : {}),
          tracking: isFood
            ? [
                { label: 'Order Placed', time: new Date(now).toLocaleString(), done: true },
                { label: 'Preparing', time: '—', done: false },
                { label: 'Out for Delivery', time: '—', done: false },
                { label: 'Delivered', time: '—', done: false },
              ]
            : [
                { label: 'Order Placed', time: new Date(now).toLocaleString(), done: true },
                { label: 'Confirmed', time: '—', done: false },
                { label: 'Preparing', time: '—', done: false },
                { label: 'Out for Delivery', time: '—', done: false },
                { label: 'Delivered', time: '—', done: false },
              ],
        };
        created.push(order);
        first = false;
      }
      setOrders((prev) => {
        const next = [...created, ...prev];
        persist(next);
        return next;
      });
      // Single server sync per order — /api/app/orders is the one real row.
      // The legacy adminSync mirror is NOT called: it created a SECOND admin
      // entity per order (duplicate cuid + order_ rows in the panel).
      // The server's cuid is captured as `serverId` so every later mutation
      // (accept/ship/review/cancel) targets the real row, not the local id.
      // Per-slice fee (the slice's own deliveryFee, exact-matched server-side)
      // and first-slice-only promoCode: the old code forwarded the global fee
      // + the same coupon on EVERY slice, so a multi-seller cart settled N x
      // fee correctly but applied the coupon N times (discount + usage count).
      const payload = (o: Order, isFirst: boolean) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        sellerUsername: o.sellerUsername,
        sellerName: o.sellerName,
        items: o.items,
        total: o.total,
        chargedTotal: o.chargedTotal,
        kind: o.kind,
        status: o.status,
        placedAt: o.placedAt,
        address: o.address,
        paymentMethod: o.paymentMethod,
        bookingDate: o.bookingDate,
        bookingTime: o.bookingTime,
        // First slice keeps the checkout-computed fee when present (offer-mode
        // live-type adjustments ride options.deliveryFee — the slice guess
        // would 400 against the server's listing-truth fee); later slices
        // send their own type-priced fee.
        deliveryFee: isFirst && options?.deliveryFee !== undefined ? options.deliveryFee : o.deliveryFee ?? 0,
        promoCode: isFirst ? options?.promoCode ?? undefined : undefined,
        ...(options?.offer ? { offer: options.offer } : {}),
        ...(options?.addressParts ?? {}),
      });
      created.forEach((o, idx) => {
        void serverApi.placeOrder(payload(o, idx === 0)).then((res) => {
          const serverOrder = res.ok && res.data && (res.data as { order?: unknown }).order
            ? (res.data as { order: { id?: unknown; chargedTotal?: unknown; deliveryFee?: unknown } }).order
            : undefined;
          const sid = serverOrder ? String(serverOrder.id ?? '') || undefined : undefined;
          // Settled figures ride the ack (server-wins receipt); absent on
          // older builds — the optimistic preview stands until the next pull.
          const settledTotal = serverOrder ? Number(serverOrder.chargedTotal) : NaN;
          const settledFee = serverOrder ? Number(serverOrder.deliveryFee) : NaN;
          const settledDiscount = serverOrder ? Number((serverOrder as { discount?: unknown }).discount) : NaN;
          if (sid) {
            adoptSettledFigures(o.id, { chargedTotal: settledTotal, deliveryFee: settledFee, discount: settledDiscount });
            setOrders((prev) => {
              const next = prev.map((x) =>
                x.id === o.id
                  ? {
                      ...x,
                      serverId: sid,
                      syncPending: false,
                      syncFailed: undefined,
                    }
                  : x
              );
              persist(next);
              return next;
            });
            // Server committed: reserve local cache stock exactly once
            // (retry-ack for the same order is a guarded no-op).
            reserveLocalStock(o);
            return;
          }
          if (!res.ok && isAmbiguousTransport((res as { error?: unknown }).error)) {
            // Ambiguous transport (device offline OR our server unreachable
            // mid-flight): the server may or may not have committed. NEVER
            // flag rejected — flag for explicit retry (idempotent on
            // orderNumber, so retry can't double-charge).
            setOrders((prev) => {
              const next = prev.map((x) => (x.id === o.id ? { ...x, syncPending: true } : x));
              persist(next);
              return next;
            });
            return;
          }
          // Server rejected this order (coupon expired, insufficient funds,
          // validation) — FLAG it with the reason instead of ghost-deleting:
          // the buyer navigated to this receipt and must see WHY, not a
          // not-found page. No money moved (server owns debit).
          const reason = String((res as { error?: unknown }).error ?? 'Rejected by server');
          setOrders((prev) => {
            const next = prev.map((x) => (x.id === o.id ? { ...x, syncPending: false, syncFailed: reason } : x));
            persist(next);
            return next;
          });
        }).catch(() => {
          // Fetch threw (offline mid-flight): same as offline above — keep + flag.
          setOrders((prev) => {
            const next = prev.map((x) => (x.id === o.id ? { ...x, syncPending: true } : x));
            persist(next);
            return next;
          });
        });
      });
      return created;
    },
    [persist, user?.username, user?.name, reserveLocalStock, adoptSettledFigures]
  );

  const retryOrderSync = useCallback(
    async (id: string): Promise<boolean> => {
      const order = ordersRef.current.find((o) => o.id === id);
      if (!order) return false;
      const res = await serverApi
        .placeOrder({
          id: order.id,
          orderNumber: order.orderNumber,
          sellerUsername: order.sellerUsername,
          sellerName: order.sellerName,
          items: order.items,
          total: order.total,
          chargedTotal: order.chargedTotal,
          kind: order.kind,
          status: order.status,
          placedAt: order.placedAt,
          address: order.address,
          paymentMethod: order.paymentMethod,
          bookingDate: order.bookingDate,
          bookingTime: order.bookingTime,
          deliveryFee: order.deliveryFee ?? 0,
          promoCode: order.promoCode ?? undefined,
          offer: order.offer ?? undefined,
        })
        .catch(() => null);
      const sid = res && res.ok && res.data && res.data.order ? String(res.data.order.id) : undefined;
      if (sid) {
        // Dedupe/retry acks carry settled figures too — same server-wins.
        adoptSettledFigures(
          id,
          res?.data?.order as { chargedTotal?: unknown; deliveryFee?: unknown } | undefined
        );
        setOrders((prev) => {
          const next = prev.map((x) => (x.id === id ? { ...x, serverId: sid, syncPending: false, syncFailed: undefined } : x));
          persist(next);
          return next;
        });
        // Server committed: reserve local cache stock exactly once.
        reserveLocalStock(order);
        return true;
      }
      // Explicit server reject on retry: flag the reason on the row (never
      // ghost-delete). Offline keeps pending.
      if (res && !res.ok && res.error !== 'offline') {
        const reason = String(res.error ?? 'Rejected by server');
        setOrders((prev) => {
          const next = prev.map((x) => (x.id === id ? { ...x, syncPending: false, syncFailed: reason } : x));
          persist(next);
          return next;
        });
      }
      return false;
    },
    [persist, reserveLocalStock, adoptSettledFigures]
  );

  const getOrder = useCallback(
    (id: string) => {
      const normalized = id.startsWith('#') ? id : `#${id}`;
      return ordersRef.current.find(
        (o) => o.id === id || o.serverId === id || o.orderNumber === id || o.orderNumber === normalized
      );
    },
    []
  );

  const updateOrderStatus = useCallback(
    async (id: string, status: OrderStatus, podNote?: string): Promise<boolean> => {
      const order = ordersRef.current.find((o) => o.id === id);
      if (!order || order.status === 'cancelled') return false;
      if (status === 'cancelled') {
        // Cancel-until-shipped: preparing is still reversible (packing
        // started, nothing left the building); out_for_delivery is the point
        // of no return. Server enforces the same allow-list.
        if (order.status !== 'placed' && order.status !== 'confirmed' && order.status !== 'preparing') return false;
      } else {
        // Fulfilment advances are seller-only AND per-order: the seller on
        // THIS order advances it. A dual-role buyer painting their own
        // purchase delivered flashed tracking + hold stamps before the server
        // 400 rolled it back (global isSeller was not enough).
        const meLower = String(user?.username ?? '').trim().toLowerCase();
        const ownerLower = String(order.sellerUsername ?? '').trim().toLowerCase();
        if (!user?.isSeller || !meLower || meLower !== ownerLower) return false;
        const curIdx = ORDER_STATUS_FLOW.indexOf(order.status);
        const nextIdx = ORDER_STATUS_FLOW.indexOf(status);
        // Adjacent-only fulfilment (seller P0): placed→confirmed→preparing→
        // out_for_delivery→delivered. Skipping straight to delivered used to
        // instantly settle withdrawable earnings with no packing/shipping.
        if (nextIdx === -1 || nextIdx !== curIdx + 1) return false;
      }
      const prevSnapshot = ordersRef.current.find((o) => o.id === id);
      setOrders((prev) => {
        const next = prev.map((o) => {
          if (o.id !== id) return o;
          const flowIndex = ORDER_STATUS_FLOW.indexOf(status);
          const tracking = o.tracking.map((step, i) => ({
            ...step,
            done: status === 'cancelled' ? step.done : i <= flowIndex,
            time:
              status !== 'cancelled' && i <= flowIndex && step.time === '—'
                ? new Date().toLocaleString()
                : step.time,
          }));
          // Delivery stamp (7-day hold anchor): set atomically on entering
          // delivered so the wallet hold gate and server payout guard agree.
          // Never backfill — missing stamp means unmatured, not withdrawable.
          const stamp = status === 'delivered' && !(o as { actualDelivery?: unknown }).actualDelivery
            ? { actualDelivery: new Date().toISOString() }
            : {};
          // Optimistic POD entry (server appends the same on ack; pull
          // reconciles). Rolls back with the status on refusal.
          const pod = status === 'delivered' && podNote
            ? { deliveryLog: [...(o.deliveryLog ?? []), { at: new Date().toISOString(), note: podNote }] }
            : {};
          return { ...o, status, tracking, ...stamp, ...pod };
        });
        persist(next);
        return next;
      });
      // Server sync OUTSIDE the updater (updaters must stay pure: StrictMode
      // double-invokes them, which fired this PATCH twice and let rapid taps
      // roll back to a stale snapshot). AWAITED: a refusal/offline rolls back
      // AND reports false so the seller never packs on a lie.
      const realId = ordersRef.current.find((o) => o.id === id)?.serverId ?? id;
      const rollbackStatus = () => {
        setOrders((cur) => {
          const rolled = cur.map((x) => (x.id === id && prevSnapshot ? prevSnapshot : x));
          persist(rolled);
          return rolled;
        });
      };
      try {
        const res = await serverApi.updateOrder(realId, podNote ? { status, podNote } : { status });
        // Ambiguous transport: the status change may have committed — keep
        // the optimistic state (next pull reconciles server-wins) and report
        // false so the seller doesn't treat it as confirmed.
        if (!res.ok && !isAmbiguousTransport((res as { error?: unknown }).error)) rollbackStatus();
        return res.ok;
      } catch {
        // Thrown = transport failed mid-flight: keep optimistic, no rollback.
        return false;
      }
    },
    [persist, user?.isSeller, user?.username]
  );

  const markReviewed = useCallback(
    async (id: string, rating: number, comment?: string, anonymous?: boolean): Promise<boolean> => {
      const prevSnapshot = ordersRef.current.find((o) => o.id === id);
      setOrders((prev) => {
        const next = prev.map((order) =>
          order.id === id ? { ...order, reviewed: true, rating, reviewComment: comment, reviewAnonymous: !!anonymous } : order
        );
        persist(next);
        return next;
      });
      // Rollback on server refusal (not delivered / already reviewed /
      // offline): a review the server never stored must not render as posted.
      // Returns the ack so callers show success ONLY after the server confirms.
      const realId = ordersRef.current.find((o) => o.id === id)?.serverId ?? id;
      const rollbackReview = () => {
        setOrders((cur) => {
          const rolled = cur.map((x) => (x.id === id && prevSnapshot ? prevSnapshot : x));
          persist(rolled);
          return rolled;
        });
      };
      try {
        const res = await serverApi.updateOrder(realId, { rating, reviewComment: comment ?? '', reviewAnonymous: !!anonymous });
        if (!res.ok && !isAmbiguousTransport((res as { error?: unknown }).error)) rollbackReview();
        return res.ok;
      } catch {
        // Ambiguous transport: a posted review the server stored must not
        // render as unposted. Keep + let the next pull reconcile.
        return false;
      }
    },
    [persist]
  );

  const requestRefund = useCallback(
    async (orderId: string, reason: string): Promise<boolean> => {
      const order = ordersRef.current.find((o) => o.id === orderId);
      if (!order || order.refund) return false;
      const now = Date.now();
      // Build the refund object OUTSIDE the state updater so the admin sync
      // below can reference it (the updater runs asynchronously — capturing
      // inside it previously made the sync never fire).
      const created: Refund = {
        id: `ref_${now}`,
        reason,
        status: 'requested',
        requestedAt: now,
        timeline: [{ author: 'you' as RefundTimelineAuthor, text: `Refund requested: ${reason}.`, time: now }],
      };
      const prevSnapshot = ordersRef.current.find((o) => o.id === orderId);
      setOrders((prev) => {
        const next = prev.map((o) => (o.id === orderId && !o.refund ? { ...o, refund: created } : o));
        persist(next);
        return next;
      });
      // The refund request itself is created server-side (single writer):
      // serverApi.updateOrder({ refundReason }) inserts the canonical Refund
      // row. The legacy admin-mirror POST is gone — it wrote a SECOND
      // duplicate row per request (different id + orderRef, no seller link).
      // AWAITED with rollback: an offline request used to render "requested"
      // forever while the server held nothing and no retry path existed.
      const realRefundId = order.serverId ?? orderId;
      try {
        const res = await serverApi.updateOrder(realRefundId, { refundReason: reason });
        if (!res.ok && !isAmbiguousTransport((res as { error?: unknown }).error)) {
          setOrders((cur) => {
            const rolled = cur.map((x) => (x.id === orderId && prevSnapshot ? prevSnapshot : x));
            persist(rolled);
            return rolled;
          });
        }
        return res.ok;
      } catch {
        // Ambiguous: a stored request must not flip back to unrequested.
        return false;
      }
    },
    [persist]
  );

  const respondRefund = useCallback(
    async (orderId: string, author: RefundTimelineAuthor, text: string, newStatus?: RefundStatus, note?: string): Promise<boolean> => {
      const now = Date.now();
      const prevStatus = ordersRef.current.find((o) => o.id === orderId)?.refund?.status;
      setOrders((prev) => {
        const next = prev.map((order) => {
          if (order.id !== orderId || !order.refund) return order;
          return {
            ...order,
            refund: {
              ...order.refund,
              status: newStatus ?? order.refund.status,
              timeline: [...order.refund.timeline, { author, text, time: now }],
            },
          };
        });
        persist(next);
        return next;
      });
      // Seller decisions settle REAL money server-side (single writer:
      // PATCH /api/app/orders/[id] {refundDecision}, seller-only, idempotent
      // legs shared with the finance desk). The legacy admin-mirror call is
      // gone — it patched a duplicate row and moved no money. Server refusal
      // (not the seller, nothing pending, offline) rolls the optimistic
      // decision back AND reports false — the UI never shows money that
      // didn't move.
      if (newStatus === 'approved' || newStatus === 'rejected') {
        const realId = ordersRef.current.find((o) => o.id === orderId)?.serverId ?? orderId;
        const rollback = () => {
          setOrders((prev) => {
            const next = prev.map((order) => {
              if (order.id !== orderId || !order.refund) return order;
              return {
                ...order,
                refund: {
                  ...order.refund,
                  status: prevStatus ?? order.refund.status,
                  timeline: order.refund.timeline.filter(
                    (t) => !(t.time === now && t.text === text && t.author === author)
                  ),
                },
              };
            });
            persist(next);
            return next;
          });
        };
        try {
          // The seller's reason travels to the server (Refund row) — the old
          // call sent the decision alone and the reason never left the device.
          const res = await serverApi.respondRefund(realId, newStatus, note);
          if (!res.ok && !isAmbiguousTransport((res as { error?: unknown }).error)) rollback();
          return res.ok;
        } catch {
          // Ambiguous: a settled decision must not flip back. Keep + reconcile.
          return false;
        }
      }
      return true;
    },
    [persist]
  );

  const cancelOrder = useCallback(
    async (orderId: string, reason?: string) => {
      const order = ordersRef.current.find((o) => o.id === orderId);
      if (!order || (order.status !== 'placed' && order.status !== 'confirmed' && order.status !== 'preparing') || order.refund) {
        return false;
      }
      const now = Date.now();
      const prevSnapshot = ordersRef.current.find((o) => o.id === orderId);
      // The server cancel settles money IMMEDIATELY in-tx (wallet buyer
      // credited, no Refund row ever created) — so the local mirror must not
      // fabricate a `requested` refund: it never advances (no server row),
      // and sellers render phantom Approve/Reject buttons that 400 forever.
      // Wallet cancels mirror `refunded`; COD moves no money → no refund row.
      const isWallet = String(order.paymentMethod ?? '').trim().toLowerCase() === 'wallet';
      setOrders((prev) => {
        const next = prev.map((o) =>
          o.id === orderId
            ? {
                ...o,
                status: 'cancelled' as OrderStatus,
                tracking: o.tracking
                  ? [
                      ...o.tracking,
                      { label: isWallet ? 'Order cancelled — refund issued' : 'Order cancelled', time: new Date(now).toLocaleString(), done: true },
                    ]
                  : o.tracking,
                ...(isWallet
                  ? {
                      refund: {
                        id: `ref_${now}`,
                        reason: reason ?? 'Order cancelled',
                        status: 'refunded' as RefundStatus,
                        requestedAt: now,
                        timeline: [
                          { author: 'you' as RefundTimelineAuthor, text: 'Order cancelled — refund issued to wallet', time: now },
                        ],
                      },
                    }
                  : { refund: undefined }),
              }
            : o
        );
        persist(next);
        return next;
      });
      // Single server sync OUTSIDE the updater (updaters must stay pure:
      // StrictMode double-invokes them, which fired this PATCH twice).
      // Rollback ONLY on explicit server refusal — ambiguous transport keeps
      // the optimistic cancel (it may have settled money in-tx; the next
      // pull reconciles server-wins). Buyer-cancel settles
      // the real refund + clawback server-side.
      const realId = ordersRef.current.find((o) => o.id === orderId)?.serverId ?? orderId;
      const rollback = () => {
        setOrders((cur) => {
          const rolled = cur.map((x) => (x.id === orderId && prevSnapshot ? prevSnapshot : x));
          persist(rolled);
          return rolled;
        });
      };
      try {
        // The cancel/decline reason travels (server appends it to the
        // deliveryLog the buyer tracking screen renders) — previously it
        // died on the device and the buyer saw bare "cancelled".
        const res = await serverApi.updateOrder(realId, reason ? { status: 'cancelled', cancelReason: reason } : { status: 'cancelled' });
        // Ambiguous transport: the cancel may have settled money in-tx — a
        // blind rollback would resurrect a refunded order. Keep + reconcile.
        if (!res.ok && !isAmbiguousTransport((res as { error?: unknown }).error)) {
          rollback();
          return false;
        }
        return res.ok;
      } catch {
        return false;
      }
    },
    [persist]
  );

  return (
    <OrderContext.Provider
      value={{
        orders,
        placeOrders,
        getOrder,
        retryOrderSync,
        updateOrderStatus,
        markReviewed,
        requestRefund,
        respondRefund,
        cancelOrder,
        loaded,
      }}
    >
      {children}
    </OrderContext.Provider>
  );
}

export function useOrders() {
  const ctx = useContext(OrderContext);
  if (!ctx) {
    throw new Error('useOrders must be used within an OrderProvider');
  }
  return ctx;
}

export { STATUS_LABELS, REFUND_STATUS_LABELS };
