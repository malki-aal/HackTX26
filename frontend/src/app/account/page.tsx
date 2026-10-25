"use client";

import Link from "next/link";
import { api } from "@/lib/api";
import { useIdentity } from "@/lib/auth/identity";
import { ExecutionStatusText } from "@/components/execution";
import { formatCents } from "@/lib/money";
import { ErrorNote, KeyValue, Loading, Page, PageHeader, SandboxNote, Section, formatWhen, useLoad } from "@/components/ui";

/** Each backend amount against the reported balance. Display only; the available figure is the backend's. */
function BudgetBars({ b }: { b: { reportedBalanceCents: number | null; availableCents: number | null; obligationsCents: number; commitmentsCents: number } }) {
  const total = b.reportedBalanceCents;
  if (!total || total <= 0) return null;
  const rows = [
    { label: "Available", cents: b.availableCents, bar: "bg-green-bar" },
    { label: "Obligations", cents: b.obligationsCents, bar: "bg-orange-bar" },
    { label: "Local commitments", cents: b.commitmentsCents, bar: "bg-pink-bar" },
  ];
  return (
    <div className="mt-4">
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="mb-1 flex justify-between text-[13px]">
              <span className="text-muted">{r.label}</span>
              <span className="font-medium tabular-nums">{r.cents === null ? "Unknown" : formatCents(r.cents)}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-track" aria-hidden>
              <div className={`h-full rounded-full ${r.bar}`} style={{ width: `${r.cents === null ? 0 : Math.min(100, Math.max(0, (r.cents / total) * 100))}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[13px] text-muted">Bars compare each amount with the reported balance.</p>
    </div>
  );
}

export default function AccountPage() {
  const { identity } = useIdentity();
  const isExecutive = identity.status === "ready" && identity.role === "executive";
  // Employees never request the company budget at all. (The backend must refuse it for them too.)
  const budget = useLoad(() => (isExecutive ? api.getBudget() : Promise.resolve(null)), [isExecutive]);
  const activity = useLoad(() => api.listActivity(), []);
  const purchases = (activity.data?.items ?? []).filter((a) => a.execution);
  const signedIn = identity.status === "ready" && identity.kind === "signed_in" ? identity : null;

  return (
    <Page>
      <PageHeader
        title="Account"
        amount={isExecutive ? (budget.loading ? undefined : (budget.data?.availableCents ?? null)) : undefined}
        amountLabel={isExecutive ? "Available budget" : undefined}
        stats={[
          ...(isExecutive ? [{ label: "Reported balance", value: budget.data ? formatCents(budget.data.reportedBalanceCents) : "–" }] : []),
          { label: "Purchases", value: activity.data ? purchases.length : "–" },
        ]}
      />

      <Section title="You">
        {signedIn ? (
          <>
            <dl>
              <KeyValue label="Name" value={signedIn.name} />
              <KeyValue label="Email" value={signedIn.email ?? "Not available"} />
              <KeyValue label="Role" value={isExecutive ? "Executive" : "Employee"} />
              <KeyValue label="Company" value={signedIn.company} />
            </dl>
            <p className="mt-1 text-[13px] text-muted">Signed in with Google. Your role and company are assigned by your team on the server.</p>
          </>
        ) : (
          <>
            <dl>
              <KeyValue label="Demo role" value={isExecutive ? "Executive" : "Employee"} />
              <KeyValue label="Sign-in" value="Not set up" />
            </dl>
            <p className="mt-1 text-[13px] text-muted">
              Sample-data mode has no accounts. The role is a label for the demo and protects nothing.
            </p>
          </>
        )}
        {isExecutive && (
          <Link href="/executive" className="mt-3 block text-[15px] font-medium text-accent">
            Open approvals
          </Link>
        )}
        {isExecutive && (
          <Link href="/settings" className="mt-3 block text-[15px] font-medium text-accent">
            Advanced research settings
          </Link>
        )}
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
                  <span className="shrink-0 text-[15px] tabular-nums">{formatCents(a.exactAmountCents)}</span>
                </div>
                <p className="text-[13px] text-muted">
                  {a.selectedTitle} · <ExecutionStatusText status={a.execution!.status} /> · {formatWhen(a.updatedAt)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
        {purchases.length > 0 && <SandboxNote />}
      </Section>

      {isExecutive && (
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
            <BudgetBars b={budget.data} />
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
      )}
    </Page>
  );
}
