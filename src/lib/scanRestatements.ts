/**
 * Detect restatements of past filings by walking inpi_financial_statements_ftp
 * in (siren, date_cloture, rne_updated_at) order. Within each (siren,
 * date_cloture) group, the first filing is the original; each later filing
 * is a restatement — diff every tracked field and emit a log row for each
 * change.
 *
 * Replaces the AFTER UPDATE trigger that used to do this in plpgsql (dropped
 * in migration 005). Shared between:
 *   - scripts/backfill-restatements.ts  (since=null → full historical scan)
 *   - scripts/restatements-cron.ts      (since=watermark → incremental tick)
 *
 * When `since` is set:
 *   - Only (siren, date_cloture) pairs with at least one filing where
 *     rne_updated_at > since enter the scan.
 *   - All filings for those pairs are still read (we need the prior
 *     snapshots to diff against), but log rows are only emitted for the
 *     NEW filings (rne_updated_at > since) — so re-running the cron never
 *     duplicates an already-logged restatement.
 *
 * Tracked fields: the 5 typed KPIs + every cerfa value column (and its N-1
 * counterpart) defined in CERFA_CODE_MAP.
 */

import { Pool, PoolClient } from "pg";
import { CERFA_CODE_MAP, type CerfaCodeMeta } from "./cerfaCodeMap.js";

type LiassePoste = {
  code: string;
  montant_exercice_N_euros: number | string | null;
  montant_exercice_N_moins_1_euros: number | string | null;
};

type SourceRow = {
  siren: string;
  date_cloture: string;
  rne_updated_at: string | null;
  chiffre_affaires: string | number | null;
  resultat_net: string | number | null;
  total_bilan: string | number | null;
  capitaux_propres: string | number | null;
  effectif_moyen: number | null;
  liasse_postes: LiassePoste[] | null;
};

type FlatValues = Map<string, number | null>;

type LogRow = {
  siren: string;
  exercise_year: number;
  field_name: string;
  old_value: number | null;
  new_value: number | null;
  source_date_cloture: string;
  source_rne_updated_at: string | null;
};

const FETCH_BATCH = 5000;
const INSERT_BATCH = 500;

function coerce(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : null;
}

function flatten(row: SourceRow): FlatValues {
  const m: FlatValues = new Map();
  m.set("chiffre_affaires", coerce(row.chiffre_affaires));
  m.set("resultat_net",     coerce(row.resultat_net));
  m.set("total_bilan",      coerce(row.total_bilan));
  m.set("capitaux_propres", coerce(row.capitaux_propres));
  m.set("effectif_moyen",   coerce(row.effectif_moyen));
  if (row.liasse_postes) {
    for (const p of row.liasse_postes) {
      const meta: CerfaCodeMeta | undefined = CERFA_CODE_MAP[p.code];
      if (!meta) continue;
      m.set(meta.column,          coerce(p.montant_exercice_N_euros));
      m.set(meta.column + "_n1",  coerce(p.montant_exercice_N_moins_1_euros));
    }
  }
  return m;
}

async function flushLogBatch(pool: Pool, batch: LogRow[], dryRun: boolean): Promise<void> {
  if (batch.length === 0 || dryRun) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    const o = i * 7;
    params.push(r.siren, r.exercise_year, r.field_name, r.old_value, r.new_value, r.source_date_cloture, r.source_rne_updated_at);
    tuples.push(`($${o+1}, $${o+2}, $${o+3}, $${o+4}, $${o+5}, $${o+6}, $${o+7})`);
  }
  await pool.query(
    `INSERT INTO company_financials_restatement_log
       (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
     VALUES ${tuples.join(", ")}`,
    params,
  );
}

export interface ScanOptions {
  /** Watermark — only emit log rows for filings with rne_updated_at > since. */
  since: Date | null;
  /** Skip INSERTs (the buffer is still built so the counts are accurate). */
  dryRun: boolean;
  /** Prefix used in periodic progress logs (defaults to "[scan-restatements]"). */
  logPrefix?: string;
}

export interface ScanResult {
  sourceRows: number;
  restatementGroups: number;
  logRows: number;
  elapsedSeconds: number;
}

