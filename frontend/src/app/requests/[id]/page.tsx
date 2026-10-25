"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { elapsedLabel, researchProgress } from "@/lib/research";
import { api, type ApiError, type Condition, type DeadlineKind, type Offer, type PurchaseRequest, type RequestItem, type Run } from "@/lib/api";
import { parseDollarsToCents } from "@/lib/money";
import { DecisionRecord } from "@/components/review";
import { CONDITION_LABEL, HIGHLIGHT_LABEL, stageIndex, stages } from "@/lib/labels";
import { itemLine } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { readSelection, selectionQuery, writeSelection } from "@/lib/selection";
import {
  Button,
  EligibilityMark,
  Field,
  inputClass,
  Empty,
  ErrorNote,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  Section,
  ChoiceList,
  Segmented,
  needsChoiceList,
  formatWhen,
  normalizeError,
  useLoad,
  usePolling,
} from "@/components/ui";

const POLL_MS = 1500;

export default function RequestDetailPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <RequestDetail />
    </Suspense>
  );
}

function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: req, error, loading, reload, refresh, setData } = useLoad(() => api.getRequest(id), [id]);
  const [editing, setEditing] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // While a proposal waits for a decision, check for the answer. Read-only.
  usePolling(refresh, 5000, req?.status === "submitted");

  return (
    <Page>
      <PageHeader
        title={req?.title ?? "Request"}
        back={{ href: "/", label: "Requests" }}
        amount={req ? req.budgetTotalCents : undefined}
        amountLabel="Total budget"
        stats={
          req
            ? [
                { label: "Quantity", value: req.items.reduce((n, item) => n + item.quantity, 0) },
                { label: req.deadline ? (req.deadlineKind === "hard" ? "Hard deadline" : "Target date") : "Deadline", value: req.deadline ?? "None" },
              ]
            : undefined
        }
      >
        {req && <StageBar current={stageIndex(req.status)} />}
      </PageHeader>
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {req && (
        <>
          {["clarifying", "awaiting_confirmation", "confirmed"].includes(req.status) ? <Summary req={req} /> : (
            <details className="mb-4 rounded-2xl bg-paper p-4"><summary className="cursor-pointer font-medium">Request details</summary><Summary req={req} /></details>
          )}
          {(req.status === "changes_requested" || req.proposalDecision === "changes_requested") && req.proposalId && (
            <ChangesNote proposalId={req.proposalId} requestId={req.id} />
          )}
          {savedNote && <p role="status" className="mb-4 rounded-xl bg-accent-soft p-3 text-[14px]">{savedNote}</p>}
          {!req.projectId && EDITABLE.has(req.status) && (editing ? (
            <EditRequest
              req={req}
              onCancel={() => setEditing(false)}
              onSaved={(next) => {
                setEditing(false);
                setData(next);
                setSavedNote(
                  next.version > req.version
                    ? `Saved as version ${next.version}. Earlier offers were for version ${req.version} and no longer apply: confirm the requirements below, then search again (uses search quota).`
                    : "No changes to save.",
                );
              }}
            />
          ) : (
            <button type="button" onClick={() => { setSavedNote(null); setEditing(true); }} className="touch mb-4 text-[15px] font-medium text-accent">
              Edit request (quantity, budget, specifications)
            </button>
          ))}
          {(req.status === "clarifying" || req.status === "awaiting_confirmation") && <Review req={req} onChange={setData} />}
          {req.status === "confirmed" && <StartResearch req={req} onChange={setData} />}
          {req.status === "researching" && req.runId && <Research runId={req.runId} onDone={reload} />}
          {["results_ready", "proposal_drafted", "submitted", "approved", "changes_requested", "rejected"].includes(
            req.status,
          ) && <Compare req={req} onChange={setData} />}
        </>
      )}
    </Page>
  );
}

/** States where the request itself can still be edited (not while researching, submitted or decided). */
const EDITABLE = new Set<PurchaseRequest["status"]>(["clarifying", "awaiting_confirmation", "confirmed", "results_ready", "proposal_drafted", "changes_requested"]);

/**
 * Edit the request itself, e.g. after the executive asked for 2 monitors instead of 4. Saving creates a
 * new version: material changes must be confirmed again and research is redone for the new version, so
 * old pricing (for 4) is never reused. Earlier versions and decisions stay in history.
 */
