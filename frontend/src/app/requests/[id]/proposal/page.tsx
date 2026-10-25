"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type ApiError, type DecisionState, type ExecutionDetail, type ExecutionState } from "@/lib/api";
import { formatCents, parseDollarsToCents } from "@/lib/money";
import {
  Button,
  ErrorNote,
  Field,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  Section,
  formatWhen,
  inputClass,
  normalizeError,
  useLoad,
} from "@/components/ui";

const DECISION_LABEL: Record<DecisionState, string> = {
  not_submitted: "Not submitted",
  awaiting_review: "Awaiting executive review",
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

const EXECUTION_LABEL: Record<ExecutionState, string> = {
  not_started: "Not started",
  queued: "Queued",
  submitting: "Submitting",
  recorded: "Recorded in Nessie sandbox",
  failed: "Failed",
  uncertain: "Uncertain, needs checking",
};

function ExecutionSection({ d }: { d: ExecutionDetail }) {
  const differs = d.providerAmountCents !== null && d.providerAmountCents !== d.amountCents;
  return (
    <div className="mt-3">
      <dl>
        <KeyValue label="Approved amount" value={formatCents(d.amountCents)} />
        {d.providerAmountCents !== null && (
          <KeyValue label="Stored in Nessie" value={formatCents(d.providerAmountCents)}
            note={differs ? (d.amountNote ?? "Nessie stores whole dollars, so the stored amount differs.") : undefined} />
        )}
        {d.providerStatus && <KeyValue label="Nessie status" value={d.providerStatus} />}
        {d.purchaseId && <KeyValue label="Nessie reference" value={d.purchaseId} />}
      </dl>
      {d.lastError && <p role="alert" className="mt-2 text-[14px] text-bad">{d.lastError}</p>}
      <p className="mt-2 text-[13px] text-muted">{d.disclaimer}</p>
    </div>
  );
}

export default function ProposalPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <ProposalInner />
    </Suspense>
  );
}

function ProposalInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const offerId = useSearchParams().get("offer");
  const req = useLoad(() => api.getRequest(id), [id]);
  const offers = useLoad(() => api.listCandidates(id), [id]);
  const existing = useLoad(
    async () => (req.data?.proposalId ? api.getProposal(req.data.proposalId) : null),
    [req.data?.proposalId],
  );

  const [justification, setJustification] = useState("");
  const [expense, setExpense] = useState("");
  const [suitable, setSuitable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const loading = req.loading || offers.loading;
  const submitted = existing.data && existing.data.decision !== "not_submitted" ? existing.data : null;
  const offer = offers.data?.find((o) => o.id === (submitted?.offerId ?? offerId));

  async function submit() {
    if (pending || !offer) return;
    const next: Record<string, string> = {};
    const cents = parseDollarsToCents(expense);
    if (!justification.trim()) next.justification = "Say why this offer is the right choice.";
    if (cents === null || cents <= 0) next.expense = "Enter the exact amount you will pay, in dollars.";
    else if (offer.listedSubtotalCents !== null && cents < offer.listedSubtotalCents)
      next.expense = `This can't be less than the listed subtotal, ${formatCents(offer.listedSubtotalCents)}.`;
    if (!suitable) next.suitable = "Confirm that you reviewed technical suitability.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setApiError(null);
    try {
      await api.saveAndSubmitProposal(id, {
        offerId: offer.id,
        justification: justification.trim(),
        suitabilityConfirmed: true,
        expenseCents: cents as number,
      });
      router.replace(`/requests/${id}/proposal`);
      await req.reload();
    } catch (e) {
      setApiError(normalizeError(e)); // inputs stay as typed
    } finally {
      setPending(false);
    }
  }

  return (
    <Page>
      <PageHeader title={submitted ? "Proposal" : "Prepare proposal"}
        back={{ href: `/requests/${id}`, label: "Request" }} />
      {loading && <Loading />}
      <ErrorNote error={req.error ?? offers.error} />

      {req.data && !offer && !loading && (
        <p className="text-[14px] text-muted">Choose an offer first from the request page.</p>
      )}

      {req.data && offer && (
        <>
          <Section title="Selected offer">
            <p className="text-[17px] font-semibold leading-snug">{offer.title}</p>
            <p className="text-[13px] text-muted">{offer.seller}</p>
          </Section>

          <Section title="Three different amounts">
            <dl>
              <KeyValue label="Research subtotal" value={formatCents(offer.listedSubtotalCents)}
                note="Listed price only. Shipping and tax may be missing." />
              <KeyValue label="Approved budget ceiling" value={formatCents(req.data.budgetTotalCents)}
                note="The most this request may spend." />
              <KeyValue label="Simulated expense to record"
                value={submitted ? formatCents(submitted.expenseCents) : expense ? (parseDollarsToCents(expense) === null ? "Invalid" : formatCents(parseDollarsToCents(expense))) : "Not entered"}
                note="Confirmed by you. Not verified at a merchant checkout." />
            </dl>
          </Section>

          {submitted ? (
            <Section title="Status">
              <dl>
                <KeyValue label="Review" value={DECISION_LABEL[submitted.decision]} />
                <KeyValue label="Simulated purchase" value={EXECUTION_LABEL[submitted.execution]} />
                <KeyValue label="Revision" value={submitted.revision} />
                {submitted.submittedAt && <KeyValue label="Submitted" value={formatWhen(submitted.submittedAt)} />}
              </dl>
              {submitted.decisionNote && (
                <p className="mt-2 text-[16px]">
                  <span className="text-muted">Executive note: </span>
                  {submitted.decisionNote}
                </p>
              )}
              {submitted.executionDetail && <ExecutionSection d={submitted.executionDetail} />}
              {!submitted.executionDetail && (
                <p className="mt-3 text-[13px] text-muted">
                  If approved, a simulated purchase is recorded in the Nessie sandbox. Nothing is ordered and no real money
                  moves.
                </p>
              )}
              {submitted.unresolved.length > 0 && (
                <>
                  <h3 className="mb-1 mt-3 text-[15px] font-semibold">Still unresolved</h3>
                  <ul className="list-disc pl-5 text-[16px]">{submitted.unresolved.map((u) => <li key={u}>{u}</li>)}</ul>
                </>
              )}
              <p className="mt-3 text-[16px]">{submitted.justification}</p>
            </Section>
          ) : (
            <Section>
              <Field label="Justification" htmlFor="justification" error={errors.justification}>
                <textarea id="justification" rows={4} className={inputClass} value={justification}
                  onChange={(e) => setJustification(e.target.value)} aria-invalid={!!errors.justification}
                  aria-describedby={errors.justification ? "justification-error" : undefined} />
              </Field>
              <Field label="Expense to record (USD)" htmlFor="expense" error={errors.expense}
                hint="Shipping and tax are unknown in the listing, so enter the exact total you confirmed.">
                <input id="expense" inputMode="decimal" className={inputClass} value={expense}
                  onChange={(e) => setExpense(e.target.value)} aria-invalid={!!errors.expense}
                  aria-describedby={errors.expense ? "expense-error" : undefined} />
              </Field>
              <div className="mb-5">
                <label className="flex items-start gap-3 text-[16px]">
                  <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent)]" checked={suitable}
                    onChange={(e) => setSuitable(e.target.checked)} />
                  <span>I reviewed this offer and it is technically suitable for the purpose. This is my review, not an AI certification.</span>
                </label>
                {errors.suitable && <p role="alert" className="mt-1.5 text-[13px] text-bad">{errors.suitable}</p>}
              </div>
              <ErrorNote error={apiError} />
              <Button disabled={pending} onClick={submit}>{pending ? "Submitting…" : "Submit for executive review"}</Button>
            </Section>
          )}
        </>
      )}
    </Page>
  );
}
