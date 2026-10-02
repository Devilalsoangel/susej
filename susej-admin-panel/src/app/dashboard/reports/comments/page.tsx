"use client";

import { useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/shared/stat-tile";
import { ErrorState } from "@/components/shared/error-state";
import { useDbResource } from "@/hooks/use-db-resource";
import { apiDelete, apiPatch } from "@/lib/api-mutate";
import { toast } from "@/components/ui/toast";
import { formatDate } from "@/lib/utils";
import { MessageSquareX, CheckCircle2 } from "lucide-react";
import type { ReportedCommentRow } from "@/types/admin-rows";

const column = createColumnHelper<ReportedCommentRow>();

const makeColumns = (
  onDelete: (r: ReportedCommentRow) => void,
  onDismiss: (r: ReportedCommentRow) => void,
  pendingId: string | null
) => [
  column.accessor("text", { header: "Comment", cell: (info) => <span className="text-[#18181B]">{info.getValue()}</span> }),
  column.accessor("authorName", { header: "Author", cell: (info) => <span className="font-medium">{info.getValue()}</span> }),
  column.accessor("postTitle", { header: "On Post", cell: (info) => <span className="text-[#71717A]">{info.getValue()}</span> }),
  column.accessor("reason", { header: "Reason", cell: (info) => <Badge variant="danger">{info.getValue()}</Badge> }),
  column.accessor("reportCount", { header: "Reports", cell: (info) => <span className="font-medium">{info.getValue()}x</span> }),
  column.accessor("createdAt", { header: "Reported", cell: (info) => <span className="text-[#71717A]">{formatDate(info.getValue())}</span> }),
  column.display({
    id: "actions",
    header: "",
    cell: (info) => {
      const row = info.row.original;
      const busy = pendingId === row.id;
      return (
        <div className="flex gap-2">
          <Button variant="danger" size="sm" disabled={busy} onClick={() => onDelete(row)}>
            <MessageSquareX className="h-3.5 w-3.5" /> Delete
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismiss(row)}>
            <CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A]" /> Dismiss
          </Button>
        </div>
      );
    },
  }),
];

export default function ReportedCommentsPage() {
  const { data: rows, error, loading: rowsLoading, refresh } = useDbResource<ReportedCommentRow>("reported-comments");
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const items = useMemo(
    () => (rows ?? []).filter((row) => !removedIds.has(row.id)),
    [rows, removedIds]
  );

  async function deleteComment(r: ReportedCommentRow) {
    setPendingId(r.id);
    setRemovedIds((current) => new Set(current).add(r.id));
    try {
      await apiPatch("reported-comments", r.id, { action: "delete" });
      await refresh();
      toast.success("Comment deleted and report resolved.");
    } catch (e) {
      setRemovedIds((current) => {
        const next = new Set(current);
        next.delete(r.id);
        return next;
      });
      toast.error(e instanceof Error ? e.message : "Comment deletion failed — nothing was changed.");
    } finally {
      setPendingId(null);
    }
  }

  async function dismissReport(r: ReportedCommentRow) {
    setPendingId(r.id);
    setRemovedIds((current) => new Set(current).add(r.id));
    try {
      await apiDelete("reported-comments", r.id);
      await refresh();
      toast.success("Report dismissed.");
    } catch (e) {
      setRemovedIds((current) => {
        const next = new Set(current);
        next.delete(r.id);
        return next;
      });
      toast.error(e instanceof Error ? e.message : "Report dismissal failed — nothing was changed.");
    } finally {
      setPendingId(null);
    }
  }

  const authors = new Set((items ?? []).map((r) => r.authorName)).size;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-[#18181B]">Reported Comments</h1>
        <p className="mt-0.5 text-[13px] text-[#71717A]">Comments flagged across communities and posts.</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Reported comments" value={(items ?? []).length} tone="red" />
        <StatTile label="Distinct authors" value={authors} tone="amber" />
        <StatTile label="Spam" value={(items ?? []).filter((r) => r.reason === "Spam").length} />
        <StatTile label="Resolved" value={(rows ?? []).length - (items ?? []).length} tone="green" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reported Comments</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <ErrorState
              title="Reported comments unavailable"
              message={error}
              onRetry={() => void refresh()}
            />
          ) : (
            <DataTable loading={rowsLoading}
              columns={makeColumns(deleteComment, dismissReport, pendingId)}
              data={items ?? []}
              searchable
              searchKey="text"
              filename="reported-comments"
              exportColumns={[
                { key: "text", label: "Comment" },
                { key: "authorName", label: "Author" },
                { key: "postTitle", label: "On Post" },
                { key: "reason", label: "Reason" },
                { key: "reportCount", label: "Reports" },
                { key: "createdAt", label: "Reported" },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}