function EditRequest({ req, onSaved, onCancel }: { req: PurchaseRequest; onSaved: (r: PurchaseRequest) => void; onCancel: () => void }) {
  const item = req.items[0]!;
  const lines = req.specLines ?? { mandatory: req.mandatory, preferences: req.preferences };
  const [title, setTitle] = useState(req.title);
  const [purpose, setPurpose] = useState(req.purpose);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [unit, setUnit] = useState(item.unit);
  const [budget, setBudget] = useState((req.budgetTotalCents / 100).toFixed(req.budgetTotalCents % 100 ? 2 : 0));
  const [mandatory, setMandatory] = useState(lines.mandatory.join("\n"));
  const [preferences, setPreferences] = useState(lines.preferences.join("\n"));
  const [condition, setCondition] = useState<Condition>(req.condition);
  const [deadline, setDeadline] = useState(req.deadline ?? "");
  const [deadlineKind, setDeadlineKind] = useState<DeadlineKind>(req.deadlineKind);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const split = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

  function save() {
    const next: Record<string, string> = {};
    const q = Number(quantity);
    const cents = parseDollarsToCents(budget);
    if (!title.trim()) next.title = "Add a short title.";
    if (!Number.isInteger(q) || q < 1) next.quantity = "Enter a whole number, 1 or more.";
    if (cents === null || cents <= 0) next.budget = "Enter the total budget in dollars.";
    if (!split(mandatory).length) next.mandatory = "List at least one must-have.";
    setErrors(next);
    if (Object.keys(next).length) return;
    void run(
      () => api.updateRequest(req.id, {
        expectedVersion: req.version,
        title: title.trim(),
        purpose: purpose.trim(),
        items: [{ name: item.name, quantity: q, unit: unit.trim() || item.unit }],
        budgetTotalCents: cents as number,
        mandatory: split(mandatory),
        preferences: split(preferences),
        condition,
        deadline: deadline || undefined,
        deadlineKind: deadline ? deadlineKind : "flexible",
        agentConfigId: req.agentConfigId || "cfg_default",
      }),
      onSaved,
    );
  }

  return (
    <Section title={`Edit request · version ${req.version}`}>
      <p className="mb-3 text-[14px] text-muted">
        Saving creates version {req.version + 1}. You&apos;ll confirm it, then search again, so prices match the new request. Earlier versions and decisions stay in the history.
      </p>
      <Field required label="Title" htmlFor="edit-title" error={errors.title}>
        <input id="edit-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="What is it for?" htmlFor="edit-purpose">
        <textarea id="edit-purpose" rows={3} className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field required label={`Quantity (${item.name})`} htmlFor="edit-qty" error={errors.quantity}>
          <input id="edit-qty" inputMode="numeric" className={inputClass} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Unit" htmlFor="edit-unit">
          <input id="edit-unit" className={inputClass} value={unit} onChange={(e) => setUnit(e.target.value)} />
        </Field>
      </div>
      <Field required label="Total budget (USD)" htmlFor="edit-budget" error={errors.budget}>
        <input id="edit-budget" inputMode="decimal" className={inputClass} value={budget} onChange={(e) => setBudget(e.target.value)} />
      </Field>
      <Field required label="Must-have specifications" htmlFor="edit-mandatory" error={errors.mandatory}>
        <textarea id="edit-mandatory" rows={4} className={inputClass} value={mandatory} onChange={(e) => setMandatory(e.target.value)} />
      </Field>
      <Field label="Nice-to-haves" htmlFor="edit-preferences">
        <textarea id="edit-preferences" rows={2} className={inputClass} value={preferences} onChange={(e) => setPreferences(e.target.value)} />
      </Field>
      <div className="mb-5">
        <p className="mb-1.5 text-[15px] font-medium">Condition</p>
        <Segmented label="Condition" value={condition} onChange={setCondition}
          options={[{ value: "new", label: "New" }, { value: "refurbished", label: "New or refurbished" }, { value: "any", label: "Any condition" }]} />
      </div>
      <Field label="Needed by" htmlFor="edit-deadline">
        <input id="edit-deadline" type="date" className={inputClass} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </Field>
      {deadline && (
        <div className="-mt-2 mb-5">
          <Segmented label="Deadline type" value={deadlineKind} onChange={setDeadlineKind}
            options={[{ value: "flexible", label: "Flexible target" }, { value: "hard", label: "Hard deadline" }]} />
        </div>
      )}
      <ErrorNote error={error} />
      <div className="space-y-3">
        <Button disabled={pending} onClick={save}>{pending ? "Saving…" : `Save as version ${req.version + 1}`}</Button>
        <Button variant="quiet" disabled={pending} onClick={onCancel}>Cancel</Button>
      </div>
    </Section>
  );
}

