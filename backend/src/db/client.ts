import postgres from 'postgres';
import { env } from '../lib/env.js';

// Single shared connection pool for the process.
// prepare:false is REQUIRED because we connect through Supabase's transaction pooler (port 6543),
// which does not support prepared statements — with them on (postgres.js default) queries
// intermittently throw `prepared statement "…" does not exist`. This is Supabase's documented fix
// for postgres.js + transaction pooler; harmless on a direct/session connection too.
export const sql = postgres(env.DATABASE_URL, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});
