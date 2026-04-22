/**
 * Audit middleware.
 *
 * Automatically records an audit entry for every HTTP request that
 * completes. The entry captures:
 *   - actor identity (from req.user, falling back to "anonymous")
 *   - HTTP method, path, and response status
 *   - correlation ID for cross-log tracing
 *   - outcome derived from the HTTP status code
 *   - sanitized query params and request body (PII-safe)
 *
 * Must be registered AFTER correlationIdMiddleware and authenticate so
 * that req.correlationId and req.user are already populated.
 *
 * The write is fire-and-forget (res.on('finish')) so it never delays
 * the response to the client.
 */

import type { Request, Response, NextFunction } from 'express';
import { auditRepository } from '../db/repositories/auditRepository.js';
import { logger } from '../lib/logger.js';

// Keys that must never appear in audit metadata
const REDACTED_KEYS = new Set([
  'token', 'secret', 'password', 'key', 'apikey', 'api_key',
  'authorization', 'x-api-key', 'x-indexer-worker-token',
]);

/**
 * Derive a human-readable action label from the request method + path.
 * Falls back to the generic "API_CALL" label for unrecognised routes.
 */
function resolveAction(method: string, path: string): string {
  const m = method.toUpperCase();
  const p = path.toLowerCase();

  if (p.startsWith('/api/streams')) {
    if (m === 'GET' && /\/api\/streams\/[^/]+$/.test(p)) return 'STREAM_FETCHED';
    if (m === 'GET') return 'STREAM_LISTED';
    if (m === 'POST') return 'STREAM_CREATED';
    if (m === 'PATCH' || m === 'PUT') return 'STREAM_UPDATED';
    if (m === 'DELETE') return 'STREAM_CANCELLED';
  }
  if (p.startsWith('/api/auth/session') && m === 'POST') return 'SESSION_CREATED';
  if (p.startsWith('/api/auth') && m === 'POST') return 'AUTH_FAILED';
  if (p.startsWith('/api/admin/pause') && m === 'PUT') return 'ADMIN_PAUSE_SET';
  if (p.startsWith('/api/admin/reindex') && m === 'POST') return 'ADMIN_REINDEX_TRIGGERED';
  if (p.startsWith('/api/admin/status') && m === 'GET') return 'ADMIN_STATUS_VIEWED';
  if (p.startsWith('/api/audit') && m === 'GET') return 'ADMIN_AUDIT_VIEWED';
  if (p.startsWith('/internal/indexer') && m === 'POST') return 'INDEXER_EVENTS_INGESTED';

  return 'API_CALL';
}

/**
 * Refine the action label based on the final HTTP status code.
 * e.g. a POST /api/auth/session that returns 401 should be AUTH_FAILED,
 * not SESSION_CREATED.
 */
function refineAction(action: string, status: number): string {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'AUTH_DENIED';
  return action;
}

/**
 * Map an HTTP status code to an audit outcome.
 */
function resolveOutcome(status: number): 'success' | 'failure' | 'denied' {
  if (status === 401 || status === 403) return 'denied';
  if (status >= 400) return 'failure';
  return 'success';
}

/**
 * Derive resource type from the request path.
 */
function resolveResourceType(path: string): string {
  const p = path.toLowerCase();
  if (p.startsWith('/api/streams')) return 'stream';
  if (p.startsWith('/api/admin')) return 'admin';
  if (p.startsWith('/api/auth')) return 'session';
  if (p.startsWith('/api/audit')) return 'audit';
  if (p.startsWith('/internal/indexer')) return 'indexer';
  return '';
}

/**
 * Strip any sensitive keys from an object before storing it.
 */
function sanitise(obj: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    safe[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return safe;
}

/**
 * Express middleware that appends an audit entry after each response.
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Capture body snapshot at request time (before any mutation)
  const bodyCopy: Record<string, unknown> =
    req.body && typeof req.body === 'object' ? { ...req.body } : {};

  res.on('finish', () => {
    try {
      const actor = req.user?.address ?? 'anonymous';
      const actorRole = req.user?.role ?? 'anonymous';
      const correlationId = req.correlationId ?? '';
      const baseAction = resolveAction(req.method, req.path);
      const action = refineAction(baseAction, res.statusCode);
      const outcome = resolveOutcome(res.statusCode);
      const resourceType = resolveResourceType(req.path);

      // Extract resource ID from path when available (e.g. /api/streams/:id)
      const resourceIdMatch = req.path.match(/\/(?:streams|audit)\/([^/]+)/);
      const resourceId = resourceIdMatch?.[1] ?? '';

      auditRepository.insert({
        action,
        actor,
        actorRole,
        resourceType,
        resourceId,
        httpMethod: req.method,
        httpPath: req.path,
        httpStatus: res.statusCode,
        correlationId,
        outcome,
        meta: {
          query: sanitise(req.query as Record<string, unknown>),
          body: sanitise(bodyCopy),
          userAgent: req.headers['user-agent'] ?? '',
          ip: req.ip ?? '',
        },
      });
    } catch (err) {
      // Audit must never crash the process
      logger.error('auditMiddleware: failed to write entry', undefined, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  next();
}
