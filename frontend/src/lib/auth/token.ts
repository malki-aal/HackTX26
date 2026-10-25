// Bridge between the auth provider (React) and the API adapter (plain module).
// The adapter asks for a fresh token on every call; it never stores one.

type TokenProvider = () => Promise<string | null>;

let provider: TokenProvider | null = null;

export function setTokenProvider(fn: TokenProvider | null) {
  provider = fn;
}

export async function getAuthToken(): Promise<string | null> {
  if (!provider) return null;
  try {
    return await provider();
  } catch {
    return null;
  }
}

/** Fired when the backend answers 401, so the UI can ask the person to sign in again. */
export const UNAUTHORIZED_EVENT = "runway:unauthorized";
