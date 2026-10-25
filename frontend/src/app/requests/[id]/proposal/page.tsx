"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type ApiError, type Offer, type Proposal, type ProposalLine } from "@/lib/api";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { DecisionBadge, DecisionRecord } from "@/components/review";
import { formatCents, isSafeHttpUrl, parseDollarsToCents } from "@/lib/money";
import { parseSelectionQuery, readSelection } from "@/lib/selection";
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
  const [suitable, setSuitable] = useState(false);
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
    if (!expense) setExpense((submitted.expenseCents / 100).toFixed(2));
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

  async function submit() {
    if (pending || !itemsReady) return;
    const next: Record<string, string> = {};
    const cents = parseDollarsToCents(expense);
    if (!justification.trim()) next.justification = "Say why these offers are the right choice.";
    if (cents === null || cents <= 0) next.expense = "Enter the exact total you will pay, in dollars.";
    else if (knownSubtotal !== null && cents < knownSubtotal)
      next.expense = `This can't be less than the listed subtotal, ${formatCents(knownSubtotal)}.`;
    if (!suitable) next.suitable = "Confirm that you reviewed technical suitability.";
    for (const f of openMust) {
      const r = resolutions[f.requirementId!];
      if (!r?.kind) next[`res-${f.requirementId}`] = "Choose whether you verified this or are making an exception.";
      else if ((r.note ?? "").trim().length < 3) next[`res-${f.requirementId}`] = r.kind === "verified" ? "Say how you verified it." : "Say why the exception is acceptable.";
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

  const enteredCents = parseDollarsToCents(expense);

  return (
    <Page>
      <PageHeader
        title={showStatus ? "Proposal" : revising ? "Revise proposal" : "Proposal review"}
        back={{ href: `/requests/${id}`, label: "Request" }}
        amount={showStatus && submitted ? submitted.expenseCents : (enteredCents ?? 0)}
        amountLabel={showStatus ? "Simulated expense to record" : "Exact total to record"}
        amountNote={!showStatus && enteredCents === null ? (expense ? "That isn’t a valid amount" : "Enter it below") : undefined}
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
          <Section title="Amounts">
            <dl>
              <KeyValue label="Research subtotal" value={formatCents(submitted.researchSubtotalCents)}
                note="Listed prices only. Shipping and tax may be missing." />
              <KeyValue label="Request budget ceiling" value={formatCents(submitted.budgetCeilingCents)} note="The most this request asked to spend. Not an approval." />
              <KeyValue label="Simulated expense to record" value={formatCents(submitted.expenseCents)}
                note="Confirmed by the requester. Not verified at a merchant checkout." />
            </dl>
          </Section>
          <Section title="Status">
            <div className="mb-2">
              {submitted.approval ? <DecisionRecord p={submitted} /> : <DecisionBadge decision={submitted.decision} />}
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
                <h3 className="mb-1 mt-3 text-[15px] font-semibold">Must-haves you verified or excepted</h3>
                <ul className="list-disc pl-5 text-[15px]">
                  {submitted.requirementResolutions.map((r) => (
                    <li key={r.requirement}>{r.requirement}: {r.kind === "verified" ? "verified by you" : "exception"} — {r.note}</li>
                  ))}
                </ul>
              </>
            )}
            {submitted.unresolved.length > 0 && (
              <>
                <h3 className="mb-1 mt-3 text-[15px] font-semibold">Still unresolved</h3>
                <ul className="list-disc pl-5 text-[16px]">{submitted.unresolved.map((u) => <li key={u}>{u}</li>)}</ul>
              </>
            )}
            <p className="mt-3 text-[16px]">{submitted.justification}</p>
          </Section>
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
                Your previous justification and amount are filled in below. Edit what was asked, then resubmit as revision {submitted.revision + 1}.
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
            <Section title="Unconfirmed must-haves">
              <p className="mb-3 text-[14px] text-muted">
                The listing evidence doesn&apos;t confirm these. They aren&apos;t treated as met. For each, either say how you
                verified it (for example with the seller), or record a deliberate exception. The executive sees both.
              </p>
              {openMust.map((f) => {
                const key = f.requirementId!;
                const r = resolutions[key] ?? { kind: "", note: "" };
                const set = (patch: Partial<typeof r>) => setResolutions((prev) => ({ ...prev, [key]: { ...r, ...patch } }));
                return (
                  <fieldset key={key} className="mb-4 border-t border-rule pt-3 first:border-t-0 first:pt-0">
                    <legend className="text-[16px] font-medium">{f.requirement}</legend>
                    <p className="text-[13px] text-muted">{f.evidence}</p>
                    <div className="mt-2 flex flex-wrap gap-4 text-[15px]">
                      <label className="flex items-center gap-2">
                        <input type="radio" name={`res-${key}`} className="h-4 w-4 accent-[var(--accent)]" checked={r.kind === "verified"} onChange={() => set({ kind: "verified" })} />
                        I verified it
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" name={`res-${key}`} className="h-4 w-4 accent-[var(--accent)]" checked={r.kind === "exception"} onChange={() => set({ kind: "exception" })} />
                        Proceed as an exception
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
          <Section title="Three different amounts">
            <dl>
              <KeyValue label="Research subtotal" value={formatCents(knownSubtotal)}
                note="Listed prices only. Shipping and tax may be missing." />
              <KeyValue label="Request budget ceiling" value={formatCents(req.data.budgetTotalCents)} note="The most this request asked to spend. Not an approval." />
              <KeyValue label="Simulated expense to record"
                value={enteredCents === null ? (expense ? "Invalid" : "Not entered") : formatCents(enteredCents)}
                note="Confirmed by you. Not verified at a merchant checkout." />
            </dl>
            {enteredCents !== null && enteredCents > req.data.budgetTotalCents && (
              <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
                This is above the budget ceiling. The executive will see it, and approval can be refused.
              </p>
            )}
          </Section>
          <Section>
            <Field required label="Justification" htmlFor="justification" error={errors.justification}>
              <textarea id="justification" rows={4} className={inputClass} value={justification}
                onChange={(e) => setJustification(e.target.value)} aria-invalid={!!errors.justification}
                aria-describedby={errors.justification ? "justification-error" : undefined} />
            </Field>
            <Field required label="Exact total to record (USD)" htmlFor="expense" error={errors.expense}
              hint="Shipping and tax are unknown in the listings, so enter the exact total you confirmed.">
              <input id="expense" inputMode="decimal" className={inputClass} value={expense}
                onChange={(e) => setExpense(e.target.value)} aria-invalid={!!errors.expense}
                aria-describedby={errors.expense ? "expense-error" : undefined} />
            </Field>
            <div className="mb-5">
              <label className="flex items-start gap-3 text-[16px]">
                <input type="checkbox" className="mt-1 h-5 w-5 accent-[var(--accent)]" checked={suitable}
                  onChange={(e) => setSuitable(e.target.checked)} />
                <span>I reviewed these offers and they are technically suitable for the purpose. This is my review, not an AI certification.</span>
              </label>
              {errors.suitable && <p role="alert" className="mt-1.5 text-[13px] text-bad">{errors.suitable}</p>}
            </div>
            <ErrorNote error={apiError} />
            <Button disabled={pending} onClick={submit}>{pending ? "Submitting…" : revising ? "Resubmit for approval" : "Submit for executive approval"}</Button>
          </Section>
        </>
      )}
    </Page>
  );
}
