"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api, type ApiError, type Offer, type PurchaseRequest, type Run } from "@/lib/api";
import { stageIndex, stages } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import {
  Button,
  EligibilityMark,
  Empty,
  ErrorNote,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  Section,
  Segmented,
  formatWhen,
  normalizeError,
  useLoad,
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
  const { data: req, error, loading, reload, setData } = useLoad(() => api.getRequest(id), [id]);

  return (
    <Page>
      <PageHeader title={req?.title ?? "Request"} back={{ href: "/", label: "Requests" }} />
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {req && (
        <>
          <Stepper current={stageIndex(req.status)} />
          <Summary req={req} />
          {(req.status === "clarifying") && <Clarify req={req} onChange={setData} />}
          {req.status === "awaiting_confirmation" && <Confirm req={req} onChange={setData} />}
          {req.status === "confirmed" && <StartResearch req={req} onChange={setData} />}
          {req.status === "researching" && req.runId && <Research runId={req.runId} onDone={reload} />}
          {["results_ready", "proposal_drafted", "submitted", "approved", "changes_requested", "rejected"].includes(
            req.status,
          ) && <Offers req={req} />}
        </>
      )}
    </Page>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mb-5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]" aria-label="Progress">
      {stages.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined}
          className={i === current ? "font-semibold text-accent" : i < current ? "text-ink" : "text-muted"}>
          {i < current ? "✓ " : ""}{i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

function Summary({ req }: { req: PurchaseRequest }) {
  return (
    <Section title="Request">
      <dl>
        <KeyValue label="Quantity" value={req.quantity} />
        <KeyValue label="Total budget" value={formatCents(req.budgetTotalCents)} note="For the whole order" />
        <KeyValue label="Condition" value={req.condition} />
        {req.deadline && <KeyValue label="Needed by" value={req.deadline} />}
      </dl>
      <h3 className="mb-1 mt-3 text-[15px] font-semibold">Must have</h3>
      <ul className="list-disc pl-5 text-[16px]">{req.mandatory.map((m) => <li key={m}>{m}</li>)}</ul>
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

function Clarify({ req, onChange }: { req: PurchaseRequest; onChange: (r: PurchaseRequest) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const unanswered = req.clarifications.filter((c) => !(answers[c.id] ?? c.answer));
  return (
    <Section title="A few questions">
      {req.clarifications.map((c) => (
        <div key={c.id} className="mb-4">
          <p id={`${c.id}-label`} className="mb-1.5 text-[16px]">{c.question}</p>
          <Segmented label={c.question} value={answers[c.id] ?? c.answer ?? ""}
            onChange={(v) => setAnswers({ ...answers, [c.id]: v })} options={c.options} />
        </div>
      ))}
      <ErrorNote error={error} />
      <Button disabled={pending || unanswered.length > 0}
        onClick={() => run(() => api.answerClarifications(req.id, answers), onChange)}>
        {pending ? "Saving…" : "Review requirements"}
      </Button>
    </Section>
  );
}

function Confirm({ req, onChange }: { req: PurchaseRequest; onChange: (r: PurchaseRequest) => void }) {
  const [ok, setOk] = useState(false);
  const { pending, error, run } = useAction();
  return (
    <Section title="Confirm requirements">
      {req.clarifications.map((c) => (
        <div key={c.id} className="mb-3">
          <p className="text-[13px] text-muted">{c.question}</p>
          <p className="text-[16px]">{c.options.find((o) => o.value === c.answer)?.label ?? c.answer ?? "No answer"}</p>
        </div>
      ))}
      <label className="my-4 flex items-start gap-3 text-[16px]">
        <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent)]" checked={ok}
          onChange={(e) => setOk(e.target.checked)} />
        <span>The must-haves above match what I need (version {req.version}). They will not be loosened.</span>
      </label>
      <ErrorNote error={error} />
      <Button disabled={!ok || pending}
        onClick={() => run(() => api.confirmRequirements(req.id, req.version), onChange)}>
        {pending ? "Confirming…" : "Confirm requirements"}
      </Button>
    </Section>
  );
}

function StartResearch({ req, onChange }: { req: PurchaseRequest; onChange: (r: PurchaseRequest) => void }) {
  const { pending, error, run } = useAction();
  return (
    <Section title="Research">
      <p className="mb-4 text-[14px] text-muted">
        Research runs one search for your confirmed requirements. It starts only when you press the button.
      </p>
      <ErrorNote error={error} />
      <Button disabled={pending}
        onClick={() => run(() => api.startResearch(req.id), () => api.getRequest(req.id).then(onChange))}>
        {pending ? "Starting…" : "Start research"}
      </Button>
    </Section>
  );
}

function Research({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const { pending, run: act } = useAction();
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  // Sequential polling: next poll is scheduled only after the previous returns.
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
      {run && (
        <p className="mb-3 text-[13px] text-muted">
          Using {run.agentConfigName} v{run.agentConfigVersion}
        </p>
      )}
      {!run && !error && <Loading label="Checking run" />}
      <ol className="mb-4 space-y-2">
        {run?.events.map((e) => (
          <li key={e.id} className="text-[16px]">
            {e.message}
            <span className="block text-[13px] text-muted">{formatWhen(e.at)}</span>
          </li>
        ))}
      </ol>
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

function Offers({ req }: { req: PurchaseRequest }) {
  const { data, error, loading, reload } = useLoad<Offer[]>(() => api.listCandidates(req.id), [req.id]);
  return (
    <Section title="Offers">
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && data.length === 0 && (
        <Empty title="No matching offers" body="The search finished but nothing met your must-haves. Nothing was loosened." />
      )}
      {data && data.length > 0 && data.every((o) => o.eligibility === "rejected") && (
        <p className="mb-3 text-[14px] text-muted">
          No offer met every must-have. These near misses are listed for reference and can&apos;t be proposed.
        </p>
      )}
      {data && data.length > 0 && (
        <ul>
          {data.map((o) => {
            const supported = o.findings.filter((f) => f.status === "supported").length;
            const unknown = o.findings.filter((f) => f.status === "unknown").length;
            const bad = o.findings.filter((f) => f.status === "contradicted").length;
            return (
              <li key={o.id} className="border-t border-rule first:border-t-0">
                <Link href={`/requests/${req.id}/offers/${o.id}`} className="block py-4 active:bg-raised">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-[17px] font-semibold leading-snug">{o.title}</h3>
                    <EligibilityMark value={o.eligibility} />
                  </div>
                  <p className="mt-0.5 text-[13px] text-muted">{o.seller}</p>
                  <p className="mt-2 text-[16px] tabular-nums">
                    {o.unitPriceCents === null ? "Price unknown" : `${formatCents(o.unitPriceCents)} ${o.packageQuantity > 1 ? `per ${o.packageQuantity}-pack` : "each"}`}
                    {o.listedSubtotalCents !== null && ` · ${formatCents(o.listedSubtotalCents)} for ${o.packagesRequired}${o.packageQuantity > 1 ? ` ${o.packagesRequired === 1 ? "pack" : "packs"}` : ""}`}
                  </p>
                  <p className="text-[13px] text-muted">
                    {supported} supported · {unknown} unknown · {bad} contradicted
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {req.proposalId && req.status !== "results_ready" && req.status !== "proposal_drafted" && (
        <Link href={`/requests/${req.id}/proposal`} className="mt-4 block text-[14px] font-medium text-accent">
          View proposal
        </Link>
      )}
    </Section>
  );
}
