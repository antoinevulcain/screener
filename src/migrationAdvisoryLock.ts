/**
 * Advisory lock for screener migrations.
 * Mirrors inpi/src/migrationAdvisoryLock.ts but with a screener-specific key
 * (852003, 852004) so it doesn't collide with the inpi or api migration locks.
 */
import type pg from "pg";

const K1 = 852003;
const K2 = 852004;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function advisoryWaitMs(): number {
  const raw = process.env.MIGRATE_ADVISORY_WAIT_MS?.trim();
  if (!raw) return 800;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(120_000, n) : 800;
}

const POLL_MS = 100;

function forceTerminateOthers(): boolean {
  return process.env.MIGRATE_FORCE_ADVISORY?.trim() !== "0";
}

export async function acquireMigrationAdvisoryLock(client: pg.PoolClient): Promise<void> {
  const maxWait = advisoryWaitMs();
  const t0 = Date.now();

  while (Date.now() - t0 < maxWait) {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1::integer, $2::integer) AS ok`,
      [K1, K2]
    );
    if (rows[0]?.ok === true) return;
    await sleep(POLL_MS);
  }

  if (!forceTerminateOthers()) {
    throw new Error(
      `[migrate] Advisory lock (${K1}, ${K2}) still held after ${maxWait} ms. ` +
        `Stop the other process or unset MIGRATE_FORCE_ADVISORY=0.`
    );
  }

  console.warn(
    `[migrate] Advisory lock (${K1}, ${K2}) still held after ~${maxWait} ms — ` +
      `terminating other sessions holding it…`
  );

  const { rows: killed } = await client.query<{ pid: number; ok: boolean }>(`
    SELECT l.pid, pg_terminate_backend(l.pid) AS ok
    FROM pg_locks l
    WHERE l.locktype = 'advisory'
      AND l.classid = ${K1}
      AND l.objid = ${K2}
      AND l.granted = true
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.pid IS NOT NULL
      AND l.pid <> pg_backend_pid()
  `);

  const nk = killed.filter((r) => r.ok).length;
  if (nk > 0) console.warn(`[migrate] ${nk} session(s) terminated — retrying lock…`);
  await sleep(600);

  const { rows: r2 } = await client.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock($1::integer, $2::integer) AS ok`,
    [K1, K2]
  );
  if (r2[0]?.ok === true) return;

  await client.query(`SELECT pg_advisory_lock($1::integer, $2::integer)`, [K1, K2]);
}
