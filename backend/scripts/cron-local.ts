// Fire the cron endpoint against the locally-running backend, the way cron-job.org will in prod.
//   npm run cron:local            # normal run
//   npm run cron:local -- --force # bypass the 90-minute idempotency skip
// Reads PORT and CRON_SECRET from the environment (same .env the server uses).
import 'dotenv/config';

const port = Number(process.env.PORT) || 4000;
const secret = process.env.CRON_SECRET || '';
const force = process.argv.includes('--force');
const url = `http://localhost:${port}/api/cron/scrape${force ? '?force=1' : ''}`;

if (!secret) {
  console.error('CRON_SECRET is not set — the endpoint will reject the call. Set it in backend/.env.');
  process.exit(1);
}

const res = await fetch(url, { method: 'POST', headers: { 'x-cron-secret': secret } });
const body = await res.text();
console.log(`POST ${url} -> ${res.status}`);
console.log(body);
process.exit(res.ok ? 0 : 1);
