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
`NEXT_PUBLIC_API_MODE=fixture` runs the UI on in-browser sample data with no backend.

Checks: `npm run lint`, `npx tsc --noEmit`, `npm run build` (frontend); `npm test`, `npm run typecheck` (backend).

## What exists (Employee view only)

Requests list, new request (monitors), clarify, confirm exact requirement version, deliberate research start with
resumable polling, offers with per-requirement evidence, offer detail, proposal with the three distinct amounts
(research subtotal, budget ceiling, user-confirmed simulated expense), submit, and an Account tab (budget context,
agent configurations, integration status).

Not built yet: the Executive screens (the adapter exists), agent configuration editing, and request editing after changes are requested.
The Employee/Executive selector is a placeholder label in the top strip and is not authentication.

## Backend connection

All data goes through `src/lib/api/client.ts` (`RunwayApi`). `live.ts` maps the backend responses (`backend/docs/FRONTEND.md`,
`openapi.json`) onto the UI types in `types.ts`; `fixtures.ts` is the in-browser sample mode. The header shows
"Live data", "Sample data" (client fixtures or a backend running in fixtures mode) or "Backend unreachable".

Mapping notes:
- Must-haves and nice-to-haves are sent as the request `description`; the backend parses them into requirements and the
  UI shows the parsed list for confirmation. Nice-to-haves go last behind a long gap so they cannot demote a must-have.
- Ranking options follow the backend: lowest cost, most evidence.
- Clarification questions are single choice and render as segmented options.
- Proposal save and submit are two backend calls made together; an unsubmitted draft is reused on retry.
- `live.ts` also exports `executiveApi` (list, decide with `Idempotency-Key`, execution, reconcile). No screen uses it yet.

## Design

White background, light cool-gray surfaces, dark neutral text and a single blue accent (#0057D9) for actions, active
navigation, selection and focus. One sans-serif stack, system font first (`-apple-system`, SF Pro on Apple devices)
with Inter as a non-Apple fallback. Colour tokens live in `src/app/globals.css`. Fixed phone-width frame (max 430px)
with a safe-area aware tab bar. Light theme only. Status and evidence are always text plus a glyph, never colour alone.

## Fixture caveats

All products, sellers, prices and the balance are invented. No Nessie purchase is recorded from fixtures. A live
SerpApi plus Nessie demonstration has not been done.
