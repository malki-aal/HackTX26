# Frontend contract requests for the backend

The mentor-feedback workflow update needs a few things the current API (`backend/docs/openapi.json`)
does not provide. The frontend does not guess at them: fixture mode implements the shapes below so the
UI can be demonstrated, and the live adapter (`frontend/src/lib/api/live.ts`) refuses what the backend
cannot do, with an explicit "unsupported by backend" error. Nothing here changes backend business logic
on its own; each item is a request to agree on.

## 1. Multiple items per request (blocks the furniture demo against the live backend)

Today: `category` is only `monitors`, one `quantity`, and requirements are monitor predicates.
A request for glue, cork backing and screws cannot be represented, and one product cannot cover all three.

Proposed minimal solution:
- Request: `items: [{ id, name, quantity, unit }]`; `category` accepts `materials` (free-text item, no monitor predicates).
  Requirements stay per request and are matched against every item.
- Research runs once per item. Each candidate carries `itemId`.
- Proposal: `selections: [{ itemId, offerId }]` instead of `offerId`. One `exactAmountCents` for the whole order,
  one execution for the total. Per-line listed subtotals are returned for display.
- Budget stays one total for the request.

Until then, the UI builds the multi-item form and the Load demo example action, but the live adapter rejects
any request that is not a single monitors item.

## 2. Deadlines: hard vs flexible, and delivery evidence

- Request: `deadline` plus `deadlineKind: "hard" | "flexible"`.
- Candidate: `delivery: { status: "stated" | "unknown", text?, estimatedDate?, source? }` and
  `deadlineFit: "meets" | "misses" | "unknown" | "not_applicable"`. Never computed from guesses; `unknown` when unsupported.
- With a hard deadline, offers that miss it must not be recommended as satisfying the request.

Today candidates carry no delivery data, so the UI shows "Delivery unknown" and `deadlineFit: unknown`.
A hard deadline is refused by the live adapter because nothing can enforce it.

## 3. Tradeoff alternatives

The "Rank offers by" selector is gone. Requested response on `GET /requests/:id/candidates`:
`alternatives: [{ itemId, label: "lowest_known_cost" | "best_deadline_fit" | "best_overall_fit", offerId, tradeoff }]`
where `tradeoff` is plain language covering price, delivery evidence, specification match, quantity and missing
information. Return fewer alternatives when they would be identical or meaningless. No invented dates, savings,
rankings or confidence numbers.

Today the live adapter labels only the backend's rank 1 eligible, priced candidate as "Lowest known cost" (true under
the default `lowest_known_total` priority) and uses `recommendationReason` as the explanation.

## 4. Merchant information

Execution already returns `externalReference.merchantId` (the Nessie sandbox merchant). Requested additions on the
execution and proposal views:
`merchant: { researchedSeller, nessieMerchantId | null, nessieMerchantName | null, mapped: boolean }`.
When no sandbox merchant exists the value is `null` and the UI shows "Merchant mapping required"; it never substitutes another.
Today the name is not returned, so the UI shows the ID only.

## 5. Smaller items

- `GET /executions` (list, filter by `status` and `providerStatus`). The UI currently reads each approved proposal's
  execution one by one, and derives "Pending at Nessie" from `providerStatus === "pending"`.
- Proposal view: include `requestTitle` and the requester (`createdBy`). The UI currently makes an extra request read for the title
  and labels the requester `employee-demo`.
- Clarification: the flow is designed around one question. Please cap or prioritise to the single most useful question
  (the UI handles any number).
- Candidate cards: include the selected item's `condition` and the seller's stated `shipping` text if available.

## 6. Not requested, noted

- Editing a request after `changes_requested` (PATCH exists) is not built in the UI yet.
- Authentication: none. Roles are labels only.
