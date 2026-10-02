"use client";

import { use, useMemo, useRef, useState } from "react";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { toast } from "@/components/ui/toast";
import { useDbResource } from "@/hooks/use-db-resource";
import { apiPatch, apiPost } from "@/lib/api-mutate";
import { formatDate } from "@/lib/utils";
import { useAuthStore } from "@/store/auth-store";
import { ArrowLeft, LifeBuoy, Send, User, Calendar, Tag, MessageSquare } from "lucide-react";
import Link from "next/link";
import type { SupportTicket, AdminUser } from "@/types";

const priorityVariants: Record<string, "success" | "warning" | "danger" | "default"> = {
  low: "success",
  medium: "warning",
  high: "danger",
  urgent: "danger",
};

interface MessageRow {
  id: string;
  threadId: string;
  sender: string;
  senderRole: string;
  body: string;
  createdAt: string;
}

interface ThreadMessage {
  id: string;
  from: "user" | "agent";
  author: string;
  text: string;
  at: string;
}

export default function SupportTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: tickets, error: ticketError, loading: ticketLoading, refresh } = useDbResource<SupportTicket>("tickets", { id });
  const { data: messageRows, error: messageError, refresh: refreshMessages } = useDbResource<MessageRow>("messages", { q: id, take: 100 });
  const { data: adminRows, error: adminError } = useDbResource<AdminUser>("admins");
  const adminUser = useAuthStore((s) => s.user);
  const [assignee, setAssignee] = useState("");
  const [reply, setReply] = useState("");
  const [ticketDraft, setTicketDraft] = useState<{ id: string; ticket: SupportTicket } | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  const fetched = useMemo(() => tickets?.find((ticketRow) => ticketRow.id === id) ?? null, [tickets, id]);
  const ticket = ticketDraft?.id === id ? ticketDraft.ticket : fetched;

  const thread = useMemo<ThreadMessage[]>(() => {
    return (messageRows ?? [])
      .filter((m) => m.threadId === id)
      .map((m) => ({
        id: m.id,
        from: m.senderRole === "agent" ? ("agent" as const) : ("user" as const),
        author: m.sender,
        text: m.body,
        at: m.createdAt,
      }));
  }, [messageRows, id]);

  const assigneeOptions = Array.from(new Set([
    ...(adminRows ?? []).filter((admin) => admin.status === "active").map((admin) => admin.name).filter(Boolean),
    ...(ticket?.assignee ? [ticket.assignee] : []),
  ])).map((name) => ({
    label: name,
    value: name,
  }));

  async function sendReply() {
    if (!reply.trim() || !ticket || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await apiPost("messages", {
        threadId: ticket.id,
        sender: adminUser?.name || "Admin",
        senderRole: "agent",
        body: reply.trim(),
        createdAt: new Date().toISOString(),
      });
      setReply("");
      await refreshMessages();
      toast.success("Reply sent.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reply failed — the draft was preserved.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  if (ticketError) {
    return (
      <div className="space-y-6">
        <Breadcrumb items={[{ label: "Support", href: "/dashboard/support" }, { label: "Ticket" }]} />
        <ErrorState title="Ticket unavailable" message={ticketError} onRetry={() => void refresh()} />
      </div>
    );
  }

  if (ticketLoading && !ticket) return <LoadingState rows={4} />;

  if (!ticket) {
    return (
      <div className="space-y-6">
        <Breadcrumb items={[{ label: "Support", href: "/dashboard/support" }, { label: "Ticket" }]} />
        <EmptyState
          icon={<LifeBuoy className="h-8 w-8 text-gray-300" />}
          title="Ticket not found"
          description={`No ticket exists with ID ${id}.`}
          action={
            <Link href="/dashboard/support">
              <Button variant="secondary">
                <ArrowLeft className="h-4 w-4" /> Back to Support
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  async function patchTicket(patch: Partial<SupportTicket>) {
    const current = ticket;
    if (!current) return;
    setTicketDraft({ id: current.id, ticket: { ...current, ...patch } });
    try {
      await apiPatch("tickets", current.id, patch);
      await refresh();
      setTicketDraft(null);
      toast.success("Ticket updated.");
    } catch (e) {
      setTicketDraft(null);
      toast.error(e instanceof Error ? e.message : "Ticket update failed — nothing was changed.");
    }
  }

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Support", href: "/dashboard/support" }, { label: ticket.id }]} />

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-bold text-[#18181B] ">{ticket.id}</h1>
            <Badge variant={priorityVariants[ticket.priority]}>
              <Tag className="mr-1 h-3 w-3" /> {ticket.priority}
            </Badge>
            <StatusBadge status={ticket.status} />
          </div>
          <p className="mt-1 text-sm font-medium text-[#18181B] ">{ticket.subject}</p>
          <p className="mt-0.5 text-xs text-gray-400">
            {ticket.userName} &middot; Opened {formatDate(ticket.createdAt, "long")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ticket.status === "open" ? (
            <>
              <Button variant="secondary" onClick={() => patchTicket({ status: "resolved", ...(assignee ? { assignee } : {}) })}>
                Resolve
              </Button>
              <Button variant="danger" onClick={() => patchTicket({ status: "closed" })}>
                Close
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => patchTicket({ status: "open" })}>
              Reopen
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-6">
        {/* Left: conversation */}
        <div className="col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Conversation</CardTitle>
            </CardHeader>
            <CardContent>
              {messageError ? (
                <ErrorState
                  title="Conversation unavailable"
                  message={messageError}
                  onRetry={() => void refreshMessages()}
                />
              ) : thread.length === 0 ? (
                <EmptyState
                  icon={<MessageSquare className="h-8 w-8 text-gray-300" />}
                  title="No messages in this thread yet"
                  description="Replies between the user and support will appear here."
                  className="py-8"
                />
              ) : (
                <div className="space-y-4">
                  {thread.map((m) => (
                    <div key={m.id} className={`flex ${m.from === "user" ? "justify-start" : "justify-end"}`}>
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                          m.from === "user" ? "rounded-tl-sm bg-[#F4F4F5]" : "rounded-tr-sm bg-[#6C3BFF]"
                        }`}
                      >
                        <p className={`text-xs font-medium ${m.from === "user" ? "text-gray-500" : "text-white/70"}`}>
                          {m.author} &middot; {formatDate(m.at, "relative")}
                        </p>
                        <p className={`mt-1 text-sm ${m.from === "user" ? "text-[#18181B]" : "text-white"}`}>{m.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {ticket.status === "open" ? (
                <div className="mt-6 flex items-center gap-3">
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    className="h-24 flex-1 rounded-xl border border-[#E4E4E7] bg-[#FAFAFA] p-4 text-sm outline-none focus:border-[#6C3BFF]"
                    placeholder="Write a reply to the user..."
                  />
                  <Button
                    variant="primary"
                    disabled={!reply.trim() || Boolean(messageError) || sending}
                    onClick={sendReply}
                  >
                    <Send className="h-4 w-4" /> Send
                  </Button>
                </div>
              ) : (
                <p className="mt-6 rounded-xl bg-[#FAFAFA] px-4 py-3 text-center text-sm text-gray-500">
                  This ticket is {ticket.status} — replies are disabled.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: ticket info */}
        <div className="col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Ticket Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-[#6C3BFF]/10">
                    <User className="h-4 w-4 text-[#6C3BFF]" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">User</p>
                    <p className="text-sm font-medium text-[#18181B] ">{ticket.userName}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-[#6C3BFF]/10">
                    <MessageSquare className="h-4 w-4 text-[#6C3BFF]" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Subject</p>
                    <p className="text-sm font-medium text-[#18181B] ">{ticket.subject}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-[#6C3BFF]/10">
                    <Calendar className="h-4 w-4 text-[#6C3BFF]" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Opened</p>
                    <p className="text-sm font-medium text-[#18181B] ">{formatDate(ticket.createdAt, "long")}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Assignment</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <p className="mb-1.5 text-xs text-gray-500">Assignee</p>
                  <Select
                    value={assignee || ticket.assignee || ""}
                    onChange={(e) => setAssignee(e.target.value)}
                    options={assigneeOptions}
                    placeholder={assigneeOptions.length > 0 ? "Select assignee" : "No admins available"}
                    disabled={assigneeOptions.length === 0 || Boolean(adminError)}
                  />
                  {adminError && <p className="mt-2 text-xs text-red-600">{adminError}</p>}
                </div>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={!assignee || Boolean(adminError)}
                  onClick={() => {
                    patchTicket({ assignee });
                  }}
                >
                  Assign Ticket
                </Button>
                {ticket.assignee && (
                  <p className="text-xs text-gray-400">Currently assigned to {ticket.assignee}</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}