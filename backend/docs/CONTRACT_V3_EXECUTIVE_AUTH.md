# Contract v3: executive review and Google sign-in

This covers the backend side of `RUNWAY_EXECUTIVE_BACKEND_AUTH.md`, written for the frontend work in `RUNWAY_EXECUTIVE_FRONTEND_AUTH.md`. Everything in v1/v2 still applies. Changes are additive except where marked **(changed)**.

## 1. Sign-in, session transport and modes

- **Provider: Clerk with Google.** The frontend and backend use the **same Clerk application**.
  - Frontend: publishable key only.
  - Backend: `CLERK_SECRET_KEY`, server-only.
- **Transport:**
  - Every protected request carries `Authorization: Bearer <session token>`, from Clerk's `getToken()` on the frontend. Fetch a fresh token per request; Clerk tokens are short-lived.
  - The API is cross-origin (`:3000` → `:8000`); CORS allows the `authorization` header from `FRONTEND_ORIGINS`.
- **Verification:**
  - The backend calls `verifyToken` from `@clerk/backend` (3.26.2). It checks the signature (Clerk JWKS, or `CLERK_JWT_KEY` for networkless checks), the expiry, and `azp` against `CLERK_AUTHORIZED_PARTIES`, which defaults to `FRONTEND_ORIGINS`.
  - Identity comes only from the verified `sub` (the Clerk user id).
- **Modes** (`GET /api/v1/health` → `data.auth = { mode, configured }`):
  - `clerk`: required with live integrations. When `CLERK_SECRET_KEY` is missing, every protected route returns `503 AUTH_NOT_CONFIGURED`.
  - `demo`: allowed only with `INTEGRATION_MODE=fixtures`. Identity comes from `X-Demo-Actor: employee-demo|executive-demo` or the legacy body `actor`, and every response has `meta.demoIdentity: true`. The server refuses to start with `AUTH_MODE=demo` plus live integrations.
- **(changed)** In `clerk` mode, any body `actor` field or `X-Demo-Actor` header returns `400 IDENTITY_FIELD_NOT_ALLOWED`. `meta.demoIdentity` is `false`, and `meta.authMode` is now on every response.
- **Public routes:** `/health`, `/categories`, `/demo/manufacturing`. Everything else needs a session.
- The eve internal tool channel keeps its own per-process token on loopback. It is unrelated to user sign-in and never sent to browsers.

## 2. Roles and company assignment (bootstrap allowlist)

- Copy `config/access.example.json` to `config/access.json` (gitignored) and list the **team-supplied** Google emails with `role` (`employee` or `executive`) and `company`.
  - The file is re-read whenever it changes.
  - Removing an email revokes that membership on the user's next request.
- **Matching:**
  - Only emails that Clerk reports as **verified** match.
  - The resulting membership is bound to the internal user id, which maps 1:1 to the Clerk user id.
  - Display-name and avatar edits never change role or company.
- **No one is auto-promoted.** A signed-in account that isn't in the allowlist is `membership.status: "pending"` and gets `403 ACCESS_PENDING` on everything except `/me`.
- **Use a new company id** (for example `runway_team`) so old demo data in `org_demo` stays separate. Set `ACCOUNT_COMPANY_ID` to that id: only that company's executives can see the Nessie account (budget figures, merchant mappings, purchase history).

## 3. Current user

`GET /api/v1/me` (signed in; works while access is pending):

```json
{
  "user": { "id": "usr_…", "displayName": "Erin Executive", "email": "erin@…", "emailVerified": true,
            "avatarStyle": "role_default", "defaultAvatar": "executive_silhouette" },
  "membership": { "status": "active", "role": "executive", "company": { "id": "runway_team", "name": "…" } },
  "auth": { "mode": "clerk", "demoIdentity": false }
}
```

- `defaultAvatar` is `executive_silhouette` or `employee_silhouette`. The frontend renders its own app-local SVG for it. The value is decorative and carries no authority.
- `PATCH /api/v1/me` accepts only `{ displayName?, avatarStyle?: "role_default"|"executive_silhouette"|"employee_silhouette" }`. Any other field, `role` and `company` included, returns `422`.

## 4. Who can do what

