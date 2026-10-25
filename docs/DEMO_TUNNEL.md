# Demo hosting: local backend + Cloudflare quick tunnel

This is the hackathon setup. The backend runs on a laptop and a free Cloudflare quick tunnel gives it a public HTTPS URL. There's no hosting cost and no account. The Vercel/Supabase migration is paused; see `MIGRATION_HANDOFF.md` on branch `migrate/vercel-supabase`.

## Start or restart

```bash
cd backend && ./scripts/demo-tunnel.sh
```

- The launcher stops any previous backend or tunnel on the port, then starts `npm start`, which also starts the eve agent. Once the backend is healthy, it opens the tunnel.
- It then checks that public `/api/v1/health` returns 200 and that an unauthenticated `/api/v1/me` returns `UNAUTHENTICATED`.
- It prints `NEXT_PUBLIC_API_BASE_URL` and saves it to `backend/var/tunnel-url.txt`.
- Keep the terminal open. Ctrl-C stops both processes.
- Logs: `backend/var/demo-backend.log` and `backend/var/demo-tunnel.log`. Both are git-ignored.

## ⚠ The URL changes on every restart

A quick tunnel gets a **new random `https://<words>.trycloudflare.com` URL each time it starts**. That includes rerunning the launcher, a laptop reboot or sleep that kills it, and a network drop that ends `cloudflared`. After any restart:

1. Copy the new URL from the launcher output or `backend/var/tunnel-url.txt`.
2. Update `NEXT_PUBLIC_API_BASE_URL` in Vercel (Production).
3. Redeploy the frontend. `NEXT_PUBLIC_*` values are baked in at build time.

On demo day, start the launcher once, update Vercel once, and don't restart. While it runs, the launcher blocks idle sleep with `caffeinate`. Closing the lid on battery still sleeps the Mac, which makes the tunnel answer **530**. Keep it plugged in with the lid open. `cloudflared` reconnects on wake under the same URL as long as the process survives.

## Frontend settings for live mode (Vercel → Settings → Environment Variables, Production)

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_API_MODE` | `live` |
| `NEXT_PUBLIC_API_BASE_URL` | `https://<current-tunnel>.trycloudflare.com/api/v1` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | publishable key of the **same** Clerk app as `backend/.env` |
| `CLERK_SECRET_KEY` | the same Clerk app's secret, server-only (never `NEXT_PUBLIC_`) |

In Clerk, Google must be enabled, and the Vercel domain must be allowed for the app if Clerk requires it.

## Backend config this relies on (`backend/.env`, git-ignored)

- `AUTH_MODE=clerk`.
- `FRONTEND_ORIGINS=https://malakai-saleh-h26.vercel.app,http://localhost:3000,http://localhost:3001`. This list is also the Clerk authorized parties, because `CLERK_AUTHORIZED_PARTIES` is blank.
- `HOST=127.0.0.1`: only the tunnel exposes the backend.
- Roles come from `backend/config/access.json` (git-ignored).
- Data stays in `backend/var/runway.sqlite` on this laptop.

## Troubleshooting

- **The local `curl` of the tunnel URL fails right after start.** macOS cached a "not found" DNS answer while the hostname was still propagating. The launcher's checks resolve through 1.1.1.1. A browser on another network or phone, or a `dscacheutil -flushcache`, works.
- **Health is 200 but sign-in fails in the app.** Check that the frontend's Clerk key belongs to the same Clerk app as the backend, and that the frontend was redeployed after the URL changed.
- **The backend exits at start.** Read `backend/var/demo-backend.log`. It never contains secret values.
