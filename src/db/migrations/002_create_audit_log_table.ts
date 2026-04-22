/**
 * Database migration: Create audit_log table
 *
 * Provides a persistent, append-only audit trail for all user actions,
 * admin operations, and API calls. Rows are never updated or deleted —
 * only inserted — to preserve tamper-evidence.
 *
 * MIGRATION: 002_create_audit_log_table
 */

export const up = `
CREATE TABLE IF NOT EXISTS audit_log (
  -- Monotonically increasing primary key (within this DB file)
  id        INTEGER PRIMARY KEY AUTOINCREMENT,

  -- ISO-8601 timestamp at the moment the event was recorded
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Action category, e.g. STREAM_CREATED, ADMIN_PAUSE_SET, API_CALL
  action    TEXT NOT NULL,

  -- Actor identity: Stellar address, "system", "admin", or "anonymous"
  actor     TEXT NOT NULL DEFAULT 'anonymous',

  -- Role of the actor at the time of the action
  actor_role TEXT NOT NULL DEFAULT 'unknown',

  -- Resource type affected, e.g. "stream", "admin", "session"
  resource_type TEXT NOT NULL DEFAULT '',

  -- Identifier of the affected resource (empty string when N/A)
  resource_id   TEXT NOT NULL DEFAULT '',

  -- HTTP method of the originating request (empty for internal events)
  http_method   TEXT NOT NULL DEFAULT '',

  -- Request path (empty for internal events)
  http_path     TEXT NOT NULL DEFAULT '',

  -- HTTP status code of the response (0 for internal events)
  http_status   INTEGER NOT NULL DEFAULT 0,

  -- Correlation ID from the originating HTTP request
  correlation_id TEXT NOT NULL DEFAULT '',

  -- Outcome: "success" | "failure" | "denied"
  outcome   TEXT NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'failure', 'denied')),

  -- Arbitrary JSON metadata (amounts, addresses, error messages, etc.)
  meta      TEXT NOT NULL DEFAULT '{}'
);

-- Indexes for common query / compliance patterns
CREATE INDEX IF NOT EXISTS idx_audit_timestamp     ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action        ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_actor         ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_resource      ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_correlation   ON audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_outcome       ON audit_log(outcome);
CREATE INDEX IF NOT EXISTS idx_audit_http_path     ON audit_log(http_path);
`;

export const down = `
DROP TABLE IF EXISTS audit_log;
`;
