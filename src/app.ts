import express from 'express';
import type { Request, Response } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { HealthCheckManager } from './config/health.js';

export const app = express();

// Wire health manager into app.locals so routes can access it
const healthManager = new HealthCheckManager();
app.locals.healthManager = healthManager;

app.use(express.json());
app.use(correlationIdMiddleware);
app.use(requestLoggerMiddleware);

app.use('/health', healthRouter);
app.use('/api/streams', streamsRouter);

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Fluxora API',
    version: '0.1.0',
    docs: 'Programmable treasury streaming on Stellar.',
  });
});
