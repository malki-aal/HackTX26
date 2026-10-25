"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { homeFor } from "@/lib/auth/config";
import { api } from "@/lib/api";
import { useIdentity } from "@/lib/auth/identity";
import { PendingActivity } from "@/components/pending";
import { WalletCard } from "@/components/wallet";
import { summarizeItems } from "@/lib/format";
import { statusLabel, statusTone } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import { Empty, ErrorNote, Loading, Page, PageHeader, formatWhen, useLoad, usePolling } from "@/components/ui";

export default function RequestsPage() {
  const { identity } = useIdentity();
  const router = useRouter();
  const isExecutive = identity.status === "ready" && identity.role === "executive";
  // Executives start at their approval queue (also when the home-screen app opens at "/").
  useEffect(() => {
    if (identity.status === "ready" && identity.role === "executive") router.replace(homeFor("executive"));
  }, [identity, router]);
  if (isExecutive) return null;
  return <EmployeeRequests />;
}

function EmployeeRequests() {
  const projects = useLoad(() => api.listProjects(), []);
  const { data, error, loading, reload, refresh } = useLoad(() => api.listRequests(), []);
  // Errors are shown, never replaced with an empty list.
  const activity = useLoad(() => api.listActivity(), []);
  // A decision or a purchase update shows up on its own. Read-only polling.
  usePolling(async () => {
    await Promise.all([refresh(), activity.refresh()]);
  }, 5000);
  const acts = activity.data?.items ?? [];
  const awaiting = acts.filter((a) => a.decision === "awaiting_review").length;
  const toRecord = acts.filter((a) => a.decision === "approved" && a.execution?.status !== "recorded").length;

  return (
    <Page>
      <PageHeader
        title="Requests"
        stats={[
          { label: "Requests", value: data ? data.filter((r) => !r.projectId).length + (projects.data?.length ?? 0) : "–" },
          { label: "Awaiting approval", value: activity.data ? awaiting : "–" },
          { label: "To record", value: activity.data ? toRecord : "–" },
        ]}
      />
      {/* Approved money arrives here (+); paying the seller takes it out (−). */}
      <WalletCard limit={4} />
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && data.length === 0 && !projects.data?.length && (
        <Empty title="No requests yet" body="Tap the + button to start. Runway researches real offers for what you need." />
      )}
      {data && data.length > 0 && (
        <ul className="mb-4 space-y-3">
          {data.filter((r) => !r.projectId).map((r) => (
            <li key={r.id}>
              <Link
                href={`/requests/${r.id}`}
                className="block rounded-2xl bg-paper p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)] active:bg-raised"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-[17px] font-semibold leading-snug">{r.title}</h2>
                  <span className="shrink-0 text-[15px] font-semibold tabular-nums">{formatCents(r.budgetTotalCents)}</span>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  {summarizeItems(r.items)} · Updated {formatWhen(r.updatedAt)}
                </p>
                <p className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-[13px] font-medium ${statusTone[r.status]}`}>
                  {statusLabel[r.status]}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={projects.error} onRetry={projects.reload} />
      {!!projects.data?.length && <section className="mb-4 space-y-3" aria-label="Grouped requests">
        {projects.data.map((p) => <Link key={p.id} href={`/projects/${p.id}`} className="block rounded-2xl bg-paper p-4 shadow-sm">
          <div className="flex justify-between gap-3"><h2 className="font-semibold">{p.title}</h2><span>{formatCents(p.budgetCents)}</span></div>
          <p className="mt-1 text-[13px] text-muted">{p.lines} item types</p>
        </Link>)}
      </section>}
      <PendingActivity hideAwaiting />
    </Page>
  );
}
