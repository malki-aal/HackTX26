// Generates docs/openapi.json from the shared Zod contracts.
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as C from "../src/contracts/index.js";

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
const envelope = (data: Record<string, unknown>) => ({ type: "object", required: ["data", "meta"], properties: { data, meta: { $ref: "#/components/schemas/Meta" } } });
const errorRef = { $ref: "#/components/schemas/ApiError" };
const json = (s: unknown) => ({ "application/json": { schema: s } });
const obj = { type: "object", description: "See docs/FRONTEND.md for the full field list" };

type Op = { summary: string; body?: string; status?: number; data?: Record<string, unknown>; params?: string[]; query?: Array<[string, string]>; headers?: string[] };
const op = (o: Op) => ({
  summary: o.summary,
  parameters: [
    ...(o.params ?? []).map((p) => ({ name: p, in: "path", required: true, schema: { type: "string" } })),
    ...(o.query ?? []).map(([n, d]) => ({ name: n, in: "query", required: false, description: d, schema: { type: "string" } })),
    ...(o.headers ?? []).map((h) => ({ name: h, in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } })),
  ],
  ...(o.body ? { requestBody: { required: true, content: json({ $ref: `#/components/schemas/${o.body}` }) } } : {}),
  responses: {
    [String(o.status ?? 200)]: { description: "OK", content: json(envelope(o.data ?? obj)) },
    "4XX": { description: "Client error", content: json(errorRef) },
    "5XX": { description: "Server or upstream error", content: json(errorRef) },
  },
});

const doc = {
  openapi: "3.1.0",
  info: { title: "Runway API", version: "1.0.0", description: "Runway purchasing backend. Demo identities only (demoIdentity=true); no authentication. All money is integer USD cents. Timestamps are ISO-8601 UTC." },
  servers: [{ url: "http://127.0.0.1:8000" }],
  paths: {
    "/api/v1/health": { get: op({ summary: "Server and storage liveness (no external calls)" }) },
    "/api/v1/integrations/status": { get: op({ summary: "Per-service configuration and last verified state (no secrets, no paid calls)", data: { type: "array", items: { $ref: "#/components/schemas/IntegrationStatus" } } }) },
    "/api/v1/agent-configs": { get: op({ summary: "List agent configurations (current versions)" }), post: op({ summary: "Create a configuration", body: "CreateAgentConfigBody", status: 201, data: { $ref: "#/components/schemas/AgentConfig" } }) },
    "/api/v1/agent-configs/{id}": { patch: op({ summary: "Create the next configuration version", body: "PatchAgentConfigBody", params: ["id"], data: { $ref: "#/components/schemas/AgentConfig" } }) },
    "/api/v1/requests": { post: op({ summary: "Create a draft request with initial requirements and clarification questions", body: "CreateRequestBody", status: 201 }), get: op({ summary: "Paginated request list", query: [["limit", "1-100"], ["cursor", "from meta.nextCursor"], ["status", "filter"]] }) },
    "/api/v1/requests/{id}": { get: op({ summary: "Full current request", params: ["id"] }), patch: op({ summary: "Version-checked edit; creates a new version", body: "PatchRequestBody", params: ["id"] }) },
    "/api/v1/requests/{id}/clarify": { post: op({ summary: "Submit clarification answers (empty answers returns current questions)", body: "ClarifyBody", params: ["id"] }) },
    "/api/v1/requests/{id}/confirm": { post: op({ summary: "Confirm an exact requirement version", body: "ConfirmBody", params: ["id"] }) },
    "/api/v1/requests/{id}/research": { post: op({ summary: "Start bounded asynchronous research", body: "ResearchBody", params: ["id"], status: 202, data: { type: "object", properties: { runId: { type: "string" }, status: { const: "queued" }, requestVersion: { type: "integer" } } } }) },
    "/api/v1/requests/{id}/candidates": { get: op({ summary: "Ranked candidate evaluations for a run (defaults to latest)", params: ["id"], query: [["runId", "run id"]] }) },
    "/api/v1/requests/{id}/events": { get: op({ summary: "Cursor-based request activity", params: ["id"], query: [["after", "cursor"], ["limit", "1-500"]] }) },
    "/api/v1/requests/{id}/proposals": { post: op({ summary: "Save an immutable proposal revision (pass proposalId to revise)", body: "CreateProposalBody", params: ["id"], status: 201 }) },
    "/api/v1/runs/{id}": { get: op({ summary: "Poll run state", params: ["id"] }) },
    "/api/v1/runs/{id}/events": { get: op({ summary: "Cursor-based run events", params: ["id"], query: [["after", "cursor"], ["limit", "1-500"]] }) },
    "/api/v1/runs/{id}/cancel": { post: op({ summary: "Cancel future work; completed evidence is preserved", params: ["id"] }) },
    "/api/v1/budget": { get: op({ summary: "Account context with freshness and reservations", query: [["refresh", "true to read Nessie now"]], data: { $ref: "#/components/schemas/FinancialContext" } }) },
    "/api/v1/proposals": { get: op({ summary: "Review/history list", query: [["decisionState", "filter"], ["limit", "1-200"]] }) },
    "/api/v1/proposals/{id}": { get: op({ summary: "Proposal with decision, execution and budget assessment", params: ["id"] }) },
    "/api/v1/proposals/{id}/submit": { post: op({ summary: "Confirm technical review and exact amount; submit for review", body: "SubmitProposalBody", params: ["id"] }) },
    "/api/v1/proposals/{id}/decision": { post: op({ summary: "Executive decision (approve executes one Nessie sandbox purchase)", body: "DecisionBody", params: ["id"], headers: ["Idempotency-Key"] }) },
    "/api/v1/executions/{id}": { get: op({ summary: "Execution status and external reference", params: ["id"] }) },
    "/api/v1/executions/{id}/reconcile": { post: op({ summary: "Check Nessie for the outcome; never blindly resends", body: "ReconcileBody", params: ["id"] }) },
  },
  components: {
    schemas: {
      Meta: schema(C.Meta),
      ApiError: schema(C.ApiError),
      IntegrationStatus: schema(C.IntegrationStatus),
      CreateRequestBody: schema(C.CreateRequestBody),
      PatchRequestBody: schema(C.PatchRequestBody),
      ClarifyBody: schema(C.ClarifyBody),
      ConfirmBody: schema(C.ConfirmBody),
      ResearchBody: schema(C.ResearchBody),
      Requirement: schema(C.Requirement),
      Offer: schema(C.Offer),
      CandidateEvaluation: schema(C.CandidateEvaluation),
      FinancialContext: schema(C.FinancialContext),
      BudgetAssessment: schema(C.BudgetAssessment),
      AgentConfig: schema(C.AgentConfig),
      CreateAgentConfigBody: schema(C.CreateAgentConfigBody),
      PatchAgentConfigBody: schema(C.PatchAgentConfigBody),
      CreateProposalBody: schema(C.CreateProposalBody.extend({ proposalId: z.string().optional() })),
      SubmitProposalBody: schema(C.SubmitProposalBody),
      DecisionBody: schema(C.DecisionBody),
      ReconcileBody: schema(C.ReconcileBody),
      RunEventType: schema(C.RunEventType),
      ErrorCode: schema(C.ErrorCode),
    },
  },
};
mkdirSync("docs", { recursive: true });
writeFileSync("docs/openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote docs/openapi.json (${Object.keys(doc.paths).length} paths)`);
