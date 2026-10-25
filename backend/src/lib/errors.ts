import type { ErrorCode } from "../contracts/api.js";
import { scrub } from "./redact.js";

/** A domain/API error with a stable code and HTTP status. Messages must be safe to show clients. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(scrub(message));
  }
}

export const notFound = (what: string, id: string) => new AppError("NOT_FOUND", `${what} ${id} not found`, 404);
export const versionConflict = (expected: number, actual: number) =>
  new AppError("VERSION_CONFLICT", `Version ${expected} is not current (current is ${actual})`, 409, false, { currentVersion: actual });
export const invalidState = (message: string, details: Record<string, unknown> = {}) => new AppError("INVALID_STATE", message, 409, false, details);

/**
 * Failure talking to an external service. `outcome` distinguishes a definite failure from an
 * ambiguous one where a write may or may not have taken effect.
 */
export class IntegrationError extends AppError {
  constructor(
    public readonly service: "gemini" | "serpapi" | "nessie" | "agent_runtime",
    code: ErrorCode,
    message: string,
    public readonly outcome: "definitive" | "ambiguous",
    retryable: boolean,
    public readonly httpStatus: number | null = null,
    extra: Record<string, unknown> = {},
  ) {
    super(code, message, code === "INTEGRATION_NOT_CONFIGURED" ? 503 : code === "UPSTREAM_RATE_LIMITED" ? 429 : code === "UPSTREAM_TIMEOUT" ? 504 : 502, retryable, { service, httpStatus, ...extra });
  }
}
