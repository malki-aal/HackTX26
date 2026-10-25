# Frontend integration guide

> **v2 changes:** read [CONTRACT_V2.md](CONTRACT_V2.md) first. It covers item categories instead of monitors only, deadline types, recommendations, projects, merchant mappings, confirmation records and activity. Everything below still applies.

- **Base URL:** `http://127.0.0.1:8000/api/v1`. For testing on a phone, set `HOST=0.0.0.0` (or your LAN IP) and add the frontend origin to `FRONTEND_ORIGINS`. Use this only on a trusted network, because there is no authentication.
- **CORS:** only origins listed in `FRONTEND_ORIGINS` are allowed (default `http://localhost:3000,http://localhost:3001`). Allowed headers are `content-type` and `idempotency-key`.
- **Contract:** `docs/openapi.json`, plus the Zod schemas and types in `src/contracts/` (`import * as C from "<backend>/src/contracts/index.js"`).

## Conventions

- Every success response is `{ "data": ..., "meta": { "mode": "live"|"fixtures", "demoIdentity": true, "requestId": "trace_…", "nextCursor"?: string|null } }`.
- Every error response is `{ "error": { "code", "message", "retryable", "requestId", "details" } }`.
- All money is in integer USD cents (`*Cents`). Timestamps are ISO-8601 UTC. Ids are opaque strings. Unknown values are explicit `null`s, and status fields say why they are unknown.
- HTTP statuses: 422 for validation errors, 404 for missing resources, 409 for stale or conflicting state, 202 for queued research, 503 when the bank check is unavailable, and 429/502/504 for upstream failures.

## Happy path (employee)

1. `POST /requests` with `{title, description, quantity, unit?, currency:"USD", budgetCents, budgetBasis?, allowedCondition?, deadline?, deadlineType?, agentConfigId?}`. `category` is optional; the backend resolves it and asks (`q_category`) if unclear. The response contains `status`, `version`, `requirements[]` (structured predicates), `questions[]` and `unansweredQuestionIds[]`.
2. If there are questions, call `POST /requests/:id/clarify` with `{expectedVersion, answers:[{questionId, value}]}`. Each answer must be one of that question's `options[].value`. The response is the new version.
3. To change requirements, call `PATCH /requests/:id` with `{expectedVersion, ...fields, requirements?}`. Material edits need confirming again.
4. `POST /requests/:id/confirm` with `{version}`. This is required before any paid research.
5. `POST /requests/:id/research` with `{version, agentConfigId?}` returns 202 with `{runId, status:"queued"}`.
6. Poll `GET /runs/:runId` every 1–2 seconds until `status` is `completed`, `failed` or `cancelled`. For a live activity feed, use `GET /runs/:runId/events?after=<meta.nextCursor>`. `POST /runs/:id/cancel` stops a run.
7. `GET /requests/:id/candidates?runId=` returns the mobile card data. Each card has `rank`, `eligibility`, `title`, `imageUrl`, `seller`, `sourceUrl`, `unitPriceCents`, `listedSubtotalCents`, `knownComparableCostCents`, `totalStatus`, `requirementChecks[]` (`state`: supported/contradicted/unknown, plus `reason` and `evidenceIds`), `evidence[]` (with excerpts), `unknowns[]`, `recommendationReason`, `observedAt`, `expiresAt`, `stale` and `fromCache`. `agentExplanation` is the model's text, labeled `model_explanation`.
   - Evidence `source` is `serpapi_google_shopping` (listing text) or `serpapi_immersive_product` (product spec page, fetched by the agent for promising candidates). A `details_fetched` event appears when product specs are fetched, and `run.limits.detailCallsUsed` counts them.
   - Check `run.outcome`: `candidates_found`, `no_confirmed_match` (a valid result: show the near misses) or `no_results`.
8. `POST /requests/:id/proposals` with `{runId, offerId, justification, alternativeOfferIds?}` saves a draft with `needsConfirmation: true`. Rejected candidates return 422.
9. `POST /proposals/:id/submit` with `{version, technicalReviewConfirmed:true, exactAmountCents}`. The exact amount is the user-confirmed checkout total including tax and shipping. It is stored as `amountSource: "user_confirmed"`.

