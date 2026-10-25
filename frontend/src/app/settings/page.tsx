"use client";

import { useState } from "react";
import { api, type AgentConfigDetail, type AgentConfigInput, type ApiError, type ToolName } from "@/lib/api";
import {
  Button,
  ErrorNote,
  Field,
  Loading,
  Page,
  PageHeader,
  Section,
  Segmented,
  formatWhen,
  inputClass,
  normalizeError,
  useLoad,
} from "@/components/ui";

const TOOL_LABEL: Record<ToolName, string> = {
  getConfirmedRequirements: "Read the confirmed requirements",
  searchProducts: "Search for products",
  getProductDetails: "Look up product details",
  evaluateCandidates: "Check offers against the requirements",
  readBudgetContext: "Read the budget",
  prepareProposalDraft: "Draft a proposal",
};
const TOOLS = Object.keys(TOOL_LABEL) as ToolName[];

const STATE_LABEL = {
  verified: "Verified",
  configured: "Configured",
  degraded: "Degraded",
  unavailable: "Unavailable",
  fixture: "Sample data",
} as const;

const blank: AgentConfigInput = {
  name: "",
  instructions: "",
  enabledTools: TOOLS,
  rankingPriority: "lowest_known_total",
  searchStrategy: "exact_specs",
  limits: { maxSearchCalls: 2, maxDetailCalls: 3, maxSteps: 14, maxDurationMs: 300000 },
};

export default function SettingsPage() {
  const configs = useLoad(() => api.listAgentConfigDetails(), []);
  const integrations = useLoad(() => api.getIntegrations(), []);
  const [editing, setEditing] = useState<AgentConfigDetail | "new" | null>(null);

  return (
    <Page>
      <PageHeader title="Agent settings" back={{ href: "/account", label: "Account" }} />

      <Section title="Saved configurations">
        <p className="mb-3 text-[14px] text-muted">
          Each research run records the configuration and version it used. Saving a change creates a new version and leaves
          older runs as they were.
        </p>
        {configs.loading && <Loading />}
        <ErrorNote error={configs.error} onRetry={configs.reload} />
        <ul>
          {configs.data?.map((c) => (
            <li key={c.id} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[17px] font-semibold">{c.name}</p>
                <span className="shrink-0 text-[14px] text-muted">v{c.version}</span>
              </div>
              <p className="text-[14px] text-muted">{c.summary}</p>
              <p className="text-[13px] text-muted">Saved {formatWhen(c.createdAt)}</p>
              <button type="button" onClick={() => setEditing(c)} className="mt-1 text-[15px] font-medium text-accent">
                Edit
              </button>
            </li>
          ))}
        </ul>
        {!editing && (
          <div className="mt-4">
            <Button variant="quiet" onClick={() => setEditing("new")}>New configuration</Button>
          </div>
        )}
      </Section>

      {editing && (
        <ConfigForm
          key={editing === "new" ? "new" : `${editing.id}-${editing.version}`}
          existing={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void configs.reload();
          }}
        />
      )}

      <Section title="Integrations">
        {integrations.loading && <Loading />}
        <ErrorNote error={integrations.error} onRetry={integrations.reload} />
        <ul>
          {integrations.data?.map((i) => (
            <li key={i.name} className="flex items-baseline justify-between gap-4 border-t border-rule py-2.5 first:border-t-0 first:pt-0">
              <div>
                <p className="text-[16px]">{i.name}</p>
                {i.detail && <p className="text-[13px] text-muted">{i.detail}</p>}
              </div>
              <span className="shrink-0 text-[14px] font-medium">{STATE_LABEL[i.state]}</span>
            </li>
          ))}
        </ul>
      </Section>
    </Page>
  );
}

