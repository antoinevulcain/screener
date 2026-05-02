/**
 * Apply SQL files from `migrations/` (sorted by filename) to DATABASE_URL_DATA.
 * Tracked in `screener_schema_migrations` (separate from inpi_schema_migrations
 * and the api migration log so the workspaces stay isolated).
 *
 * Idempotent + advisory-locked. Run as a CLI:
 *
 *     npm run migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { acquireMigrationAdvisoryLock } from "./migrationAdvisoryLock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const MIGRATIONS_TABLE = "screener_schema_migrations";

function listMigrationFiles(): { filename: string; absolutePath: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((filename) => ({ filename, absolutePath: join(MIGRATIONS_DIR, filename) }));
}

export async function runMigrations(connectionString: string): Promise<void> {
  const steps = listMigrationFiles();
  if (steps.length === 0) {
    console.warn(`[migrate] no .sql files in ${MIGRATIONS_DIR}`);
    return;
  }

  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  const onPgNotice = (msg: { message?: string }) => {
    const line = msg.message?.trim() ?? "";
    if (line) console.log(`[migrate] ${line}`);
  };
  client.on("notice", onPgNotice);

  try {
    await acquireMigrationAdvisoryLock(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const applied = new Set<string>(
      (await client.query<{ filename: string }>(`SELECT filename FROM ${MIGRATIONS_TABLE}`))
        .rows.map((r) => r.filename),
    );

    for (const step of steps) {
      if (applied.has(step.filename)) {
        console.log(`[migrate] skip ${step.filename} (already applied)`);
        continue;
      }
      const sql = readFileSync(step.absolutePath, "utf8");
      console.log(`[migrate] applying ${step.filename} (${sql.length} bytes)…`);
      const t0 = Date.now();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (filename) VALUES ($1)`,
          [step.filename],
        );
        await client.query("COMMIT");
        console.log(`[migrate] ${step.filename} OK in ${Date.now() - t0} ms`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`[migrate] ${step.filename} FAILED: ${(e as Error).message}`);
      }
    }
  } finally {
    client.off("notice", onPgNotice);
    await client.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) { console.error("DATABASE_URL_DATA required"); process.exit(1); }
  runMigrations(url).catch((e) => { console.error(e); process.exit(1); });
}
