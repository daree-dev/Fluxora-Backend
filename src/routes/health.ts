import { Router, Request, Response } from 'express';
import { getIndexerHealth } from './indexer.js';
import { HealthCheckManager } from '../config/health.js';
import { Config } from '../config/env.js';
import { isShuttingDown } from '../shutdown.js';

export const healthRouter = Router();

/**
 * GET /health
 * Liveness check — returns 503 during graceful shutdown.
 */
healthRouter.get('/', (req: Request, res: Response) => {
  const config = req.app.locals.config as Config | undefined;

  if (isShuttingDown()) {
    res.status(503).json({
      status: 'shutting_down',
      service: 'fluxora-backend',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const indexer = getIndexerHealth();
  const status =
    indexer.dependency === 'unavailable' || indexer.dependency === 'degraded'
      ? 'degraded'
      : 'ok';

  res.json({
    status,
    service: 'fluxora-backend',
    network: config?.stellarNetwork ?? 'unknown',
    timestamp: new Date().toISOString(),
    dependencies: { indexer },
  });
});

/**
 * GET /health/ready
 * Readiness check — runs all registered health checkers.
 */
healthRouter.get('/ready', async (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;

  if (!healthManager) {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  try {
    const report = await healthManager.checkAll();

    if (report.status === 'unhealthy') {
      res.status(503).json({ status: 'not_ready', report });
      return;
    }

    res.json({ status: 'ready', report });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      error: err instanceof Error ? err.message : 'Health check failed',
    });
  }
});

/**
 * GET /health/live
 * Returns the last cached health report without re-running checks.
 */
healthRouter.get('/live', (req: Request, res: Response) => {
  const healthManager = req.app.locals.healthManager as HealthCheckManager | undefined;
  const config = req.app.locals.config as Config | undefined;

  if (!healthManager) {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  const report = healthManager.getLastReport(config?.apiVersion ?? '0.1.0');
  res.json({ status: report.status, report });
});
