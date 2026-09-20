"use client";

import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/shared/stat-tile";
import { exportToCSV, exportToExcel } from "@/lib/export";
import { useAuthStore } from "@/store/auth-store";
import { Download, FileSpreadsheet, Clock } from "lucide-react";

const RESOURCES: { value: string; label: string }[] = [
  { value: "users", label: "Users" },
  { value: "sellers", label: "Sellers" },
  { value: "products", label: "Products" },
  { value: "orders", label: "Orders" },
  { value: "categories", label: "Categories" },
  { value: "communities", label: "Communities" },
  { value: "reviews", label: "Reviews" },
  { value: "transactions", label: "Transactions" },
  { value: "ledger", label: "Ledger" },
  { value: "gateway-logs", label: "Gateway Logs" },
  { value: "shipments", label: "Shipments" },
  { value: "carriers", label: "Carriers" },
  { value: "delivery-zones", label: "Delivery Zones" },
  { value: "tickets", label: "Support Tickets" },
  { value: "withdrawals", label: "Withdrawals" },
  { value: "refunds", label: "Refunds" },
  { value: "disputes", label: "Disputes" },
  { value: "coupons", label: "Coupons" },
  { value: "promotions", label: "Promotions & Ads" },
  { value: "commission", label: "Commission & Fees" },
  // Moderation + content queues the desk moderates (were API-only while the
  // desk that judges them couldn't pull them for audit).
  { value: "posts", label: "Posts" },
  { value: "blocked", label: "Blocked Users" },
  { value: "messages", label: "Messages" },
  { value: "reported-products", label: "Reported Products" },
  { value: "reported-messages", label: "Reported Messages" },
  { value: "reported-comments", label: "Reported Comments" },
  { value: "reported-users", label: "Reported Users" },
  { value: "stories", label: "Stories" },
  { value: "reels", label: "Reels" },
  { value: "live", label: "Live Streams" },
  { value: "hashtags", label: "Hashtags" },
  { value: "bundles", label: "Bundles" },
  { value: "bookings", label: "Bookings" },
  { value: "auctions", label: "Auctions" },
  { value: "loyalty", label: "Loyalty" },
  { value: "seller-documents", label: "Seller Documents" },
  { value: "webhook-events", label: "Webhook Events" },
  // Subscribers removed: no such resource exists (export 404ed). Re-add only
  // with a real newsletter/subscriber table behind it.
  { value: "audit-logs", label: "Audit Logs" },
  { value: "admins", label: "Admins" },
];

function prettifyLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RecentExport {
  resource: string;
  format: string;
  rows: number;
  at: string;
}

