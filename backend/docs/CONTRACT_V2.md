# Contract v2: changes for the frontend

This is the shared contract for the mentor-feedback changes. It is **additive**: every v1 field the frontend reads is still present with the same meaning, except the three marked **(changed)**. The frontend adapter (`frontend/src/lib/api/live.ts`, `types.ts`) already has the minimal updates listed at the end.

## 1. Item category (the "Chairs → monitors" fix)

- `POST /requests` `category` is now **optional**. Send nothing, and the backend resolves it from the title and description.
  - The old hard-coded hint `"monitors"` is still accepted. If the text contradicts it (for example the title "Chairs"), the backend asks instead of defaulting.
- If the item type can't be resolved, the request gets a clarification question `q_category` (single choice; options are category ids). Confirm returns `409 CATEGORY_UNRESOLVED` until it is answered.
- **(changed)** `request.category` is a category id (`monitors`, `office_chairs`, `wood_glue`, `cork_sheets`, `wood_screws`) or `null` while unresolved.
- New `request.item`: `{ resolved, category, label, plural, sector, unit, quantity }`. Use `item.plural` for labels; when `resolved` is false, `label` reads "Item type to be confirmed".
- New `request.unit` (for example `"chair"`, `"sheet"`, `"screw"`). You may send `unit` on create; it defaults to the category's unit.
- Every requirement now has `display`, a ready-to-show label such as "Is an office chair", "#6 × 0.625 in", "At least 12 × 12 in" or "Must arrive by 2026-11-06". Prefer it over local formatting so new categories need no UI code.
- `GET /categories` lists the categories with their units, specs and features.
- Candidates and research results are bound to the exact confirmed requirement version. `GET /requests/:id/candidates` adds `resultsCurrent`, `requestVersion` and `currentRequestVersion`. Results from an older version are never shown as `eligible`.
- **(changed)** `request.proposals` is now ordered oldest → newest, so `proposals[length-1]` is the latest, as `live.ts` already assumed.

## 2. Deadlines

- New `deadlineType`: `"hard"` or `"target"` (default `"target"`), alongside `deadline`.
- With a hard deadline, a stated late delivery makes the offer **rejected (noncompliant)**, and an unstated delivery makes it **needs_review**. With a target date, a late offer stays eligible but loses the "deadline fit" role.
- Candidates gain `delivery`: `{ status, excerpt, earliest, latest, source }`. Dates appear only when the seller states one; otherwise they are `null` (unknown).

## 3. Recommendations (no ranking mode required)

- `rankingPriority` is optional and deprecated. The form no longer needs a ranking selector.
- `GET /requests/:id/candidates` adds:
  - `recommendations[]`: `{ offerId, rank, kinds: ("lowest_cost"|"deadline_fit"|"best_overall")[], reasoning[], comparison }`. When one offer wins several roles, it is merged into a single entry.
  - `noncompliantAlternatives[]`: `{ offerId, kind: "cheaper_but_late", reason, comparison }`. These are never recommendations.
  - `recommendationNotes[]`, which includes the "compared N observed offers; not a claim about prices elsewhere" note.
  - Each candidate gets `recommendationKinds`, `delivery`, `availability` and `detailsStatus`.

## 4. Projects (multi-material lines)

- `POST /projects`: `{ title, purpose, sector, budgetCents, neededBy, deadlineType, suppliedInventory[], lines[] }`.
  - Each line is `{ key, title, description, category?, quantity, unit?, budgetCents, allowedCondition? }`.
  - Each line becomes an ordinary request (`request.projectId` and `request.lineKey`), so every existing request screen works on a line unchanged.
- `GET /projects/:id` returns per-line status and research rollup, plus `totals { lowestKnownCostCents, fitsBudget, committedCents, remainingCents }`, `suppliedInventory[]` (`purchased: false`) and `limitations[]`.
- `POST /projects/:id/confirm` confirms ready lines. `POST /projects/:id/research` is the paid action and only runs when called.
- `GET /demo/manufacturing` returns the validated demo input. POST it to `/projects`.
- The project budget is a **hard cap** across approvals. Exceeding it returns `409 BUDGET_EXCEEDED` with `details.projectId`.

## 5. Merchants and purchase history

- Approval now requires an explicit seller → Nessie merchant mapping. Without one it returns `409 MERCHANT_MAPPING_REQUIRED` (`details.seller`), and nothing is reserved or written.
- `POST /merchant-mappings` takes either form (both require `actor: "executive-demo"`; otherwise `403 FORBIDDEN_ACTOR`):
  - `{ action: "create_sandbox_merchant", seller, actor: "executive-demo" }`
  - `{ action: "link_existing_merchant", seller, nessieMerchantId, actor: "executive-demo" }`
- `GET /merchant-mappings` returns mappings with `provenance`, `provenanceNote` and `disclaimer`.
- `GET /merchants/:nessieId` returns Nessie merchant details and the sellers mapped to it.
- `GET /purchase-history` returns the company account's Nessie purchases. Each has `origin: "runway" | "external"`, a link to the Runway execution, and the stored amount.

## 6. Executions, confirmation and activity

- Executions add canonical fields: `approvedAmountCents`, `providerStoredAmountCents`, `currency`, `accountMasked` ("•••• 7956"), `merchantMapping`, `providerPurchaseDate` and `timestamps { approvedAt, providerSubmittedAt, recordedAt, providerRetrievedAt }`. The v1 fields `amountCents`, `providerAmountCents` and `amountDiscrepancyCents` are unchanged.
- `GET /proposals/:id/confirmation` returns everything a confirmation screen needs, all persisted:
  - ids, item, offer and evidence links;
  - requester and approver;
  - the masked account;
  - the researched seller and mapped merchant;
  - approved, stored and discrepancy amounts;
  - the provider purchase id, status and date;
  - all timestamps, statuses and the `notice`.
- `GET /activity` returns `groups`: `awaitingApproval`, `approvedNotExecuted`, `executionInProgressOrUncertain`, `providerPending`, `providerRecorded` and `executionFailed`, plus `counts`.
- A Nessie record is a bank record only. There is no shipment, delivery, merchant order id or receipt anywhere in the API.

## New error codes

`CATEGORY_UNRESOLVED` (409), `MERCHANT_MAPPING_REQUIRED` (409), `FORBIDDEN_ACTOR` (403). `UPSTREAM_RATE_LIMITED` now carries `details.kind` (`rate_limited` or `quota_exhausted`) and `details.retryAfterSeconds`.

## Frontend adapter changes already made

- **`live.ts`:**
  - No longer sends `category: "monitors"`, and sends `rankingPriority` only if the form provides one.
  - Marks must-haves "(required)".
  - Uses requirement `display` labels and maps `item` to `itemLabel` and `unit`.
  - Maps `recommendationKinds`.
- **`types.ts`:** `category: string | null`, optional `itemLabel`, `unit`, `ranking` and `recommendationKinds`.
- **`new/page.tsx`:** the ranking selector is removed, and the wording and placeholders are no longer monitor-only.
- **`page.tsx`:** the list shows `{quantity} {itemLabel}` instead of "monitors".

Not built in the UI (backend ready): project screens, merchant mapping, the activity view, the confirmation screen, and showing recommendations and noncompliant alternatives.
