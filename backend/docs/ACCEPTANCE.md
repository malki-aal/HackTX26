# Acceptance report

Date: 2026-10-24. Branch: `feat/runway-backend`.

## Automated (no network): 60/60 passing (`npm test`)

**Unit tests** (`test/domain.test.ts`) cover:
- integer-cent parsing, float drift, and rejection of NaN, Infinity, negative and non-USD values;
- request validation: string versus number, quantity bounds, currency;
- extraction: 1440p vs 1080p, 144 Hz is not a resolution, HDMI vs USB-C, screen sizes, accessory vs monitor, multipacks;
- requirement derivation, preferences, rejecting model requirements whose source text is missing, clarification questions only when needed;
- evaluation: contradicted → rejected, unknown → needs_review, installment prices excluded, multipack cost, stable ranking and tie-breaks, known budget violations, non-USD rejection, dedup that keeps different sellers;
- budget: obligations, reservations, unreflected expenses, remote balance changing vs unchanged, unexplained changes, assessment states.

**Integration tests** (`test/flow.test.ts`, Fastify inject with controlled fixture adapters and the scripted runner) cover:
- the full flow: clarification → confirmation → research → proposal → approval → sandbox execution, with the expected event sequence;
- no research before confirmation and no decision before submission;
- input validation over HTTP;
- configuration limits and enabled tools change behavior (1 vs 2 searches, budget tool off); config versioning and version conflicts; environment caps; unknown tools rejected; step limit stops the agent;
- SerpApi rate-limit failure; malformed and empty provider data; no results and no confirmed match as completed runs; cancellation and RUN_ALREADY_ACTIVE;
- prompt-injection listing: flagged needs_review, no execution, no secret in responses, events or DB; internal tool route rejects requests without the token or from non-loopback addresses;
- fixture mode never builds a live bank adapter; MODE_MISMATCH blocks a fixture proposal in live mode;
- rejected candidates can't be proposed; stale offers return OFFER_STALE; submitted requests are locked; changed requirements invalidate the proposal;
- duplicate submit and duplicate/concurrent approval return one logical result with one provider call; same key with a different body returns IDEMPOTENCY_CONFLICT;
- two concurrent approvals cannot oversubscribe the budget;
- missing bank context blocks execution but not research;
- definite failure releases the hold; ambiguous timeout keeps it; reconciliation never resends; a lost response is found by reference with no duplicate;
- restart turns `submitting` into `uncertain` and fails interrupted runs; saved state survives restart.

## Process-level checks (fixtures mode, real HTTP server)

`npm run start:fixtures` + `npm run smoke -- --approve`: the full flow ran over HTTP. 2 searches, 6 agent steps (scripted runner), 4 eligible / 2 needs review / 4 rejected; proposal submitted; approval recorded fixture purchase `fixture_purchase_1`; idempotent replay returned the same execution; budget showed the expense subtracted once.

`eve info`: agent discovered with status ready, 0 diagnostics, and exactly the Runway tools (now 6, with `get_product_details`; no bash, file, web or subagent tools).

Live-mode process check, without keys: `npm start` ran `eve build` and started the eve runtime on loopback. `integrations/status` reported `agent_runtime: ok` through the token-authenticated client. An unauthenticated `POST /eve/v1/session` returned 401. Ctrl+C stopped both processes. No model call was made.

## Live verification (2026-10-24, team keys)

