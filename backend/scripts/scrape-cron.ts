// The scheduled scrape entrypoint. Run by .github/workflows/scrape.yml (and usable locally with a
// DATABASE_URL pointing at a local DB).
//
// Why a workflow instead of an HTTP trigger: Render's free instance spins down after 15 min idle
// and cold-starts in ~2.5 min — far past cron-job.org's 30s request cap — so an HTTP-triggered
// scrape, and even a pre-warm ping, dies in the cold-start gap before the handler ever runs. GitHub
// Actions has a real scheduler, no spin-down, and enough CPU/RAM for Chromium, so the scheduled run
// lives here and writes straight to Supabase through the same run engine the manual endpoint uses.
//
// Exit-code contract: 0 when the run engine completes, even if some products failed — those
// failures are honest rows in scrape_logs, not a CI failure. Non-zero ONLY when executeRun itself
// throws (an infra fault: DB unreachable, browser launch failed), so the workflow goes red only for
// real breakage.
import { sql } from '../src/db/client.js';
import { executeRun } from '../src/scrape/run.js';

const force = process.argv.includes('--force');

async function main() {
  // trigger = 'cron' so the dashboard treats an Actions run identically to any other scheduled run.
  const [run] = await sql<{ id: string }[]>`
    insert into scrape_runs (trigger) values ('cron') returning id`;
  const runId = run!.id;
  console.log(`scrape run ${runId} started (trigger=cron, force=${force})`);

  const result = await executeRun(runId, { force });

  console.log('================ run summary ================');
  console.log(JSON.stringify({ run_id: runId, ...result }, null, 2));
  console.log(
    `run ${runId}: total=${result.total} succeeded=${result.succeeded} ` +
      `failed=${result.failed} skipped=${result.skipped} slowest_attempt_ms=${result.slowestAttemptMs}`,
  );

  await sql.end();
}

main().catch(async (err) => {
  console.error('scheduled scrape run failed:', err);
  await sql.end().catch(() => {});
  process.exit(1);
});
