"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { ExecutionStatusText } from "@/components/execution";
import { formatCents } from "@/lib/money";
import { ErrorNote, KeyValue, Loading, Page, PageHeader, SandboxNote, Section, formatWhen, useLoad } from "@/components/ui";

export default function AccountPage() {
  const budget = useLoad(() => api.getBudget(), []);
  const activity = useLoad(() => api.listActivity(), []);
  const purchases = (activity.data ?? []).filter((a) => a.execution);

  return (
    <Page>
      <PageHeader
        title="Account"
        amount={budget.loading ? undefined : (budget.data?.availableCents ?? null)}
        amountLabel="Available budget"
        stats={[
          { label: "Reported balance", value: budget.data ? formatCents(budget.data.reportedBalanceCents) : "–" },
          { label: "Purchases", value: activity.data ? purchases.length : "–" },
        ]}
      />

      <Section title="You">
        <dl>
          <KeyValue label="Demo role" value="Employee" />
          <KeyValue label="Sign-in" value="Not set up" />
        </dl>
        <p className="mt-1 text-[13px] text-muted">
          There are no accounts yet, so no name or email is available. The role is a label for the demo and protects nothing.
        </p>
        <Link href="/executive" className="mt-3 block text-[15px] font-medium text-accent">
          Open the Executive approvals view
        </Link>
        <Link href="/settings" className="mt-3 block text-[15px] font-medium text-accent">
          Agent settings and integration status
        </Link>
      </Section>

      <Section title="Past purchases">
        {activity.loading && <Loading />}
        <ErrorNote error={activity.error} onRetry={activity.reload} />
        {activity.data && purchases.length === 0 && <p className="text-[14px] text-muted">No purchases have been recorded yet.</p>}
        <ul>
          {purchases.map((a) => (
            <li key={a.proposalId} className="border-t border-rule first:border-t-0">
              <Link href={`/purchases/${a.execution!.id}`} className="block py-2.5 active:bg-raised">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px]">{a.title}</span>
                  <span className="shrink-0 text-[15px] tabular-nums">{formatCents(a.execution!.amountCents)}</span>
                </div>
                <p className="text-[13px] text-muted">
                  <ExecutionStatusText status={a.execution!.status} /> · {formatWhen(a.execution!.createdAt)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
        {purchases.length > 0 && <SandboxNote />}
      </Section>

      <Section title="Company budget">
        {budget.loading && <Loading />}
        <ErrorNote error={budget.error} onRetry={budget.reload} />
        {budget.data && (
          <>
            <dl>
              <KeyValue label="Available budget" value={formatCents(budget.data.availableCents)} />
              <KeyValue label="Reported balance" value={formatCents(budget.data.reportedBalanceCents)} />
              <KeyValue label="Obligations" value={formatCents(budget.data.obligationsCents)} />
              <KeyValue label="Local commitments" value={formatCents(budget.data.commitmentsCents)} />
            </dl>
            {budget.data.status === "bank_check_unavailable" && (
              <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
                The bank check is unavailable. Research can continue; approvals wait for a fresh check.
              </p>
            )}
            <p className="mt-2 text-[13px] text-muted">
              {budget.data.fetchedAt ? `Last fetched ${formatWhen(budget.data.fetchedAt)}. ` : "Not fetched yet. "}
              {budget.data.source}. {budget.data.notes}
            </p>
            <SandboxNote />
          </>
        )}
      </Section>
    </Page>
  );
}
