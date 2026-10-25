"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type ApiError, type Condition, type DeadlineKind, type NewRequestInput } from "@/lib/api";
import { parseDollarsToCents } from "@/lib/money";
import { BLANK_FORM, dateInZone, isDirty, presetToForm, type RequestFormState, type ScenarioPreset } from "@/lib/scenarios";
import {
  Button,
  ErrorNote,
  useLoad,
  Field,
  Page,
  PageHeader,
  RequiredMark,
  Section,
  Segmented,
  inputClass,
  normalizeError,
} from "@/components/ui";

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);


interface ItemRow {
  key: number;
  name: string;
  quantity: string;
  unit: string;
  budget: string;
  specifications: string;
}

const blankItem = (key: number): ItemRow => ({ key, name: "", quantity: "1", unit: "units", budget: "", specifications: "" });

export default function NewRequestPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [items, setItems] = useState<ItemRow[]>([blankItem(1)]);
  const [budget, setBudget] = useState("");
  const [mandatory, setMandatory] = useState("");
  const [preferences, setPreferences] = useState("");
  const [condition, setCondition] = useState<Condition>("new");
  const [deadline, setDeadline] = useState("");
  const [deadlineKind, setDeadlineKind] = useState<DeadlineKind>("flexible");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  // ---- Example presets: they fill editable inputs only. Nothing is created, confirmed or researched. ----
  const scenarios = useLoad(() => api.getScenarios(), []);
  const [presetId, setPresetId] = useState<string>("");
  const [eventNote, setEventNote] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<RequestFormState>(BLANK_FORM);
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  const form: RequestFormState = {
    title, purpose, itemName: items[0]?.name ?? "", quantity: items[0]?.quantity ?? "", unit: items[0]?.unit ?? "",
    budget, mandatory, preferences, condition, deadline, deadlineKind,
  };
  const dirty = items.length > 1 || isDirty(form, baseline);

  function applyForm(next: RequestFormState, preset: ScenarioPreset | null, timeZone: string) {
    setTitle(next.title);
    setPurpose(next.purpose);
    setItems([{ key: 1, name: next.itemName, quantity: next.quantity, unit: next.unit, budget: "", specifications: "" }]);
    setBudget(next.budget);
    setMandatory(next.mandatory);
    setPreferences(next.preferences);
    setCondition(next.condition);
    setDeadline(next.deadline);
    setDeadlineKind(next.deadlineKind);
    setBaseline(next);
    setPresetId(preset?.id ?? "");
    const eventDate = preset?.eventDays ? new Date(`${dateInZone(preset.eventDays, timeZone)}T12:00:00`) : null;
    setEventNote(eventDate ? `Event date: ${eventDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : null);
    setErrors({});
    setApiError(null);
    setPendingChoice(null);
    setNotice(preset ? "Example loaded — edit anything." : "Cleared. Start from scratch.");
    setFlash(!!preset);
  }

  function choose(id: string) {
    if (id === presetId) return;
    if (dirty) {
      setPendingChoice(id); // ask before replacing edits
      return;
    }
    load(id);
  }

  function load(id: string) {
    const set = scenarios.data;
    const preset = set?.scenarios.find((x) => x.id === id) ?? null;
    if (id && (!set || !preset)) return;
    applyForm(preset ? presetToForm(preset, set!.timezone) : BLANK_FORM, preset, set?.timezone ?? "America/Chicago");
  }

  const setItem = (key: number, patch: Partial<ItemRow>) =>
    setItems((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    const next: Record<string, string> = {};
    const cents = parseDollarsToCents(budget);
    if (!title.trim()) next.title = "Add a short title.";
    if (cents === null || cents <= 0) next.budget = "Enter the total budget in dollars, like 100 or 1,000.00.";
    if (items.length === 1 && lines(mandatory).length === 0 && !items[0].specifications.trim()) next.mandatory = "List at least one must-have specification.";
    for (const it of items) {
      const q = Number(it.quantity);
      if (!it.name.trim()) next[`item-${it.key}-name`] = "Name the item.";
      if (!Number.isInteger(q) || q < 1) next[`item-${it.key}-qty`] = "Enter a whole number, 1 or more.";
      if (items.length > 1 && !(parseDollarsToCents(it.budget)! > 0)) next[`item-${it.key}-budget`] = "Set a budget for this item type.";
    }
    if (items.length > 1 && cents !== null && items.reduce((n, it) => n + (parseDollarsToCents(it.budget) ?? 0), 0) > cents) next.budget = "Item budgets exceed the total budget.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setApiError(null);
    try {
      const input: NewRequestInput = {
        ...(presetId ? { presetId } : {}),
        title: title.trim(),
        purpose: purpose.trim(),
        items: items.map((it) => ({ name: it.name.trim(), quantity: Number(it.quantity), unit: it.unit.trim() || "units", specifications: lines(it.specifications), budgetCents: parseDollarsToCents(it.budget) ?? undefined })),
        budgetTotalCents: cents as number,
        mandatory: lines(mandatory),
        preferences: lines(preferences),
        condition,
        deadline: deadline || undefined,
        deadlineKind: deadline ? deadlineKind : "flexible",
        // New requests use the intended preset, independently of API sort order.
        // Existing requests and runs keep their saved configuration/version.
        agentConfigId: "cfg_default",
      };
      if (items.length > 1) {
        const project = await api.createProject(input);
        router.push(`/projects/${project.id}`);
        return;
      }
      const r = await api.createRequest(input);
      if (r.status === "awaiting_confirmation" && r.clarifications.every((c) => c.answer)) {
        // The user pressed Find options. Do not require two more confirmations to do that.
        // A failed start leaves a saved request that can be retried without recreating it.
        try {
          await api.confirmRequirements(r.id, r.version);
          await api.startResearch(r.id);
        } catch {
          router.push(`/requests/${r.id}`);
          return;
        }
      }
      router.push(`/requests/${r.id}`);
    } catch (err) {
      setApiError(normalizeError(err)); // form state is kept
      setPending(false);
    }
  }

  return (
    <Page>
      <PageHeader title="New request" />
      <div className="mb-6">
        <label htmlFor="example" className="mb-1.5 block text-[15px] font-medium">Try an example</label>
        <select
          id="example"
          className={inputClass}
          value={pendingChoice ?? presetId}
          disabled={!scenarios.data}
          onChange={(e) => choose(e.target.value)}
          aria-describedby="example-status"
        >
          <option value="">Start from scratch</option>
          {scenarios.data?.scenarios.map((sc) => (
            <option key={sc.id} value={sc.id}>{sc.sector} — {sc.menuLabel}</option>
          ))}
        </select>
        {scenarios.error && <ErrorNote error={scenarios.error} onRetry={scenarios.reload} />}
        {pendingChoice !== null && (
          <div role="alert" className="mt-2 rounded-xl bg-orange-soft p-3 text-[14px]">
            <p className="font-medium">Replace what you&apos;ve entered?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="rounded-full bg-accent px-4 py-2 font-semibold text-white" onClick={() => load(pendingChoice)}>
                Replace current details
              </button>
              <button type="button" className="rounded-full bg-raised px-4 py-2 font-semibold" onClick={() => setPendingChoice(null)}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        <p id="example-status" aria-live="polite" className="mt-1.5 min-h-[1.25rem] text-[13px] text-muted">{notice}</p>
      </div>
      <form onSubmit={submit} noValidate className={`rounded-2xl transition-colors duration-700 ${flash ? "bg-accent-soft" : ""}`}>
        <Section title="Basics">
        <Field required label="Title" htmlFor="title" error={errors.title}>
          <input id="title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you buying for?" aria-invalid={!!errors.title}
            aria-describedby={errors.title ? "title-error" : undefined} />
        </Field>
        <Field label="What is it for?" htmlFor="purpose">
          <textarea id="purpose" rows={3} className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)}
            placeholder="Optional. Helps the agent ask better questions." />
        </Field>

        </Section>
        <Section>
        <fieldset>
          <legend className="mb-1.5 text-[15px] font-medium">Items<RequiredMark /></legend>
          {items.map((it, i) => (
            <div key={it.key} className="mb-4 border-t border-rule pt-3 first:border-t-0 first:pt-0">
              <label htmlFor={`item-${it.key}-name`} className="sr-only">Item {i + 1} name</label>
              <input id={`item-${it.key}-name`} className={inputClass} value={it.name} placeholder="Item name"
                onChange={(e) => setItem(it.key, { name: e.target.value })} aria-invalid={!!errors[`item-${it.key}-name`]}
                aria-describedby={errors[`item-${it.key}-name`] ? `item-${it.key}-name-error` : undefined} />
              {errors[`item-${it.key}-name`] && (
                <p id={`item-${it.key}-name-error`} role="alert" className="mt-1.5 text-[13px] text-bad">{errors[`item-${it.key}-name`]}</p>
              )}
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`item-${it.key}-qty`} className="sr-only">Item {i + 1} quantity</label>
                  <input id={`item-${it.key}-qty`} inputMode="numeric" className={inputClass} value={it.quantity}
                    placeholder="Quantity" onChange={(e) => setItem(it.key, { quantity: e.target.value })}
                    aria-invalid={!!errors[`item-${it.key}-qty`]}
                    aria-describedby={errors[`item-${it.key}-qty`] ? `item-${it.key}-qty-error` : undefined} />
                  {errors[`item-${it.key}-qty`] && (
                    <p id={`item-${it.key}-qty-error`} role="alert" className="mt-1.5 text-[13px] text-bad">{errors[`item-${it.key}-qty`]}</p>
                  )}
                </div>
                <div>
                  <label htmlFor={`item-${it.key}-unit`} className="sr-only">Item {i + 1} unit</label>
                  <input id={`item-${it.key}-unit`} className={inputClass} value={it.unit} placeholder="Unit, like sheets"
                    onChange={(e) => setItem(it.key, { unit: e.target.value })} />
                </div>
              </div>
              {items.length > 1 && <div className="mt-3 space-y-3">
                <Field label="Budget for this item type (USD)" htmlFor={`item-${it.key}-budget`} error={errors[`item-${it.key}-budget`]}>
                  <input id={`item-${it.key}-budget`} inputMode="decimal" className={inputClass} value={it.budget} onChange={(e) => setItem(it.key, { budget: e.target.value })} />
                </Field>
                <Field label="Specifications for this item" htmlFor={`item-${it.key}-specs`}>
                  <textarea id={`item-${it.key}-specs`} rows={2} className={inputClass} value={it.specifications} onChange={(e) => setItem(it.key, { specifications: e.target.value })} />
                </Field>
              </div>}
              {items.length > 1 && (
                <button type="button" onClick={() => setItems((rows) => rows.filter((r) => r.key !== it.key))}
                  className="mt-2 text-[14px] font-medium text-accent">
                  Remove item {i + 1}
                </button>
              )}
            </div>
          ))}
          <button type="button" disabled={items.length >= 10} onClick={() => setItems((rows) => [...rows, blankItem(Math.max(...rows.map((r) => r.key)) + 1)])}
            className="text-[15px] font-medium text-accent">
            Add another item
          </button>
        </fieldset>
        </Section>
        <Section title="Requirements">

        <Field required={items.length === 1} label={items.length > 1 ? "Shared specifications (optional)" : "Must-have specifications"} htmlFor="mandatory" error={errors.mandatory}>
          <textarea id="mandatory" rows={4} className={inputClass} value={mandatory}
            onChange={(e) => setMandatory(e.target.value)} placeholder="Dimensions, compatibility, standards. One per line."
            aria-invalid={!!errors.mandatory} aria-describedby={errors.mandatory ? "mandatory-error" : undefined} />
        </Field>
        <Field label="Nice-to-haves" htmlFor="preferences">
          <textarea id="preferences" rows={3} className={inputClass} value={preferences} onChange={(e) => setPreferences(e.target.value)} />
        </Field>
        <div>
          <p className="mb-1.5 text-[15px] font-medium">Condition<RequiredMark /></p>
          <Segmented label="Condition" value={condition} onChange={setCondition}
            options={[{ value: "new", label: "New" }, { value: "refurbished", label: "New or refurbished" },
              { value: "any", label: "Any condition" }]} />
        </div>
        </Section>
        <Section title="Budget and timing">
        <Field required label="Total budget (USD)" htmlFor="budget" error={errors.budget}>
          <input id="budget" inputMode="decimal" className={inputClass} value={budget}
            onChange={(e) => setBudget(e.target.value)} placeholder="100" aria-invalid={!!errors.budget}
            aria-describedby={errors.budget ? "budget-error" : undefined} />
        </Field>
        <Field label="Needed by" htmlFor="deadline">
          <input id="deadline" type="date" className={inputClass} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        {eventNote && <p className="-mt-3 mb-4 text-[13px] text-muted">{eventNote}. The item must arrive by the date above so it can be checked first.</p>}
        {deadline && (
          <div className="-mt-2 mb-5">
            <Segmented label="Deadline type" value={deadlineKind} onChange={setDeadlineKind}
              options={[{ value: "flexible", label: "Flexible target" }, { value: "hard", label: "Hard deadline" }]} />
          </div>
        )}
        </Section>
        <ErrorNote error={apiError} />
        <Button type="submit" disabled={pending}>{pending ? "Preparing…" : items.length > 1 ? "Create grouped request" : "Find options"}</Button>
        {items.length === 1 && <p className="mt-2 text-[12px] text-muted">Starts research using search quota once requirements are clear.</p>}
      </form>
    </Page>
  );
}
