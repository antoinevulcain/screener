/**
 * Long-running cron loop: nightly screener refresh.
 *
 * Designed to be deployed as a Railway cron service.
 * Sleeps SCREENER_CRON_INTERVAL_MIN minutes (default 1440 = 24h) between runs.
 * On each iteration: runs migrations (idempotent), then incremental refresh.
 *
 * Exits non-zero only on fatal errors (config issues). Per-run failures are
 * logged into `company_financials_screener_run_log` and the loop continues.
 */
import { runMigrations } from "../src/runMigrations.js";
import { runIncremental } from "./build-screener.js";

const INTERVAL_MIN = parseInt(process.env.SCREENER_CRON_INTERVAL_MIN ?? "1440", 10);

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  if (!Number.isFinite(INTERVAL_MIN) || INTERVAL_MIN <= 0) {
    throw new Error("SCREENER_CRON_INTERVAL_MIN must be a positive integer");
  }

  // Apply pending migrations once at startup so a fresh deploy gets the latest schema.
  await runMigrations(url);

  while (true) {
    const startedAt = new Date();
    console.log(`[cron] tick ${startedAt.toISOString()} — running incremental refresh`);
    try {
      await runIncremental(url);
      console.log(`[cron] tick OK in ${Date.now() - startedAt.getTime()} ms`);
    } catch (e) {
      console.error("[cron] tick FAILED:", (e as Error).message);
      // Don't exit — wait for the next tick. The run log already captured the error.
    }
    console.log(`[cron] sleeping ${INTERVAL_MIN} min until next tick`);
    await sleepMs(INTERVAL_MIN * 60 * 1000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
