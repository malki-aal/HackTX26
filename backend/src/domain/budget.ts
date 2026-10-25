// Budget context and assessment. Pure functions over a bank snapshot plus the local ledger.
//
// Invariant: availableBudget = reportedBalance - includedObligations - activeReservations - unreflectedExpenses
//   - A reservation is a hold for an approved-but-not-yet-recorded (or uncertain) execution.
//   - An expense is a sandbox purchase confirmed by Nessie. It is "unreflected" until a balance
//     drop that exactly matches it is observed, then "reflected" and no longer subtracted locally.
//   - Historical seed transactions are already inside the reported balance and are never in the ledger.
import type { BudgetAssessment, FinancialContext } from "./types.js";

export interface BillSnapshot {
  id: string;
  payee: string;
  status: string; // pending | recurring | completed | cancelled
  amountCents: number | null;
}

export interface BankSnapshot {
  accountId: string;
  balanceCents: number;
  fetchedAt: string;
  bills: BillSnapshot[];
  source: "nessie_live" | "nessie_cached" | "fixture";
}

export interface LedgerEntry {
  id: string;
  kind: "reservation" | "expense";
  amountCents: number;
  status: "active" | "released" | "converted" | "unreflected" | "reflected";
  createdAt: string;
  /** For expenses: the amount the bank actually recorded, when it differs (e.g. whole dollars). */
  providerAmountCents?: number | null;
}

export function obligationsFromBills(bills: BillSnapshot[]): FinancialContext["obligations"] {
  return bills.map((b) => {
    if (b.amountCents === null) return { id: b.id, payee: b.payee, status: b.status, amountCents: 0, included: false, reason: "Amount not parseable" };
    if (b.status === "pending" || b.status === "recurring") {
      return { id: b.id, payee: b.payee, status: b.status, amountCents: b.amountCents, included: true, reason: b.status === "recurring" ? "Next recurring payment not yet posted" : "Pending bill not yet posted" };
    }
    return { id: b.id, payee: b.payee, status: b.status, amountCents: b.amountCents, included: false, reason: b.status === "completed" ? "Already posted; included in balance" : "Cancelled" };
  });
}

export function computeFinancialContext(snapshot: BankSnapshot | null, ledger: LedgerEntry[], notes: string[] = []): FinancialContext {
  const activeReservationsCents = ledger.filter((l) => l.kind === "reservation" && l.status === "active").reduce((s, l) => s + l.amountCents, 0);
  const unreflectedExpensesCents = ledger.filter((l) => l.kind === "expense" && l.status === "unreflected").reduce((s, l) => s + l.amountCents, 0);
  if (!snapshot) {
    return {
      status: "bank_check_unavailable",
      accountId: null,
      source: "none",
      fetchedAt: null,
      reportedBalanceCents: null,
      obligations: [],
      obligationsCents: 0,
      activeReservationsCents,
      unreflectedExpensesCents,
      availableBudgetCents: null,
      reconciliationNotes: [...notes, "Bank context unavailable; research may proceed against the request budget, execution is blocked"],
    };
  }
  const obligations = obligationsFromBills(snapshot.bills);
  const obligationsCents = obligations.filter((o) => o.included).reduce((s, o) => s + o.amountCents, 0);
  return {
    status: snapshot.source === "fixture" ? "fixture" : "verified",
    accountId: snapshot.accountId,
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    reportedBalanceCents: snapshot.balanceCents,
    obligations,
    obligationsCents,
    activeReservationsCents,
    unreflectedExpensesCents,
    availableBudgetCents: snapshot.balanceCents - obligationsCents - activeReservationsCents - unreflectedExpensesCents,
    reconciliationNotes: notes,
  };
}

/**
 * Decide which unreflected expenses the remote balance now includes. Only an exact match between
 * the observed balance drop and a FIFO prefix of unreflected expenses marks them reflected; any
 * other change is reported and the expenses stay subtracted (conservative: never overspend).
 */
export function reconcileReflections(previousBalanceCents: number | null, currentBalanceCents: number, unreflected: LedgerEntry[]): { reflectedIds: string[]; notes: string[] } {
  if (previousBalanceCents === null) return { reflectedIds: [], notes: [] };
  const drop = previousBalanceCents - currentBalanceCents;
  if (drop === 0) {
    return { reflectedIds: [], notes: unreflected.length ? [`Remote balance unchanged; ${unreflected.length} recorded sandbox expense(s) still subtracted locally`] : [] };
  }
  const ordered = [...unreflected].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  let sum = 0;
  for (let i = 0; i < ordered.length; i++) {
    // The balance can only move by what the bank recorded, which may differ from the approved amount.
    sum += ordered[i]!.providerAmountCents ?? ordered[i]!.amountCents;
    if (sum === drop) {
      const ids = ordered.slice(0, i + 1).map((e) => e.id);
      return { reflectedIds: ids, notes: [`Remote balance dropped by exactly the amount of ${ids.length} recorded expense(s); no longer subtracted locally`] };
    }
  }
  return {
    reflectedIds: [],
    notes: [`Remote balance changed by ${-drop} cents, which does not match recorded expenses; keeping local expenses subtracted (conservative)`],
  };
}

export function assessBudget(input: {
  amountCents: number | null;
  amountBasis: BudgetAssessment["amountBasis"];
  requestBudgetCents: number;
  financial: FinancialContext;
}): BudgetAssessment {
  const { amountCents, amountBasis, requestBudgetCents, financial } = input;
  const notes: string[] = [];
  const available = financial.availableBudgetCents;
  if (amountCents === null) {
    return { status: "amount_unknown", amountCents, amountBasis, requestBudgetCents, availableBudgetCents: available, notes: ["Cost for the requested quantity is unknown"] };
  }
  if (amountCents > requestBudgetCents) {
    return { status: "exceeds_request_budget", amountCents, amountBasis, requestBudgetCents, availableBudgetCents: available, notes };
  }
  if (available === null) {
    notes.push("Bank account context unavailable; checked against the request budget only");
    return { status: "bank_check_unavailable", amountCents, amountBasis, requestBudgetCents, availableBudgetCents: null, notes };
  }
  if (amountCents > available) {
    notes.push("Amount exceeds available funds after obligations, reservations and recorded expenses");
    return { status: "exceeds_available_funds", amountCents, amountBasis, requestBudgetCents, availableBudgetCents: available, notes };
  }
  if (amountBasis !== "user_confirmed_exact") notes.push("Tax (and possibly shipping) unknown; affordability is provisional");
  return {
    status: amountBasis === "user_confirmed_exact" ? "within_budget" : "within_budget_provisional",
    amountCents,
    amountBasis,
    requestBudgetCents,
    availableBudgetCents: available,
    notes,
  };
}
