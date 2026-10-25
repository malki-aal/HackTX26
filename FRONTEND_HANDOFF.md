# Frontend handoff

Branch: `frontend-ui`. Next.js (App Router), React, TypeScript, Tailwind v4, in `frontend/`.

## Run the combined app

Branch: `integration/runway-fullstack` (frontend branch plus `origin/feat/runway-backend`).

```sh
# terminal 1: backend (fixtures mode needs no keys; see backend/README.md for live setup)
cd backend && npm install && cp .env.example .env
INTEGRATION_MODE=fixtures DATABASE_PATH=./var/runway-fixtures.sqlite npx tsx src/server.ts

# terminal 2: frontend
cd frontend && npm install && cp .env.example .env.local
npm run dev            # or: npm run build && npx next start -p 3100
```

Add the frontend origin (for example `http://127.0.0.1:3000`) to `FRONTEND_ORIGINS` in `backend/.env`. Keys go only in
`backend/.env`. For a phone, use the machine's LAN address in both `NEXT_PUBLIC_API_BASE_URL` and `FRONTEND_ORIGINS`.
`NEXT_PUBLIC_API_MODE=fixture` runs the UI on in-browser sample data with no backend. That is the mode that demonstrates the furniture example end to end.

Checks: `npm run lint`, `npx tsc --noEmit`, `npm run build` (frontend); `npm test`, `npm run typecheck` (backend).

## What exists

Flow: request (with a "Load demo example" action that only fills the form) → one review-and-confirm step →
research (starts only on a button press) → compare and select (tradeoff sections, delivery shown or "unknown",
hard-deadline misses in their own section) → proposal review (exact total collected here) → approval status →
purchase record (printable, labelled as a simulated banking record).

Also: Requests list with pending activity in four separate groups, a minimal Executive view at `/executive`
(linked from Account; list, approve with an exact-amount authorization, request changes, reject), and an Account page
(demo role, past purchases, company budget with its breakdown). The header strip and the integration checklist
are gone; a "Sample data" or "Backend unreachable" note appears at the top of each page only when relevant, and a
"Nessie sandbox" note appears wherever financial records do.

Not built: editing a request after changes are requested, agent configuration editing.

Backend contract gaps are listed in `docs/FRONTEND_CONTRACT_REQUESTS.md`. Short version: the backend supports one
monitors item per request, no hard deadlines, no delivery data and no tradeoff alternatives. The UI and fixtures
implement the proposed shapes; the live adapter refuses unsupported requests with an explicit error.

## Backend connection

All data goes through `src/lib/api/client.ts` (`RunwayApi`). `live.ts` maps the backend responses (`backend/docs/FRONTEND.md`,
`openapi.json`) onto the UI types in `types.ts`; `fixtures.ts` is the in-browser sample mode. Pages show a note
for "Sample data" (client fixtures or a backend in fixtures mode) or "Backend unreachable"; nothing is shown for live data.

Mapping notes:
- Must-haves and nice-to-haves are sent as the request `description`; the backend parses them into requirements and the
  UI shows the parsed list for confirmation. Nice-to-haves go last behind a long gap so they cannot demote a must-have.
- The ranking selector was removed; the backend default (lowest known total) applies.
- Clarification questions are single choice and render as segmented options.
- Proposal save and submit are two backend calls made together; an unsubmitted draft is reused on retry.
- Executive decisions use one `Idempotency-Key` per logical decision (same decision, version and note reuse it).
- Research is started only from a button; pages read saved runs and results and never start paid work on mount, refresh or polling.

## Design

White background, light cool-gray surfaces, dark neutral text and a single blue accent (#0057D9) for actions, active
navigation, selection and focus. One sans-serif stack, system font first (`-apple-system`, SF Pro on Apple devices)
with Inter as a non-Apple fallback. Colour tokens live in `src/app/globals.css`. Fixed phone-width frame (max 430px)
with a safe-area aware tab bar. Light theme only. Status and evidence are always text plus a glyph, never colour alone.

## Fixture caveats

All products, sellers, prices and the balance are invented. No Nessie purchase is recorded from fixtures. A live
SerpApi plus Nessie demonstration has not been done.


## Executive review, profiles and sign-in (branch `frontend/executive-auth`)

Merged `origin/feat/runway-backend` (contract v2, `backend/docs/CONTRACT_V2.md`) into this branch; the workflow-update UI was kept
and the live adapter updated for v2 (item and unit from the backend, `deadlineType`, requirement `display` labels,
recommendations and late alternatives, v2 execution fields). The form no longer asks for a category: the backend resolves it.
One request still covers one item type; project (multi-item) requests are not wired into the UI yet.

**Executive queue** (`/executive`): Pending and Decided tabs with counts, refreshed about every five seconds while visible
(one read at a time, paused when the tab is hidden, never starts research or touches a purchase). Counts show "100+" at the list limit.

**Proposal review** (`/executive/[id]`): requester, purpose, requirements, selected offer with source link and freshness,
requirement-by-requirement evidence, cost with unknown shipping and tax, alternatives, justification, revision and decision history.

**Decision step**: choosing Approve, Request changes or Reject opens a separate confirmation with the proposal and revision, the
exact amount, the optional note, and for approve the available budget with its check time, an estimated projected budget, and an unchecked
confirmation checkbox (reset when the revision or amount changes). One idempotency key per logical decision. Version conflicts reload the
proposal and ask for a fresh decision; a missing merchant mapping offers an explicit "create sandbox merchant" action; uncertain executions
offer "Check status" (never a resend).

**Employee side**: the request, proposal and list screens poll for the decision and the purchase result. After "request changes" the
employee sees the note and can choose offers again and resubmit a new revision.

**Avatars and profile**: original low-poly SVGs (`src/components/avatars.tsx`), a circular profile menu in every header
(`src/components/profile-menu.tsx`).

**Sign-in**: Clerk is wired behind `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (see `.env.example` and `docs/AUTH_AND_EXECUTIVE_CONTRACT.md`).
Without keys the app runs in explicit demo mode. **Not verified:** a real Google sign-in has never run (no Clerk application or keys), and the
backend does not verify tokens or roles yet, so nothing is protected. With a fake publishable key the build and the middleware engage and redirect to
Clerk, as expected. Passkey or Face ID approval is not built.


## Four demo scenarios (feat/four-scenarios)

**New Request → "Try an example"** at the top of the form. It offers "Start from scratch" plus four examples:
- Manufacturing — Restock wood glue
- Growing business — Equip incoming interns
- Café — Replace a broken blender
- Community nonprofit — Power an outreach event

**How the examples behave:**
- Choosing one fills the editable form immediately: title, reason, item, quantity and unit, budget, condition, must-haves, nice-to-haves, needed-by date and hard deadline.
- It shows "Example loaded — edit anything.", announced to screen readers.
- It never submits, confirms, calls Gemini or searches.
- If you've edited the form, it asks "Replace current details" or "Keep editing" first.
- Dates are computed in America/Chicago when the example loads, shown as concrete dates and saved as such.

**Data and contract:**
- Presets come from `GET /api/v1/demo/scenarios` in live mode, or the bundled copy in sample-data mode.
- Contract changes are in `backend/docs/CONTRACT_V3_EXECUTIVE_AUTH.md` §12.

**Layout:** item-type questions with many or long options use a stacked list (`ChoiceList`) instead of the pill row, so nothing runs off a phone screen.
