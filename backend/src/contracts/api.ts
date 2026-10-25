// API envelope and error contracts.
import { z } from "zod";

export const ErrorCode = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "INVALID_STATE",
  "REQUIREMENTS_UNCONFIRMED",
  "RUN_ALREADY_ACTIVE",
  "INTEGRATION_NOT_CONFIGURED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_ERROR",
  "NO_CONFIRMED_MATCH",
  "OFFER_STALE",
  "CONFIRMATION_REQUIRED",
  "BUDGET_EXCEEDED",
  "BANK_CHECK_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "EXECUTION_UNCERTAIN",
  "MODE_MISMATCH",
  "CATEGORY_UNRESOLVED",
  "FORBIDDEN_ACTOR",
  "MERCHANT_MAPPING_REQUIRED",
  "UNAUTHENTICATED",
  "AUTH_NOT_CONFIGURED",
  "ACCESS_PENDING",
  "FORBIDDEN_ROLE",
  "IDENTITY_FIELD_NOT_ALLOWED",
  "TERMS_CHANGED",
  "SELF_APPROVAL_NOT_ALLOWED",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});

export const Meta = z.object({
  mode: z.enum(["live", "fixtures"]),
  demoIdentity: z.literal(true),
  requestId: z.string(),
  nextCursor: z.string().nullable().optional(),
});

export const IntegrationService = z.enum(["gemini", "serpapi", "nessie", "agent_runtime"]);
export const IntegrationStatus = z.object({
  service: IntegrationService,
  configured: z.boolean(),
  mode: z.enum(["live", "fixtures"]),
  state: z.enum(["unverified", "ok", "degraded", "error", "not_configured", "fixture"]),
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
