"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { createColumnHelper } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { useDbResource } from "@/hooks/use-db-resource";
import { formatDate } from "@/lib/utils";
import { Eye } from "lucide-react";
import type { Seller } from "@/types";

const columnHelper = createColumnHelper<Seller>();

const baseColumns = [
  columnHelper.accessor("businessName", {
    header: "Business",
    cell: (info) => (
      <div>
        <p className="font-medium text-[#18181B] ">{info.getValue()}</p>
        <p className="text-xs text-gray-500">{info.row.original.ownerName}</p>
      </div>
    ),
  }),
  columnHelper.accessor("kycStatus", {
    header: "KYC",
    // Soft-deleted sellers otherwise render as live — the status column is
    // the only place deletion is visible (rows stay for audit recovery).
    cell: (info) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusBadge status={info.getValue()} />
        {(info.row.original as { status?: string }).status === "deleted" && (
          <span className="rounded-full bg-[#FEE2E2] px-1.5 py-0.5 text-[10px] font-medium text-[#991B1B]">
            Deleted
          </span>
        )}
      </span>
    ),
  }),
  columnHelper.accessor("gstStatus", {
    header: "GST",
    cell: (info) => <StatusBadge status={info.getValue()} />,
  }),
  columnHelper.accessor("productsCount", {
    header: "Products",
    cell: (info) => <span>{info.getValue()}</span>,
  }),
  columnHelper.accessor("joinedAt", {
    header: "Joined",
    cell: (info) => <span className="text-gray-500">{formatDate(info.getValue())}</span>,
  }),
];

function PendingQueue({ sellers, total, loading }: { sellers: Seller[]; total: number | null; loading?: boolean }) {
  const pending = sellers.filter((s) => s.kycStatus === "pending");

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {typeof total === "number" && total > sellers.length && (
        <p className="text-[12px] text-[#71717A]">Server queue holds {total} — paging above pages the full queue.</p>
      )}
      {pending.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-500">No pending verification requests.</p>
        </div>
      ) : (
        pending.map((seller) => {
          const verifiedDocs = (seller.documents ?? []).filter((d) => d.verified).length;
          const totalDocs = (seller.documents ?? []).length;
          return (
            <Link key={seller.id} href={`/dashboard/sellers/${seller.id}`}>
              <div className="flex items-center justify-between rounded-xl border border-[#E4E4E7] px-5 py-4 transition-colors hover:bg-gray-50  ">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#6C3BFF]/10 text-lg font-bold text-[#6C3BFF]">
                    {seller.businessName[0]}
                  </div>
                  <div>
                    <p className="font-medium text-[#18181B] ">{seller.businessName}</p>
                    <p className="text-sm text-gray-500">{seller.ownerName} · {seller.email}</p>
                    <p className="text-xs text-gray-400">Submitted {formatDate(seller.submittedAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm text-gray-500">Documents</p>
                    <p className="text-sm font-medium text-[#18181B] ">{verifiedDocs}/{totalDocs} verified</p>
                  </div>
                  <Button variant="primary" size="sm">
                    <Eye className="h-4 w-4" /> Review
                  </Button>
                </div>
              </div>
            </Link>
          );
        })
      )}
    </div>
  );
}

const tabs = [
  { label: "All Sellers", value: "all" },
  { label: "Pending Queue", value: "pending" },
  { label: "Verified", value: "verified" },
  { label: "Rejected", value: "rejected" },
];

