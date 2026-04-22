/**
 * Express application factory.
 *
 * Separated from the server bootstrap in index.ts so that tests
 * can import the app without binding to a port.
 */

import express from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { privacyRouter } from './routes/privacy.js';
import { auditRouter } from './routes/audit.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { indexerRouter } from './routes/indexer.js';
import { privacyHeaders, requestLogger, safeErrorHandler } from './middleware/pii.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { auditMiddleware } from './middleware/auditMiddleware.js';

export interface AppOptions {
  /** When true, mounts a /__test/error route that throws unconditionally. */
  includeTestRoutes?: boolean;
  /** Override payload limit in bytes (default 256 KiB). */
  payloadLimitBytes?: number;
}

export function createApp(options: AppOptions = {}): express.Express {
  const app = express();

  // ── Core middleware (order matters) ────────────────────────────────────────
  app.use(express.json({ limit: options.payloadLimitBytes ?? 256 * 1024 }));
  app.use(correlationIdMiddleware);   // req.correlationId populated here
  app.use(privacyHeaders);
  app.use(requestLogger);
  app.use(auditMiddleware);           // auto-audit every request after auth

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/api/streams', streamsRouter);
  app.use('/api/privacy', privacyRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/audit', auditRouter);
  app.use('/internal/indexer', indexerRouter);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  // ── Test-only routes ───────────────────────────────────────────────────────
  if (options.includeTestRoutes) {
    app.get('/__test/error', () => {
      throw new Error('Test error route');
    });
  }

  app.use(safeErrorHandler);

  return app;
}

// Default export for backwards compatibility with existing imports
export const app = createApp();
