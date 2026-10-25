"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/money";
import { Empty, ErrorNote, Loading, Page, PageHeader, formatWhen, useLoad } from "@/components/ui";

export default function ExecutivePage() {
  const { data, error, loading, reload } = useLoad(() => api.listActivity(), []);
  const waiting = (data ?? []).filter((a) => a.decision === "awaiting_review");

  return (
    <Page>
      <PageHeader
        title="Approvals"
        back={{ href: "/account", label: "Account" }}
        stats={[{ label: "Awaiting approval", value: data ? waiting.length : "–" }]}
      />
      <p className="mb-4 text-[14px] text-muted">
        Demo role: Executive. This is a view for the demo, not a sign-in.
      </p>
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && waiting.length === 0 && <Empty title="Nothing to approve" body="Submitted proposals appear here." />}
      {waiting.length > 0 && (
        <ul className="space-y-3">
          {waiting.map((a) => (
            <li key={a.proposalId}>
              <Link href={`/executive/${a.proposalId}`} className="block rounded-2xl bg-paper p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)] active:bg-raised">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[17px] font-semibold leading-snug">{a.title}</span>
                  <span className="shrink-0 text-[15px] tabular-nums">{formatCents(a.exactAmountCents)}</span>
                </div>
                <p className="mt-1 text-[13px] text-muted">Submitted {formatWhen(a.updatedAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
