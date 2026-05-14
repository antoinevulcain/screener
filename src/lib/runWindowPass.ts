/**
 * Window-pass runner: refresh CAGR + 3y-flag columns on
 * company_financials_screener.
 *
 * Flow per chunk (chunked by 2-char siren prefix):
 *   1. SELECT source rows + current stored multi-year columns,
 *      ordered by (siren, type_comptes, exercise_year).
 *   2. Group by (siren, type_comptes), run computeWindowMetricsForSiren
 *      in Node — sociaux (C) and consolidé (K) are independent series
 *      and CAGRs must not mix the two (a holding's 700K€ sociaux next
 *      to its 200Md€ consolidé would yield nonsense CAGRs).
 *   3. Keep only rows where the freshly computed metrics differ from
 *      what's already stored (skip no-op writes).
 *   4. Send batched UPDATEs via unnest(arrays) — one statement per
 *      BATCH_SIZE rows; the WHERE clause matches on the (siren,
 *      exercise_year, type_comptes) PK introduced in migration 006.
 *
 * The DB does plain reads and writes only; the multi-year LAG/CAGR
 * logic runs in Node. No window functions are evaluated in Postgres.
 *
 * Shared between scripts/window-pass.ts (standalone) and the tail of
 * scripts/build-screener.ts (full / incremental builds).
 */

import { Pool } from "pg";
import {
  computeWindowMetricsForSiren,
  type WindowSourceRow,
  type WindowMetrics,
} from "./computeWindowMetrics.js";

const BATCH_SIZE = 5000;

interface ChunkedRow extends WindowSourceRow {
  type_comptes:                 string;
  chiffre_affaires_cagr_3y_pct: number | null;
  chiffre_affaires_cagr_5y_pct: number | null;
  resultat_net_cagr_3y_pct:     number | null;
  resultat_net_cagr_5y_pct:     number | null;
  effectif_cagr_3y_pct:         number | null;
  has_grown_3y:                 boolean | null;
  is_loss_making_3y:            boolean | null;
  is_high_growth:               boolean | null;
}

interface PendingUpdate {
  siren: string;
  exercise_year: number;
  type_comptes: string;
  m: WindowMetrics;
}

/**
 * Compare a stored REAL value (as returned by pg-driver — text-parsed float64
 * that's *close* to but not bit-equal to the underlying float32) against a
 * freshly computed value (already `Math.fround`-rounded inside cagrPct).
 * Bringing both sides through Math.fround normalises them to the same float32
 * representation; without this every row would always diff and re-write.
 */
function eqReal(stored: number | null, computed: number | null): boolean {
  if (stored === null) return computed === null;
  if (computed === null) return false;
  return Math.fround(stored) === computed;
}

function metricsDiffer(stored: ChunkedRow, computed: WindowMetrics): boolean {
  return (
    !eqReal(stored.chiffre_affaires_cagr_3y_pct, computed.chiffre_affaires_cagr_3y_pct) ||
    !eqReal(stored.chiffre_affaires_cagr_5y_pct, computed.chiffre_affaires_cagr_5y_pct) ||
    !eqReal(stored.resultat_net_cagr_3y_pct,     computed.resultat_net_cagr_3y_pct) ||
    !eqReal(stored.resultat_net_cagr_5y_pct,     computed.resultat_net_cagr_5y_pct) ||
    !eqReal(stored.effectif_cagr_3y_pct,         computed.effectif_cagr_3y_pct) ||
    stored.has_grown_3y      !== computed.has_grown_3y ||
    stored.is_loss_making_3y !== computed.is_loss_making_3y ||
    stored.is_high_growth    !== computed.is_high_growth
  );
}

async function flushUpdates(pool: Pool, batch: PendingUpdate[]): Promise<void> {
  if (batch.length === 0) return;
  const sirens = batch.map(u => u.siren);
  const years  = batch.map(u => u.exercise_year);
  const types  = batch.map(u => u.type_comptes);
  const ca3    = batch.map(u => u.m.chiffre_affaires_cagr_3y_pct);
  const ca5    = batch.map(u => u.m.chiffre_affaires_cagr_5y_pct);
  const rn3    = batch.map(u => u.m.resultat_net_cagr_3y_pct);
  const rn5    = batch.map(u => u.m.resultat_net_cagr_5y_pct);
  const eff3   = batch.map(u => u.m.effectif_cagr_3y_pct);
  const grew   = batch.map(u => u.m.has_grown_3y);
  const lossy  = batch.map(u => u.m.is_loss_making_3y);
  const hg     = batch.map(u => u.m.is_high_growth);

  await pool.query(
    `
    UPDATE company_financials_screener s SET
      chiffre_affaires_cagr_3y_pct = v.ca3,
      chiffre_affaires_cagr_5y_pct = v.ca5,
      resultat_net_cagr_3y_pct     = v.rn3,
      resultat_net_cagr_5y_pct     = v.rn5,
      effectif_cagr_3y_pct         = v.eff3,
      has_grown_3y                 = v.grew,
      is_loss_making_3y            = v.lossy,
      is_high_growth               = v.hg
    FROM unnest(
      $1::varchar[],  $2::smallint[],  $3::varchar[],
      $4::real[],     $5::real[],
      $6::real[],     $7::real[],
      $8::real[],
      $9::bool[],     $10::bool[],     $11::bool[]
    ) AS v(siren, exercise_year, type_comptes, ca3, ca5, rn3, rn5, eff3, grew, lossy, hg)
    WHERE s.siren = v.siren
      AND s.exercise_year = v.exercise_year
      AND s.type_comptes = v.type_comptes
    `,
    [sirens, years, types, ca3, ca5, rn3, rn5, eff3, grew, lossy, hg],
  );
}

