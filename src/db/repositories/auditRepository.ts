/**
 * Audit Log Repository
 *
 * Append-only writes and rich read queries against the audit_log table.
 * All writes are fire-and-forget safe — callers should never await a
 * write that could block a primary operation.
 *
 * @module db/repositories/auditRepository
 */

import { getDatabase } from '../connection.js';
import { error as logError } from '../../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditOutcome = 'success' | 'failure' | 'denied';

export type AuditAction =
  // Stream lifecycle
  | 'STREAM_CREATED'
  | 'STREAM_CANCELLED'
  | 'STREAM_UPDATED'
  | 'STREAM_LISTED'
  | 'STREAM_FETCHED'
  // Auth events
  | 'SESSION_CREATED'
  | 'AUTH_FAILED'
  | 'AUTH_DENIED'
  // Admin operations
  | 'ADMIN_PAUSE_SET'
  | 'ADMIN_REINDEX_TRIGGERED'
  | 'ADMIN_STATUS_VIEWED'
  | 'ADMIN_AUDIT_VIEWED'
  // Indexer
  | 'INDEXER_EVENTS_INGESTED'
  // Generic API call (fallback for unclassified routes)
  | 'API_CALL';

export interface AuditRecord {
  id: number;
  timestamp: string;
  action: AuditAction | string;
  actor: string;
  actor_role: string;
  resource_type: string;
  resource_id: string;
  http_method: string;
  http_path: string;
  http_status: number;
  correlation_id: string;
  outcome: AuditOutcome;
  meta: string; // raw JSON string
}

export interface AuditRecordParsed extends Omit<AuditRecord, 'meta'> {
  meta: Record<string, unknown>;
}

export interface CreateAuditInput {
  action: AuditAction | string;
  actor?: string;
  actorRole?: string;
  resourceType?: string;
  resourceId?: string;
  httpMethod?: string;
  httpPath?: string;
  httpStatus?: number;
  correlationId?: string;
  outcome?: AuditOutcome;
  meta?: Record<string, unknown>;
}

export interface AuditFilter {
  action?: string;
  actor?: string;
  actorRole?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  correlationId?: string;
  httpPath?: string;
  httpMethod?: string;
  httpStatus?: number;
  /** ISO-8601 lower bound (inclusive) */
  from?: string;
  /** ISO-8601 upper bound (inclusive) */
  to?: string;
}

export interface AuditPagination {
  limit: number;
  offset: number;
}

