// Shared callback used by every agent tool. Tools are thin: the Runway server validates input,
// derives run/request/account scope from the eve session id, enforces limits and executes.
export async function callRunway(tool: string, sessionId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const url = process.env.RUNWAY_INTERNAL_URL;
  const token = process.env.RUNWAY_INTERNAL_TOKEN;
  if (!url || !token) return { error: "Runway server callback is not configured" };
  const res = await fetch(`${url}/internal/agent-tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-agent-session-id": sessionId },
    body: JSON.stringify(input ?? {}),
    signal,
  });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { result?: unknown; error?: string };
  if (body.error) return { error: body.error };
  return body.result;
}
