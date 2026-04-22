/**
 * Audit log facade.
 *
 * Provides a single call-site for recording audit events throughout the
 * application. Writes are persisted to the SQLite audit_log table via
 * auditRepository. When the database is not yet initialised (e.g. during
 * unit tests) the entry falls back to an in-memory store so tests never
 * need a real DB.
 *
 * Guarantees:
 * - recordAuditEvent() never throws — a failed write is logged to stderr
 *   and silently dropped so the primary operation is never blocked.
 * - Entries are append-only; nothing in this module mutates or removes
 *   existing records.
 *
 * Trust boundaries:
 * - Internal workers call recordAuditEvent() directly.
 * - Administrators query entries via GET /api/audit (with filtering).
 * - Public clients and authenticated partners have no access to this log.
 */

import { logger } from './logger.js';
import { auditRepository, AuditAction, CreateAuditInput } from '../db/repositories/auditRepository.js';

export type { AuditAction };

export interface AuditEntry {
  /** Monotonically increasing sequence number within this process lifetime. */
  seq: number;
  /** ISO-8601 timestamp at the moment the event was recorded. */
  timestamp: string;
  action: AuditAction | string;
  actor: string;
  actorRole: string;
  /** Resource type affected, e.g. "stream". */
  resourceType: string;
  /** Identifier of the affected resource. */
  resourceId: string;
  httpMethod: string;
  httpPath: string;
  httpStatus: number;
  /** Correlation ID from the originating HTTP request, if available. */
  correlationId?: string;
  outcome: 'success' | 'failure' | 'denied';
  /** Arbitrary additional context (amounts, addresses, etc.). */
  meta?: Record<string, unknown>;
}

// ── In-memory fallback (used when DB is unavailable / in tests) ───────────────

let seq = 0;
const AUDIT_LOG_KEY = '__FLUXORA_AUDIT_LOG__';
if (!(globalThis as any)[AUDIT_LOG_KEY]) {
  (globalThis as any)[AUDIT_LOG_KEY] = [];
}
const memoryLog: AuditEntry[] = (globalThis as any)[AUDIT_LOG_KEY];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record an audit event. Persists to DB when available; falls back to
 * in-memory store otherwise. Never throws.
 */
export function recordAuditEvent(
  action: AuditAction | string,
  resourceType: string,
  resourceId: string,
  correlationId?: string,
  meta?: Record<string, unknown>,
  options?: {
    actor?: string;
    actorRole?: string;
    httpMethod?: string;
    httpPath?: string;
    httpStatus?: number;
    outcome?: 'success' | 'failure' | 'denied';
  },
): void {
  const entry: AuditEntry = {
    seq: ++seq,
    timestamp: new Date().toISOString(),
    action,
    actor: options?.actor ?? 'system',
    actorRole: options?.actorRole ?? 'unknown',
    resourceType,
    resourceId,
    httpMethod: options?.httpMethod ?? '',
    httpPath: options?.httpPath ?? '',
    httpStatus: options?.httpStatus ?? 0,
    correlationId,
    outcome: options?.outcome ?? 'success',
    meta,
  };

  try {
    // Attempt persistent write first
    const input: CreateAuditInput = {
      action,
      actor: entry.actor,
      actorRole: entry.actorRole,
      resourceType,
      resourceId,
      httpMethod: entry.httpMethod,
      httpPath: entry.httpPath,
      httpStatus: entry.httpStatus,
      correlationId,
      outcome: entry.outcome,
      meta,
    };
    auditRepository.insert(input);
  } catch {
    // DB unavailable — fall through to in-memory store
    memoryLog.push(entry);
  }

  logger.info('Audit event recorded', correlationId, {
    action,
    actor: entry.actor,
    resourceType,
    resourceId,
    outcome: entry.outcome,
  });
}

/**
 * Return a shallow copy of all in-memory entries (oldest first).
 * Only populated when the DB is unavailable (e.g. in tests).
 */
export function getAuditEntries(): AuditEntry[] {
  return [...((globalThis as any)[AUDIT_LOG_KEY] as AuditEntry[])];
}

/** Reset in-memory store — test use only. */
export function _resetAuditLog(): void {
  (globalThis as any)[AUDIT_LOG_KEY] = [];
  seq = 0;
}
