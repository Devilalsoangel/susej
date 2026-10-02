"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

export type DbResource =
  | "address-book"
  | "admins"
  | "app-settings"
  | "auctions"
  | "audit-logs"
  | "blocked"
  | "bookings"
  | "broadcasts"
  | "bundles"
  | "carriers"
  | "categories"
  | "communities"
  | "commission"
  | "coupons"
  | "delivery-zones"
  | "disputes"
  | "featured-posts"
  | "food-hub"
  | "gateway-logs"
  | "hashtags"
  | "hot-deals"
  | "home-sections"
  | "ledger"
  | "live"
  | "loyalty"
  | "messages"
  | "notification-history"
  | "notification-templates"
  | "orders"
  | "payment-methods"
  | "posts"
  | "products"
  | "promotions"
  | "reported-comments"
  | "reported-messages"
  | "reported-products"
  | "refunds"
  | "reported-users"
  | "revenue-metrics"
  | "reviews"
  | "reels"
  | "sessions"
  | "sellers"
  | "seller-documents"
  | "seller-audit-log"
  | "shipments"
  | "spotlights"
  | "storefront-banners"
  | "stories"
  | "tickets"
  | "top-sellers"
  | "transactions"
  | "users"
  | "withdrawals";

export type DbResourceOptions = {
  q?: string;
  status?: string;
  id?: string;
  take?: number;
  skip?: number;
  page?: number;
  orderBy?: string;
  orderDir?: "asc" | "desc";
};

type DbResponse<T> = { rows?: T[]; total?: number; error?: string };

function resourceUrl(resource: DbResource, opts?: DbResourceOptions): string {
  if (!opts || (!opts.q && !opts.status && !opts.id && !opts.take && !opts.skip && !opts.page && !opts.orderBy)) {
    return `/api/data/${resource}?take=100`;
  }
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.status) params.set("status", opts.status);
  if (opts.id) params.set("id", opts.id);
  if (opts.take) params.set("take", String(opts.take));
  if (opts.skip) params.set("skip", String(opts.skip));
  if (opts.page) params.set("page", String(opts.page));
  if (opts.orderBy) params.set("orderBy", opts.orderBy);
  if (opts.orderDir) params.set("orderDir", opts.orderDir);
  const query = params.toString();
  return query ? `/api/data/${resource}?${query}` : `/api/data/${resource}`;
}

export function useDbResource<T>(resource: DbResource, opts?: DbResourceOptions) {
  const optionsKey = useMemo(() => JSON.stringify(opts ?? null), [opts]);
  const url = resourceUrl(resource, opts);
  const query = useQuery<DbResponse<T>>({
    queryKey: ["db-resource", resource, optionsKey],
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 8000);
      try {
        const response = await fetch(url, { cache: "no-store", credentials: "include", signal: controller.signal });
        const text = await response.text();
        let body: DbResponse<T> = {};
        try {
          body = text ? JSON.parse(text) as DbResponse<T> : {};
        } catch {
          throw new Error(`Database request failed (${response.status})`);
        }
        if (!response.ok) throw new Error(body.error ?? `Database request failed (${response.status})`);
        if (!Array.isArray(body.rows)) {
          throw new Error(body.error ?? "Database returned an invalid response");
        }
        return { rows: body.rows, total: typeof body.total === "number" ? body.total : undefined };
      } catch (error) {
        if (timedOut) throw new Error("Request timed out — database may be unavailable");
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const refetch = query.refetch;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    data: query.data?.rows ?? null,
    error: query.error ? (query.error instanceof Error ? query.error.message : "Failed to load data") : null,
    isError: query.isError,
    loading: query.isFetching,
    total: query.data?.total ?? null,
    refresh,
  };
}
