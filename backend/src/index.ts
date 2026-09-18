import express from 'express';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { health } from './routes/health.js';

const app = express();
app.use(express.json());
app.use(health);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'backend listening');
});
