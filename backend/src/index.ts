import express from 'express';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { health } from './routes/health.js';
import { debug } from './routes/debug.js'; // TEMPORARY: remove in Phase 8

const app = express();
app.use(express.json());
app.use(health);
app.use(debug); // TEMPORARY: remove in Phase 8

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'backend listening');
});