export async function scanRestatements(pool: Pool, opts: ScanOptions): Promise<ScanResult> {
  const { since, dryRun } = opts;
  const prefix = opts.logPrefix ?? "[scan-restatements]";
  const t0 = Date.now();

  const client: PoolClient = await pool.connect();
  let sourceRows = 0;
  let restatementGroups = 0;
  let logRows = 0;
  const buffer: LogRow[] = [];

  // Build the cursor WHERE clause. For an incremental tick we still need to
  // read prior filings in each pair (to diff against), so we filter by
  // (siren, date_cloture) pairs that have any filing > watermark — not by
  // rne_updated_at on the filings themselves.
  const params: unknown[] = [];
  let pairsClause = "";
  if (since) {
    params.push(since.toISOString());
    pairsClause = `
      AND (siren, date_cloture) IN (
        SELECT DISTINCT siren, date_cloture
        FROM inpi_financial_statements_ftp
        WHERE rne_updated_at > $1
      )
    `;
  }

  try {
    await client.query("BEGIN");
    await client.query(
      `
      DECLARE c_restate NO SCROLL CURSOR FOR
      SELECT siren, date_cloture::text AS date_cloture, rne_updated_at,
             chiffre_affaires, resultat_net, total_bilan, capitaux_propres, effectif_moyen,
             liasse_postes
      FROM inpi_financial_statements_ftp
      WHERE liasse_postes IS NOT NULL
        AND siren IS NOT NULL
        AND date_cloture IS NOT NULL
        ${pairsClause}
      ORDER BY siren, date_cloture, rne_updated_at NULLS FIRST
      `,
      params,
    );

    let groupKey: string | null = null;
    let groupFirstValues: FlatValues | null = null;
    let lastReport = Date.now();
    const sinceMs = since ? since.getTime() : -Infinity;

    while (true) {
      const r = await client.query<SourceRow>(`FETCH ${FETCH_BATCH} FROM c_restate`);
      if (r.rows.length === 0) break;

      for (const row of r.rows) {
        sourceRows++;
        const key = `${row.siren}|${row.date_cloture}`;
        const values = flatten(row);
        const exerciseYear = new Date(row.date_cloture).getUTCFullYear();

        if (key !== groupKey) {
          groupKey = key;
          groupFirstValues = values;
          continue;
        }

        if (groupFirstValues) {
          const rowMs = row.rne_updated_at ? new Date(row.rne_updated_at).getTime() : -Infinity;
          const emit = rowMs > sinceMs;
          let anyDiff = false;
          for (const [field, newV] of values) {
            const oldV = groupFirstValues.get(field) ?? null;
            if ((oldV ?? null) !== (newV ?? null)) {
              if (emit) {
                buffer.push({
                  siren: row.siren,
                  exercise_year: exerciseYear,
                  field_name: field,
                  old_value: oldV,
                  new_value: newV,
                  source_date_cloture: row.date_cloture,
                  source_rne_updated_at: row.rne_updated_at,
                });
                logRows++;
              }
              anyDiff = true;
            }
          }
          if (anyDiff && emit) restatementGroups++;
          groupFirstValues = values;
        }

        if (buffer.length >= INSERT_BATCH) {
          await flushLogBatch(pool, buffer, dryRun);
          buffer.length = 0;
        }
      }

      const now = Date.now();
      if (now - lastReport > 5000) {
        const dt = (now - t0) / 1000;
        const rate = sourceRows / dt;
        console.log(`${prefix} source_rows=${sourceRows.toLocaleString()} restatement_groups=${restatementGroups.toLocaleString()} log_rows=${logRows.toLocaleString()} rate=${rate.toFixed(0)}/s`);
        lastReport = now;
      }
    }

    if (buffer.length > 0) await flushLogBatch(pool, buffer, dryRun);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return {
    sourceRows,
    restatementGroups,
    logRows,
    elapsedSeconds: (Date.now() - t0) / 1000,
  };
}

/**
 * Read the watermark used by the incremental cron tick: the latest
 * source_rne_updated_at the log has ever observed. Returns null if the log
 * is empty (cron should refuse to tick until backfill has run).
 */
export async function readRestatementWatermark(pool: Pool): Promise<Date | null> {
  const r = await pool.query<{ max: string | null }>(
    `SELECT MAX(source_rne_updated_at) AS max FROM company_financials_restatement_log`,
  );
  const v = r.rows[0]?.max;
  return v ? new Date(v) : null;
}
