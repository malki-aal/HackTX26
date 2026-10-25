"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type ApiError, type Condition, type RankingPriority } from "@/lib/api";
import { parseDollarsToCents } from "@/lib/money";
import {
  Button,
  ErrorNote,
  Field,
  Page,
  PageHeader,
  RequiredMark,
  Segmented,
  inputClass,
  normalizeError,
  useLoad,
} from "@/components/ui";

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export default function NewRequestPage() {
  const router = useRouter();
  const configs = useLoad(() => api.listAgentConfigs(), []);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [budget, setBudget] = useState("");
  const [mandatory, setMandatory] = useState("");
  const [preferences, setPreferences] = useState("");
  const [condition, setCondition] = useState<Condition>("new");
  const [deadline, setDeadline] = useState("");
  const [agentId, setAgentId] = useState("");
  const [ranking, setRanking] = useState<RankingPriority>("lowest_known_total");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    const qty = Number(quantity);
    const cents = parseDollarsToCents(budget);
    if (!title.trim()) next.title = "Add a short title.";
    if (!Number.isInteger(qty) || qty < 1) next.quantity = "Enter a whole number, 1 or more.";
    if (cents === null || cents <= 0) next.budget = "Enter the total budget in dollars, like 1000 or 1,000.00.";
    if (lines(mandatory).length === 0) next.mandatory = "List at least one must-have specification.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setApiError(null);
    try {
      const r = await api.createRequest({
        title: title.trim(),
        purpose: purpose.trim(),
        quantity: qty,
        budgetTotalCents: cents as number,
        mandatory: lines(mandatory),
        preferences: lines(preferences),
        condition,
        deadline: deadline || undefined,
        agentConfigId: agentId || configs.data?.[0]?.id || "cfg_default",
        ranking,
      });
      router.push(`/requests/${r.id}`);
    } catch (err) {
      setApiError(normalizeError(err)); // form state is kept
      setPending(false);
    }
  }

  return (
    <Page>
      <PageHeader title="New request" subtitle="Runway researches monitors for now." />
      <form onSubmit={submit} noValidate>
        <Field required label="Title" htmlFor="title" error={errors.title}>
          <input id="title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Monitors for the design team" aria-invalid={!!errors.title}
            aria-describedby={errors.title ? "title-error" : undefined} />
        </Field>
        <Field label="What is it for?" htmlFor="purpose">
          <textarea id="purpose" rows={3} className={inputClass} placeholder="Optional. Helps the agent ask better questions." value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field required label="Quantity" htmlFor="quantity" error={errors.quantity}>
            <input id="quantity" inputMode="numeric" className={inputClass} value={quantity}
              onChange={(e) => setQuantity(e.target.value)} aria-invalid={!!errors.quantity}
              aria-describedby={errors.quantity ? "quantity-error" : undefined} />
          </Field>
          <Field required label="Total budget (USD)" htmlFor="budget" error={errors.budget}>
            <input id="budget" inputMode="decimal" className={inputClass} value={budget}
              onChange={(e) => setBudget(e.target.value)} placeholder="1,000" aria-invalid={!!errors.budget}
              aria-describedby={errors.budget ? "budget-error" : undefined} />
          </Field>
        </div>
        <Field required label="Must-have specifications" htmlFor="mandatory" error={errors.mandatory}>
          <textarea id="mandatory" rows={4} className={inputClass} value={mandatory}
            onChange={(e) => setMandatory(e.target.value)} placeholder={"27 inch screen\nAt least 1440p\nHDMI input"}
            aria-invalid={!!errors.mandatory} aria-describedby={errors.mandatory ? "mandatory-error" : undefined} />
        </Field>
        <Field label="Nice-to-haves" htmlFor="preferences">
          <textarea id="preferences" rows={3} className={inputClass} value={preferences} onChange={(e) => setPreferences(e.target.value)} />
        </Field>
        <div className="mb-5">
          <p className="mb-1.5 text-[15px] font-medium">Condition<RequiredMark /></p>
          <Segmented label="Condition" value={condition} onChange={setCondition}
            options={[{ value: "new", label: "New" }, { value: "refurbished", label: "Refurbished" },
              { value: "used", label: "Used" }, { value: "any", label: "Any" }]} />
        </div>
        <Field label="Needed by" htmlFor="deadline">
          <input id="deadline" type="date" className={inputClass} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        <div className="mb-5">
          <p className="mb-1.5 text-[15px] font-medium">Rank offers by<RequiredMark /></p>
          <Segmented label="Ranking priority" value={ranking} onChange={setRanking}
            options={[{ value: "lowest_known_total", label: "Lowest cost" },
              { value: "evidence_completeness", label: "Most evidence" }]} />
        </div>
        <Field label="Agent configuration" htmlFor="agent">
          <select id="agent" className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {(configs.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name} (v{c.version})</option>
            ))}
          </select>
        </Field>
        <ErrorNote error={apiError} />
        <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Continue"}</Button>
      </form>
    </Page>
  );
}
