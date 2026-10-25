# Runway backend

Runway turns a purchasing requirement into an evidence-backed proposal that an executive reviews and approves.

**Workflow:** request → clarification → confirmed requirements → SerpApi research → deterministic checks and ranking → Nessie budget assessment → employee proposal → executive decision → Nessie simulated purchase → saved history.

Stack: Node.js 24, TypeScript (run with `tsx`), Fastify 5, Zod 4, SQLite through Node's built-in `node:sqlite`, eve 0.83 as the agent runtime, Gemini through `@ai-sdk/google`, and Vitest.

## Quick start

```bash
cd backend
npm install
cp .env.example .env   # then fill in keys locally; never commit .env
npm test               # unit + integration tests, no network
npm run start:fixtures # API on :8000 with synthetic, labeled fixture data
npm start              # live mode: API on :8000 + internal eve agent on 127.0.0.1:8100
```

`npm start` is the single command. In live mode it runs `eve build`, then starts the eve agent process on loopback (`AGENT_RUNTIME_PORT`, default 8100) and shuts it down with the API. Press Ctrl+C to stop both.

## Live setup (once)

1. Put your keys in `backend/.env`: `GEMINI_API_KEY`, `SERPAPI_API_KEY` and `NESSIE_API_KEY`. `GOOGLE_GENERATIVE_AI_API_KEY` is accepted as an alias; setting both to different values is an error.
2. Run `npm run check:gemini`. It lists the models your key can use. Set `GEMINI_MODEL` to one of them, then rerun it to verify structured output and tool calling.
   - On the free tier (5 requests/minute and 20/day per model), keep `GEMINI_MAX_RPM=4` and expect about 2 research runs per model per day. `gemini-3.5-flash` shares the `gemini-3.6-flash` daily quota. Verified working: `gemini-3.6-flash` and `gemini-3.5-flash-lite`. See `docs/ACCEPTANCE.md`.
3. Run `npm run check:serpapi`. This uses one search and saves a sanitized sample under `var/recordings/`.
4. Run `npm run probe:nessie`. This is read-only and prints Nessie route status codes and response shapes.
5. Run `npm run seed:nessie`. It creates or reuses a fictional customer, a checking account and one pending bill, and stores their ids. It is safe to rerun.
6. Run `npm start`, then `npm run smoke` (research and proposal). `npm run smoke -- --approve` also records one sandbox purchase.

## Scripts

| Script | Purpose |
|---|---|
| `npm start` / `npm run dev` | API (+ eve agent in live mode); `dev` restarts on change |
| `npm run start:fixtures` | Fixture mode with a separate database (`var/runway-fixtures.sqlite`) |
| `npm test` / `npm run typecheck` | Tests / TypeScript |
| `npm run openapi` | Regenerate `docs/openapi.json` from the Zod contracts |
| `npm run check:gemini`, `check:serpapi`, `probe:nessie` | Live adapter checks |
| `npm run seed:nessie` | Explicit sandbox seed; server startup never seeds |
| `npm run smoke [-- --approve]` | Acceptance client against a running server (`RUNWAY_URL` overrides the base URL) |

## Sign-in and roles (Clerk + Google)

1. **Create the Clerk application** (team-owned) with Google enabled. A development instance can use Clerk's shared Google credentials; production needs custom Google OAuth.
2. **Backend `.env`:** set `CLERK_SECRET_KEY` (server-only). Optionally set `CLERK_JWT_KEY` and `CLERK_AUTHORIZED_PARTIES`, which defaults to `FRONTEND_ORIGINS`.
3. **Allowlist:** copy `config/access.example.json` to `config/access.json` and list the team's real Google emails with `role` and `company`. Set `ACCOUNT_COMPANY_ID` to that company.
4. **Frontend:** uses the same Clerk app's publishable key and sends `Authorization: Bearer <getToken()>`.

How the modes behave:
- **Live mode:** always uses Clerk. Without `CLERK_SECRET_KEY`, protected routes return `503 AUTH_NOT_CONFIGURED`; nothing falls back to demo identities.
- **Fixtures mode:** defaults to the declared demo actors (`X-Demo-Actor`).

Details are in `docs/CONTRACT_V3_EXECUTIVE_AUTH.md`.

## Categories, projects and the manufacturing demo

- **Categories, not monitors.** A request's item category is resolved from its text (`src/domain/categories.ts`): monitors, office chairs, wood glue, cork sheets, wood screws.
  - When the category is ambiguous or contradicts the hint, the request asks rather than defaulting.
  - Category consistency is a mandatory eligibility check.
  - Search queries and cached results are bound to the confirmed category and requirement version.
  - To add a category or sector, add a profile.