export default function ExportCenterPage() {
  const [resource, setResource] = useState("users");
  // Finance reconciliation scope: money datasets only — never sellers/users
  // full PII, admins, or audit trails. The API read scope enforces the same
  // boundary; the picker simply doesn't offer what the role cannot pull.
  // Finance reconciliation scope: EXACTLY the API read scope. Role aliases
  // (accountant/treasury normalize to finance in proxy + API) count too —
  // otherwise those roles see the full picker but 403 on fetch.
  const roleNorm = String(useAuthStore((s) => s.user?.role) ?? "").toLowerCase();
  const financeOnly = roleNorm === "finance" || roleNorm === "accountant" || roleNorm === "treasury";
  const MONEY_RESOURCES = new Set([
    "orders", "transactions", "ledger", "gateway-logs", "commission",
    "withdrawals", "refunds", "disputes",
  ]);
  const visibleResources = financeOnly ? RESOURCES.filter((r) => MONEY_RESOURCES.has(r.value)) : RESOURCES;
  const effectiveResource = financeOnly && !MONEY_RESOURCES.has(resource) ? "orders" : resource;
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentExport[]>([]);

  const resourceLabel = RESOURCES.find((r) => r.value === effectiveResource)?.label ?? effectiveResource;

  // Preview shows the first 12 columns; the FILE carries every column (the
  // old slice(0,12) silently dropped money/identity columns from exports).
  const allColumns = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    return Object.keys(rows[0])
      .filter((k) => !["password", "passwordHash", "twoFactorCode"].includes(k))
      .map((k) => ({ key: k, label: prettifyLabel(k) }));
  }, [rows]);
  const exportColumns = useMemo(() => allColumns.slice(0, 12), [allColumns]);

  async function load(full = false) {
    setLoading(true);
    setError(null);
    try {
      // Full-book mode (?export=1&take=5000) for finance reconciliation:
      // the 100-row window is knowingly partial past 100 rows. The exported
      // file carries its own row-count marker (see doExport).
      const url = full
        ? `/api/data/${effectiveResource}?export=1&take=5000`
        : `/api/data/${effectiveResource}?take=100`;
      const res = await fetch(url, { cache: "no-store", credentials: "include" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Failed to load");
      setRows(body.rows as Record<string, unknown>[]);
      setTotal(typeof body.total === "number" ? body.total : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
      setRows(null);
      setTotal(null);
    } finally {
      setLoading(false);
    }
  }

  // In-file marker row: a partial export must say so INSIDE the file, not
  // just on the preview page (files travel without their page).
  function withMarker(data: Record<string, unknown>[]): Record<string, unknown>[] {
    const marker = {
      __export: `susej ${effectiveResource} export ${new Date().toISOString()} — ${data.length} rows${typeof total === "number" && total > data.length ? ` (PARTIAL of ${total})` : " (complete)"}`,
    };
    return [marker, ...data];
  }

  function doExport(format: "CSV" | "Excel") {
    if (!rows) return;
    const stamped = withMarker(rows);
    if (format === "CSV") exportToCSV(stamped, `susej-${effectiveResource}`, [{ key: "__export", label: "export_info" }, ...allColumns]);
    else exportToExcel(stamped, `susej-${effectiveResource}`, [{ key: "__export", label: "export_info" }, ...allColumns]);
    record(format);
  }

  function record(format: "CSV" | "Excel") {
    setRecent((prev) =>
      [
        { resource: resourceLabel, format, rows: rows?.length ?? 0, at: new Date().toLocaleTimeString() },
        ...prev,
      ].slice(0, 8)
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-[#18181B]">Export Center</h1>
        <p className="mt-0.5 text-[13px] text-[#71717A]">Export any dataset to CSV or Excel.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Export data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="w-full max-w-xs">
              <label className="mb-1.5 block text-sm font-medium text-[#18181B]">Dataset</label>
              <select
                value={effectiveResource}
                onChange={(e) => setResource(e.target.value)}
                className="h-9 w-full rounded-[6px] border border-[#E4E4E7] bg-white px-3 text-sm text-[#18181B] outline-none focus:border-[#6C3BFF]"
              >
                {visibleResources.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            <Button variant="secondary" onClick={() => load(false)} disabled={loading}>
              {loading ? "Loading..." : "Load data"}
            </Button>
            <Button variant="secondary" onClick={() => load(true)} disabled={loading} title="Full book up to 5000 rows for reconciliation">
              {loading ? "Loading..." : "Load full book"}
            </Button>
            <Button onClick={() => { if (rows) { doExport("CSV"); } }} disabled={!rows || rows.length === 0}>
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Button variant="secondary" onClick={() => { if (rows) { doExport("Excel"); } }} disabled={!rows || rows.length === 0}>
              <FileSpreadsheet className="h-4 w-4" />
              Export Excel
            </Button>
          </div>

          {error && <p className="text-sm text-[#EF4444]">{error}</p>}

          {loading ? (
            <p className="py-8 text-center text-sm text-[#A1A1AA]">Loading...</p>
          ) : rows === null ? (
            <p className="py-8 text-center text-sm text-[#A1A1AA]">Choose a dataset and click &ldquo;Load data&rdquo; to preview it.</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[#A1A1AA]">No rows in this dataset.</p>
          ) : (
            <>
              <p className="text-[13px] text-[#71717A]">
                {rows.length} rows{typeof total === "number" && total > rows.length ? ` of ${total} total` : ""} · {allColumns.length} columns
                {exportColumns.length < allColumns.length ? ` (preview shows first ${exportColumns.length})` : ""}
              </p>
              <div className="overflow-x-auto rounded-[6px] bg-white">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#E4E4E7] bg-[#FAFAFA]">
                      {exportColumns.map((c) => (
                        <th key={c.key} className="px-4 py-2.5 text-[13px] font-medium text-[#71717A]">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((row, i) => (
                      <tr key={i} className="border-b border-[#E4E4E7] last:border-0">
                        {exportColumns.map((c) => {
                          const v = row[c.key];
                          const str = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
                          return <td key={c.key} className="max-w-[240px] truncate px-4 py-2.5 text-[13px] text-[#18181B]">{str}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 5 && (
                <p className="text-xs text-[#A1A1AA]">Showing first 5 rows — export includes all {rows.length}.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Datasets available" value={visibleResources.length} tone="purple" />
        <StatTile label="Loaded rows" value={rows?.length ?? 0} />
        <StatTile label="This session exports" value={recent.length} tone="green" />
        <StatTile label="Last export" value={recent[0] ? `${recent[0].format} · ${recent[0].rows} rows` : "—"} />
      </div>

      {recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent exports</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-[#E4E4E7]">
              {recent.map((r, i) => (
                <div key={i} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-[#A1A1AA]" />
                    <p className="text-[13px] font-medium text-[#18181B]">{r.resource}</p>
                    <BadgeMini>{r.format}</BadgeMini>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-[#A1A1AA]">
                    <span>{r.rows} rows</span>
                    <span>{r.at}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BadgeMini({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[4px] bg-[#F4F4F5] px-1.5 py-0.5 text-[10px] font-medium text-[#71717A]">
      {children}
    </span>
  );
}