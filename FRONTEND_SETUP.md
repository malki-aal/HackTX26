# Frontend setup

The frontend lives in `frontend/` and uses Next.js App Router, React, TypeScript, Tailwind CSS, and ESLint.

From the repository root:

```sh
cd frontend
npm run dev
```

Open http://localhost:3000. To check changes, run `npm run lint` and `npm run build` from `frontend/`.

See `FRONTEND_HANDOFF.md` for the screens, backend connection and what is still missing.

For Vercel, import malki-aal/HackTX26 after pushing your frontend branch and set Root Directory to `frontend`. Use the Next.js preset. Deployment is not configured yet.
