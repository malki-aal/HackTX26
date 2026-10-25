// Ordered schema migrations. Money is integer cents; timestamps are ISO-8601 UTC strings.
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE actors (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), role TEXT NOT NULL, label TEXT NOT NULL);

CREATE TABLE agent_configs (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE agent_config_heads (id TEXT PRIMARY KEY, current_version INTEGER NOT NULL, FOREIGN KEY (id, current_version) REFERENCES agent_configs(id, version));

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  current_version INTEGER NOT NULL,
  confirmed_version INTEGER,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE request_versions (
  request_id TEXT NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL,
  fields TEXT NOT NULL,
  requirements TEXT NOT NULL,
  explicit_fields TEXT NOT NULL,
  change_note TEXT NOT NULL,
  material_change INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  PRIMARY KEY (request_id, version)
);
CREATE TABLE clarification_questions (
  id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id),
  request_version INTEGER NOT NULL,
  question TEXT NOT NULL,
  source TEXT NOT NULL,
  answer TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  request_version INTEGER NOT NULL,
  config_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  config_snapshot TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  search_calls INTEGER NOT NULL DEFAULT 0,
  agent_steps INTEGER NOT NULL DEFAULT 0,
  agent_session_id TEXT UNIQUE,
  agent_summary TEXT,
  financial_context TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (config_id, config_version) REFERENCES agent_configs(id, version)
);
CREATE INDEX runs_request ON runs(request_id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  run_id TEXT,
  request_id TEXT,
  proposal_id TEXT,
  execution_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_request ON events(request_id, seq);

CREATE TABLE search_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  query TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER,
  from_cache INTEGER NOT NULL,
  fetched_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE search_cache (
  cache_key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  query_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX offers_run ON offers(run_id);

CREATE TABLE evaluations (
  run_id TEXT NOT NULL REFERENCES runs(id),
  offer_id TEXT NOT NULL REFERENCES offers(id),
  rank INTEGER NOT NULL,
  class TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, offer_id)
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  current_version INTEGER NOT NULL,
  decision_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE proposal_versions (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  exact_amount_cents INTEGER,
  amount_source TEXT,
  technical_review_confirmed INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  PRIMARY KEY (proposal_id, version)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (proposal_id, proposal_version),
  FOREIGN KEY (proposal_id, proposal_version) REFERENCES proposal_versions(proposal_id, version)
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  mode TEXT NOT NULL,
  account_id TEXT NOT NULL,
  merchant_id TEXT,
  amount_cents INTEGER NOT NULL,
  provider_amount TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_status TEXT,
  external_id TEXT UNIQUE,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (proposal_id, proposal_version),
  FOREIGN KEY (proposal_id, proposal_version) REFERENCES proposal_versions(proposal_id, version)
);

CREATE TABLE financial_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  bills TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX financial_snapshots_account ON financial_snapshots(account_id, fetched_at);

CREATE TABLE budget_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reservation', 'expense')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  external_id TEXT,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (execution_id, kind)
);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idem_key)
);

