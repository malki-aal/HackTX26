"use client";

import type { ExecutionDetail } from "@/lib/api";
import { EXECUTION_LABEL } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import { KeyValue } from "@/components/ui";

const TONE: Record<ExecutionDetail["status"], string> = {
  not_started: "text-ink",
  queued: "text-ink",
  submitting: "text-ink",
  recorded: "text-ok",
  failed: "text-bad",
  uncertain: "text-bad",
};

/** Execution state in words, never colour alone. Only `recorded` reads as success. */
export function ExecutionStatusText({ status }: { status: ExecutionDetail["status"] }) {
  return <span className={`font-medium ${TONE[status]}`}>{EXECUTION_LABEL[status]}</span>;
}

export function amountsDiffer(d: ExecutionDetail): boolean {
  return d.providerAmountCents !== null && d.providerAmountCents !== d.amountCents;
}

/** Approved amount and the amount Nessie stored, kept apart, with an explicit discrepancy state. */
export function ExecutionAmounts({ d }: { d: ExecutionDetail }) {
  const differs = amountsDiffer(d);
  return (
    <dl>
      <KeyValue label="Approved amount" value={formatCents(d.amountCents)} note="Confirmed by the requester, approved by the executive" />
      <KeyValue
        label="Stored in Nessie"
        value={d.providerAmountCents === null ? "Not read back" : formatCents(d.providerAmountCents)}
        note={d.providerAmountCents === null ? "Nessie has not confirmed an amount." : "Read back from Nessie"}
      />
      {differs && (
        <KeyValue
          label="Amounts differ"
          value={formatCents(Math.abs(d.amountCents - (d.providerAmountCents ?? 0)))}
          note={d.amountNote ?? "The stored amount is not the approved amount."}
        />
      )}
    </dl>
  );
}

export function ExecutionWarnings({ d }: { d: ExecutionDetail }) {
  return (
    <>
      {d.status === "uncertain" && (
        <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
          Whether this was recorded is uncertain. Don&apos;t treat it as complete. It needs to be checked, not resent.
        </p>
      )}
      {d.status === "failed" && (
        <p role="alert" className="mt-2 text-[14px] font-medium text-bad">The purchase was not recorded.</p>
      )}
      {d.lastError && <p className="mt-1 text-[13px] text-bad">{d.lastError}</p>}
    </>
  );
}
