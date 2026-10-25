"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { personLabel } from "@/lib/api/mappers";
import { Avatar } from "@/components/avatars";
import { ExecutionStatusText } from "@/components/execution";
import { useIdentity } from "@/lib/auth/identity";
import { DECISION_LABEL } from "@/lib/labels";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import { Empty, ErrorNote, Loading, Page, PageHeader, Segmented, formatWhen, useLoad, usePolling } from "@/components/ui";

export default function ExecutivePage() {
  const { identity } = useIdentity();
  const demo = identity.status === "ready" && identity.kind === "demo";
  const act = useLoad(() => api.listActivity(), []);
  // New submissions appear without a reload. Read-only: this never starts research or touches a purchase.
  usePolling(act.refresh, 5000);
  const [tab, setTab] = useState<"pending" | "decided">("pending");

  const all = act.data?.items ?? [];
  const pending = all.filter((a) => a.decision === "awaiting_review");
  const decided = all.filter((a) => a.decision !== "awaiting_review");
  // Totals come from the server over the whole company, not from the rows fetched.
  const c = act.data?.counts;
  const waiting = c ? c.awaiting_review : null;
  const decidedTotal = c ? c.approved + c.changes_requested + c.rejected : null;
  const count = (n: number | null) => (n === null ? "–" : String(n));
  const rows = tab === "pending" ? pending : decided;

  return (
    <Page>
      <PageHeader
        title="Approvals"
        stats={[
          { label: "Waiting for you", value: count(waiting) },
          { label: "Decided", value: count(decidedTotal) },
        ]}
      />
      {demo && (
        <p className="mb-4 text-[14px] text-muted">Demo role: Executive. This is a view for the demo, not a sign-in.</p>
      )}
      <div className="mb-4">
        <Segmented
          label="Queue"
          value={tab}
          onChange={setTab}
          options={[
            { value: "pending", label: `Pending (${count(waiting)})` },
            { value: "decided", label: `Decided (${count(decidedTotal)})` },
          ]}
        />
      </div>
      {act.loading && <Loading />}
      <ErrorNote error={act.error} onRetry={act.reload} />
      {act.data?.truncated && <p className="mb-3 text-[13px] text-muted">Showing the most recent proposals; the totals above cover all of them.</p>}
      {act.data && rows.length === 0 && (
        <Empty
          title={tab === "pending" ? "Nothing to approve" : "No decisions yet"}
          body={tab === "pending" ? "Submitted proposals appear here on their own." : "Decided proposals appear here."}
        />
      )}
      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((a) => (
            <li key={a.proposalId}>
              <Link
                href={`/executive/${a.proposalId}`}
                className="block rounded-2xl bg-paper p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)] active:bg-raised"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[17px] font-semibold leading-snug">{a.title}</span>
                  <span className="shrink-0 text-[16px] font-semibold tabular-nums">{formatCents(a.exactAmountCents)}</span>
                </div>
                <div className="mt-2 flex gap-3">
                  {a.imageUrl && isSafeHttpUrl(a.imageUrl) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-raised object-contain" />
                  )}
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-[14px]">{a.selectedTitle}</p>
                    <p className="text-[13px] text-muted">{[a.quantityText, a.seller].filter(Boolean).join(" · ")}</p>
                  </div>
                </div>
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted">
                  <Avatar role="employee" size={20} />
                  <span>
                    {personLabel(a.requester, "Unknown requester")} · {a.submittedAt ? `Submitted ${formatWhen(a.submittedAt)}` : `Updated ${formatWhen(a.updatedAt)}`} · Revision {a.version}
                  </span>
                </p>
                {tab === "pending" && (a.unresolved.length > 0 || a.offerStale) && (
                  <p className="mt-2 text-[13px] font-medium text-orange-ink">
                    {[a.offerStale ? "Offer evidence expired" : null, a.unresolved.length ? `${a.unresolved.length} unresolved` : null].filter(Boolean).join(" · ")}
                  </p>
                )}
                {tab === "decided" && (
                  <p className="mt-2 text-[14px] font-medium">
                    {DECISION_LABEL[a.decision]}
                    {a.execution && (
                      <>
                        {" · "}
                        <ExecutionStatusText status={a.execution.status} />
                      </>
                    )}
                  </p>
                )}
                {tab === "decided" && a.latestDecision?.note && (
                  <p className="mt-1 line-clamp-2 text-[13px] text-muted">Note: {a.latestDecision.note}</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