## Executive screen

- Before approving, the researched seller must be mapped to a Nessie sandbox merchant: `POST /merchant-mappings` (executive-demo). An approval without a mapping returns `MERCHANT_MAPPING_REQUIRED`.
- `GET /activity` groups proposals by where they are waiting. `GET /proposals/:id/confirmation` returns the full persisted confirmation record.
- `GET /proposals?decisionState=awaiting_review` lists proposals waiting for a decision. `GET /proposals/:id` returns the full detail: `amounts`, which separates the research subtotal, the budget ceiling and the exact amount; `budgetAssessment`; `unresolved[]`; `offerStale`; `decisions[]`; and `execution`.
- `POST /proposals/:id/decision` takes header `Idempotency-Key: <uuid>` and body `{version, decision: "approve"|"request_changes"|"reject", actor:"executive-demo", note?}`.
  - Generate one key per button press and reuse it on retries. The same key with the same body returns the same result. The same key with a different body returns `IDEMPOTENCY_CONFLICT`.
  - Approval errors you should handle: `OFFER_STALE` (rerun research), `BANK_CHECK_UNAVAILABLE` (retryable), `BUDGET_EXCEEDED`, `VERSION_CONFLICT` and `INVALID_STATE` (already decided).
  - An approval response includes `execution`. `status` is one of `recorded`, `failed` or `uncertain`. `externalReference.purchaseId` is the Nessie id.
- Executions carry `amountCents` (approved, user-confirmed), `providerAmountCents` (what Nessie stored: whole dollars) and `amountDiscrepancyCents`. Show `amountNote` when it is non-null.
- `GET /executions/:id` reads the execution. `POST /executions/:id/reconcile` with `{action:"check"}` checks the outcome, and `{action:"mark_failed"}` should be used only after a check found nothing. Show `disclaimer`: this is a sandbox simulation and no real money moves.
- After `request_changes`, the employee edits the request (new version), confirms, reruns research, then posts a proposal with `{proposalId, runId, offerId}` to create revision v2.

## Other endpoints

- `GET /budget?refresh=true` returns the bank context: `status` (`verified`, `bank_check_unavailable` or `fixture`), `reportedBalanceCents`, `obligations[]` (each marked included or excluded with a reason), `activeReservationsCents`, `unreflectedExpensesCents`, `availableBudgetCents`, `fetchedAt` and `reconciliationNotes`. Without `refresh`, it returns the cached snapshot.
- `GET /integrations/status` returns per-service `configured` and `state`. Use it for a settings or debug badge. It makes no paid calls.
- `GET /agent-configs`, `POST /agent-configs` and `PATCH /agent-configs/:id` (with `expectedVersion`) manage configurations.
- `GET /requests?limit=&cursor=&status=` and `GET /requests/:id/events?after=` return history.

## Enums

- Request `status`: `draft`, `needs_clarification`, `ready_to_confirm`, `confirmed`, `researching`, `researched`, `proposal_draft`, `submitted`, `approved`, `changes_requested`, `rejected`.
- Run `status`: `queued`, `running`, `completed`, `failed`, `cancelled`. Run `outcome`: `candidates_found`, `no_confirmed_match`, `no_results`.
- Candidate `eligibility`: `eligible`, `needs_review`, `rejected`. `affordability`: `within_budget_provisional`, `over_budget`, `unknown`.
- `totalStatus`: `price_unknown`, `listed_subtotal_only`, `subtotal_plus_shipping_tax_unknown`.
- Proposal `decisionState`: `not_submitted`, `awaiting_review`, `approved`, `changes_requested`, `rejected`.
- Execution `status`: `not_started`, `queued`, `submitting`, `recorded`, `failed`, `uncertain`. `providerStatus` is Nessie's own status string, for example `pending`.
- Event types: see `RunEventType` in `src/contracts/domain.ts`.
