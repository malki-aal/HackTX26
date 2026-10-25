"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { PendingActivity } from "@/components/pending";
import { summarizeItems } from "@/lib/format";
import { statusLabel, statusTone } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import { Empty, ErrorNote, Loading, Page, PageHeader, Section, formatWhen, useLoad, usePolling } from "@/components/ui";

// Executive overview: purchase outcomes and the company's requests. The server decides which requests
// this person may read (executives: their company; others: their own), so nothing is filtered here.
export default function ActivityPage() {
  const requests = useLoad(() => api.listRequests(), []);
  usePolling(requests.refresh, 10000);
  const rows = requests.data ?? [];

  return (
    <Page>
      <PageHeader title="Activity" stats={[{ label: "Company requests", value: requests.data ? rows.length : "–" }]} />
      <PendingActivity />
      <Section title="Company requests">
        {requests.loading && <Loading />}
        <ErrorNote error={requests.error} onRetry={requests.reload} />
        {requests.data && rows.length === 0 && <Empty title="No requests yet" body="Requests from your company appear here." />}
        <ul>
          {rows.map((r) => (
            <li key={r.id} className="border-t border-rule first:border-t-0">
              <Link href={`/requests/${r.id}`} className="block py-2.5 active:bg-raised">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px]">{r.title}</span>
                  <span className="shrink-0 text-[15px] tabular-nums">{formatCents(r.budgetTotalCents)}</span>
                </div>
                <p className="text-[13px] text-muted">
                  {summarizeItems(r.items)} · Updated {formatWhen(r.updatedAt)} ·{" "}
                  <span className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${statusTone[r.status]}`}>{statusLabel[r.status]}</span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </Page>
  );
}
