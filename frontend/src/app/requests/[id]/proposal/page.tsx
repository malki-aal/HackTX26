"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type ExecutionDetail, type ApiError, type Offer, type Proposal, type ProposalLine } from "@/lib/api";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { DecisionRecord } from "@/components/review";
import { PayButton } from "@/components/wallet";
import { formatCents, isSafeHttpUrl, parseDollarsToCents } from "@/lib/money";
import { parseSelectionQuery, readSelection } from "@/lib/selection";
import { proposedCost } from "@/lib/proposal-cost";
import {
  Button,
  ErrorNote,
  Field,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  ProgressBar,
  Section,
  formatWhen,
  inputClass,
  normalizeError,
  useLoad,
  usePolling,
} from "@/components/ui";

export default function ProposalPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <ProposalInner />
    </Suspense>
  );
}

/** After approval: the money that arrived in the employee's account (+) and their payment to the seller (−). */
function MoneyFlow({ d, onPaid }: { d: ExecutionDetail; onPaid: () => void }) {
  const seller = d.merchant.researchedSeller;
  const paid = d.payment;
  return (
    <div className="mt-3 rounded-xl bg-raised p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px]">{d.status === "recorded" ? "Received in your Runway account" : "Sending to your Runway account"}</span>
        <span className={`font-semibold tabular-nums ${d.status === "recorded" ? "text-ok" : "text-muted"}`}>+{formatCents(d.amountCents)}</span>
      </div>
      {paid && (
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-[15px]">{paid.status === "recorded" ? `Paid ${seller ?? "seller"}` : `Paying ${seller ?? "seller"} · ${paid.status === "uncertain" ? "checking" : paid.status}`}</span>
          <span className={`font-semibold tabular-nums ${paid.status === "recorded" ? "text-bad" : "text-muted"}`}>−{formatCents(paid.amountCents)}</span>
        </div>
      )}
      {d.status === "recorded" && (!paid || paid.status === "failed") && (
        <PayButton executionId={d.id} seller={seller} amountCents={d.amountCents} onPaid={onPaid} />
      )}
    </div>
  );
}