CREATE TABLE integration_state (
  service TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  last_verified_at TEXT,
  last_error TEXT,
  detail TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE nessie_resources (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);
`,
  },
  {
    version: 2,
    sql: `
-- Opaque SerpApi product-page token, kept server-side and never returned to clients or the model.
ALTER TABLE offers ADD COLUMN detail_token TEXT;
CREATE TABLE detail_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  offer_id TEXT NOT NULL REFERENCES offers(id),
  status TEXT NOT NULL,
  from_cache INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
-- Amount Nessie actually stored (it keeps whole dollars), used to match balance changes.
ALTER TABLE budget_ledger ADD COLUMN provider_amount_cents INTEGER;
`,
  },
  {
    version: 4,
    sql: `
-- Projects group single-category request lines under one hard budget (multi-material demo).
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE requests ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE requests ADD COLUMN line_key TEXT;
CREATE UNIQUE INDEX requests_project_line ON requests(project_id, line_key) WHERE project_id IS NOT NULL;

-- Explicit researched-seller -> Nessie sandbox merchant mapping, with provenance.
CREATE TABLE merchant_mappings (
  seller_key TEXT PRIMARY KEY,
  seller_name TEXT NOT NULL,
  nessie_merchant_id TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('created_sandbox_merchant', 'linked_existing_merchant', 'legacy_auto_created')),
  merchant_snapshot TEXT NOT NULL,
  created_by TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO merchant_mappings (seller_key, seller_name, nessie_merchant_id, provenance, merchant_snapshot, created_by, note, created_at)
  SELECT lower(trim(json_extract(payload, '$.seller'))), json_extract(payload, '$.seller'), external_id, 'legacy_auto_created', '{}', 'system',
         'Created automatically at approval before explicit mapping existed', created_at
  FROM nessie_resources WHERE kind = 'merchant' AND json_extract(payload, '$.seller') IS NOT NULL;

-- Persisted confirmation details for executions.
ALTER TABLE executions ADD COLUMN approved_at TEXT;
ALTER TABLE executions ADD COLUMN provider_submitted_at TEXT;
ALTER TABLE executions ADD COLUMN recorded_at TEXT;
ALTER TABLE executions ADD COLUMN provider_retrieved_at TEXT;
ALTER TABLE executions ADD COLUMN account_masked TEXT;
ALTER TABLE executions ADD COLUMN merchant_mapping TEXT;
ALTER TABLE executions ADD COLUMN provider_purchase_date TEXT;
UPDATE executions SET approved_at = created_at WHERE approved_at IS NULL;
`,
  },
  {
    version: 5,
    sql: `
-- Authenticated identities. provider_user_id is the stable provider identity (Clerk user id).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  primary_email TEXT,
  primary_email_verified INTEGER NOT NULL DEFAULT 0,
  verified_emails TEXT NOT NULL DEFAULT '[]',
  avatar_style TEXT NOT NULL DEFAULT 'role_default',
  profile_synced_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_user_id)
);

-- Server-owned company membership and role. Only the bootstrap allowlist writes it.
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('employee', 'executive')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  source TEXT NOT NULL,
  matched_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
CREATE UNIQUE INDEX memberships_one_active ON memberships(user_id) WHERE status = 'active';

ALTER TABLE projects ADD COLUMN org_id TEXT REFERENCES organizations(id);
UPDATE projects SET org_id = 'org_demo' WHERE org_id IS NULL;

-- Decision notes and the immutable terms an approver confirmed.
ALTER TABLE decisions ADD COLUMN actor_display TEXT;
ALTER TABLE decisions ADD COLUMN confirmed_version INTEGER;
ALTER TABLE decisions ADD COLUMN confirmed_amount_cents INTEGER;
ALTER TABLE decisions ADD COLUMN confirmed_at TEXT;
ALTER TABLE decisions ADD COLUMN confirmation_statement TEXT;
`,
  },
  {
    version: 6,
    sql: `
-- Approval moves money to the employee: an execution is now a company -> employee transfer.
-- Older executions stay 'purchase' (company paid the merchant directly) and keep their meaning.
ALTER TABLE executions ADD COLUMN kind TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'transfer'));
ALTER TABLE executions ADD COLUMN payee_user_id TEXT;
ALTER TABLE executions ADD COLUMN payee_account_id TEXT;

-- One Nessie sandbox customer + checking account per employee, created on their first approval.
CREATE TABLE employee_accounts (
  user_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  customer_id TEXT,
  account_id TEXT,
  account_masked TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The employee paying the seller from their account. At most one payment per approved transfer.
CREATE TABLE employee_payments (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitting', 'recorded', 'failed', 'uncertain')),
  provider_status TEXT,
  external_id TEXT,
  provider_amount TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recorded_at TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 7,
    sql: `
-- The shortlist shown for a research run (labels and explanations), saved once when the run ends.
ALTER TABLE runs ADD COLUMN shortlist TEXT;
`,
  },
];
