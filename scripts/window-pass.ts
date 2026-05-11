/**
 * Standalone CAGR + 3y-flag back-fill.
 *
 * All compute happens in Node (see src/lib/computeWindowMetrics.ts);
 * the DB only does plain SELECTs and batched UPDATEs via unnest. No
 * window functions or CASE-CAGR math run inside Postgres.
 *
 *   npm run screener:window
 *   npm run screener:window -- --chunks=100   (more chunks, smaller each)
 *
 * Idempotent: re-running is cheap because rows whose computed values
 * already match what's stored are filtered out in Node before any
 * UPDATE is sent.
 */
import { Pool } from "pg";
import { runMigrations } from "../src/runMigrations.js";
import { runWindowPass } from "../src/lib/runWindowPass.js";

const N_CHUNKS = parseInt(
  process.argv.find(a => a.startsWith("--chunks="))?.split("=")[1] ?? "50",
  10,
);

async function main() {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  await runMigrations(url);
  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    await runWindowPass(pool, { nChunks: N_CHUNKS });
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