function Lines({ lines }: { lines: ProposalLine[] }) {
  return (
    <ul>
      {lines.map((l) => (
        <li key={l.itemId} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
          <p className="text-[13px] text-muted">{l.itemName} · {l.quantityText}</p>
          <p className="text-[17px] font-semibold leading-snug">{l.title}</p>
          <p className="text-[14px] text-muted">
            {l.seller ?? "Unknown seller"}
            {l.listedSubtotalCents !== null && ` · ${formatCents(l.listedSubtotalCents)} listed`}
          </p>
          {l.sourceUrl && isSafeHttpUrl(l.sourceUrl) && (
            <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[14px] font-medium text-accent">
              Source listing
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProposalInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const selParam = useSearchParams().get("sel");
  const req = useLoad(() => api.getRequest(id), [id]);
  const offers = useLoad(() => api.listCandidates(id), [id]);
  const existing = useLoad(
    async () => (req.data?.proposalId ? api.getProposal(req.data.proposalId) : null),
    [req.data?.proposalId],
  );

  // Watch for the executive's decision and for the purchase result. Read-only; never starts research.
  const live = existing.data;
  usePolling(
    async () => {
      await Promise.all([existing.refresh(), req.refresh()]);
    },
    5000,
    !!live && (live.decision === "awaiting_review" || live.execution === "queued" || live.execution === "submitting"),
  );

  const [justification, setJustification] = useState("");
  const [expense, setExpense] = useState("");
  // Per unconfirmed must-have: verified by the requester, or a deliberate exception, with a note.
  const [resolutions, setResolutions] = useState<Record<string, { kind: "verified" | "exception" | ""; note: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const loading = req.loading || offers.loading;
  const submitted: Proposal | null = existing.data && existing.data.decision !== "not_submitted" ? existing.data : null;
  const fromQuery = parseSelectionQuery(selParam);
  const selection = Object.keys(fromQuery).length ? fromQuery : req.data ? readSelection(req.data.id) : {};

  const chosen: { itemId: string; offer: Offer }[] = [];
  for (const item of req.data?.items ?? []) {
    const offer = offers.data?.find((o) => o.id === selection[item.id] && o.itemId === item.id);
    if (offer) chosen.push({ itemId: item.id, offer });
  }
  const itemsReady = !!req.data && chosen.length === req.data.items.length;
  // After "request changes" the requester may revise: choose offers again, then resubmit as a new revision.
  const revising = submitted?.decision === "changes_requested" && itemsReady && Object.keys(fromQuery).length > 0;
  const showStatus = !!submitted && !revising;

  // A revision starts from what was submitted last time, so only the requested change needs editing.
  const [prefilled, setPrefilled] = useState<number | null>(null);
  if (revising && submitted && prefilled !== submitted.revision) {
    setPrefilled(submitted.revision);
    if (!justification) setJustification(submitted.justification);
    // The amount field holds only extras (tax or shipping not in the listing), so carry over just those.
    const priorExtras = submitted.expenseCents - (submitted.researchSubtotalCents ?? 0) - (submitted.review?.cost.shippingCents ?? 0);
    if (!expense && submitted.researchSubtotalCents !== null && priorExtras > 0) setExpense((priorExtras / 100).toFixed(2));
  }
  const knownSubtotal = chosen.every((c) => c.offer.listedSubtotalCents !== null)
    ? chosen.reduce((s, c) => s + (c.offer.listedSubtotalCents ?? 0), 0)
    : null;
  const lines: ProposalLine[] = chosen.map(({ itemId, offer }) => {
    const item = req.data!.items.find((i) => i.id === itemId)!;
    return {
      itemId,
      itemName: item.name,
      offerId: offer.id,
      title: offer.title,
      seller: offer.seller,
      sourceUrl: offer.url || null,
      listedSubtotalCents: offer.listedSubtotalCents,
      quantityText: `${item.quantity} ${item.unit}`,
    };
  });
  const late = chosen.filter((c) => c.offer.deadlineFit === "misses" && req.data?.deadlineKind === "hard");
  // Must-haves the evidence left unconfirmed. They are never treated as met.
  const openMust = chosen.flatMap((c) => c.offer.findings.filter((f) => f.mandatory && f.status === "unknown" && f.requirementId));
  const extrasCents = expense.trim() ? parseDollarsToCents(expense) : 0;
  const enteredCents = extrasCents === null ? null : proposedCost(chosen.map((c) => c.offer), extrasCents);

  async function submit() {
    if (pending || !itemsReady) return;
    const next: Record<string, string> = {};
    const cents = enteredCents;
    if (!justification.trim()) next.justification = "Say why these offers are the right choice.";
    if (cents === null || cents <= 0) next.expense = "Enter a valid additional cost, or select a priced offer.";
    else if (knownSubtotal !== null && cents < knownSubtotal)
      next.expense = `This can't be less than the listed subtotal, ${formatCents(knownSubtotal)}.`;
    for (const f of openMust) {
      const r = resolutions[f.requirementId!];
      if (!r?.kind) next[`res-${f.requirementId}`] = "Choose whether you verified this or are making an exception.";
      else if ((r.note ?? "").trim().length < 12) next[`res-${f.requirementId}`] = r.kind === "verified" ? "Describe the source and what it confirmed (at least 12 characters)." : "Explain why this requirement can be waived (at least 12 characters).";
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    setApiError(null);
    try {
      await api.saveAndSubmitProposal(id, {
        selections: chosen.map((c) => ({ itemId: c.itemId, offerId: c.offer.id })),
        justification: justification.trim(),
        suitabilityConfirmed: true,
        expenseCents: cents as number,
        requirementResolutions: openMust.map((f) => ({
          requirementId: f.requirementId!,
          kind: resolutions[f.requirementId!]!.kind as "verified" | "exception",
          note: resolutions[f.requirementId!]!.note.trim(),
        })),
      });
      router.replace(`/requests/${id}/proposal`);
      await Promise.all([req.reload(), existing.reload()]); // a revision keeps the same proposal id
    } catch (e) {
      setApiError(normalizeError(e)); // inputs stay as typed
    } finally {
      setPending(false);
    }
  }

  return (
    <Page>
      <PageHeader
        title={showStatus ? "Proposal" : revising ? "Revise proposal" : "Proposal review"}
        back={{ href: `/requests/${id}`, label: "Request" }}
        amount={showStatus && submitted ? submitted.expenseCents : (enteredCents ?? 0)}
        amountLabel="Proposed total"
        amountNote={!showStatus ? "Listed cost + known shipping + any extras below" : undefined}
      >
        {req.data && (
          <div className="mt-4">
            <ProgressBar
              value={showStatus && submitted ? submitted.expenseCents : (enteredCents ?? 0)}
              max={req.data.budgetTotalCents}
              over={(showStatus && submitted ? submitted.expenseCents : (enteredCents ?? 0)) > req.data.budgetTotalCents}
            />
            <p className="mt-1.5 text-[13px] text-white/85">of {formatCents(req.data.budgetTotalCents)} budget ceiling</p>
          </div>
        )}
      </PageHeader>
      {loading && <Loading />}
      <ErrorNote error={req.error ?? offers.error} />

      {submitted && showStatus && (
        <>
          <Section title="Selected items">
            <Lines lines={submitted.lines} />
          </Section>
          <Section title="Cost summary">
            <dl>
              <KeyValue label="Listed items" value={formatCents(submitted.researchSubtotalCents)} />
              <KeyValue label="Listed shipping" value={formatCents(submitted.review?.cost.shippingCents ?? null)} />
              <KeyValue label="Budget limit" value={formatCents(submitted.budgetCeilingCents)} />
              <KeyValue label="Submitted total" value={formatCents(submitted.expenseCents)} />
            </dl>
            {submitted.researchSubtotalCents !== null && submitted.expenseCents > submitted.researchSubtotalCents + (submitted.review?.cost.shippingCents ?? 0) && <p className="mt-2 rounded-xl bg-orange-soft p-3 text-[14px]">Includes {formatCents(submitted.expenseCents - submitted.researchSubtotalCents - (submitted.review?.cost.shippingCents ?? 0))} beyond listed items and known shipping. This difference is requester-entered, not merchant-verified.</p>}
          </Section>
          <Section title="Status">
            <div className="mb-2">
              <DecisionRecord p={submitted} />
            </div>
            <dl>
              <KeyValue label="Purchase record" value={submitted.executionDetail ? <ExecutionStatusText status={submitted.executionDetail.status} /> : submitted.decision === "approved" ? "Recording not started" : "Not started"} />
              <KeyValue label="Revision" value={submitted.revision} />
              {submitted.submittedAt && <KeyValue label="Submitted" value={formatWhen(submitted.submittedAt)} />}
            </dl>
            {submitted.decision === "changes_requested" && (
              <div className="mt-3">
                <p className="mb-2 text-[14px] text-muted">
                  The executive asked for changes. Choose your offers again, adjust the amount or your case, and resubmit.
                  The earlier decision stays in the history and doesn&apos;t approve the new revision.
                </p>
                <Link href={`/requests/${id}`} className="touch text-[15px] font-medium text-accent">Revise and resubmit</Link>
              </div>
            )}
            {submitted.executionDetail?.kind === "transfer" && (
              <MoneyFlow d={submitted.executionDetail} onPaid={() => void existing.refresh()} />
            )}
            {submitted.executionDetail && (
              <div className="mt-3">
                <ExecutionAmounts d={submitted.executionDetail} />
                <ExecutionWarnings d={submitted.executionDetail} />
                <Link href={`/purchases/${submitted.executionDetail.id}`} className="mt-3 block text-[15px] font-medium text-accent">
                  View purchase record
                </Link>
              </div>
            )}
            {!submitted.executionDetail && submitted.decision === "awaiting_review" && (
              <p className="mt-3 text-[13px] text-muted">
                If approved, a simulated purchase is recorded in the Nessie sandbox. Nothing is ordered and no real money moves.
              </p>
            )}
            {submitted.requirementResolutions.length > 0 && (
              <>
                <h3 className="mb-1 mt-3 text-[15px] font-semibold">Your checks and exceptions</h3>
                <ul className="list-disc pl-5 text-[15px]">
                  {submitted.requirementResolutions.map((r) => (
                    <li key={r.requirement}>{r.requirement}: {r.kind === "verified" ? "verified by you" : "exception"} — {r.note}</li>
                  ))}
                </ul>
              </>
            )}
            {submitted.unresolved.length > 0 && (
              <details className="mt-3 rounded-xl border border-rule p-3">
                <summary className="cursor-pointer text-[14px] font-medium">Listing gaps ({submitted.unresolved.length})</summary>
                <ul className="list-disc pl-5 text-[16px]">{submitted.unresolved.map((u) => <li key={u}>{u}</li>)}</ul>
              </details>
            )}
          </Section>
          <Section title="Why this option"><p className="text-[16px]">{submitted.justification}</p></Section>
        </>
      )}

      {!showStatus && req.data && !loading && !itemsReady && (
        <p className="text-[14px] text-muted">Choose an offer for every item on the request page first.</p>
      )}

      {!showStatus && req.data && itemsReady && (
        <>
          {revising && submitted && (
            <Section title="Changes requested">
              <DecisionRecord p={submitted} />
              <p className="mt-2 text-[14px] text-muted">
                Your previous justification and any extra costs are filled in below. Edit what was asked, then resubmit as revision {submitted.revision + 1}.
              </p>
            </Section>
          )}
          <Section title="Selected items">
            <Lines lines={lines} />
            {late.length > 0 && (
              <p role="alert" className="mt-3 text-[14px] font-medium text-bad">
                {late.map((c) => c.offer.title).join(", ")} arrives after your hard deadline and doesn&apos;t meet the request as written.
              </p>
            )}
          </Section>
          {openMust.length > 0 && (
            <Section title="Check these requirements">
              <p className="mb-3 text-[14px] text-muted">
                We couldn&apos;t verify these from the listing. Add your source, allow an exception for approval, or go back and choose another option.
              </p>
              {openMust.map((f) => {
                const key = f.requirementId!;
                const r = resolutions[key] ?? { kind: "", note: "" };
                const set = (patch: Partial<typeof r>) => setResolutions((prev) => ({ ...prev, [key]: { ...r, ...patch } }));
                return (
                  <fieldset key={key} className="mb-4 rounded-xl border border-rule bg-raised p-4">
                    <legend className="text-[16px] font-medium">{f.requirement}</legend>
                    <p className="text-[13px] text-muted">{f.evidence}</p>
                    <div className="mt-2 flex flex-wrap gap-4 text-[15px]">
                      <label className="flex items-center gap-2">
                        <input type="radio" name={`res-${key}`} className="h-4 w-4 accent-[var(--accent)]" checked={r.kind === "verified"} onChange={() => set({ kind: "verified" })} />
                        I checked another source
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" name={`res-${key}`} className="h-4 w-4 accent-[var(--accent)]" checked={r.kind === "exception"} onChange={() => set({ kind: "exception" })} />
                        Ask to waive this requirement
                      </label>
                    </div>
                    {r.kind && (
                      <textarea rows={2} className={`${inputClass} mt-2`} value={r.note} aria-label={r.kind === "verified" ? "How you verified it" : "Why the exception is acceptable"}
                        placeholder={r.kind === "verified" ? "How you verified it (who, where, what they said)" : "Why proceeding without confirmation is acceptable"}
                        onChange={(e) => set({ note: e.target.value })} />
                    )}
                    {errors[`res-${key}`] && <p role="alert" className="mt-1.5 text-[13px] text-bad">{errors[`res-${key}`]}</p>}
                  </fieldset>
                );
              })}
            </Section>
          )}
          <Section title="Cost summary">
            <dl>
              <KeyValue label="Listed items" value={formatCents(knownSubtotal)} />
              <KeyValue label="Known shipping" value={chosen.some((c) => c.offer.shippingCents === null) ? "Not fully known" : formatCents(chosen.reduce((n, c) => n + (c.offer.shippingCents ?? 0), 0))} />
              <KeyValue label="Budget limit" value={formatCents(req.data.budgetTotalCents)} />
              <KeyValue label="Proposed total"
                value={enteredCents === null ? (expense ? "Invalid" : "Not entered") : formatCents(enteredCents)}
                note="Tax and unlisted shipping are excluded unless you add them below." />
            </dl>
            {enteredCents !== null && enteredCents > req.data.budgetTotalCents && (
              <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
                This is above the budget ceiling. The executive will see it, and approval can be refused.
              </p>
            )}
          </Section>
          <Section>
            <Field required label="Why this option?" htmlFor="justification" error={errors.justification}>
              <textarea id="justification" rows={2} className={inputClass} value={justification}
                onChange={(e) => setJustification(e.target.value)} aria-invalid={!!errors.justification}
                aria-describedby={errors.justification ? "justification-error" : undefined} />
            </Field>
            <Field label="Additional tax or shipping (USD)" htmlFor="expense" error={errors.expense}
              hint="Optional. Add only costs not already included above.">
              <input id="expense" inputMode="decimal" placeholder="0.00" className={inputClass} value={expense}
                onChange={(e) => setExpense(e.target.value)} aria-invalid={!!errors.expense}
                aria-describedby={errors.expense ? "expense-error" : undefined} />
            </Field>
            <p className="mb-4 text-[12px] text-muted">Submitting confirms you reviewed the selected items, total, and any exceptions. No real purchase is made.</p>
            <ErrorNote error={apiError} />
            <Button disabled={pending} onClick={submit}>{pending ? "Submitting…" : revising ? "Resubmit for approval" : "Submit for executive approval"}</Button>
          </Section>
        </>
      )}
    </Page>
  );
}
