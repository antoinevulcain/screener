/**
 * One-shot backfill of `company_financials_restatement_log` from historical
 * source filings.
 *
 * The screener table only stores the latest known values per (siren, year).
 * The trigger logs *future* restatements but can't see anything that happened
 * before today. This script reads the raw source (`inpi_financial_statements_ftp`)
 * — which DOES keep every filing as a separate row — and reconstructs the
 * restatement history.
 *
 * Algorithm:
 *   1. Stream source rows ordered by (siren, date_cloture, rne_updated_at ASC).
 *   2. Per (siren, date_cloture) tuple : remember the first seen values.
 *   3. For each subsequent filing of the same (siren, date_cloture) — that's
 *      a restatement of an earlier filing — compare every tracked field.
 *      If a value differs, emit a log row.
 *   4. Bulk-insert log rows in batches of 500.
 *
 * Tracked fields:
 *   - The 5 typed KPI columns (chiffre_affaires, resultat_net, total_bilan,
 *     capitaux_propres, effectif_moyen) read directly from the source table.
 *   - All 355 cerfa value columns + N-1 columns extracted from liasse_postes.
 *
 * Output rows go into company_financials_restatement_log with:
 *   - source_date_cloture = the date_cloture of the filing
 *   - source_rne_updated_at = the rne_updated_at of the NEW (restating) filing
 *   - detected_at = now() (when the backfill ran)
 *
 * Idempotent on re-run if you DELETE the prior backfill first; otherwise
 * duplicates are added. Use `--dry-run` to preview without writing.
 */
import { Pool } from "pg";
import { CERFA_CODE_MAP, type CerfaCodeMeta } from "../src/lib/cerfaCodeMap.js";

const DRY_RUN = process.argv.includes("--dry-run");
const FETCH_BATCH = 5000;
const INSERT_BATCH = 500;

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

const KPI_FIELDS = [
  "chiffre_affaires",
  "resultat_net",
  "total_bilan",
  "capitaux_propres",
  "effectif_moyen",
] as const;

/** Convert any source value into a NUMERIC-safe number or null. */
function coerce(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : null;
}

/** Build flat field map for one source row. */
function flatten(row: SourceRow): FlatValues {
  const m: FlatValues = new Map();
  m.set("chiffre_affaires", coerce(row.chiffre_affaires));
  m.set("resultat_net", coerce(row.resultat_net));
  m.set("total_bilan", coerce(row.total_bilan));
  m.set("capitaux_propres", coerce(row.capitaux_propres));
  m.set("effectif_moyen", coerce(row.effectif_moyen));
  if (row.liasse_postes) {
    for (const p of row.liasse_postes) {
      const meta: CerfaCodeMeta | undefined = CERFA_CODE_MAP[p.code];
      if (!meta) continue;
      m.set(meta.column, coerce(p.montant_exercice_N_euros));
      m.set(meta.column + "_n1", coerce(p.montant_exercice_N_moins_1_euros));
    }
  }
  return m;
}

type LogRow = {
  siren: string;
  exercise_year: number;
  field_name: string;
  old_value: number | null;
  new_value: number | null;
  source_date_cloture: string;
  source_rne_updated_at: string | null;
};

async function flushLogBatch(pool: Pool, batch: LogRow[]): Promise<void> {
  if (batch.length === 0 || DRY_RUN) return;
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

async function main() {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  const pool = new Pool({ connectionString: url, max: 4 });
  const t0 = Date.now();

  console.log(`[backfill-restatements] starting (dry_run=${DRY_RUN})`);

  const client = await pool.connect();
  let sourceRows = 0;
  let restatementGroups = 0;
  let logRows = 0;
  const buffer: LogRow[] = [];

  try {
    await client.query("BEGIN");
    // Stream ordered by (siren, date_cloture, rne_updated_at) so consecutive
    // rows with the same (siren, date_cloture) are restatements of each other.
    await client.query(`
      DECLARE c_restate NO SCROLL CURSOR FOR
      SELECT siren, date_cloture::text AS date_cloture, rne_updated_at,
             chiffre_affaires, resultat_net, total_bilan, capitaux_propres, effectif_moyen,
             liasse_postes
      FROM inpi_financial_statements_ftp
      WHERE liasse_postes IS NOT NULL
        AND siren IS NOT NULL
        AND date_cloture IS NOT NULL
      ORDER BY siren, date_cloture, rne_updated_at NULLS FIRST
    `);

    // State for the current (siren, date_cloture) group: the FIRST seen values.
    let groupKey: string | null = null;
    let groupFirstValues: FlatValues | null = null;
    let lastReport = Date.now();

    while (true) {
      const r = await client.query<SourceRow>(`FETCH ${FETCH_BATCH} FROM c_restate`);
      if (r.rows.length === 0) break;

      for (const row of r.rows) {
        sourceRows++;
        const key = `${row.siren}|${row.date_cloture}`;
        const values = flatten(row);
        const exerciseYear = new Date(row.date_cloture).getUTCFullYear();

        if (key !== groupKey) {
          // New (siren, date_cloture) group — this is the FIRST filing for it
          groupKey = key;
          groupFirstValues = values;
          continue;
        }

        // Same (siren, date_cloture) → this row is a RESTATEMENT of the first
        if (groupFirstValues) {
          let anyDiff = false;
          for (const [field, newV] of values) {
            const oldV = groupFirstValues.get(field) ?? null;
            if ((oldV ?? null) !== (newV ?? null)) {
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
              anyDiff = true;
            }
          }
          if (anyDiff) restatementGroups++;
          // Update the "first" snapshot to the most recent values so we can
          // detect the NEXT restatement against this one (not against the
          // original) — this makes the log a chain of consecutive deltas.
          groupFirstValues = values;
        }

        // Flush buffer when full
        if (buffer.length >= INSERT_BATCH) {
          await flushLogBatch(pool, buffer);
          buffer.length = 0;
        }
      }

      const now = Date.now();
      if (now - lastReport > 5000) {
        const dt = (now - t0) / 1000;
        const rate = sourceRows / dt;
        console.log(`[backfill-restatements] source_rows=${sourceRows.toLocaleString()} restatement_groups=${restatementGroups.toLocaleString()} log_rows=${logRows.toLocaleString()} rate=${rate.toFixed(0)}/s`);
        lastReport = now;
      }
    }

    // Flush remainder
    if (buffer.length > 0) await flushLogBatch(pool, buffer);
    await client.query("COMMIT");

    const dt = (Date.now() - t0) / 1000;
    console.log(`[backfill-restatements] DONE — source_rows=${sourceRows.toLocaleString()} restatement_groups=${restatementGroups.toLocaleString()} log_rows=${logRows.toLocaleString()} elapsed=${dt.toFixed(0)}s${DRY_RUN ? " [DRY-RUN: nothing written]" : ""}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("[backfill-restatements] fatal:", err);
  process.exit(1);
});