export interface PaginatedAuditLog {
  entries: AuditRecordParsed[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface TimeRangeBucket {
  bucket: string;
  count: number;
}

// ── Repository ────────────────────────────────────────────────────────────────

export const auditRepository = {
  /**
   * Insert one audit entry. Never throws — failures are logged to stderr
   * so the primary operation is never blocked by audit infrastructure.
   */
  insert(input: CreateAuditInput): void {
    try {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO audit_log (
          action, actor, actor_role, resource_type, resource_id,
          http_method, http_path, http_status, correlation_id, outcome, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.action,
        input.actor ?? 'anonymous',
        input.actorRole ?? 'unknown',
        input.resourceType ?? '',
        input.resourceId ?? '',
        input.httpMethod ?? '',
        input.httpPath ?? '',
        input.httpStatus ?? 0,
        input.correlationId ?? '',
        input.outcome ?? 'success',
        JSON.stringify(input.meta ?? {}),
      );
    } catch (err) {
      logError('Failed to write audit log entry', {
        action: input.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Query audit entries with optional filtering and pagination.
   * Results are ordered newest-first.
   */
  find(filter: AuditFilter = {}, pagination: AuditPagination = { limit: 50, offset: 0 }): PaginatedAuditLog {
    const db = getDatabase();

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.action) {
      conditions.push('action = ?');
      params.push(filter.action);
    }
    if (filter.actor) {
      conditions.push('actor = ?');
      params.push(filter.actor);
    }
    if (filter.actorRole) {
      conditions.push('actor_role = ?');
      params.push(filter.actorRole);
    }
    if (filter.resourceType) {
      conditions.push('resource_type = ?');
      params.push(filter.resourceType);
    }
    if (filter.resourceId) {
      conditions.push('resource_id = ?');
      params.push(filter.resourceId);
    }
    if (filter.outcome) {
      conditions.push('outcome = ?');
      params.push(filter.outcome);
    }
    if (filter.correlationId) {
      conditions.push('correlation_id = ?');
      params.push(filter.correlationId);
    }
    if (filter.httpPath) {
      conditions.push('http_path LIKE ?');
      params.push(`%${filter.httpPath}%`);
    }
    if (filter.httpMethod) {
      conditions.push('http_method = ?');
      params.push(filter.httpMethod.toUpperCase());
    }
    if (filter.httpStatus !== undefined) {
      conditions.push('http_status = ?');
      params.push(filter.httpStatus);
    }
    if (filter.from) {
      conditions.push('timestamp >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push('timestamp <= ?');
      params.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM audit_log ${where}`)
      .get(...params) as { total: number };

    const rows = db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pagination.limit, pagination.offset) as AuditRecord[];

    const entries = rows.map(parseRecord);

    return {
      entries,
      total: countRow.total,
      limit: pagination.limit,
      offset: pagination.offset,
      hasMore: pagination.offset + entries.length < countRow.total,
    };
  },

  /**
   * Fetch a single entry by its auto-increment ID.
   */
  getById(id: number): AuditRecordParsed | undefined {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as AuditRecord | undefined;
    return row ? parseRecord(row) : undefined;
  },

  /**
   * Return all entries for a specific actor, newest first.
   * Useful for per-user activity reports and compliance investigations.
   */
  findByActor(actor: string, pagination: AuditPagination = { limit: 50, offset: 0 }): PaginatedAuditLog {
    return auditRepository.find({ actor }, pagination);
  },

  /**
   * Count entries grouped by action — useful for compliance dashboards.
   */
  countByAction(): Record<string, number> {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT action, COUNT(*) as count FROM audit_log GROUP BY action ORDER BY count DESC')
      .all() as { action: string; count: number }[];

    return Object.fromEntries(rows.map((r) => [r.action, r.count]));
  },

  /**
   * Count entries grouped by actor — useful for per-user activity reports.
   */
  countByActor(): Record<string, number> {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT actor, COUNT(*) as count FROM audit_log GROUP BY actor ORDER BY count DESC')
      .all() as { actor: string; count: number }[];

    return Object.fromEntries(rows.map((r) => [r.actor, r.count]));
  },

  /**
   * Count entries grouped by outcome — quick compliance health check.
   */
  countByOutcome(): Record<AuditOutcome, number> {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT outcome, COUNT(*) as count FROM audit_log GROUP BY outcome')
      .all() as { outcome: AuditOutcome; count: number }[];

    const result: Record<AuditOutcome, number> = { success: 0, failure: 0, denied: 0 };
    for (const r of rows) result[r.outcome] = r.count;
    return result;
  },

  /**
   * Count entries grouped by hour/day bucket within an optional time range.
   * Granularity: 'hour' | 'day' (default 'day').
   *
   * Useful for time-series charts in compliance dashboards.
   */
  countByTimeRange(
    from: string,
    to: string,
    granularity: 'hour' | 'day' = 'day',
  ): TimeRangeBucket[] {
    const db = getDatabase();

    // SQLite strftime format for the requested granularity
    const fmt = granularity === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';

    const rows = db
      .prepare(`
        SELECT strftime(?, timestamp) as bucket, COUNT(*) as count
        FROM audit_log
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY bucket
        ORDER BY bucket ASC
      `)
      .all(fmt, from, to) as { bucket: string; count: number }[];

    return rows.map((r) => ({ bucket: r.bucket, count: r.count }));
  },

  /**
   * Count entries grouped by HTTP method — useful for API usage reports.
   */
  countByHttpMethod(): Record<string, number> {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT http_method, COUNT(*) as count FROM audit_log GROUP BY http_method ORDER BY count DESC')
      .all() as { http_method: string; count: number }[];

    return Object.fromEntries(rows.map((r) => [r.http_method, r.count]));
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRecord(row: AuditRecord): AuditRecordParsed {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    meta = { _raw: row.meta };
  }
  return { ...row, meta };
}
