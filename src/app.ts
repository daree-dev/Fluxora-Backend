import express from 'express';
import helmet from 'helmet';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';

const app = express();

app.use(helmet());
app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/streams', streamsRouter);

app.get('/', (_req, res) => {
  res.json({
    name: 'Fluxora API',
    version: '0.1.0',
    docs: 'Programmable treasury streaming on Stellar.',
  });
});

export { app };
