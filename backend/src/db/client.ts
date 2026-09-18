import postgres from 'postgres';
import { env } from '../lib/env.js';

// Single shared connection pool for the process.
export const sql = postgres(env.DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});