| Area | Employee | Executive (same company) |
|---|---|---|
| Requests, runs, candidates, events, projects | own only (others' ids → 404) | read all in company; edit only own |
| Create/submit proposals | own requests | own requests |
| `GET /proposals` | own submissions | company queue |
| `GET /proposals/:id`, `/confirmation`, `/executions/:id` | own | company |
| Decide, `/financial-preview`, reconcile, agent-config edits | 403 `FORBIDDEN_ROLE` | yes, **except their own proposals** (403 `SELF_APPROVAL_NOT_ALLOWED`) |
| `/budget` | status only (`scope:"employee"`, figures `null`) | full when the company is `ACCOUNT_COMPANY_ID` |
| Merchant mappings, `/merchants/:id`, `/purchase-history` | 403 | `ACCOUNT_COMPANY_ID` executives only |

Resources belonging to another company always return `404`, so their existence isn't leaked.

## 5. Queue and employee submissions: `GET /api/v1/proposals`

- **Query parameters:**
  - `decisionState` (`awaiting_review|approved|changes_requested|rejected|not_submitted`);
  - `limit` (1–100, default 20);
  - `cursor`, taken from `meta.nextCursor`;
  - `updatedAfter`, the `meta.serverTime` returned by the previous poll. It is inclusive, so dedupe by `id`.
- `meta.counts` holds totals per decision state, computed over the whole scope regardless of paging. Use these for badges, never fixture counts.
- Item shape: `{ id, requestId, projectId, version, title, item, quantity, unit, deadline, deadlineType, employee { id, displayName, role, demoIdentity }, decisionState, executionStatus, providerStatus, offer { id, title, seller, sourceUrl, imageUrl, observedAt }, exactAmountCents, eligibility, unresolved[], offerStale, latestDecision { decision, resultingState, note, actor, version, createdAt } | null, submittedAt, executionId, updatedAt }`.
- **Polling:** poll every ~5 s while visible.
  - Polling is read-only and never runs research, model calls or purchases.
  - Any execution status change bumps the proposal's `updatedAt`.

## 6. Review detail: `GET /api/v1/proposals/:id`

Adds the following to the v2 detail:

- `requester`;
- `request { title, purpose, item, quantity, unit, deadline, deadlineType, requirements[] (with display) }` for the **immutable submitted revision**;
- `decisions[]`: `{ version, decision, resultingState, note, actorInfo { displayName, role }, createdAt, confirmation { proposalVersion, exactAmountCents, confirmedAt, statement } | null }`;
- `financialAssessment`: the preview below, served from cached data, for executives; `null` for employees.

Employees also get `budgetAssessment.availableBudgetCents: null`.

## 7. Financial preview: `GET /api/v1/proposals/:id/financial-preview?refresh=true`

```json
{
  "currency": "USD",
  "label": "Available budget from Runway's ledger … Not a bank balance.",
  "currentAvailableCents": 200000,
  "exactExpenseCents": 58756,
  "projectedAvailableCents": 141244,
  "reservationIncluded": false,
  "freshness": { "source": "nessie_live", "fetchedAt": "…", "refreshedNow": true, "status": "verified" },
  "canApprove": true,
  "blockingReasons": [],
  "amounts": { "researchListedSubtotalCents": …, "budgetCeilingCents": …, "exactExpenseCents": 58756, "amountSource": "user_confirmed",
               "approvedAmountCents": null, "providerStoredAmountCents": null, "discrepancyCents": null },
  "unknowns": ["Sales tax", "Shipping"],
  "project": null,
  "notes": []
}
```

- **The projection:** `projectedAvailableCents = currentAvailableCents - exactExpenseCents`, unless `reservationIncluded` is true. In that case the amount is already in the ledger, so projected equals current and is never subtracted twice.
- **No fake balance:** if bank data is missing, `currentAvailableCents` is `null` and `blockingReasons` includes `bank_check_unavailable`.
- **`blockingReasons[].code`:**
  - `not_awaiting_review`, `no_exact_amount`;
  - `bank_check_unavailable`, `exceeds_available_budget`, `exceeds_request_budget`, `exceeds_project_budget`;
  - `offer_stale`, `merchant_mapping_required`, `requirements_changed`.
- `refresh=true` re-reads Nessie (a free read; no research). The approval itself always rechecks the bank and reserves atomically, so a stale preview can't overspend.
- **After approval:** `amounts.providerStoredAmountCents` and `discrepancyCents` show Nessie's whole-dollar storage, for example 58756 approved → 58700 stored → 56.

## 8. Decisions: `POST /api/v1/proposals/:id/decision`

Header `Idempotency-Key: <uuid>`. Create one key per decision attempt and reuse it on retries.

```json
// approve
{ "version": 2, "decision": "approve", "note": "Optional text",
  "confirmation": { "confirmed": true, "proposalVersion": 2, "exactAmountCents": 58756 } }
// request changes / reject: no confirmation needed
{ "version": 2, "decision": "request_changes", "note": "" }
```

- **Values:** `decision` is `approve`, `request_changes` or `reject`. The resulting `decisionState` is `approved`, `changes_requested` or `rejected`.
- **Note:** optional for all three decisions. It is plain text: whitespace is normalized, control characters are rejected (422), and the limit is 1000 characters (422).
- **Approve without confirmation** (or with `confirmed: false`) returns `422 CONFIRMATION_REQUIRED`. `details` carries `proposalVersion`, `exactAmountCents` and the server's `statement`:
  > I approve this simulated purchase for $587.56 and understand that it commits this amount from the available company budget.
- **Terms mismatch** (`proposalVersion` or `exactAmountCents` differs from the server's) returns `409 TERMS_CHANGED` with the current terms. A stale `version` returns `409 VERSION_CONFLICT`. In both cases, refresh the detail and require a fresh checkbox.
- **Persistence:** the server stores the actor (from the session), a server timestamp, and the confirmed version, amount and statement.
- **Idempotency:** scoped to *this executive + this proposal*. The same key and payload returns the same result, which covers double clicks and lost responses with exactly one decision and one purchase. The same key with a different payload returns `409 IDEMPOTENCY_CONFLICT`.
- **Approval** keeps every v1/v2 protection:
  - fresh evidence and bank checks;
  - explicit merchant mapping;
  - the project cap and the atomic reservation;
  - a durable execution intent before the single Nessie POST;
  - no automatic resend after an ambiguous result.
- **Request changes:** the employee creates a revision with `POST /requests/:id/proposals { proposalId, runId, offerId }`, then submits `version + 1`. Old decisions stay in `decisions[]`.
- **Reject:** no purchase and no reservation.

## 9. Errors the UI should distinguish

| Status / code | Meaning | UI |
|---|---|---|
| 401 `UNAUTHENTICATED` (`details.reason: missing/invalid/expired`) | signed out or expired | send to sign-in |
| 403 `ACCESS_PENDING` | signed in, not on the allowlist | pending-access screen |
| 403 `FORBIDDEN_ROLE` / `SELF_APPROVAL_NOT_ALLOWED` | wrong role / own proposal | hide action, explain |
| 404 | not visible to this user (or absent) | not found |
| 409 `VERSION_CONFLICT` / `TERMS_CHANGED` | stale review | reload, reset checkbox |
| 409 `BUDGET_EXCEEDED` / `OFFER_STALE` / `MERCHANT_MAPPING_REQUIRED` | approval blocked | show reason |
| 422 `CONFIRMATION_REQUIRED` / `VALIDATION_ERROR` | input | fix input |
| 503 `AUTH_NOT_CONFIGURED` | server missing Clerk config | config error state |

## 10. What is not real yet

- Real Google sign-in has **not** been verified. The backend tests use a controlled test identity provider, labeled as such. Verifying it needs the team's Clerk application keys and an allowlist of real emails.
- Passkeys / Face ID are out of scope.

## 11. Integration pass (additive)

### Condition evidence is no longer inferred into "supported"
- A listing that only lacks a second-hand marker gives `condition` the state **`unknown`**, with the reason "Inferred new …; verify with the seller".
- Only a stated condition is `supported`: the provider's second-hand field, or listing text such as "New" or "Condition: New".
- Consequences: many live offers are now `needs_review` instead of `eligible`, and research reports `no_confirmed_match` more often. Nothing unconfirmed is presented as met.

### Unconfirmed must-haves need a recorded verification or exception at submission
- `POST /proposals/:id/submit` accepts `requirementResolutions: [{ requirementId, kind: "verified" | "exception", note }]`.
  - There is one entry for every **mandatory requirement whose evidence state is `unknown`** for the proposed offer.
  - `note`: 3–500 characters of plain text, with no control characters.
- Missing entries return `422 UNRESOLVED_REQUIREMENTS`, with `details.requirements: [{ requirementId, attribute, reason }]`.
- Entries for anything else return `422 VALIDATION_ERROR`.
- Contradicted must-haves still make the offer `rejected`, and it cannot be proposed.
- **Storage:** resolutions are stored with that (draft) version and returned on proposal detail as `requirementResolutions: [{ requirementId, attribute, evidenceReason, kind, note, recordedAt }]`.
  - Already-submitted versions are never rewritten.
  - The evidence state itself stays `unknown`.

### Research progress
- Search and product-detail tool results now include the deterministic ranking (`evaluation`) when `evaluateCandidates` is enabled for the configuration. This saves model turns.
- `detailsCouldHelp: false` marks candidates whose only unconfirmed must-haves are things a product page cannot state, such as condition.
  - `getProductDetails` returns `{ skipped: true }` for them without spending a lookup.
- New run event `model_quota_wait`, payload `{ waitMs }`. It records a real pause by the agent's Gemini pacing (`GEMINI_MAX_RPM`) and is reported over the loopback-only `/internal/agent-progress`.
- `GET /runs/:id/events` accepts `limit` up to 500.

## 12. Four demo scenarios (additive)

### Supported item types
- **New requests can use:** `monitors`, `wood_glue`, `countertop_blender` and `portable_power_station`, plus `general`.
- **Older types** (`office_chairs`, `cork_sheets`, `wood_screws`):
  - still resolve, so existing records keep their details;
  - still detected in request text, so a contradicting hint is a conflict;
  - never chosen from text or offered in questions;
  - an explicit API `category` hint naming one still works for older clients.
- `GET /categories` now includes `selectable` on each type.

### Item-type question
- When text names no supported item type, `q_category` offers the four item types plus `general` ("Something else (general search, every result needs review)").
- When text names only an older type, the question says it isn't supported in this version.
- Nothing is forced into another category.
- **`general` category:**
  - searches with the request's own title;
  - has no category or spec checks, so `product_type` stays `unknown`;
  - every result is `needs_review` and nothing is recommended.

### New requirement types
- **`capacity_wh`:** `gte`, unit `wh`, read only from "Wh", "kWh" or "watt-hours". Watts (output power) never count.
- **`ac_outlets`:** `gte`, unit `outlets`.
- **New features:**
  - `commercial_use` (blender): only an explicit "commercial" counts; "professional" and wattage don't;
  - `interior_hardwood` (wood glue);
  - `height_adjustable` (monitors).
- **Screen size:** "At least 27 inches" now means a minimum of 27 in (`max: 100`). A bare "27 inch" still means the 27-inch class.

### Volumes
- Only explicit fluid units count: `fl oz`, `fluid ounces`, `ml`, `L`, `gal`, `qt`, `pt`.
- A bare `oz` (which may be weight, e.g. "Net Wt 18 oz") is never read as a volume. The exception is blender pitcher capacity, which can't be a weight.

### Total-volume quantities (wood glue)
- A request whose `unit` is a fluid unit, such as `quantity: 128, unit: "US fluid ounces"`, orders a total volume, not containers.
- The quantity isn't turned into a per-container volume requirement.
- **Cost:**
  - `packagesRequired = ceil(required / (container volume × pack count))`, with a 0.2% tolerance for ml rounding;
  - `cost.volume = { requiredMl, perPackageMl, purchasedMl, excessMl }`;
  - a cost note reads e.g. "4 × 32 fl oz = 128 fl oz for 128 fl oz needed".
- A listing that doesn't state its volume in fluid units has unknown package volume. Its cost for the order is unknown and it is `needs_review`.

### Other notes
- **Stock:** a multi-unit order adds the unknown "stock for N units not confirmed by the seller". It doesn't block.
- **Best overall:** for volume orders, fewer containers breaks ties before cost.

### Example presets
- `GET /demo/scenarios` is public and read-only. It serves `backend/demo/scenarios.json` (versioned, America/Chicago dates).
- **Each preset:** `id`, `sector`, `menuLabel`, `title`, `purpose`, `item`, `categoryId`, `quantity`, `unit`, `budgetCents`, `condition`, `deadlineDays`, `deadlineType`, `eventDays`, `mandatory[]`, `preferences[]`.
- Presets contain no products, prices, merchants, stock or delivery claims.
- `frontend/src/lib/scenarios/scenarios.json` is an identical copy for sample-data mode, and a backend test fails if they differ.
- `POST /requests` accepts an optional `presetId` as debugging metadata. The server still parses the edited text.

## 13. Employee wallet: approval transfers money, the employee pays the seller (additive)
- **Approval** now creates an execution with `kind: "transfer"`: a Nessie sandbox **transfer** from the company account to the requester's own sandbox account.
  - The account (customer plus checking, starting at $0) is created on their first approval.
  - The company budget moves once, when the transfer is recorded, using the same reservation and ledger rules as before.
  - Older executions keep `kind: "purchase"`, meaning the company paid the merchant directly.
- **`POST /executions/:id/pay`** (requires an `Idempotency-Key` header) lets the employee who received the money pay the seller.
  - It records a Nessie sandbox **purchase** from their account to the mapped merchant.
  - It's only allowed once the transfer is `recorded`, and there's at most one payment per transfer (unique in the database).
  - The same key returns the same payment. A different key can't pay again.
  - An ambiguous result is `uncertain` (409 `PAYMENT_UNCERTAIN` on a new attempt) until **`POST /executions/:id/payment/check`** finds it by reference. It's never re-sent.
  - Paying never touches the company budget again.
- **`GET /me/wallet`** returns `runwayBalanceCents`, `receivedCents`, `paidCents`, Nessie's `reportedBalance` (shown separately), and `entries[]`.
  - Each entry is `type` (`received` / `paid`), `amountCents`, `status`, `at`, `title`, `seller`, and `canPay`.
- **Execution view** adds `kind`, `payee`, `payment`, and `externalReference.transferId`. `externalReference.purchaseId` stays the merchant purchase (the employee's payment for transfers).
- **Purchase history** adds `transfers[]`, linked to Runway executions and the employee's payment.

## 14. Evidence strength and the result shortlist (additive)

All fields below are optional additions; older stored runs still parse and existing fields keep their meaning.

**Evidence** (`candidates[].evidence[]`): `claim` — `"explicit" | "certification" | "keyword" | "marketing"` on feature evidence for features with explicit rules (café: commercial use). Keyword ("Commercial" in a seller title) and marketing ("commercial grade") claims never satisfy a requirement; explicit statements, certifications of stated scope (NSF, ETL Sanitation; generic ETL/UL marks are ignored) and structured Google product specs ("Commercial: Yes", "Rec. use: Commercial") do. Negations ("not for commercial use") contradict.

**Requirement checks** (`candidates[].requirementChecks[]`): `deadlineRisk` on `delivery_by` — `none | estimate_only | on_deadline | late_estimate | no_date`. Google Shopping delivery dates are estimates; without `SHOPPING_LOCATION` they are `unknown`, never `supported` or `contradicted`. With a stated search location they may pass or fail the check, but stay estimates: `deadlineRisk` is never `none` for a Google date, and the reason says "an estimate, not a guaranteed arrival". Only a requester-confirmed date has risk `none`. Shortlists for runs saved before this change are `source: "computed"` from their stored evaluations, with a headline saying they predate the current checks.

**Delivery** (`candidates[].delivery`): `basis: "google_estimate"`, `location` (null when unset), `timeZone` (relative days are read in `COMPANY_TIMEZONE`, default America/Chicago).

**Shipping**: "Free delivery on $1,500+" is free only when the order subtotal clears the threshold (`costNotes` says which); membership-conditional free shipping stays unknown.

**Shortlist** (`GET /requests/:id/candidates` → `data.shortlist`, null when results are for an older request version):

```
shortlist: {
  source: "saved" | "computed",      // saved when the run ended; computed for runs before this change
  headline: string | null,           // shown above the cards when no option meets every must-have
  notEvaluated: string[],            // specs the backend cannot check (general search)
  moreOfferIds: string[],            // everything else, ranking order, for "More options"
  folded: { offerId, into }[],       // near-duplicates (same product, no meaningful difference)
  entries: Array<{
    offerId, rank,
    role: "closest_match" | "lowest_cost" | "spec_advantage" | "fewer_packages" | "delivery_evidence"
        | "stretch_budget" | "another_match" | "cheaper_compromise",
    label: string,                   // 1–5 words, prominent
    status: string,                  // factual secondary status ("Over budget by $35.00")
    compliance: "meets_all" | "unconfirmed" | "over_budget" | "fails_must_have",
    explanation: string, compromise: string, unverified: string[],
    source: "deterministic" | "model",
    facts: { knownCostCents, costBasis, budgetCents, overBudgetCents, costVsClosestCents, mustHaves[], advantages[], drawbacks[], title, seller }
  }>
}
```

Selection is deterministic (backend `domain/shortlist.ts`) from the request's own requirements; labels differ by sector (e.g. "More battery capacity", "Fewer containers"). At most four entries; fewer when nothing else differs meaningfully. `over_budget` and `fails_must_have` entries are compromises: their candidates stay `rejected` and cannot be proposed; the server's verification, exception and budget rules are unchanged. The research model may reword an entry through `prepareProposalDraft.shortlistNotes`; wording is accepted only if it uses existing offer ids and numbers already in `facts`, makes no quality, certification or confirmed-arrival claims, and calls an unconfirmed delivery date an estimate. Otherwise (or when the model fails) the deterministic wording is shown. The shortlist is saved on the run (`runs.shortlist`, migration 7) and never regenerated on page load.