function StageBar({ current }: { current: number }) {
  return (
    <div className="mt-5" role="img" aria-label={`Step ${current + 1} of ${stages.length}: ${stages[current]}`}>
      <div className="flex gap-1.5" aria-hidden>
        {stages.map((s, i) => (
          <span key={s} className={`h-1.5 flex-1 rounded-full ${i <= current ? "bg-white" : "bg-hero-tile"}`} />
        ))}
      </div>
    </div>
  );
}

/** The executive's notes, shown first so the employee knows exactly what to edit. */
function ChangesNote({ proposalId, requestId }: { proposalId: string; requestId: string }) {
  const { data, error, reload } = useLoad(() => api.getProposal(proposalId), [proposalId]);
  return (
    <Section title="Changes requested">
      {data ? <DecisionRecord p={data} /> : <ErrorNote error={error} onRetry={reload} />}
      <p className="mt-2 text-[14px] text-muted">
        If the quantity, budget or specifications need to change, use Edit request below (you&apos;ll search again for the new version).
        Otherwise select an offer below, adjust the amount or your case, and resubmit.
      </p>
      <Link href={`/requests/${requestId}/proposal`} className="touch text-[15px] font-medium text-accent">View proposal and status</Link>
    </Section>
  );
}

function Summary({ req }: { req: PurchaseRequest }) {
  return (
    <Section title="Request">
      {req.purpose && <p className="mb-3 text-[16px]">{req.purpose}</p>}
      <h3 className="mb-1 text-[15px] font-semibold">Items</h3>
      <ul className="mb-2 list-disc pl-5 text-[16px]">{req.items.map((it) => <li key={it.id}>{itemLine(it)}</li>)}</ul>
      <dl>
        <KeyValue label="Condition" value={CONDITION_LABEL[req.condition]} />
      </dl>
      <h3 className="mb-1 mt-3 text-[15px] font-semibold">Must have</h3>
      {req.mandatory.length
        ? <ul className="list-disc pl-5 text-[16px]">{req.mandatory.map((m) => <li key={m}>{m}</li>)}</ul>
        : <p className="text-[15px] text-muted">None stated</p>}
      {req.preferences.length > 0 && (
        <>
          <h3 className="mb-1 mt-3 text-[15px] font-semibold">Nice to have</h3>
          <ul className="list-disc pl-5 text-[16px]">{req.preferences.map((m) => <li key={m}>{m}</li>)}</ul>
        </>
      )}
    </Section>
  );
}

function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function run<T>(fn: () => Promise<T>, then: (v: T) => void) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      then(await fn());
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