- **Projects** group single-category request lines under one hard budget, with supplied inventory recorded but never purchased. See `docs/CONTRACT_V2.md`.
- **Demo:** `GET /api/v1/demo/manufacturing` returns the validated input (also in `demo/manufacturing-desk-organizers.json`): a small furniture manufacturer, five desk-organizer prototypes from leftover walnut and maple, buying glue, cork backing and screws for $100. POST it to `/api/v1/projects`, then call `/confirm` and `/research`.
- **Recommendations:** lowest known comparable cost, best deadline fit and best overall, chosen from compliant offers only. Cheaper offers that miss a hard deadline are listed separately as noncompliant alternatives.
- **Merchants:** approval requires an explicit seller → Nessie sandbox merchant mapping (`POST /api/v1/merchant-mappings`). Purchase history comes from `GET /accounts/{id}/purchases`; Nessie has no generic transactions endpoint.

## Layout

```
agent/            eve agent: agent.ts (Gemini direct, defaultTools:false), instructions.md, 5 tools, token-protected channel
src/contracts/    Zod schemas = public API contract (exported for the frontend)
src/domain/       pure logic: money, extraction, requirements, normalization, evaluation/ranking, budget
src/integrations/ SerpApi, Nessie, Gemini adapters + labeled fixture adapters
src/agent/        runner interface, eve runner, scripted fixture runner, tool schemas
src/services/     requests, research runs, proposals/decisions, executions, budget ledger, events
src/http/app.ts   /api/v1 routes, error envelope, CORS, internal tool callback
scripts/          checks, seed, smoke, OpenAPI generator
docs/             openapi.json, FRONTEND.md, NESSIE.md, ACCEPTANCE.md
```

## How the pieces fit

- **One agent engine, versioned configs.** Two saved configurations ship by default: `cfg_default` (exact specs, 2 searches, 3 product-detail lookups, budget tool on) and `cfg_broad_scan` (broad queries, 3 searches, 2 lookups, no budget tool, evidence-first ranking). Each run stores a snapshot of its configuration. Configurations can only tighten the environment caps, and they can only enable the six known tools.
- **SerpApi scope.** Only two engines are used: `google_shopping` to discover candidates, and `google_immersive_product`, SerpApi's product-page lookup for the current Shopping layout, to enrich shortlisted candidates by the token Shopping returns.
  - Calls are capped per run by the configuration, and a concurrency limit applies (`SERPAPI_MAX_CONCURRENCY`).
  - Each call has a timeout (`SERPAPI_TIMEOUT_MS`).
  - Safe reads retry with bounded backoff. A `Retry-After` of 5 s or less is waited out once; a longer one fails fast with `retryAfterSeconds`.
  - An exhausted plan is reported as `quota_exhausted`.
  - Paid research runs only when `POST .../research` is called.
- **Product-detail evidence.** Google Shopping titles rarely list ports. `getProductDetails` fetches the SerpApi product-spec page for one offer, using a token held server-side and never a URL, and adds cited spec evidence plus the matching seller's shipping and stock. When sources disagree, the requirement becomes `unknown` (conflicting).
- **Tools never take scope ids.** The eve tools call back to `POST /internal/agent-tools/:tool`, which accepts only loopback requests carrying the per-process token. The server resolves the run from the eve session id and enforces enablement, search caps, step caps and time caps. No tool can approve, submit, execute, fetch arbitrary URLs, run shell commands or read the environment.
- **Deterministic ranking.** `evaluateCandidates` in `src/domain/evaluate.ts` classifies each offer as `eligible`, `needs_review` or `rejected`, and ranks by eligibility, then known affordability, then lowest known cost, then evidence completeness, then offer id. The model's explanation is stored separately and never reorders anything.
- **Money path.** Approval rechecks evidence freshness and the bank, takes a durable reservation inside an `IMMEDIATE` SQLite transaction, persists `submitting` before the single Nessie POST, and stores the external id. Ambiguous failures become `uncertain`, keep the hold, and need reconciliation. Writes are never retried automatically.

## Limitations

- There is no real authentication. `employee-demo` and `executive-demo` are declared demo actors and every response carries `demoIdentity: true`. CORS restricts origins but is not authentication. Bind to loopback, or to a LAN address only on a trusted network.
- Only one category (monitors) and USD are supported. Extraction relies on listing text patterns and does not guarantee engineering compatibility.
- Tax is always unknown, and shipping is known only when the listing states it. Recording a purchase requires a user-confirmed exact amount.
- Nessie purchases are simulated sandbox records. No real money moves and no merchant order is placed. Nessie stores whole dollars, so cents are dropped; the execution shows the approved amount, the stored amount and the difference.
- Restarting the server loses the agent context of in-flight research runs. Those runs are marked `failed` with `INTERRUPTED`; their collected evidence is preserved.
