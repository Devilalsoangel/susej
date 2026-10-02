"use client";

import { useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { StatTile } from "@/components/shared/stat-tile";
import { ErrorState } from "@/components/shared/error-state";
import { useDbResource } from "@/hooks/use-db-resource";
import { apiDelete, apiPatch } from "@/lib/api-mutate";
import { toast } from "@/components/ui/toast";
import { formatDate } from "@/lib/utils";
import { VolumeX, ShieldBan, CheckCircle2 } from "lucide-react";
import type { ReportedMessageRow } from "@/types/admin-rows";

type ReportedMessageModerationRow = ReportedMessageRow & { participantUsernames?: string[] };

function participantOptions(row: ReportedMessageModerationRow) {
  const values = row.participantUsernames?.length
    ? row.participantUsernames
    : String(row.participants ?? "").split(/\s*(?:,|;|\||&|•|·|\bvs\.?\b|\bwith\b)\s*/i);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].map((value) => ({ label: value, value }));
}

const column = createColumnHelper<ReportedMessageModerationRow>();

const severityVariant: Record<string, "success" | "warning" | "danger" | "default"> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

const makeColumns = (
  onMute: (r: ReportedMessageModerationRow) => void,
  onBlock: (r: ReportedMessageModerationRow) => void,
  onDismiss: (r: ReportedMessageModerationRow) => void,
  targets: Record<string, string>,
  onTarget: (r: ReportedMessageModerationRow, target: string) => void,
  pendingId: string | null
) => [
  column.accessor("threadId", { header: "Thread", cell: (info) => <span className="font-mono text-sm font-medium text-[#18181B]">{info.getValue()}</span> }),
  column.accessor("participants", { header: "Participants", cell: (info) => <span>{info.getValue()}</span> }),
  column.accessor("preview", { header: "Message Preview", cell: (info) => <span className="text-[#71717A]">{info.getValue()}</span> }),
  column.accessor("reason", { header: "Reason", cell: (info) => <Badge variant="danger">{info.getValue()}</Badge> }),
  column.accessor("severity", {
    header: "Severity",
    cell: (info) => <Badge variant={severityVariant[info.getValue()]} className="capitalize">{info.getValue()}</Badge>,
  }),
  column.accessor("reportCount", { header: "Reports", cell: (info) => <span className="font-medium">{info.getValue()}x</span> }),
  column.accessor("createdAt", { header: "Reported", cell: (info) => <span className="text-[#71717A]">{formatDate(info.getValue())}</span> }),
  column.display({
    id: "actions",
    header: "",
    cell: (info) => {
      const row = info.row.original;
      const options = participantOptions(row);
      const target = targets[row.id] ?? (options.length === 1 ? options[0].value : "");
      const busy = pendingId === row.id;
      return (
        <div className="flex items-center gap-2">
          <Select
            className="h-8 w-44 rounded-lg text-xs"
            value={target}
            onChange={(event) => onTarget(row, event.target.value)}
            options={options}
            placeholder={options.length ? "Select offender" : "Participants unresolved"}
            disabled={busy || options.length === 0}
            aria-label={`Offending participant for report ${row.id}`}
          />
          <Button variant="secondary" size="sm" disabled={!target || options.length < 2 || busy} onClick={() => onMute(row)}>
            <VolumeX className="h-3.5 w-3.5" /> Mute
          </Button>
          <Button variant="danger" size="sm" disabled={!target || options.length < 2 || busy} onClick={() => onBlock(row)}>
            <ShieldBan className="h-3.5 w-3.5" /> Block
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismiss(row)}>
            <CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A]" /> Dismiss
          </Button>
        </div>
      );
    },
  }),
];

export default function ReportedMessagesPage() {
  const { data: rows, error, loading: rowsLoading, total, refresh } = useDbResource<ReportedMessageModerationRow>("reported-messages");
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const items = useMemo(
    () => (rows ?? []).filter((row) => !removedIds.has(row.id)),
    [rows, removedIds]
  );

  function setTarget(row: ReportedMessageModerationRow, target: string) {
    setTargets((current) => ({ ...current, [row.id]: target }));
  }

  async function act(row: ReportedMessageModerationRow, action: "mute" | "block" | "dismiss") {
    const options = participantOptions(row);
    const target = targets[row.id] ?? (options.length === 1 ? options[0].value : "");
    if (action !== "dismiss" && options.length < 2) {
      toast.error("Both thread participants must resolve before Mute or Block.");
      return;
    }
    if (action !== "dismiss" && !target) {
      toast.error("Select the offending participant first.");
      return;
    }
    setPendingId(row.id);
    setRemovedIds((current) => new Set(current).add(row.id));
    try {
      if (action === "dismiss") {
        await apiDelete("reported-messages", row.id);
      } else {
        await apiPatch("reported-messages", row.id, { action, target });
      }
      await refresh();
      setTargets((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      toast.success(
        action === "dismiss"
          ? "Report dismissed."
          : action === "mute"
            ? `${target} can no longer message the other participant in this conversation.`
            : `${target} is suspended and blocked from this conversation.`
      );
    } catch (e) {
      setRemovedIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      toast.error(e instanceof Error ? e.message : "Moderation action failed — nothing was changed.");
    } finally {
      setPendingId(null);
    }
  }

  const high = (items ?? []).filter((r) => r.severity === "high").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-[#18181B]">Reported Messages</h1>
        <p className="mt-0.5 text-[13px] text-[#71717A]">Chat threads reported for scams, spam, or harassment.</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Reported threads" value={(items ?? []).length} tone="red" />
        <StatTile label="High severity" value={high} tone="red" />
        <StatTile label="Scam reports" value={(items ?? []).filter((r) => r.reason.toLowerCase().includes("scam") || r.reason.toLowerCase().includes("fraud")).length} tone="amber" />
        <StatTile label="Resolved" value={(rows ?? []).length - (items ?? []).length} tone="green" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reported Chat Threads</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <ErrorState
              title="Reported messages unavailable"
              message={error}
              onRetry={() => void refresh()}
            />
          ) : (
            <DataTable loading={rowsLoading}
              columns={makeColumns(
                (row) => void act(row, "mute"),
                (row) => void act(row, "block"),
                (row) => void act(row, "dismiss"),
                targets,
                setTarget,
                pendingId
              )}
              data={items ?? []}
              totalCount={total ?? (items ?? []).length}
              searchable
              searchKey="participants"
              filename="reported-messages"
              exportColumns={[
                { key: "threadId", label: "Thread" },
                { key: "participants", label: "Participants" },
                { key: "reason", label: "Reason" },
                { key: "severity", label: "Severity" },
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