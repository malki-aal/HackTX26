"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/avatars";
import { ExecutionStatusText } from "@/components/execution";
import { useIdentity } from "@/lib/auth/identity";
import { DECISION_LABEL } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import { Empty, ErrorNote, Loading, Page, PageHeader, Segmented, formatWhen, useLoad, usePolling } from "@/components/ui";

const PAGE_LIMIT = 100; // the list endpoint returns at most this many; beyond it counts show "+"

export default function ExecutivePage() {
  const { identity } = useIdentity();
  const demo = identity.status === "ready" && identity.kind === "demo";
  const act = useLoad(() => api.listActivity(), []);
  // New submissions appear without a reload. Read-only: this never starts research or touches a purchase.
  usePolling(act.refresh, 5000);
  const [tab, setTab] = useState<"pending" | "decided">("pending");

  const all = act.data ?? [];
  const pending = all.filter((a) => a.decision === "awaiting_review");
  const decided = all.filter((a) => a.decision !== "awaiting_review");
  const capped = all.length >= PAGE_LIMIT;
  const count = (n: number) => (act.data ? `${n}${capped ? "+" : ""}` : "–");
  const rows = tab === "pending" ? pending : decided;

  return (
    <Page>
      <PageHeader
        title="Approvals"
        back={{ href: "/account", label: "Account" }}
        stats={[
          { label: "Waiting for you", value: count(pending.length) },
          { label: "Decided", value: count(decided.length) },
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
            { value: "pending", label: `Pending (${count(pending.length)})` },
            { value: "decided", label: `Decided (${count(decided.length)})` },
          ]}
        />
      </div>
      {act.loading && <Loading />}
      <ErrorNote error={act.error} onRetry={act.reload} />
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
                <p className="mt-1 text-[14px]">{a.selectedTitle}</p>
                <p className="text-[13px] text-muted">
                  {[a.quantityText, a.seller].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
                  <Avatar role="employee" size={20} />
                  <span>
                    Requested by {a.requester} · {tab === "pending" ? "Submitted" : "Updated"} {formatWhen(a.updatedAt)}
                  </span>
                </p>
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
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
