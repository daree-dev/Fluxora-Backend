import { Router, Request, Response } from 'express';
import { assessIndexerHealth, DEFAULT_INDEXER_STALL_THRESHOLD_MS } from '../indexer/stall.js';
import { HealthCheckManager } from '../config/health.js';
import { logger } from '../lib/logger.js';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  const indexer = assessIndexerHealth({
    enabled: false,
    stallThresholdMs: DEFAULT_INDEXER_STALL_THRESHOLD_MS,
  });

  res.json({
    status: indexer.status === 'stalled' || indexer.status === 'starting' ? 'degraded' : 'ok',
    service: 'fluxora-backend',
    timestamp: new Date().toISOString(),
    indexer,
  });
});

/**
 * GET /health/ready
 * Deep readiness probe — runs live checks against Postgres and Stellar RPC.
 * Returns 503 if any dependency is unhealthy.
 */
healthRouter.get('/ready', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;

  if (!healthManager) {
    res.status(503).json({ status: 'unhealthy', error: 'Health manager not configured' });
    return;
  }

  try {
    const report = await healthManager.checkAll();

    if (report.status === 'unhealthy') {
      logger.warn('Readiness check failed', undefined, { dependencies: report.dependencies });
      res.status(503).json(report);
      return;
    }

    res.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Readiness check threw unexpectedly', undefined, { error: message });
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
  }
});
