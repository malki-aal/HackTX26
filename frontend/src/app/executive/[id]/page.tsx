"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { api, type ApiError, type Budget, type Proposal } from "@/lib/api";
import { Avatar } from "@/components/avatars";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { newIdempotencyKey } from "@/lib/format";
import { DECISION_LABEL } from "@/lib/labels";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import {
  Button,
  ErrorNote,
  FindingMark,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  ProgressBar,
  SandboxNote,
  Section,
  formatWhen,
  inputClass,
  normalizeError,
  useLoad,
  usePolling,
} from "@/components/ui";

type Decision = "approve" | "request_changes" | "reject";

const DECISION_BUTTON: Record<Decision, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  reject: "Reject",
};

const TOTAL_STATUS: Record<string, string> = {
  price_unknown: "Price unknown",
  listed_subtotal_only: "Listed subtotal only. Shipping and tax are unknown.",
  subtotal_plus_shipping_tax_unknown: "Subtotal plus shipping. Tax is unknown.",
};

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
  const [notice, setNotice] = useState<string | null>(null);
  const p = prop.data;

  // Notice a new revision, a decision by someone else or an execution update. Read-only.
  const watching = !!p && (p.decision === "awaiting_review" || p.execution === "queued" || p.execution === "submitting");
  usePolling(prop.refresh, 5000, watching);

  const awaiting = p?.decision === "awaiting_review";

  return (
    <Page>
      <PageHeader
        title={p?.requestTitle ?? "Proposal"}
        back={{ href: "/executive", label: "Approvals" }}
        amount={p ? p.expenseCents : undefined}
        amountLabel={p ? `Requested expense · revision ${p.revision}` : undefined}
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

      {p && <ReviewSections p={p} />}

      {p && awaiting && (
        <>
          {notice && (
            <p role="alert" className="mb-4 rounded-xl bg-orange-soft p-3 text-[14px] font-medium text-warn">{notice}</p>
          )}
          <DecisionStep
            key={`${p.id}|${p.revision}|${p.expenseCents}`}
            p={p}
            budget={budget.data}
            budgetError={budget.error}
            refreshBudget={budget.refresh}
            onDecided={(next) => {
              setNotice(null);
              prop.setData(next);
              void budget.refresh();
            }}
            onConflict={() => {
              setNotice("This proposal changed while you were reviewing it. Review the latest version before deciding.");
              void prop.refresh();
            }}
          />
        </>
      )}

      {p && !awaiting && <Outcome p={p} reload={prop.refresh} />}
    </Page>
  );
}

// ---------- the proposal as submitted ----------

