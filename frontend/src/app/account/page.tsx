"use client";

import { api } from "@/lib/api";
import { formatCents } from "@/lib/money";
import { ErrorNote, KeyValue, Loading, Page, PageHeader, Section, formatWhen, useLoad } from "@/components/ui";

export default function AccountPage() {
  const budget = useLoad(() => api.getBudget(), []);
  const integrations = useLoad(() => api.getIntegrations(), []);
  const configs = useLoad(() => api.listAgentConfigs(), []);

  return (
    <Page>
      <PageHeader title="Account" />
      <p className="mb-5 text-[14px] text-muted">
        This device is set to the Employee demo view. It is a view selector for the demo, not a sign-in, and does not
        protect anything.
      </p>

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
              {budget.data.source}
              {budget.data.fetchedAt && ` · fetched ${formatWhen(budget.data.fetchedAt)}`}. {budget.data.notes}
            </p>
          </>
        )}
      </Section>

      <Section title="Agent configurations">
        {configs.data?.map((c) => (
          <div key={c.id} className="py-1.5">
            <p className="text-[15px]">
              {c.name} <span className="text-muted">v{c.version}</span>
            </p>
            <p className="text-[13px] text-muted">{c.summary}</p>
          </div>
        ))}
      </Section>

      <Section title="Integrations">
        {integrations.data?.map((i) => (
          <div key={i.name} className="flex items-baseline justify-between gap-4 py-1.5">
            <div>
              <p className="text-[15px]">{i.name}</p>
              <p className="text-[13px] text-muted">{i.detail}</p>
            </div>
            <span className="text-[14px] font-medium capitalize text-ink">{i.state}</span>
          </div>
        ))}
      </Section>
    </Page>
  );
}
