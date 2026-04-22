/**
 * Audit log routes — admin-only.
 *
 * All routes require a valid ADMIN_API_KEY Bearer token (enforced by
 * requireAdminAuth). Public clients and authenticated partners must not
 * be granted access to this router.
 *
 * Endpoints:
 *   GET  /api/audit              — paginated, filterable audit log
 *   GET  /api/audit/summary      — compliance summary (counts by action/actor/outcome)
 *   GET  /api/audit/stats        — time-bucketed event counts for dashboards
 *   GET  /api/audit/export       — NDJSON export for compliance tooling
 *   GET  /api/audit/actor/:actor — all entries for a specific actor
 *   GET  /api/audit/:id          — single entry by ID
 */

import { Router, Request, Response } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  auditRepository,
  AuditFilter,
  AuditPagination,
} from '../db/repositories/auditRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const auditRouter = Router();

// Every audit route requires admin credentials.
auditRouter.use(requireAdminAuth);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>): AuditPagination {
  const limit = Math.min(Math.max(parseInt(String(query['limit'] ?? '50'), 10) || 50, 1), 500);
  const offset = Math.max(parseInt(String(query['offset'] ?? '0'), 10) || 0, 0);
  return { limit, offset };
}

function parseFilter(query: Record<string, unknown>): AuditFilter {
  const filter: AuditFilter = {};

  if (query['action'])        filter.action        = String(query['action']);
  if (query['actor'])         filter.actor         = String(query['actor']);
  if (query['actorRole'])     filter.actorRole     = String(query['actorRole']);
  if (query['resourceType'])  filter.resourceType  = String(query['resourceType']);
  if (query['resourceId'])    filter.resourceId    = String(query['resourceId']);
  if (query['outcome'])       filter.outcome       = String(query['outcome']) as AuditFilter['outcome'];
  if (query['correlationId']) filter.correlationId = String(query['correlationId']);
  if (query['path'])          filter.httpPath      = String(query['path']);
  if (query['method'])        filter.httpMethod    = String(query['method']);
  if (query['status']) {
    const parsed = parseInt(String(query['status']), 10);
    if (!isNaN(parsed)) filter.httpStatus = parsed;
  }
  if (query['from'])          filter.from          = String(query['from']);
  if (query['to'])            filter.to            = String(query['to']);

  return filter;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/audit
 *
 * Returns a paginated, filterable list of audit entries (newest first).
 *
 * Query parameters (all optional):
 *   action        — exact match on action field (e.g. STREAM_CREATED)
 *   actor         — exact match on actor (Stellar address or "system")
 *   actorRole     — exact match on actor_role
 *   resourceType  — exact match on resource_type (e.g. "stream")
 *   resourceId    — exact match on resource_id
 *   outcome       — "success" | "failure" | "denied"
 *   correlationId — exact match on correlation_id
 *   path          — substring match on http_path
 *   method        — exact match on http_method (e.g. GET, POST)
 *   status        — exact match on http_status (e.g. 200, 401)
 *   from          — ISO-8601 lower bound on timestamp (inclusive)
 *   to            — ISO-8601 upper bound on timestamp (inclusive)
 *   limit         — page size (1–500, default 50)
 *   offset        — page offset (default 0)
 */
auditRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const filter = parseFilter(req.query as Record<string, unknown>);
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const result = auditRepository.find(filter, pagination);

    res.json({
      entries: result.entries,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
    });
  }),
);

/**
 * GET /api/audit/summary
 *
 * Returns aggregate counts for compliance dashboards:
 *   - total entries
 *   - counts by action
 *   - counts by actor
 *   - counts by outcome
 *   - counts by HTTP method
 */
auditRouter.get(
  '/summary',
  asyncHandler(async (_req: Request, res: Response) => {
    const byAction     = auditRepository.countByAction();
    const byActor      = auditRepository.countByActor();
    const byOutcome    = auditRepository.countByOutcome();
    const byHttpMethod = auditRepository.countByHttpMethod();

    const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);

    res.json({
      total,
      byAction,
      byActor,
      byOutcome,
      byHttpMethod,
      generatedAt: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/audit/stats
 *
 * Returns time-bucketed event counts for charting / compliance reporting.
 *
 * Query parameters:
 *   from        — ISO-8601 lower bound (required)
 *   to          — ISO-8601 upper bound (required)
 *   granularity — "hour" | "day" (default "day")
 */
auditRouter.get(
  '/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const { from, to, granularity } = req.query as Record<string, string | undefined>;

    if (!from || !to) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: '"from" and "to" query parameters are required' },
      });
      return;
    }

    const gran = granularity === 'hour' ? 'hour' : 'day';
    const buckets = auditRepository.countByTimeRange(from, to, gran);

    res.json({
      from,
      to,
      granularity: gran,
      buckets,
      generatedAt: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/audit/export
 *
 * Streams the full audit log (or a filtered subset) as NDJSON for
 * ingestion by compliance tooling (Splunk, Elastic, etc.).
 *
 * Accepts the same filter query parameters as GET /api/audit.
 * Uses a large page size internally to avoid multiple DB round-trips.
 */
auditRouter.get(
  '/export',
  asyncHandler(async (req: Request, res: Response) => {
    const filter = parseFilter(req.query as Record<string, unknown>);

    // Fetch up to 10 000 entries per export request
    const result = auditRepository.find(filter, { limit: 10_000, offset: 0 });

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    );

    for (const entry of result.entries) {
      res.write(JSON.stringify(entry) + '\n');
    }

    res.end();
  }),
);

/**
 * GET /api/audit/actor/:actor
 *
 * Returns all audit entries for a specific actor (Stellar address or "system").
 * Supports the same pagination parameters as GET /api/audit.
 */
auditRouter.get(
  '/actor/:actor',
  asyncHandler(async (req: Request, res: Response) => {
    const { actor } = req.params;
    const pagination = parsePagination(req.query as Record<string, unknown>);
    const result = auditRepository.findByActor(actor, pagination);

    res.json({
      actor,
      entries: result.entries,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
    });
  }),
);

/**
 * GET /api/audit/:id
 *
 * Returns a single audit entry by its numeric ID.
 */
auditRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'id must be a number' } });
      return;
    }

    const entry = auditRepository.getById(id);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `Audit entry ${id} not found` } });
      return;
    }

    res.json(entry);
  }),
);
