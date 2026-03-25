import express from 'express';

import { errorHandler, notFoundHandler, requestIdMiddleware } from './errors.js';
import { healthRouter } from './routes/health.js';
import { streamsRouter } from './routes/streams.js';

type CreateAppOptions = {
  includeTestRoutes?: boolean;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '256kb' }));

  app.use('/health', healthRouter);
  app.use('/api/streams', streamsRouter);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Fluxora API',
      version: '0.1.0',
      docs: 'Programmable treasury streaming on Stellar.',
    });
  });

  if (options.includeTestRoutes) {
    app.get('/__test/error', () => {
      throw new Error('synthetic test failure');
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
