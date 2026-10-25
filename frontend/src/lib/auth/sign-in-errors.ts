// Turns a failed Google sign-in start into something a person can act on. Clerk's errors sometimes
// arrive with an empty message (seen on its development instance as a bare HTTP 500), which used to
// leave the page silent with nothing to retry.
interface ClerkLikeError {
  message?: unknown;
  status?: unknown;
  errors?: Array<{ code?: string; message?: string; longMessage?: string }>;
}

export function signInErrorMessage(e: unknown): string {
  const err = (e ?? {}) as ClerkLikeError;
  const detail = err.errors?.[0];
  const text = detail?.longMessage || detail?.message || (typeof err.message === "string" ? err.message.trim() : "");
  if (text) return text;
  const status = typeof err.status === "number" ? err.status : null;
  if (status === 429) return "Too many sign-in attempts right now. Wait a minute, then try again once.";
  if (status !== null && status >= 500) {
    return `The sign-in service didn’t respond properly (HTTP ${status}). Wait a few seconds, then try again once.`;
  }
  return "Couldn’t start Google sign-in. Wait a few seconds, then try again once.";
}
