"use client";

import Link from "next/link";
import { api, type ActivityItem } from "@/lib/api";
import { useIdentity } from "@/lib/auth/identity";
import { formatCents } from "@/lib/money";
import { ErrorNote, Loading, Section, formatWhen, useLoad, usePolling } from "@/components/ui";

interface Group {
  key: string;
  title: string;
  explain: string;
  tone: string;
  items: ActivityItem[];
  caption: (a: ActivityItem) => string;
}

function groupsOf(all: ActivityItem[]): Group[] {
  const status = (a: ActivityItem) => a.execution?.status;
  return [
    {
      key: "awaiting",
      tone: "bg-orange-bar",
      title: "Awaiting executive approval",
      explain: "Submitted and waiting for a decision.",
      items: all.filter((a) => a.decision === "awaiting_review"),
      caption: () => "Not approved yet",
    },
    {
      key: "not_started",
      tone: "bg-indigo-bar",
      title: "Approved, purchase recording not started",
      explain: "Approved, but no purchase has been recorded in Nessie.",
      items: all.filter((a) => a.decision === "approved" && (!a.execution || status(a) === "not_started")),
      caption: () => "Recording not started",
    },
    {
      key: "in_progress",
      tone: "bg-pink-bar",
      title: "Purchase recording in progress or uncertain",
      explain: "Not confirmed as recorded. Uncertain ones need checking, not resending.",
      items: all.filter((a) => ["queued", "submitting", "uncertain", "failed"].includes(status(a) ?? "")),
      caption: (a) =>
        a.execution?.status === "uncertain" ? "Uncertain" : a.execution?.status === "failed" ? "Failed" : a.execution?.status === "queued" ? "Queued" : "In progress",
    },
    {
      key: "provider_pending",
      tone: "bg-purple-bar",
      title: "Pending at Nessie",
      explain: "Recorded, and Nessie reports the purchase as pending.",
      items: all.filter((a) => status(a) === "recorded" && (a.execution?.providerStatus ?? "").toLowerCase() === "pending"),
      caption: () => "Nessie status: pending",
    },
  ];
}

export function PendingActivity() {
  const { identity } = useIdentity();
  const isExecutive = identity.status === "ready" && identity.role === "executive";
  const { data, error, loading, reload, refresh } = useLoad(() => api.listActivity(), []);
  usePolling(refresh, 5000);
  const groups = data ? groupsOf(data.items).filter((g) => g.items.length > 0) : [];

  return (
    <Section title="Pending activity">
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && groups.length === 0 && <p className="text-[14px] text-muted">Nothing pending.</p>}
      {groups.map((g) => (
        <div key={g.key} className="mb-4">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${g.tone}`} />
            {g.title} <span className="font-normal text-muted">({g.items.length})</span>
          </h3>
          <p className="text-[13px] text-muted">{g.explain}</p>
          <ul>
            {g.items.map((a) => (
              <li key={a.proposalId} className="border-t border-rule first:border-t-0">
                <Link
                  href={a.execution ? `/purchases/${a.execution.id}` : isExecutive ? `/executive/${a.proposalId}` : `/requests/${a.requestId}/proposal`}
                  className="block py-2.5 active:bg-raised"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[16px]">{a.title}</span>
                    <span className="shrink-0 text-[15px] tabular-nums">{formatCents(a.exactAmountCents)}</span>
                  </div>
                  <p className="text-[13px] text-muted">
                    {g.caption(a)} · {formatWhen(a.updatedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}