| Step | Result |
|---|---|
| 1. Gemini | Key lists 34 models. `gemini-3.6-flash`: structured extraction correct (HDMI required, "USB-C would be nice" kept as a preference); tool calling 1 call, 2 steps, correct answer. Final model used: **`gemini-3.5-flash-lite`** (see quota notes). |
| 2. SerpApi | `27 inch 1440p monitor HDMI` returned 40 live offers. Only 1 of 40 mentions HDMI in listing text. The product-detail endpoint returns structured specs such as `Connector Type = HDMI, DisplayPort` and per-store shipping and stock. |
| 3. Nessie read | `GET /customers` 200; seeded customer, account ($25,000) and pending bill ($1,500); account read verified; rerunning the seed created nothing new. |
| 4. Full research run | `run_a70faf1ecfe444ba` (eve + Gemini 3.5 Flash Lite): 7 agent steps, 2 searches over 79 offers, bank check ($23,500 available), deterministic evaluation **1 eligible / 37 needs review / 41 rejected**, outcome `candidates_found`. Top: Crua 27" 4K UHD (HDMI & DP), Walmart – CRUA Technology, $146.89 × 4 = **$587.56**, free shipping, tax unknown. The model's explanation cited only real checks and the real offer id. |
| 5. Approved purchase | `prop_fe3b4144f3f44b5f` approved by `executive-demo` → execution `exe_e35ac862231a4804` **recorded**, Nessie purchase `56b93197-ef98-45cf-8f88-6aee8d0e7cd9`, provider status `pending`. Replaying the same Idempotency-Key returned the same execution. |
| 6. Read-back and balance | `GET /purchase/{id}` → amount **587** (Nessie stores whole dollars; $0.56 discrepancy recorded), status pending. Balance **unchanged** at $25,000, so the expense stays subtracted locally: available $23,500.00 → **$22,912.44**. |

### Issues found live and fixed