/** One step: answer any open question and confirm the exact requirement version. */
function Review({ req, onChange }: { req: PurchaseRequest; onChange: (r: PurchaseRequest) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const answerOf = (id: string, saved?: string) => answers[id] ?? saved;
  const unanswered = req.clarifications.filter((c) => !answerOf(c.id, c.answer));

  async function confirm() {
    const changed = Object.keys(answers).length > 0;
    const current = changed ? await api.answerClarifications(req.id, answers) : req;
    const confirmed = await api.confirmRequirements(current.id, current.version);
    onChange(confirmed); // Keep the recoverable state if starting research fails.
    await api.startResearch(confirmed.id);
    return api.getRequest(confirmed.id);
  }

  return (
    <Section title={req.clarifications.length ? "A few details" : "Ready to search"}>
      {req.clarifications.map((c) => (
        <div key={c.id} className="mb-4">
          <p className="mb-1.5 text-[16px]">{c.question}</p>
          {c.options.length ? (needsChoiceList(c.options)
            ? <ChoiceList label={c.question} value={answerOf(c.id, c.answer) ?? ""} onChange={(v) => setAnswers({ ...answers, [c.id]: v })} options={c.options} />
            : <Segmented label={c.question} value={answerOf(c.id, c.answer) ?? ""}
            onChange={(v) => setAnswers({ ...answers, [c.id]: v })} options={c.options} />) :
            <input aria-label={c.question} className="w-full rounded-xl border border-rule p-3" value={answerOf(c.id, c.answer) ?? ""} onChange={(e) => setAnswers({ ...answers, [c.id]: e.target.value })} />}
        </div>
      ))}
      <ErrorNote error={error} />
      <Button disabled={unanswered.length > 0 || pending} onClick={() => run(confirm, onChange)}>
        {pending ? "Starting…" : "Find options"}
      </Button>
      <p className="mt-2 text-[12px] text-muted">Confirms these requirements and starts research using search quota.</p>
    </Section>
  );
}

function StartResearch({ req, onChange }: { req: PurchaseRequest; onChange: (r: PurchaseRequest) => void }) {
  const { pending, error, run } = useAction();
  return (
    <Section title="Research">
      <ErrorNote error={error} />
      <Button disabled={pending}
        onClick={() => run(() => api.startResearch(req.id), () => api.getRequest(req.id).then(onChange))}>
        {pending ? "Starting…" : "Find options"}
      </Button>
      <p className="mt-2 text-[12px] text-muted">Uses search quota.</p>
    </Section>
  );
}

function Research({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  // Ticks the elapsed time and quota countdown between polls; display only.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [error, setError] = useState<ApiError | null>(null);
  const { pending, run: act } = useAction();
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  // Sequential polling reads the saved run; it never starts research.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const r = await api.getRun(runId);
        if (stopped) return;
        setRun(r);
        setError(null);
        if (r.state === "failed") return; // keep the failure visible; the user decides what to do
        if (r.state !== "running") {
          doneRef.current();
          return;
        }
      } catch (e) {
        if (stopped) return;
        setError(normalizeError(e));
      }
      timer = setTimeout(tick, POLL_MS);
    }
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);

  return (
    <Section title="Research in progress">
      {run && (() => {
        const pr = researchProgress(run, now);
        const el = elapsedLabel(run.startedAt, now);
        return (
          <div className="mb-3" aria-live="polite">
            <p className="text-[16px] font-semibold">
              {pr.label}
              {el && <span className="font-normal text-muted"> · {el}</span>}
            </p>
            {pr.detail && <p className="text-[13px] text-muted">{pr.detail}</p>}
          </div>
        );
      })()}
      {!run && !error && <Loading label="Checking run" />}
      <details className="mb-4"><summary className="cursor-pointer text-[13px] text-muted">Research activity</summary><ol className="mt-2 space-y-2">
        {run?.events.map((e) => (
          <li key={e.id} className="text-[16px]">
            {e.message}
            <span className="block text-[13px] text-muted">{formatWhen(e.at)}</span>
          </li>
        ))}
      </ol></details>
      <ErrorNote error={error} />
      {run?.state === "failed" ? (
        <>
          <ErrorNote error={{ code: "RESEARCH_FAILED", message: run.error ?? "Research did not finish." }} />
          <Button onClick={() => onDone()}>Back to request</Button>
        </>
      ) : (
        <Button variant="quiet" disabled={pending} onClick={() => act(() => api.cancelRun(runId), () => onDone())}>
          Cancel research
        </Button>
      )}
    </Section>
  );
}

// ---------- compare and select ----------

const HIGHLIGHT_INK = { lowest_known_cost: "text-green-ink", best_deadline_fit: "text-orange-ink", best_overall_fit: "text-purple-ink" } as const;
const HIGHLIGHT_ORDER = ["lowest_known_cost", "best_deadline_fit", "best_overall_fit"] as const;

function priceLine(o: Offer): string {
  if (o.unitPriceCents === null) return "Price unknown";
  const per = o.packageQuantity > 1 ? `per ${o.packageQuantity}-pack` : "each";
  const sub = o.listedSubtotalCents === null ? "" : ` · ${formatCents(o.listedSubtotalCents)} for ${o.packagesRequired}${o.packageQuantity > 1 ? (o.packagesRequired === 1 ? " pack" : " packs") : ""}`;
  return `${formatCents(o.unitPriceCents)} ${per}${sub}`;
}

