"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { statusLabel } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import { Empty, ErrorNote, Loading, Page, PageHeader, formatWhen, useLoad } from "@/components/ui";

export default function RequestsPage() {
  const { data, error, loading, reload } = useLoad(() => api.listRequests(), []);

  return (
    <Page>
      <PageHeader title="Requests" />
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && data.length === 0 && (
        <Empty title="No requests yet" body="Start with what you need and Runway will research real offers." />
      )}
      {data && data.length > 0 && (
        <ul className="border-b border-rule">
          {data.map((r) => (
            <li key={r.id} className="border-t border-rule">
              <Link href={`/requests/${r.id}`} className="block py-4 active:bg-raised">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-[17px] font-semibold leading-snug">{r.title}</h2>
                  <span className="shrink-0 text-[15px] tabular-nums">{formatCents(r.budgetTotalCents)}</span>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  {r.quantity} monitors · Updated {formatWhen(r.updatedAt)}
                </p>
                <p className="mt-1 text-[14px] font-medium text-ink">{statusLabel[r.status]}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href="/new" className="mt-6 block h-12 rounded-lg bg-accent text-center text-[16px] font-semibold leading-[48px] text-white active:bg-accent-press">
        New request
      </Link>
    </Page>
  );
}
