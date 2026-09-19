import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { cors } from './lib/cors.js';
import { health } from './routes/health.js';
import { store } from './routes/store.js';
import { products } from './routes/products.js';
import { alerts } from './routes/alerts.js';
import { cron } from './routes/cron.js';
import { debug } from './routes/debug.js'; 

const app = express();
app.use(cors); 
app.use(express.json());
app.use(health);
app.use(store);
app.use(products);
app.use(alerts);
app.use(cron);
app.use(debug); 

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'unhandled route error');
  if (!res.headersSent) res.status(500).json({ error: 'internal' });
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'backend listening');
});
