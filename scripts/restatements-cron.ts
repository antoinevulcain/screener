/**
 * Long-running cron: incremental restatement detection.
 *
 * Replaces the AFTER UPDATE trigger that used to log restatements
 * synchronously on every screener-table write (dropped in migration 005).
 * Designed to be deployed as a Railway cron service.
 *
 * Sleeps RESTATEMENTS_CRON_INTERVAL_MIN minutes (default 60 = 1h) between
 * ticks. Each tick:
 *   1. Read the watermark = MAX(source_rne_updated_at) from the log table.
 *   2. Scan source filings for (siren, date_cloture) pairs that have any
 *      new filing > watermark, diff against prior filings, log changes.
 *   3. Sleep.
 *
 * On the first tick after a fresh deploy, the log must already contain
 * some backfilled history (so the watermark is non-null). Run
 * `npm run screener:backfill-restatements` once before starting the cron.
 *
 * Exits non-zero only on fatal errors (bad config). Per-tick failures are
 * logged and the loop continues.
 */

import { Pool } from "pg";
import { runMigrations } from "../src/runMigrations.js";
import { scanRestatements, readRestatementWatermark } from "../src/lib/scanRestatements.js";

const INTERVAL_MIN = parseInt(process.env.RESTATEMENTS_CRON_INTERVAL_MIN ?? "60", 10);

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  if (!Number.isFinite(INTERVAL_MIN) || INTERVAL_MIN <= 0) {
    throw new Error("RESTATEMENTS_CRON_INTERVAL_MIN must be a positive integer");
  }
  await runMigrations(url);
  const pool = new Pool({ connectionString: url, max: 4 });

  console.log(`[restatements-cron] starting, interval=${INTERVAL_MIN}min`);

  while (true) {
    const startedAt = new Date();
    try {
      const watermark = await readRestatementWatermark(pool);
      if (!watermark) {
        console.warn(
          `[restatements-cron] tick ${startedAt.toISOString()} —` +
          ` log table is empty; run screener:backfill-restatements first.` +
          ` Skipping tick.`,
        );
      } else {
        console.log(
          `[restatements-cron] tick ${startedAt.toISOString()} —` +
          ` watermark=${watermark.toISOString()}`,
        );
        const r = await scanRestatements(pool, {
          since: watermark,
          dryRun: false,
          logPrefix: "[restatements-cron]",
        });
        console.log(
          `[restatements-cron] tick DONE —` +
          ` source_rows=${r.sourceRows.toLocaleString()}` +
          ` restatement_groups=${r.restatementGroups.toLocaleString()}` +
          ` log_rows=${r.logRows.toLocaleString()}` +
          ` elapsed=${r.elapsedSeconds.toFixed(0)}s`,
        );
      }
    } catch (e) {
      console.error("[restatements-cron] tick FAILED:", (e as Error).message);
    }
    console.log(`[restatements-cron] sleeping ${INTERVAL_MIN} min until next tick`);
    await sleepMs(INTERVAL_MIN * 60 * 1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