export interface RunWindowPassOptions {
  nChunks?: number;
}

export async function runWindowPass(pool: Pool, opts: RunWindowPassOptions = {}): Promise<void> {
  const nChunks = opts.nChunks ?? 50;
  const t0 = Date.now();

  const buckets = Math.min(100, Math.max(2, nChunks));
  const step = Math.ceil(100 / buckets);
  const chunks: { from: string; to: string | null }[] = [];
  for (let i = 0; i < 100; i += step) {
    const from = i.toString().padStart(2, "0");
    const next = i + step;
    const to = next >= 100 ? null : next.toString().padStart(2, "0");
    chunks.push({ from, to });
  }
  console.log(
    `[window] computing CAGR + 3y flags in Node, ${chunks.length} chunks` +
    ` (siren prefix buckets), first=${chunks[0].from}…${chunks[0].to ?? "∞"}`,
  );

  let done = 0;
  let totalWritten = 0;
  let totalScanned = 0;
  for (const { from, to } of chunks) {
    const chunkLabel = `${(done + 1).toString().padStart(3)}/${chunks.length} siren ${from}…${to ?? "∞"}`;
    const tc = Date.now();
    const fromKey = from + "0000000";
    const toKey = to ? to + "0000000" : null;
    const params: unknown[] = [fromKey];
    const where = toKey ? `siren >= $1 AND siren < $2` : `siren >= $1`;
    if (toKey) params.push(toKey);

    console.log(`[window] ${chunkLabel} SELECT start`);
    const tSel = Date.now();
    const res = await pool.query<ChunkedRow>(
      `
      SELECT siren, exercise_year, type_comptes,
             chiffre_affaires, resultat_net, effectif_moyen,
             chiffre_affaires_yoy_pct,
             chiffre_affaires_cagr_3y_pct, chiffre_affaires_cagr_5y_pct,
             resultat_net_cagr_3y_pct,     resultat_net_cagr_5y_pct,
             effectif_cagr_3y_pct,
             has_grown_3y, is_loss_making_3y, is_high_growth
      FROM company_financials_screener
      WHERE ${where}
      ORDER BY siren, type_comptes, exercise_year
      `,
      params,
    );
    console.log(
      `[window] ${chunkLabel} SELECT done` +
      ` rows=${res.rows.length.toLocaleString()}` +
      ` in ${((Date.now() - tSel) / 1000).toFixed(1)}s`,
    );

    const tCompute = Date.now();
    const updates: PendingUpdate[] = [];
    // We group by (siren, type_comptes) — sociaux and consolidé are
    // independent series whose CAGRs must be computed separately. The
    // SELECT's ORDER BY (siren, type_comptes, exercise_year) keeps
    // identical (siren, type_comptes) rows contiguous.
    let seriesSeen = 0;
    let i = 0;
    while (i < res.rows.length) {
      const siren = res.rows[i].siren;
      const typeC = res.rows[i].type_comptes;
      let j = i;
      while (
        j < res.rows.length &&
        res.rows[j].siren === siren &&
        res.rows[j].type_comptes === typeC
      ) j++;
      const seriesRows = res.rows.slice(i, j);
      const computed = computeWindowMetricsForSiren(seriesRows);
      for (let k = 0; k < seriesRows.length; k++) {
        if (metricsDiffer(seriesRows[k], computed[k])) {
          updates.push({
            siren,
            exercise_year: seriesRows[k].exercise_year,
            type_comptes: typeC,
            m: computed[k],
          });
        }
      }
      seriesSeen += 1;
      i = j;
    }
    console.log(
      `[window] ${chunkLabel} compute done` +
      ` series=${seriesSeen.toLocaleString()}` +
      ` toWrite=${updates.length.toLocaleString()}` +
      ` (skipped ${(res.rows.length - updates.length).toLocaleString()})` +
      ` in ${((Date.now() - tCompute) / 1000).toFixed(1)}s`,
    );

    const totalBatches = Math.ceil(updates.length / BATCH_SIZE);
    for (let k = 0; k < updates.length; k += BATCH_SIZE) {
      const batchNum = Math.floor(k / BATCH_SIZE) + 1;
      const slice = updates.slice(k, k + BATCH_SIZE);
      const tFlush = Date.now();
      await flushUpdates(pool, slice);
      console.log(
        `[window] ${chunkLabel} flush ${batchNum}/${totalBatches}` +
        ` wrote=${slice.length.toLocaleString()}` +
        ` in ${((Date.now() - tFlush) / 1000).toFixed(1)}s`,
      );
    }

    done += 1;
    totalWritten += updates.length;
    totalScanned += res.rows.length;
    const dt = ((Date.now() - tc) / 1000).toFixed(1);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? Math.round((chunks.length - done) / rate) : 0;
    console.log(
      `[window] ${chunkLabel} CHUNK DONE` +
      ` scanned=${res.rows.length.toLocaleString()}` +
      ` written=${updates.length.toLocaleString()}` +
      ` chunk=${dt}s total=${Math.round(elapsed)}s ETA=${eta}s`,
    );
  }

  console.log(
    `[window] done in ${((Date.now() - t0) / 1000).toFixed(0)}s,` +
    ` scanned=${totalScanned.toLocaleString()} written=${totalWritten.toLocaleString()}`,
  );
}
