# Deploying Runway

Two hosts. Secrets are typed only into each host's dashboard. They are never committed, pasted into chat, or logged.

| Piece | Host | Why |
| --- | --- | --- |
| Frontend (`frontend/`) | Vercel (already connected to GitHub `main`) | Static/Next.js |
| Backend (`backend/`) | Render (blueprint in `render.yaml`) | Needs a long-running Node 24 process and a persistent disk for SQLite. Vercel can't host it. |

**Order matters:** deploy the backend first, confirm it is reachable, then switch the frontend to live. Until then the Vercel site stays in sample-data mode.

## Variables by host (names only)

### Backend host (Render)

| Name | Secret? | Value |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Gemini key |
| `GEMINI_MODEL` | no | run `npm run check:gemini` locally to pick one |
| `SERPAPI_API_KEY` | yes | SerpApi key |
| `NESSIE_API_KEY` | yes | Nessie sandbox key |
| `NESSIE_CUSTOMER_ID`, `NESSIE_ACCOUNT_ID` | no | ids from `npm run seed:nessie` (local `backend/.env`). **`NESSIE_ACCOUNT_ID` is required on the host:** the hosted database starts empty, so the locally seeded id is not there to fall back on. |
| `CLERK_SECRET_KEY` | yes | Clerk secret from the same Clerk app as the frontend |
| `FRONTEND_ORIGINS` | no | the Vercel origin, e.g. `https://malakai-saleh-h26.vercel.app` (no trailing slash, no path). Also used as the Clerk authorized party. |
| Allowlist: Secret File `access.json` **or** `ACCESS_BOOTSTRAP_JSON` | yes (emails) | see step 4. Use one, not both (the env var wins if both are set). |
| `CLERK_AUTHORIZED_PARTIES` | no | optional; defaults to `FRONTEND_ORIGINS` |
| Preset in `render.yaml` | no | `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=8000`, `INTEGRATION_MODE=live`, `AUTH_MODE=clerk`, `DEMO_MODE=false`, `DATABASE_PATH=/data/runway.sqlite` (persistent disk), `ACCESS_BOOTSTRAP_FILE=/etc/secrets/access.json`, `ACCOUNT_COMPANY_ID=runway_team`, `GEMINI_MAX_RPM=4` |
| Preset in the `Dockerfile` | no | `RUNWAY_SKIP_AGENT_BUILD=1`. The eve agent is built at image build time (no keys needed), so boot takes about a second and health checks pass right away. |

### Frontend host (Vercel → Project → Settings → Environment Variables, Production)

| Name | Secret? | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_API_MODE` | no | `live` |
| `NEXT_PUBLIC_API_BASE_URL` | no | `https://<your-backend>.onrender.com/api/v1` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | no (browser key) | Clerk publishable key |
| `CLERK_SECRET_KEY` | yes, server-only | Clerk secret key. Never use a `NEXT_PUBLIC_` name for it. |

`NEXT_PUBLIC_*` values are baked in at build time, so changing them needs a redeploy.

## Backend steps (you do these; they need your logins)

1. Sign in at render.com with GitHub and grant access to `malki-aal/HackTX26`.
2. New → Blueprint → select the repo. Render reads `render.yaml` and creates `runway-backend` with a 1 GB disk (disk needs the Starter plan).
3. Fill the `sync: false` fields from the table above when prompted (or later under Environment).
4. Add the allowlist in **one** of two ways:
   - **Secret file:** Environment → Secret Files → `access.json` (Render serves it at `/etc/secrets/access.json`, which is `ACCESS_BOOTSTRAP_FILE`). Leave `ACCESS_BOOTSTRAP_JSON` empty.
   - **Env var** (for hosts without secret files, e.g. Railway or Fly): paste the same JSON on one line into `ACCESS_BOOTSTRAP_JSON`.

   Malformed JSON stops the server at boot. The error names only the field path, never an email or the text. Change the env var and redeploy to update it; the file is re-read live. Use this shape with the real Google emails:
   ```json
   { "companies": [{ "id": "runway_team", "name": "Runway HackTX team" }],
     "members": [
       { "email": "<executive google email>", "role": "executive", "company": "runway_team" },
       { "email": "<employee google email>", "role": "employee", "company": "runway_team" } ] }
   ```
   Only provider-verified emails match. The file is re-read when it changes.
5. Deploy, then open `https://<backend>/api/v1/health`. It should return 200 with `"auth":{"mode":"clerk","configured":true}`. The boot log should say `access allowlist source: ACCESS_BOOTSTRAP_FILE` (or `_JSON`). If it says `none`, every account will stay "Access pending".
   - The hosted database starts empty, so an executive must re-create the merchant mappings from the app before the first approval. Approvals stay blocked with `MERCHANT_MAPPING_REQUIRED` until then.
   - The frontend's `NEXT_PUBLIC_API_BASE_URL` is `https://<service-name>.onrender.com/api/v1`, with no trailing slash.
6. In the Clerk dashboard, add the Vercel domain to the allowed origins for the app, and confirm Google is enabled as a social connection.
7. Auto-deploy: Render redeploys on push to `main` (`autoDeploy: true`).

## Frontend steps

1. Only after step 5 above passes: enter the four variables in Vercel (Production).
2. Redeploy (Deployments → ⋯ → Redeploy). The Git connection to `main` stays as is.

## Verification (two devices, no paid actions)

- Phone A signs in with the executive Google account → lands on `/executive`.
- Phone B signs in with the employee account → lands on `/`, no company budget visible.
- A third Google account → "Access pending".
- Employee opens `/executive` → "No approval access"; `GET /budget` as employee returns null figures.
- Create a draft request on B and confirm it shows on A's list. Do **not** start research (Gemini and SerpApi cost) and do **not** approve (writes a Nessie purchase) without explicit go-ahead.

## Rotating keys

A Clerk secret was shared in chat during development. Rotate it in Clerk, then update it in Vercel and Render and redeploy both.
