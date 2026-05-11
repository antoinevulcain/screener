/**
 * One-shot backfill of `company_financials_restatement_log` from historical
 * source filings. Use after a fresh deploy (or to rebuild the log).
 *
 * Algorithm lives in src/lib/scanRestatements.ts. This entrypoint just calls
 * it with `since=null` (full scan) and writes results to the log table.
 *
 *   npm run screener:backfill-restatements
 *   npm run screener:backfill-restatements -- --dry-run
 *
 * Idempotent only if you DELETE the prior backfill first — otherwise it
 * appends duplicates. For ongoing detection use screener:restatements-cron,
 * which tracks a watermark and never re-emits past rows.
 */
import { Pool } from "pg";
import { runMigrations } from "../src/runMigrations.js";
import { scanRestatements } from "../src/lib/scanRestatements.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  await runMigrations(url);
  const pool = new Pool({ connectionString: url, max: 4 });
  console.log(`[backfill-restatements] starting (dry_run=${DRY_RUN})`);
  try {
    const r = await scanRestatements(pool, {
      since: null,
      dryRun: DRY_RUN,
      logPrefix: "[backfill-restatements]",
    });
    console.log(
      `[backfill-restatements] DONE — source_rows=${r.sourceRows.toLocaleString()}` +
      ` restatement_groups=${r.restatementGroups.toLocaleString()}` +
      ` log_rows=${r.logRows.toLocaleString()}` +
      ` elapsed=${r.elapsedSeconds.toFixed(0)}s` +
      `${DRY_RUN ? " [DRY-RUN: nothing written]" : ""}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("[backfill-restatements] fatal:", err);
  process.exit(1);
});
