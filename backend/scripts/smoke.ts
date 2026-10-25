// Acceptance client for a running server: drives request -> research -> proposal, and with
// --approve also records ONE sandbox purchase through the executive decision endpoint.
//   npm run smoke                      # research + proposal only
//   npm run smoke -- --approve         # also approve (live Nessie sandbox write in live mode)
//   npm run smoke -- --approve --amount-cents=89996
const base = process.env.RUNWAY_URL ?? "http://127.0.0.1:8000/api/v1";
const args = new Set(process.argv.slice(2));
const amountArg = process.argv.find((a) => a.startsWith("--amount-cents="))?.split("=")[1];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as { data?: any; error?: any; meta?: any };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.error)}`);
  return json;
}
const usd = (c: number | null) => (c === null ? "unknown" : `$${(c / 100).toFixed(2)}`);

const health = await api("GET", "/health");
console.log(`mode=${health.meta.mode} health=${health.data.status}`);
console.log("integrations:", (await api("GET", "/integrations/status")).data.map((s: any) => `${s.service}:${s.state}`).join(" "));

const created = await api("POST", "/requests", {
  title: "Four engineering monitors (Runway acceptance)",
  description: "Find four new 27-inch monitors, at least 1440p, HDMI required.",
  category: "monitors",
  quantity: 4,
  currency: "USD",
  budgetCents: 100000,
  budgetBasis: "total",
  allowedCondition: "new",
});
let req = created.data;
console.log(`request ${req.id} v${req.version} status=${req.status} model-extraction=${created.data.extraction?.model}`);
if (req.unansweredQuestionIds.length) {
  const answers = req.questions.filter((q: any) => q.answer === null).map((q: any) => ({ questionId: q.id, value: q.options[0]?.value ?? "no preference" }));
  req = (await api("POST", `/requests/${req.id}/clarify`, { expectedVersion: req.version, answers })).data;
}
req = (await api("POST", `/requests/${req.id}/confirm`, { version: req.version })).data;
const started = await api("POST", `/requests/${req.id}/research`, { version: req.version });
const runId = started.data.runId;
console.log(`run ${runId} queued`);
let run: any;
let cursor = "";
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const ev = await api("GET", `/runs/${runId}/events${cursor ? `?after=${cursor}` : ""}`);
  for (const e of ev.data) console.log(`  [${e.type}] ${e.summary}`);
  cursor = ev.meta.nextCursor ?? cursor;
  run = (await api("GET", `/runs/${runId}`)).data;
  if (!["queued", "running"].includes(run.status)) break;
}
console.log(`run status=${run.status} outcome=${run.outcome} searches=${run.limits.searchCallsUsed} steps=${run.limits.agentSteps} runtime=${run.agentSummary?.runtime?.runtime}`);
if (run.status !== "completed") process.exit(1);
const cands = (await api("GET", `/requests/${req.id}/candidates?runId=${runId}`)).data;
for (const c of cands.candidates.slice(0, 5)) console.log(`  #${c.rank} [${c.eligibility}] ${c.title.slice(0, 70)} | ${c.seller} | unit ${usd(c.unitPriceCents)} | ${usd(c.knownComparableCostCents)} (${c.totalStatus}) | observed ${c.observedAt}`);
if (cands.agentExplanation) console.log(`agent explanation (${cands.agentExplanation.offerId}): ${cands.agentExplanation.text}`);
const top = cands.candidates.find((c: any) => c.eligibility === "eligible");
if (!top) {
  console.log("No eligible candidate: no confirmed match. Stopping before proposal.");
  process.exit(0);
}
const proposal = (await api("POST", `/requests/${req.id}/proposals`, { runId, offerId: top.offerId, justification: "Lowest known eligible cost (acceptance run)" })).data;
const amount = amountArg ? Number(amountArg) : top.knownComparableCostCents;
const submitted = (await api("POST", `/proposals/${proposal.id}/submit`, { version: proposal.version, technicalReviewConfirmed: true, exactAmountCents: amount })).data;
console.log(`proposal ${submitted.id} submitted for ${usd(amount)} (amount source: user_confirmed by the operator running this script); budget=${submitted.budgetAssessment.status}`);
if (!args.has("--approve")) {
  console.log("Not approving (pass --approve to record one sandbox purchase).");
  process.exit(0);
}
const key = `smoke-${proposal.id}-v${proposal.version}`;
const decided = (await api("POST", `/proposals/${proposal.id}/decision`, { version: proposal.version, decision: "approve", actor: "executive-demo", note: "Acceptance run" }, { "idempotency-key": key })).data;
const exe = decided.execution;
console.log(`execution ${exe.id} status=${exe.status} providerStatus=${exe.providerStatus} external=${JSON.stringify(exe.externalReference)}`);
const replay = (await api("POST", `/proposals/${proposal.id}/decision`, { version: proposal.version, decision: "approve", actor: "executive-demo", note: "Acceptance run" }, { "idempotency-key": key })).data;
console.log(`idempotent replay returns same execution: ${replay.execution.id === exe.id}`);
const rec = (await api("POST", `/executions/${exe.id}/reconcile`, { action: "check" })).data;
console.log(`read-back: status=${rec.status} providerStatus=${rec.providerStatus} providerAmountRaw=${JSON.stringify(rec.providerAmountRaw)} notes=${JSON.stringify(rec.reconciliationNotes)}`);
const budget = (await api("GET", "/budget?refresh=true")).data;
console.log(`budget: reported balance ${usd(budget.reportedBalanceCents)}, obligations ${usd(budget.obligationsCents)}, unreflected expenses ${usd(budget.unreflectedExpensesCents)}, available ${usd(budget.availableBudgetCents)}; notes ${JSON.stringify(budget.reconciliationNotes)}`);