function ReviewSections({ p }: { p: Proposal }) {
  const r = p.review;
  return (
    <>
      <Section title="Request">
        <dl>
          <KeyValue label="Requested by" value={<span className="inline-flex items-center gap-2"><Avatar role="employee" size={24} />{p.requester}</span>} note="A demo role, not an account." />
          {p.submittedAt && <KeyValue label="Submitted" value={formatWhen(p.submittedAt)} />}
          <KeyValue label="Revision" value={p.revision} />
        </dl>
        {r?.purpose && <p className="mt-2 text-[16px]">{r.purpose}</p>}
        {r && r.requirements.length > 0 && (
          <>
            <h3 className="mb-1 mt-3 text-[15px] font-semibold">Requirements</h3>
            <ul className="list-disc pl-5 text-[16px]">
              {r.requirements.map((x) => (
                <li key={x.label}>
                  {x.label}
                  {!x.mandatory && <span className="text-muted"> (nice to have)</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Selected offer">
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
                <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="touch text-[14px] font-medium text-accent">
                  Source listing
                </a>
              )}
            </li>
          ))}
        </ul>
        {r?.observedAt && (
          <p className="mt-2 text-[13px] text-muted">
            Observed {formatWhen(r.observedAt)}
            {r.expiresAt && `, fresh until ${formatWhen(r.expiresAt)}`}
            {r.fromCache && ". Reused from an earlier search"}.
          </p>
        )}
        {r?.stale && (
          <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
            This offer is out of date. Approval will be refused until research is run again.
          </p>
        )}
      </Section>

      {r && r.findings.length > 0 && (
        <Section title="Requirements and evidence">
          <ul className="divide-y divide-rule">
            {r.findings.map((f) => (
              <li key={f.requirement} className="py-2.5 first:pt-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px]">{f.requirement}</span>
                  <FindingMark status={f.status} />
                </div>
                <p className="mt-0.5 text-[13px] text-muted">{f.evidence}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] text-muted">Evidence comes from the listing, not from the manufacturer.</p>
        </Section>
      )}

      <Section title="Cost">
        <dl>
          {r && <KeyValue label="Unit price" value={r.cost.unitPriceCents === null ? "Unknown" : formatCents(r.cost.unitPriceCents)} />}
          {r && r.cost.packagesRequired !== null && <KeyValue label="Quantity" value={r.cost.packagesRequired} />}
          <KeyValue label="Listed subtotal" value={formatCents(p.researchSubtotalCents)} />
          {r && <KeyValue label="Shipping" value={r.cost.shippingCents === null ? "Unknown" : formatCents(r.cost.shippingCents)} />}
          <KeyValue label="Tax" value="Unknown" />
          <KeyValue label="Request budget ceiling" value={formatCents(p.budgetCeilingCents)} />
          <KeyValue
            label="Exact proposed expense"
            value={formatCents(p.expenseCents)}
            note="Confirmed by the requester, not verified at a merchant checkout."
          />
        </dl>
        {r && <p className="mt-1 text-[13px] text-muted">{TOTAL_STATUS[r.cost.totalStatus] ?? ""}</p>}
        {p.unresolved.length > 0 && (
          <>
            <h3 className="mb-1 mt-3 text-[15px] font-semibold">Still unresolved</h3>
            <ul className="list-disc pl-5 text-[16px]">{p.unresolved.map((u) => <li key={u}>{u}</li>)}</ul>
          </>
        )}
      </Section>

      {r && r.alternatives.length > 0 && (
        <Section title="Alternatives considered">
          <ul>
            {r.alternatives.map((a) => (
              <li key={a.title} className="border-t border-rule py-2.5 first:border-t-0 first:pt-0">
                <p className="text-[16px]">{a.title}</p>
                <p className="text-[13px] text-muted">
                  {a.seller ?? "Unknown seller"} · {a.eligibility.replace("_", " ")}
                  {a.costCents !== null && ` · ${formatCents(a.costCents)}`}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Requester’s case">
        <p className="text-[16px]">{p.justification || "No justification given."}</p>
        <p className="mt-2 text-[14px]">
          {p.suitabilityConfirmed
            ? "The requester confirmed they reviewed technical suitability. That is their review, not a certification."
            : "Technical suitability was not confirmed."}
        </p>
      </Section>

      {r && (r.revisions.length > 1 || r.history.length > 0) && (
        <Section title="History">
          <ul>
            {r.revisions.map((v) => (
              <li key={`rev-${v.version}`} className="py-1 text-[14px]">
                Revision {v.version} submitted{v.submittedAt ? ` ${formatWhen(v.submittedAt)}` : ""}
                {v.exactAmountCents !== null && ` for ${formatCents(v.exactAmountCents)}`}
              </li>
            ))}
            {r.history.map((h) => (
              <li key={`dec-${h.at}`} className="py-1 text-[14px]">
                {h.decision.replace("_", " ")} on revision {h.version} by {h.actor}, {formatWhen(h.at)}
                {h.note && <span className="text-muted"> — “{h.note}”</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ---------- decision ----------

function DecisionStep({
  p,
  budget,
  budgetError,
  refreshBudget,
  onDecided,
  onConflict,
}: {
  p: Proposal;
  budget: Budget | null;
  budgetError: ApiError | null;
  refreshBudget: () => Promise<void>;
  onDecided: (p: Proposal) => void;
  onConflict: () => void;
}) {
  // Everything here resets when the revision or amount changes, because the parent re-keys this step.
  const [choice, setChoice] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false); // never checked by default
  const [needsAck, setNeedsAck] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [mapping, setMapping] = useState<{ seller: string } | null>(null);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);
  // One key per logical decision; a retry with the same decision, note and amount reuses it.
  const keyRef = useRef<{ sig: string; key: string } | null>(null);

  const amount = formatCents(p.expenseCents);
  const available = budget?.availableCents ?? null;
  const projected = available === null ? null : available - p.expenseCents;

  function choose(d: Decision) {
    setChoice(d);
    setError(null);
    setMapping(null);
    setLinked(null);
    setNeedsAck(false);
    void refreshBudget(); // read-only bank check so the numbers below are current
  }

  async function submit() {
    if (!choice || pending) return;
    if (choice === "approve" && !ack) {
      setNeedsAck(true);
      document.getElementById("approve-ack")?.focus();
      return;
    }
    const sig = `${p.id}|${p.revision}|${p.expenseCents}|${choice}|${note}`;
    if (keyRef.current?.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };
    setPending(true);
    setError(null);
    try {
      const next = await api.decide({
        proposalId: p.id,
        version: p.revision,
        decision: choice,
        note: note.trim(),
        exactAmountCents: p.expenseCents,
        idempotencyKey: keyRef.current.key,
      });
      onDecided(next);
    } catch (e) {
      const err = normalizeError(e);
      if (err.code === "VERSION_CONFLICT" || err.code === "TERMS_CHANGED") onConflict();
      else if (err.code === "MERCHANT_MAPPING_REQUIRED") setMapping({ seller: p.lines[0]?.seller ?? "this seller" });
      else setError(err);
    } finally {
      setPending(false);
    }
  }

  async function link() {
    if (!mapping || linking) return;
    setLinking(true);
    setError(null);
    try {
      const m = await api.createMerchantMapping(mapping.seller);
      setLinked(`${m.merchantName ?? "Sandbox merchant"} (${m.nessieMerchantId})`);
      setMapping(null);
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setLinking(false);
    }
  }

  if (!choice) {
    return (
      <Section title="Decision">
        <p className="mb-4 text-[14px] text-muted">
          Review the proposal above, then choose. Nothing happens until you confirm on the next step.
        </p>
        <div className="space-y-3">
          <Button onClick={() => choose("approve")}>Approve</Button>
          <Button variant="quiet" onClick={() => choose("request_changes")}>Request changes</Button>
          <Button variant="quiet" onClick={() => choose("reject")}>Reject</Button>
        </div>
      </Section>
    );
  }

  const label = DECISION_BUTTON[choice];
  return (
    <Section title={`Confirm: ${label.toLowerCase()}`}>
      <dl>
        <KeyValue label="Proposal" value={p.requestTitle} />
        <KeyValue label="Revision" value={p.revision} />
        <KeyValue label="Exact purchase amount" value={amount} />
        {choice === "approve" && (
          <>
            <KeyValue
              label="Available budget now"
              value={available === null ? "Unknown" : formatCents(available)}
              note={
                budget
                  ? budget.fetchedAt
                    ? `${budget.source}, checked ${formatWhen(budget.fetchedAt)}`
                    : budget.source
                  : budgetError
                    ? "The budget couldn’t be read."
                    : "Checking…"
              }
            />
            <KeyValue
              label="Projected available after approval"
              value={projected === null ? "Unknown" : formatCents(projected)}
              note="An estimate. The backend rechecks the budget and the offer when you approve."
            />
          </>
        )}
      </dl>
      {choice === "approve" && budget?.status === "bank_check_unavailable" && (
        <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
          The bank check is unavailable. Approval can’t be completed until it works again.
        </p>
      )}
      {choice === "approve" && projected !== null && projected < 0 && (
        <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
          This is more than the available budget, so the approval will be refused.
        </p>
      )}
      {choice === "approve" && (
        <p className="mt-2 text-[13px] text-muted">
          This is the available company budget, not the bank balance. Nessie’s reported balance may not change right away.
        </p>
      )}

      <div className="mt-4">
        <label htmlFor="decision-note" className="mb-1.5 block text-[15px] font-medium">Note (optional)</label>
        <textarea id="decision-note" rows={3} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        <p className="mt-1 text-[13px] text-muted">The requester will see this note.</p>
      </div>

      {choice === "approve" && (
        <label className="mt-4 flex items-start gap-3 text-[16px]">
          <input
            id="approve-ack"
            type="checkbox"
            className="mt-1 h-5 w-5 accent-[var(--accent)]"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            aria-describedby={needsAck && !ack ? "approve-ack-error" : undefined}
          />
          <span>
            I approve this simulated purchase for {amount} and understand that it commits this amount from the available company budget.
          </span>
        </label>
      )}
      {needsAck && !ack && (
        <p id="approve-ack-error" role="alert" className="mt-2 text-[13px] text-bad">Tick the box to approve.</p>
      )}

      {mapping && (
        <div role="alert" className="mt-4 rounded-xl bg-orange-soft p-3 text-[14px]">
          <p className="font-medium text-warn">No Nessie sandbox merchant is linked to {mapping.seller}.</p>
          <p className="mt-1 text-ink">
            Approval needs one so the simulated purchase is booked against the right sandbox record. Nothing has been reserved.
          </p>
          <div className="mt-3">
            <Button variant="quiet" disabled={linking} onClick={link}>
              {linking ? "Linking…" : `Create a sandbox merchant for ${mapping.seller}`}
            </Button>
          </div>
        </div>
      )}
      {linked && (
        <p className="mt-4 text-[14px] text-ok">Linked to {linked}. Confirm again to {label.toLowerCase()}.</p>
      )}
      <ErrorNote error={error} />

      <div className="mt-4 space-y-3">
        <Button disabled={pending} onClick={submit}>
          {pending ? "Working…" : choice === "approve" ? `Approve ${amount}` : choice === "reject" ? "Reject proposal" : "Send back for changes"}
        </Button>
        <Button variant="quiet" disabled={pending} onClick={() => setChoice(null)}>Back</Button>
      </div>
    </Section>
  );
}

// ---------- after a decision ----------

function Outcome({ p, reload }: { p: Proposal; reload: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ex = p.executionDetail;

  async function check() {
    if (!ex || checking) return;
    setChecking(true);
    setError(null);
    try {
      await api.reconcile(ex.id, "check");
      await reload();
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Section title="Outcome">
      <dl>
        <KeyValue label="Decision" value={DECISION_LABEL[p.decision]} />
        <KeyValue label="Purchase record" value={ex ? <ExecutionStatusText status={ex.status} /> : "Not started"} />
      </dl>
      {p.decisionNote && <p className="mt-2 text-[16px]"><span className="text-muted">Note: </span>{p.decisionNote}</p>}
      {ex && (
        <div className="mt-3">
          <ExecutionAmounts d={ex} />
          <ExecutionWarnings d={ex} />
          {(ex.status === "uncertain" || ex.status === "queued" || ex.status === "submitting") && (
            <div className="mt-3">
              <ErrorNote error={error} />
              <Button variant="quiet" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check status"}</Button>
              <p className="mt-1.5 text-[13px] text-muted">This only looks up the result. It never sends the purchase again.</p>
            </div>
          )}
          <Link href={`/purchases/${ex.id}`} className="touch mt-2 text-[15px] font-medium text-accent">View purchase record</Link>
        </div>
      )}
      <SandboxNote />
    </Section>
  );
}
