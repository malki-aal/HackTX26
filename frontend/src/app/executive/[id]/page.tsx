"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { api, type ApiError, type Proposal } from "@/lib/api";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { newIdempotencyKey } from "@/lib/format";
import { DECISION_LABEL } from "@/lib/labels";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import {
  Button,
  ErrorNote,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  ProgressBar,
  SandboxNote,
  Section,
  inputClass,
  normalizeError,
  useLoad,
} from "@/components/ui";

type Decision = "approve" | "request_changes" | "reject";

export default function ExecutiveProposalPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <ExecutiveProposal />
    </Suspense>
  );
}

function ExecutiveProposal() {
  const { id } = useParams<{ id: string }>();
  const prop = useLoad(() => api.getProposal(id), [id]);
  const budget = useLoad(() => api.getBudget(), []);
  const [done, setDone] = useState<Proposal | null>(null);
  const [note, setNote] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // One key per logical decision. A retry of the same decision, version and note reuses it.
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const p = done ?? prop.data;

  async function decide(decision: Decision) {
    if (pending || !p) return;
    const sig = `${p.id}|${p.revision}|${decision}|${note}`;
    if (keyRef.current?.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };
    setPending(decision);
    setError(null);
    try {
      const result = await api.decide({ proposalId: p.id, version: p.revision, decision, note, idempotencyKey: keyRef.current.key });
      setDone(result);
      void budget.reload();
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setPending(null);
    }
  }

  const awaiting = p?.decision === "awaiting_review";

  return (
    <Page>
      <PageHeader
        title={p?.requestTitle ?? "Proposal"}
        back={{ href: "/executive", label: "Approvals" }}
        amount={p ? p.expenseCents : undefined}
        amountLabel="Requested expense"
      >
        {p && (
          <div className="mt-4">
            <ProgressBar value={p.expenseCents} max={p.budgetCeilingCents} over={p.expenseCents > p.budgetCeilingCents} />
            <p className="mt-1.5 text-[13px] text-white/85">of {formatCents(p.budgetCeilingCents)} budget ceiling</p>
          </div>
        )}
      </PageHeader>
      {prop.loading && <Loading />}
      <ErrorNote error={prop.error} onRetry={prop.reload} />

      {p && (
        <>
          <Section title="Items">
            <ul>
              {p.lines.map((l) => (
                <li key={l.itemId} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
                  <p className="text-[13px] text-muted">{l.itemName} · {l.quantityText}</p>
                  <p className="text-[17px] font-semibold leading-snug">{l.title}</p>
                  <p className="text-[14px] text-muted">
                    {l.seller ?? "Unknown seller"}
                    {l.listedSubtotalCents !== null && ` · ${formatCents(l.listedSubtotalCents)} listed`}
                  </p>
                  {l.sourceUrl && isSafeHttpUrl(l.sourceUrl) && (
                    <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[14px] font-medium text-accent">Source listing</a>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[16px]">{p.justification}</p>
          </Section>

          <Section title="Amounts">
            <dl>
              <KeyValue label="Requested expense" value={formatCents(p.expenseCents)} note="Confirmed by the requester. Not verified at a merchant checkout." />
              <KeyValue label="Research subtotal" value={formatCents(p.researchSubtotalCents)} />
              <KeyValue label="Request budget ceiling" value={formatCents(p.budgetCeilingCents)} />
              <KeyValue label="Company available budget" value={budget.data ? formatCents(budget.data.availableCents) : "Loading"}
                note={budget.data ? budget.data.source : undefined} />
            </dl>
            {p.unresolved.length > 0 && (
              <>
                <h3 className="mb-1 mt-3 text-[15px] font-semibold">Still unresolved</h3>
                <ul className="list-disc pl-5 text-[16px]">{p.unresolved.map((u) => <li key={u}>{u}</li>)}</ul>
              </>
            )}
            <SandboxNote />
          </Section>

          {awaiting && (
            <Section title="Decision">
              <label htmlFor="note" className="mb-1.5 block text-[15px] font-medium">Note (optional)</label>
              <textarea id="note" rows={3} className={`${inputClass} mb-4`} value={note} onChange={(e) => setNote(e.target.value)} />
              <label className="mb-4 flex items-start gap-3 text-[16px]">
                <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent)]" checked={authorized}
                  onChange={(e) => setAuthorized(e.target.checked)} />
                <span>
                  I approve exactly {formatCents(p.expenseCents)} for this version. Approving records a simulated purchase in
                  the Nessie sandbox. Nothing is ordered and no real money moves.
                </span>
              </label>
              <ErrorNote error={error} />
              <div className="space-y-3">
                <Button disabled={!authorized || pending !== null} onClick={() => decide("approve")}>
                  {pending === "approve" ? "Approving…" : `Approve ${formatCents(p.expenseCents)}`}
                </Button>
                <Button variant="quiet" disabled={pending !== null} onClick={() => decide("request_changes")}>
                  {pending === "request_changes" ? "Sending…" : "Request changes"}
                </Button>
                <Button variant="quiet" disabled={pending !== null} onClick={() => decide("reject")}>
                  {pending === "reject" ? "Rejecting…" : "Reject"}
                </Button>
              </div>
            </Section>
          )}

          {!awaiting && (
            <Section title="Outcome">
              <dl>
                <KeyValue label="Decision" value={DECISION_LABEL[p.decision]} />
                <KeyValue label="Purchase record" value={p.executionDetail ? <ExecutionStatusText status={p.executionDetail.status} /> : "Not started"} />
              </dl>
              {p.decisionNote && <p className="mt-2 text-[16px]"><span className="text-muted">Note: </span>{p.decisionNote}</p>}
              {p.executionDetail && (
                <div className="mt-3">
                  <ExecutionAmounts d={p.executionDetail} />
                  <ExecutionWarnings d={p.executionDetail} />
                  <Link href={`/purchases/${p.executionDetail.id}`} className="mt-3 block text-[15px] font-medium text-accent">
                    View purchase record
                  </Link>
                </div>
              )}
              <SandboxNote />
            </Section>
          )}
        </>
      )}
    </Page>
  );
}
