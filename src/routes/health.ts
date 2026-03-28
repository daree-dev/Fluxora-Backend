import { Router } from 'express';
import { successResponse } from '../utils/response.js';

export const healthRouter = Router();

/**
 * Health check route for the Fluxora API.
 * 
 * Returns a 200 OK with common health metrics and dependencies.
 */
healthRouter.get('/', (_req, res) => {
  res.json(successResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '0.1.0',
    dependencies: {
        database: 'healthy',
        redis: 'healthy',
        stellar: 'healthy',
    }
  }));
});

/**
 * Readiness check - service can handle requests
 */
healthRouter.get("/ready", (_req: Request, res: Response) => {
  const dbHealth = checkDatabaseHealth();
  const health = getHealthMetrics();

  const isReady = dbHealth.healthy && health.healthy;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks: {
      database: dbHealth,
      metrics: health.checks,
    },
  });
});

/**
 * Metrics endpoint for monitoring
 */
healthRouter.get("/metrics", (_req: Request, res: Response) => {
  const health = getHealthMetrics();

  res.json({
    timestamp: new Date().toISOString(),
    ...health,
  });
});
