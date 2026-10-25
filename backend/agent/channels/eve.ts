// Only the Runway server (holding the per-process internal token) may reach this agent.
import { timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import { extractBearerToken, withAuthChallenges, type AuthFn } from "eve/channels/auth";

const runwayServer: AuthFn<Request> = withAuthChallenges((request) => {
  const expected = process.env.RUNWAY_INTERNAL_TOKEN;
  const given = extractBearerToken(request.headers.get("authorization"));
  if (!expected || !given) return null;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { authenticator: "runway-internal", principalId: "runway-server", principalType: "service", attributes: {} };
}, [{ scheme: "Bearer" }]);

export default eveChannel({ auth: [runwayServer] });