- Real Google Shopping titles rarely state ports, so nearly everything was "unknown". Added a bounded, config-gated `getProductDetails` tool. It looks up SerpApi product specs using a server-held token (never a URL), caps calls per run, and feeds the same deterministic checks; conflicting evidence becomes unknown.
- Parts were classed as monitors ("Monitor … Button Board", "Replacement Power Board") and "VESA Wall Mount Ready" as an accessory. Fixed with feature-phrase stripping; real titles were added as tests.
- Seller storefronts such as "Walmart - B2B Renew" are now condition evidence (refurbished).
- Nessie: bills created without `payment_date` break every later bill listing (seed fixed; the existing bill was repaired with `PUT /bills/{id}`); merchant `category` must be a string; amounts are whole dollars (now tracked).
- After a restart, eve's durable local store resumed old agent sessions, which kept spending model quota. Startup now clears eve's local session store; Runway already fails interrupted runs explicitly.
- Gemini errors are now unwrapped and mapped (`UPSTREAM_RATE_LIMITED` with Google's message), and integration status reflects real outcomes.

### Gemini free-tier quota (important for the demo)

- The key is on the free tier: **5 requests/minute and 20 requests/day per model**. One research run uses about 7–10 model calls.
- `gemini-2.5-flash` is retired for new users. `gemini-3.8-flash` returned 503 "high demand", and `gemini-3.7-flash` took about 50 seconds per call.
- **`gemini-3.5-flash` shares the `gemini-3.6-flash` daily bucket**: Google's 429 names `gemini-3.6-flash` as the quota dimension.
- Today's 3.6 bucket was spent by checks plus two runs that hit the per-minute limit. The completed run used `gemini-3.5-flash-lite`, which has its own bucket.
- `GEMINI_MAX_RPM=4` now paces agent calls so the per-minute limit doesn't fail runs. For the demo, use a paid key, or budget about 2 runs per model per day.

### Not verified live

- The Lite model skipped the optional `getProductDetails` step in the completed run. The detail tool itself was verified live in an earlier run with `gemini-3.6-flash` (3 parallel calls; eligible candidates rose from 1 to 2), before that run hit the quota.
- Nessie posting the purchase (pending → completed) and any resulting balance change were not observed; the reconciliation code for that case is covered by tests only.
- An ambiguous Nessie write (timeout) was not induced live; it is covered by tests only.

---

# v2 (mentor feedback), 2026-10-25

No live API calls were made this round; everything below ran against fixtures.

## Automated: 90/90 passing (`npm test`), backend typecheck clean, frontend `lint` and `build` clean

New tests:
- **Category bug regression (`test/category.test.ts`):**
  - A "Chairs" request sent with the frontend's old `category: "monitors"` hint becomes a category conflict, not monitors.
  - After choosing office chairs, monitor listings, even when the provider returns only monitors, are rejected ("Listing is a monitor, not an office chair"), queries name office chairs, the label is accurate, and the outcome is `no_confirmed_match`.
  - With category-appropriate results, only a real chair qualifies; the monitor, seat cushion and chair mat are rejected.
  - Unrecognized items ask instead of defaulting.
  - Results and caches are bound to the request version: after an edit, old results are not current and never shown as eligible.
- **Materials:** volume, dimensions (in/ft/mm), thickness, screw size (#gauge × fractional inch) and piece counts; packs needed for 40 screws and 5 sheets; wrong-size, glue-gun, wine-cork and screwdriver listings rejected.
- **Deadlines and recommendations:**
  - Hard vs target deadlines are handled.
  - A cheaper late offer is noncompliant under a hard deadline, never recommended.
  - Identical winners are merged.
  - Unknown shipping, tax, stock and delivery stay unknown.
- **Manufacturing demo (`test/manufacturing.test.ts`):** the demo input validates; three confirmed lines with the right units; lowest compliant total $42.93; the project hard cap blocks an over-cap approval with details.
- **Merchant mapping:** approval blocked without a mapping, with nothing reserved or written; employee role forbidden; link requires an existing Nessie merchant; provenance recorded; duplicates refused.
- **Confirmation and activity:** persisted ids, requester and approver, masked account, seller and mapped merchant, approved vs stored amount with discrepancy, provider id and status, all timestamps; no fulfillment claims. Activity separates awaiting approval, uncertain execution and provider-pending items.
- **Purchase history:** joins Runway executions with account purchases; external purchases are labeled.
- **Rate limiting:** `Retry-After` parsing; a short wait is retried; a long wait is surfaced with the seconds; an exhausted quota is non-retryable; a rate-limited run fails with a clear code; the concurrency cap holds.
- **UI regressions found end to end:** "36 x 48 inch" is no longer read as a 36-pack; "Armless" contradicts the armrests requirement.

## End-to-end with the frontend (fixtures backend + `next start`, driven in a browser)

1. **UI:** a new request "Chairs", quantity 12, $2,000, must-have "Armrests".
   - The backend resolved office chairs with no category hint and asked no questions.
   - Confirm and research.
   - Offers: the ergonomic office chair is eligible at $1,548; the armless chair, seat cushion, chair mat and monitor are rejected.
2. **UI:** opened the offer and submitted a proposal with a user-confirmed $1,659.12.
3. **API (no executive screen exists):**
   - The approval without a mapping returned `MERCHANT_MAPPING_REQUIRED`.
   - Mapping as employee-demo returned `FORBIDDEN_ACTOR`.
   - The executive linked an existing sandbox merchant (provenance recorded) and approved; the fixture purchase was recorded.
4. **UI:** the proposal page showed Approved, "Recorded in Nessie sandbox", approved and stored amounts, Nessie status `pending`, the reference, and the no-real-money disclaimer.
5. **API:** the manufacturing demo project ran end to end.
   - Totals: lowest compliant total $42.93; three approvals each needed a mapping first; replaying an approval returned the same execution; committed $45.54 of $100.
   - Confirmation record, activity and purchase history were checked.

The end-to-end run found a fixture-only defect: in-memory fixture purchase ids repeated after a restart. The safety path held: the execution was marked `uncertain` instead of recorded or retried. Fixture ids are now unique per boot.

## Not verified live this round

Category-aware SerpApi queries for chairs and materials, real Google Shopping evidence quality for glue, cork and screws, `GET /merchants/{id}` live, merchant creation through the new mapping endpoint, and the purchase-history join against the live account. A live run costs SerpApi and Gemini quota and needs an explicit go-ahead.