function deliveryLine(o: Offer): string {
  return o.delivery.status === "stated" && o.delivery.text ? o.delivery.text : "Delivery unknown";
}

function Compare({ req, onChange }: { req: PurchaseRequest; onChange: (r: PurchaseRequest) => void }) {
  const router = useRouter();
  const { data, error, loading, reload } = useLoad<Offer[]>(() => api.listCandidates(req.id), [req.id]);
  const again = useAction();
  const [selection, setSelection] = useState<Record<string, string>>(() => readSelection(req.id));
  const locked = req.status !== "results_ready" && req.status !== "proposal_drafted" && req.status !== "changes_requested";

  function choose(itemId: string, offerId: string) {
    const next = { ...selection, [itemId]: offerId };
    setSelection(next);
    writeSelection(req.id, next);
  }

  const complete = req.items.every((it) => selection[it.id] && data?.some((o) => o.id === selection[it.id]));
  const hard = req.deadlineKind === "hard";

  return (
    <Section title="Compare and select">
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && data.length === 0 && (
        <Empty title="No matching offers" body="The search finished but nothing met your must-haves. Nothing was loosened." />
      )}
      {data && data.length > 0 && req.items.map((item) => (
        <ItemOffers key={item.id} item={item} multi={req.items.length > 1} offers={data.filter((o) => o.itemId === item.id)}
          requestId={req.id} hard={hard} selected={selection[item.id]} locked={locked}
          onChoose={(offerId) => choose(item.id, offerId)} />
      ))}
      {data && data.length > 0 && !locked && (
        <>
          {!complete && req.items.length > 1 && (
            <p className="mb-3 text-[14px] text-muted">Select one option for each item to continue.</p>
          )}
          <Button disabled={!complete}
            onClick={() => router.push(`/requests/${req.id}/proposal?sel=${encodeURIComponent(selectionQuery(selection))}`)}>
            Review proposal
          </Button>
        </>
      )}
      {!locked && data && (data.some((o) => o.stale) || req.status === "changes_requested") && (
        <div className="mt-4">
          <p className="mb-2 text-[14px] text-muted">
            {data.some((o) => o.stale) ? "Some offer evidence has expired, and approval is refused for expired offers." : "To revise with fresh offers, search again."}{" "}
            Searching again uses search and model quota and starts only when you press the button.
          </p>
          <ErrorNote error={again.error} />
          <Button variant="quiet" disabled={again.pending}
            onClick={() => again.run(() => api.startResearch(req.id), () => api.getRequest(req.id).then(onChange))}>
            {again.pending ? "Starting…" : "Search again"}
          </Button>
        </div>
      )}
      {req.proposalId && (req.status === "submitted" || req.status === "approved" || req.status === "changes_requested" || req.status === "rejected") && (
        <Link href={`/requests/${req.id}/proposal`} className="mt-4 block text-[15px] font-medium text-accent">
          View proposal and status
        </Link>
      )}
    </Section>
  );
}