function ConfigForm({
  existing,
  onCancel,
  onSaved,
}: {
  existing?: AgentConfigDetail;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<AgentConfigInput>(existing ? { ...existing } : blank);
  const [limits, setLimits] = useState({
    maxSearchCalls: String(form.limits.maxSearchCalls),
    maxDetailCalls: String(form.limits.maxDetailCalls),
    maxSteps: String(form.limits.maxSteps),
    maxDurationSeconds: String(Math.round(form.limits.maxDurationMs / 1000)),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const num = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : NaN);
  const inRange = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

  async function save() {
    if (pending) return;
    const next: Record<string, string> = {};
    const l = {
      maxSearchCalls: num(limits.maxSearchCalls),
      maxDetailCalls: num(limits.maxDetailCalls),
      maxSteps: num(limits.maxSteps),
      maxDurationMs: num(limits.maxDurationSeconds) * 1000,
    };
    if (!form.name.trim()) next.name = "Give it a name.";
    if (form.enabledTools.length === 0) next.tools = "Allow at least one tool.";
    if (!inRange(l.maxSearchCalls, 1, 6)) next.search = "Enter 1 to 6.";
    if (!inRange(l.maxDetailCalls, 0, 5)) next.detail = "Enter 0 to 5.";
    if (!inRange(l.maxSteps, 2, 24)) next.steps = "Enter 2 to 24.";
    if (!inRange(l.maxDurationMs / 1000, 10, 300)) next.duration = "Enter 10 to 300 seconds.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setApiError(null);
    try {
      await api.saveAgentConfig({ ...form, name: form.name.trim(), limits: l }, existing ? { id: existing.id, version: existing.version } : undefined);
      onSaved();
    } catch (e) {
      setApiError(normalizeError(e)); // inputs stay as typed
      setPending(false);
    }
  }

  return (
    <Section title={existing ? `Edit ${existing.name}` : "New configuration"}>
      <Field required label="Name" htmlFor="cfg-name" error={errors.name}>
        <input id="cfg-name" className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          aria-invalid={!!errors.name} aria-describedby={errors.name ? "cfg-name-error" : undefined} />
      </Field>
      <Field label="Instructions" htmlFor="cfg-instructions">
        <textarea id="cfg-instructions" rows={4} className={inputClass} value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
      </Field>
      <div className="mb-5">
        <p className="mb-1.5 text-[15px] font-medium">Rank offers by</p>
        <Segmented label="Ranking" value={form.rankingPriority} onChange={(v) => setForm({ ...form, rankingPriority: v })}
          options={[{ value: "lowest_known_total", label: "Lowest cost" }, { value: "evidence_completeness", label: "Most evidence" }]} />
      </div>
      <div className="mb-5">
        <p className="mb-1.5 text-[15px] font-medium">Search style</p>
        <Segmented label="Search style" value={form.searchStrategy} onChange={(v) => setForm({ ...form, searchStrategy: v })}
          options={[{ value: "exact_specs", label: "Exact specs" }, { value: "broad_then_filter", label: "Broad, then filter" }]} />
      </div>
      <fieldset className="mb-5">
        <legend className="mb-1.5 text-[15px] font-medium">Allowed tools</legend>
        {TOOLS.map((t) => (
          <label key={t} className="flex items-center gap-3 py-1.5 text-[16px]">
            <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={form.enabledTools.includes(t)}
              onChange={(e) => setForm({ ...form, enabledTools: e.target.checked ? [...form.enabledTools, t] : form.enabledTools.filter((x) => x !== t) })} />
            {TOOL_LABEL[t]}
          </label>
        ))}
        {errors.tools && <p role="alert" className="mt-1.5 text-[13px] text-bad">{errors.tools}</p>}
        <p className="mt-1 text-[13px] text-muted">These tools only read and research. None can approve or spend.</p>
      </fieldset>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Searches" htmlFor="cfg-search" error={errors.search}>
          <input id="cfg-search" inputMode="numeric" className={inputClass} value={limits.maxSearchCalls}
            onChange={(e) => setLimits({ ...limits, maxSearchCalls: e.target.value })} aria-invalid={!!errors.search}
            aria-describedby={errors.search ? "cfg-search-error" : undefined} />
        </Field>
        <Field label="Product lookups" htmlFor="cfg-detail" error={errors.detail}>
          <input id="cfg-detail" inputMode="numeric" className={inputClass} value={limits.maxDetailCalls}
            onChange={(e) => setLimits({ ...limits, maxDetailCalls: e.target.value })} aria-invalid={!!errors.detail}
            aria-describedby={errors.detail ? "cfg-detail-error" : undefined} />
        </Field>
        <Field label="Steps" htmlFor="cfg-steps" error={errors.steps}>
          <input id="cfg-steps" inputMode="numeric" className={inputClass} value={limits.maxSteps}
            onChange={(e) => setLimits({ ...limits, maxSteps: e.target.value })} aria-invalid={!!errors.steps}
            aria-describedby={errors.steps ? "cfg-steps-error" : undefined} />
        </Field>
        <Field label="Time limit (seconds)" htmlFor="cfg-duration" error={errors.duration}>
          <input id="cfg-duration" inputMode="numeric" className={inputClass} value={limits.maxDurationSeconds}
            onChange={(e) => setLimits({ ...limits, maxDurationSeconds: e.target.value })} aria-invalid={!!errors.duration}
            aria-describedby={errors.duration ? "cfg-duration-error" : undefined} />
        </Field>
      </div>
      <ErrorNote error={apiError} />
      <div className="space-y-3">
        <Button disabled={pending} onClick={save}>
          {pending ? "Saving…" : existing ? "Save as new version" : "Create configuration"}
        </Button>
        <Button variant="quiet" disabled={pending} onClick={onCancel}>Cancel</Button>
      </div>
    </Section>
  );
}
