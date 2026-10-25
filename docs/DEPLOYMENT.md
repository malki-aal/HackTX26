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
| `NESSIE_CUSTOMER_ID`, `NESSIE_ACCOUNT_ID` | no | ids from `npm run seed:nessie` (local `backend/.env`) |
| `CLERK_SECRET_KEY` | yes | Clerk secret from the same Clerk app as the frontend |
| `FRONTEND_ORIGINS` | no | the Vercel origin, e.g. `https://malakai-saleh-h26.vercel.app` (no trailing slash, no path). Also used as the Clerk authorized party. |
| Secret file `access.json` | yes (emails) | see below |
| Preset in `render.yaml` | no | `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=8000`, `INTEGRATION_MODE=live`, `AUTH_MODE=clerk`, `DEMO_MODE=false`, `DATABASE_PATH=/data/runway.sqlite` (persistent disk), `ACCESS_BOOTSTRAP_FILE=/etc/secrets/access.json`, `ACCOUNT_COMPANY_ID=runway_team` |

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
4. Environment → Secret Files → add `access.json` with this shape, using the real Google emails:
   ```json
   { "companies": [{ "id": "runway_team", "name": "Runway HackTX team" }],
     "members": [
       { "email": "<executive google email>", "role": "executive", "company": "runway_team" },
       { "email": "<employee google email>", "role": "employee", "company": "runway_team" } ] }
   ```
   Only provider-verified emails match. The file is re-read when it changes.
5. Deploy, then open `https://<backend>/api/v1/health`. It should return 200.
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