export default function SellersPage() {
  const router = useRouter();
  const { data: sellers, loading: sellersLoading, total: sellersTotal, refresh } = useDbResource<Seller>("sellers", { take: 100 });
  // Every queue pages the SERVER (?status → kycStatus): in-memory filters
  // over the first 100 hid rows at 101+ on every tab, not just pending.
  const [pendingSkip, setPendingSkip] = useState(0);
  const { data: pendingRows, loading: pendingRowsLoading, total: pendingTotal } = useDbResource<Seller>("sellers", {
    take: 100,
    status: "pending",
    ...(pendingSkip > 0 ? { skip: pendingSkip } : {}),
  });
  const [verifiedSkip, setVerifiedSkip] = useState(0);
  const { data: verifiedRows, loading: verifiedLoading, total: verifiedTotal } = useDbResource<Seller>("sellers", {
    take: 100,
    status: "approved",
    ...(verifiedSkip > 0 ? { skip: verifiedSkip } : {}),
  });
  const [rejectedSkip, setRejectedSkip] = useState(0);
  const { data: rejectedRows, loading: rejectedLoading, total: rejectedTotal } = useDbResource<Seller>("sellers", {
    take: 100,
    status: "rejected",
    ...(rejectedSkip > 0 ? { skip: rejectedSkip } : {}),
  });
  const allSellers = sellers ?? [];
  const pendingCount = typeof pendingTotal === "number" ? pendingTotal : allSellers.filter((s) => s.kycStatus === "pending").length;
  const verifiedCount = typeof verifiedTotal === "number" ? verifiedTotal : allSellers.filter((s) => s.kycStatus === "approved").length;
  const rejectedCount = typeof rejectedTotal === "number" ? rejectedTotal : allSellers.filter((s) => s.kycStatus === "rejected").length;
  // Window qualifier for the unfiltered All view only — every status tab now
  // pages the server.
  const win = typeof sellersTotal === "number" && sellersTotal > allSellers.length ? " · first 100" : "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#18181B] ">Sellers</h1>
        <p className="mt-1 text-sm text-gray-500">Review and verify seller applications</p>
      </div>

      <Tabs tabs={tabs} defaultTab="all">
        {(active) => (
          <>
            {active === "all" && (
              <Card>
                <CardHeader>
                  <CardTitle>All Sellers ({allSellers.length}{win})</CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable loading={sellersLoading} columns={baseColumns} data={allSellers}
                    totalCount={sellersTotal ?? allSellers.length}
                    searchable
                    searchKey="businessName"
                    filename="sellers"
                    exportColumns={[
                      { key: "businessName", label: "Business" },
                      { key: "kycStatus", label: "KYC" },
                      { key: "gstStatus", label: "GST" },
                      { key: "productsCount", label: "Products" },
                      { key: "joinedAt", label: "Joined" },
                    ]}
                    selectable
                    onBulkDelete={async (rows) => {
                      const ids = (rows as any[]).map((r) => r.id);
                      if (!confirm(`Delete ${ids.length} seller(s)? Sellers with live data or review evidence are protected and will be skipped.`)) return;
                      const failures: string[] = [];
                      for (const id of ids) {
                        try {
                          const res = await fetch(`/api/data/sellers`, { method: "DELETE", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ id }) });
                          // Surface the server's exact 409 reason (live data /
                          // review evidence) — never a generic permissions shrug.
                          if (!res.ok) {
                            const body = await res.json().catch(() => null);
                            failures.push(`${id}: ${body?.error ?? `HTTP ${res.status}`}`);
                          }
                        } catch (e) { failures.push(`${id}: ${e instanceof Error ? e.message : "network error"}`); }
                      }
                      if (failures.length > 0) alert(`${failures.length} delete(s) refused:\n${failures.slice(0, 5).join("\n")}${failures.length > 5 ? `\n…+${failures.length - 5} more` : ""}`);
                      refresh();
                    }}
                    onRowClick={(row) => router.push(`/dashboard/sellers/${row.id}`)}
                  />
                </CardContent>
              </Card>
            )}
            {active === "pending" && (
              <Card>
                <CardHeader>
                  <CardTitle>Pending Queue ({pendingCount})</CardTitle>
                </CardHeader>
                <CardContent>
                  <PendingQueue sellers={pendingRows ?? []} total={pendingTotal} loading={pendingRowsLoading} />
                  {typeof pendingTotal === "number" && pendingTotal > (pendingRows ?? []).length && (
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pendingSkip === 0}
                        onClick={() => setPendingSkip(Math.max(0, pendingSkip - 100))}
                      >
                        Prev 100
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pendingSkip + (pendingRows ?? []).length >= pendingTotal}
                        onClick={() => setPendingSkip(pendingSkip + 100)}
                      >
                        Next 100
                      </Button>
                      <span className="text-[12px] text-[#71717A]">
                        Showing {pendingSkip + 1}–{pendingSkip + (pendingRows ?? []).length} of {pendingTotal}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            {active === "verified" && (
              <Card>
                <CardHeader>
                  <CardTitle>Verified Sellers ({verifiedCount})</CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable loading={verifiedLoading}
                    columns={baseColumns}
                    data={verifiedRows ?? []}
                    totalCount={verifiedTotal ?? (verifiedRows ?? []).length}
                    searchable
                    searchKey="businessName"
                    onRowClick={(row) => router.push(`/dashboard/sellers/${row.id}`)}
                  />
                  {typeof verifiedTotal === "number" && verifiedTotal > (verifiedRows ?? []).length && (
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={verifiedSkip === 0}
                        onClick={() => setVerifiedSkip(Math.max(0, verifiedSkip - 100))}
                      >
                        Prev 100
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={verifiedSkip + (verifiedRows ?? []).length >= verifiedTotal}
                        onClick={() => setVerifiedSkip(verifiedSkip + 100)}
                      >
                        Next 100
                      </Button>
                      <span className="text-[12px] text-[#71717A]">
                        Showing {verifiedSkip + 1}–{verifiedSkip + (verifiedRows ?? []).length} of {verifiedTotal}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            {active === "rejected" && (
              <Card>
                <CardHeader>
                  <CardTitle>Rejected Sellers ({rejectedCount})</CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable loading={rejectedLoading}
                    columns={baseColumns}
                    data={rejectedRows ?? []}
                    totalCount={rejectedTotal ?? (rejectedRows ?? []).length}
                    searchable
                    searchKey="businessName"
                    onRowClick={(row) => router.push(`/dashboard/sellers/${row.id}`)}
                  />
                  {typeof rejectedTotal === "number" && rejectedTotal > (rejectedRows ?? []).length && (
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={rejectedSkip === 0}
                        onClick={() => setRejectedSkip(Math.max(0, rejectedSkip - 100))}
                      >
                        Prev 100
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={rejectedSkip + (rejectedRows ?? []).length >= rejectedTotal}
                        onClick={() => setRejectedSkip(rejectedSkip + 100)}
                      >
                        Next 100
                      </Button>
                      <span className="text-[12px] text-[#71717A]">
                        Showing {rejectedSkip + 1}–{rejectedSkip + (rejectedRows ?? []).length} of {rejectedTotal}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </Tabs>
    </div>
  );
}
