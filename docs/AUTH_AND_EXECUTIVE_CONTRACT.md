# Sign-in, roles and executive review: contract requests for the backend

The frontend now supports Google sign-in through Clerk and sends the session token to the API. **None of this
protects anything until the backend verifies the token and decides roles on the server.** The current backend has no
authentication: it trusts the `actor` field in the request body (`demoIdentity: true`). A frontend role toggle, or a
role the client claims, must never authorize a spend.

This file is the request to the backend owner. The frontend is written to these shapes; where the backend does not
have them yet, the UI says so instead of pretending.

## How the frontend behaves today

- **No Clerk key set (default):** explicit demo mode. The role is a label chosen by the screen (`/executive` is the
  Executive view). The profile menu says it protects nothing. Backend calls carry no token.
- **`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` set:** Clerk handles Google sign-in. Every API call
  sends `Authorization: Bearer <fresh Clerk session token>`. The app calls `GET /api/v1/me` and shows:
  loading, signed out, session ended (any 401), access pending (403), "can't verify access" (404 or other failure), or the app.
- **`NEXT_PUBLIC_REQUIRE_AUTH=true` with no key:** refuses to run and says sign-in is not configured.
- Switching accounts re-keys the whole tree (component state, polling timers) and clears stored offer selections.
- Executive screens need `role: "executive"` from `/me` in signed-in mode. That is a courtesy; the server must enforce it.

## 1. Verify the token on every protected endpoint

- Use Clerk's server verification (`@clerk/backend` `verifyToken`, or JWKS) with the expected issuer, authorized
  parties (`azp`, the frontend origin), expiry and signature. Reject missing or invalid tokens with `401` in the standard
  error envelope.
- **CORS:** `Authorization` must be added to the allowed request headers. Today only `content-type` and
  `idempotency-key` are allowed, so a browser's preflight for a Bearer token fails.
- Ignore any client-supplied `actor`, role, email, company id or identity header. Derive them from the verified user.
- In authenticated mode (for example `AUTH_MODE=clerk`) the demo actors (`employee-demo`, `executive-demo`) must be
  rejected, not silently accepted. Keep demo mode explicit and separate.

## 2. `GET /api/v1/me` (new)

```json
{ "data": { "userId": "user_…", "displayName": "Pat Lee", "email": "pat@example.com",
            "role": "employee" | "executive", "company": { "id": "co_…", "name": "…" } },
  "meta": { … } }
```

- `403` with code `NO_MEMBERSHIP` when the verified user has no company membership. The UI shows "Access pending".
- Never auto-create a membership and never promote the first user to sign in.

## 3. Roles and company membership

Smallest safe bootstrap: a `memberships` table `(provider_user_id, verified_email, company_id, role)` seeded from an
environment allowlist the team supplies, for example `EXECUTIVE_EMAILS=a@x.com,b@x.com` and
`EMPLOYEE_EMAILS=…`. Match only **verified** provider emails and bind the row to the provider user id on first
sign-in. Users not on a list have no membership (pending access). No public company creation or invite flow.

Open questions for the team (not decided by the frontend): which Google addresses are executives, how employees are
assigned, and whether approval should additionally require a passkey. Passkey/Face ID is not built.

Queue audience: all executives of the requester's company (documented default; change it here if an individual
assignee is wanted).

## 4. Authorization on reads and writes

- Employees see only their own requests, proposals and executions. Executives see their company's review queue and
  the proposals they may decide. Wrong-company and cross-user reads return `404` or `403`.
- `POST /proposals/:id/decision`: reject employees with `403` (suggested code `FORBIDDEN_ROLE`) whatever the body says.
  The decision actor is the verified executive.
- `GET /budget` (the company balance, obligations and available budget) must be executive-only. The employee screens no longer show or request it, but that is only the UI; today any caller can read it.
- `GET /proposals` needs a total and a cursor so the queue can show true counts. Today it returns at most 100 rows; the
  UI shows "100+" when it hits that.

## 5. Decision body and persisted confirmation

The UI sends today: `{ version, decision: "approve"|"request_changes"|"reject", actor, note }` with an
`Idempotency-Key`. The note is optional for all three. Requested addition for approve: `approvalConfirmed: true`,
persisted with the proposal version and amount, and rejected with `422` if absent. Request changes and reject carry no
confirmation field.

## 6. Budget preview and reservation state

The UI estimates `projectedAvailable = availableBudget − exactExpense` only while a proposal is awaiting review, and
labels it an estimate. Requested so it never has to guess:

- `proposal.reservation`: `{ reserved: boolean, amountCents: number | null, includedInAvailable: boolean }`.
- `budgetAssessment.fetchedAt` (when the available figure was computed).
- Optional server-computed `projectedAvailableCents` for an unreserved proposal.

Once approved, the UI shows the backend's available figure without subtracting again.

## 7. Live updates

The UI polls about every five seconds while a queue, request or proposal is visible, one request at a time, paused when
the tab is hidden. If the backend adds server-sent events (or `GET /events?after=`), the polling can be replaced.

## 8. Requester identity

Proposal views and activity rows need the requester as `{ id, displayName }` (and optionally an avatar URL). The UI shows
`employee-demo` and the default low-poly avatar until then.

## Merchant mapping (already in contract v2)

Approval returns `409 MERCHANT_MAPPING_REQUIRED` until the seller has a Nessie sandbox merchant. The executive
confirmation step shows this and offers an explicit "Create a sandbox merchant" action
(`POST /merchant-mappings`, `create_sandbox_merchant`). That endpoint currently requires `actor: "executive-demo"`; with
real auth it should be limited to verified executives.