function ItemOffers({
  item,
  multi,
  offers,
  requestId,
  hard,
  selected,
  locked,
  onChoose,
}: {
  item: RequestItem;
  multi: boolean;
  offers: Offer[];
  requestId: string;
  hard: boolean;
  selected?: string;
  locked: boolean;
  onChoose: (offerId: string) => void;
}) {
  const late = (o: Offer) => hard && o.deadlineFit === "misses";
  const suggested = offers
    .filter((o) => o.highlights.length > 0 && !late(o) && o.eligibility !== "rejected")
    .sort((a, b) => Math.min(...a.highlights.map((h) => HIGHLIGHT_ORDER.indexOf(h))) - Math.min(...b.highlights.map((h) => HIGHLIGHT_ORDER.indexOf(h))));
  const other = offers.filter((o) => !suggested.includes(o) && !late(o) && o.eligibility !== "rejected");
  const fullyMatched = offers.filter((o) => o.eligibility === "eligible" && !late(o));
  const afterDeadline = offers.filter((o) => late(o) && o.eligibility !== "rejected");
  const rejected = offers.filter((o) => o.eligibility === "rejected");

  const row = (o: Offer, note?: string) => (
    <li key={o.id} className="border-t border-rule py-4 first:border-t-0">
      {o.highlights.length > 0 && (
        <p className={`mb-1 text-[14px] font-semibold ${HIGHLIGHT_INK[o.highlights[0]]}`}>{o.highlights.map((h) => HIGHLIGHT_LABEL[h]).join(" · ")}</p>
      )}
      {note && <p className="mb-1 text-[14px] font-semibold text-bad">{note}</p>}
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[17px] font-semibold leading-snug">{o.title}</h4>
        <EligibilityMark value={o.eligibility} />
      </div>
      <p className="mt-0.5 text-[13px] text-muted">{o.seller}</p>
      <p className="mt-2 text-[16px] tabular-nums">{priceLine(o)}</p>
      {/* Volume orders: how many containers cover the amount, and any excess (or why it can't be verified). */}
      {o.costNotes.filter((n) => /fl oz/.test(n)).map((n) => <p key={n} className="text-[13px] text-muted">{n}</p>)}
      {!o.tradeoff && <p className="text-[14px] text-muted">{deliveryLine(o)}</p>}
      <p className="mt-1 text-[14px]">{o.tradeoff ?? o.rankNote}</p>
      <div className="mt-2 flex items-center gap-4">
        <Link href={`/requests/${requestId}/offers/${o.id}`} className="text-[15px] font-medium text-accent">Details</Link>
        {!locked && o.eligibility !== "rejected" && !o.stale && (
          <button type="button" onClick={() => onChoose(o.id)} aria-pressed={selected === o.id}
            className={`h-10 rounded-full px-5 text-[14px] font-semibold ${selected === o.id ? "bg-accent text-white" : "bg-accent-soft text-accent"}`}>
            {selected === o.id ? "Selected ✓" : "Select"}
          </button>
        )}
        {o.stale && <span className="text-[13px] font-medium text-bad">Out of date</span>}
      </div>
    </li>
  );

  return (
    <div className="mb-6">
      {multi && <h3 className="mb-1 text-[17px] font-semibold">{itemLine(item)}</h3>}
      {offers.every((o) => o.eligibility === "rejected") && (
        <p className="mb-2 text-[14px] text-muted">
          No offer met every must-have. These near misses are listed for reference and can&apos;t be proposed.
        </p>
      )}
      {suggested.length > 0 && (
        <>
          <h4 className="mt-2 text-[15px] font-semibold">Suggested options</h4>
          <ul>{suggested.map((o) => row(o))}</ul>
        </>
      )}
      {fullyMatched.length === 0 && offers.some((o) => o.eligibility === "needs_review") && (
        <p className="mb-3 rounded-xl bg-orange-soft p-3 text-[14px]">No fully verified match yet. These options have gaps to check before submitting.</p>
      )}
      {other.length > 0 && (
        <>
          <h4 className="mt-3 text-[15px] font-semibold">{suggested.length ? "Other options" : "Options"}</h4>
          <ul>{other.slice(0, 5).map((o) => row(o))}</ul>
          {other.length > 5 && <details className="mt-3"><summary className="cursor-pointer text-[14px] font-medium text-accent">More options ({other.length - 5})</summary><ul>{other.slice(5).map((o) => row(o))}</ul></details>}
        </>
      )}
      {afterDeadline.length > 0 && (
        <>
          <h4 className="mt-3 text-[15px] font-semibold text-bad">After your hard deadline</h4>
          <p className="text-[13px] text-muted">These do not meet the request as written. Choosing one is a deliberate exception.</p>
          <ul>{afterDeadline.map((o) => row(o, "Arrives after your hard deadline"))}</ul>
        </>
      )}
      {rejected.length > 0 && offers.some((o) => o.eligibility !== "rejected") && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[14px] text-muted">Excluded options ({rejected.length})</summary>
          <ul>{rejected.map((o) => row(o))}</ul>
        </details>
      )}
      {rejected.length > 0 && offers.every((o) => o.eligibility === "rejected") && (
        <ul>{rejected.map((o) => row(o))}</ul>
      )}
    </div>
  );
}
