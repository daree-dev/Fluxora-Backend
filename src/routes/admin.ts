import { Router, Request, Response } from 'express';
import { requireAdminAuth } from '../middleware/adminAuth.js';
import {
  getPauseFlags,
  setPauseFlags,
  getReindexState,
  triggerReindex,
} from '../state/adminState.js';
import { recordAuditEvent } from '../lib/auditLog.js';

export const adminRouter = Router();

// Every admin route requires a valid Bearer token.
adminRouter.use(requireAdminAuth);

/**
 * GET /api/admin/status
 * Returns current pause flags and reindex state.
 */
adminRouter.get('/status', (req: Request, res: Response) => {
  recordAuditEvent(
    'ADMIN_STATUS_VIEWED',
    'admin',
    'status',
    req.correlationId,
    {},
    { actor: 'admin', actorRole: 'admin', httpMethod: 'GET', httpPath: '/api/admin/status', httpStatus: 200, outcome: 'success' },
  );

  res.json({
    pauseFlags: getPauseFlags(),
    reindex: getReindexState(),
  });
});

/**
 * GET /api/admin/pause
 * Read-only view of the current pause flags.
 */
adminRouter.get('/pause', (_req: Request, res: Response) => {
  res.json(getPauseFlags());
});

/**
 * PUT /api/admin/pause
 * Update one or both pause flags.
 *
 * Body (all fields optional):
 *   { "streamCreation": true, "ingestion": false }
 */
adminRouter.put('/pause', (req: Request, res: Response) => {
  const { streamCreation, ingestion } = req.body ?? {};

  if (streamCreation === undefined && ingestion === undefined) {
    res.status(400).json({
      error: 'Request body must include at least one of: streamCreation, ingestion.',
    });
    return;
  }

  const errors: string[] = [];
  if (streamCreation !== undefined && typeof streamCreation !== 'boolean') {
    errors.push('streamCreation must be a boolean.');
  }
  if (ingestion !== undefined && typeof ingestion !== 'boolean') {
    errors.push('ingestion must be a boolean.');
  }
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join(' ') });
    return;
  }

  const updated = setPauseFlags({ streamCreation, ingestion });

  recordAuditEvent(
    'ADMIN_PAUSE_SET',
    'admin',
    'pause',
    req.correlationId,
    { streamCreation, ingestion, result: updated },
    { actor: 'admin', actorRole: 'admin', httpMethod: 'PUT', httpPath: '/api/admin/pause', httpStatus: 200, outcome: 'success' },
  );

  res.json({ message: 'Pause flags updated.', pauseFlags: updated });
});

/**
 * GET /api/admin/reindex
 * Returns the current reindex job state.
 */
adminRouter.get('/reindex', (_req: Request, res: Response) => {
  res.json(getReindexState());
});

/**
 * POST /api/admin/reindex
 * Triggers a reindex operation. Returns 409 if one is already running.
 */
adminRouter.post('/reindex', async (req: Request, res: Response) => {
  const current = getReindexState();
  if (current.status === 'running') {
    res.status(409).json({
      error: 'A reindex operation is already in progress.',
      reindex: current,
    });
    return;
  }

  const state = await triggerReindex();

  recordAuditEvent(
    'ADMIN_REINDEX_TRIGGERED',
    'admin',
    'reindex',
    req.correlationId,
    { reindexState: state },
    { actor: 'admin', actorRole: 'admin', httpMethod: 'POST', httpPath: '/api/admin/reindex', httpStatus: 202, outcome: 'success' },
  );

  res.status(202).json({
    message: 'Reindex started.',
    reindex: state,
  });
});
