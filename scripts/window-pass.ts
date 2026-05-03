/**
 * Standalone CAGR + 3y-flag back-fill — runs the window pass in chunks
 * with per-chunk logging + ETA, instead of one giant 4h+ UPDATE.
 *
 * Use this after a `screener:full` finishes inserts but you want to fill /
 * refresh the multi-year columns without re-running the whole import.
 *
 *   npm run screener:window
 *   npm run screener:window -- --chunks=100   (more chunks, smaller each)
 *
 * Idempotent : re-running is safe, each chunk just re-computes the same
 * values from the same source rows.
 */
import { Pool } from "pg";

const N_CHUNKS = parseInt(
  process.argv.find(a => a.startsWith("--chunks="))?.split("=")[1] ?? "50",
  10,
);

async function main() {
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  const pool = new Pool({ connectionString: url, max: 4 });
  const t0 = Date.now();

  console.log(`[window] computing CAGR + 3y flags in ${N_CHUNKS} chunks…`);

  // Bucket by first 2 chars of siren — gives ~100 chunks, each touching
  // ~62k sirens (6.5M total / 100). Simple, fast to compute, no scan needed.
  // Allows tuning via --chunks=N : we use N evenly-spaced 2-char prefixes.
  const buckets = Math.min(100, Math.max(2, N_CHUNKS));
  const step = Math.ceil(100 / buckets);
  const chunks: { from: string; to: string | null }[] = [];
  for (let i = 0; i < 100; i += step) {
    const from = i.toString().padStart(2, "0");
    const next = i + step;
    const to = next >= 100 ? null : next.toString().padStart(2, "0");
    chunks.push({ from, to });
  }
  console.log(`[window] ${chunks.length} chunks (siren prefix buckets), first=${chunks[0].from}…${chunks[0].to ?? "∞"}`);

  let done = 0;
  let totalUpdated = 0;
  for (const { from, to } of chunks) {
    const tc = Date.now();
    // siren prefix bucketing: WHERE siren >= 'XX0000000' AND siren < 'YY0000000'
    const fromKey = from + "0000000";
    const toKey = to ? to + "0000000" : null;
    const params: unknown[] = [fromKey];
    const inner = toKey ? `siren >= $1 AND siren < $2` : `siren >= $1`;
    if (toKey) params.push(toKey);
    const outer = toKey ? `s.siren >= $1 AND s.siren < $2` : `s.siren >= $1`;

    const r = await pool.query(`
      WITH series AS (
        SELECT siren, exercise_year,
               chiffre_affaires, resultat_net, effectif_moyen,
               LAG(chiffre_affaires, 3) OVER w AS ca_3y_ago,
               LAG(chiffre_affaires, 5) OVER w AS ca_5y_ago,
               LAG(resultat_net, 3)     OVER w AS rn_3y_ago,
               LAG(resultat_net, 5)     OVER w AS rn_5y_ago,
               LAG(effectif_moyen, 3)   OVER w AS eff_3y_ago,
               LAG(resultat_net, 1)     OVER w AS rn_1,
               LAG(resultat_net, 2)     OVER w AS rn_2,
               LAG(chiffre_affaires, 1) OVER w AS ca_1,
               LAG(chiffre_affaires, 2) OVER w AS ca_2
        FROM company_financials_screener
        WHERE ${inner}
        WINDOW w AS (PARTITION BY siren ORDER BY exercise_year)
      )
      UPDATE company_financials_screener s SET
        chiffre_affaires_cagr_3y_pct = CASE WHEN series.ca_3y_ago > 0 AND series.chiffre_affaires > 0
          THEN (POWER(series.chiffre_affaires::float / series.ca_3y_ago, 1.0/3) - 1) * 100 END,
        chiffre_affaires_cagr_5y_pct = CASE WHEN series.ca_5y_ago > 0 AND series.chiffre_affaires > 0
          THEN (POWER(series.chiffre_affaires::float / series.ca_5y_ago, 1.0/5) - 1) * 100 END,
        resultat_net_cagr_3y_pct = CASE WHEN series.rn_3y_ago > 0 AND series.resultat_net > 0
          THEN (POWER(series.resultat_net::float / series.rn_3y_ago, 1.0/3) - 1) * 100 END,
        resultat_net_cagr_5y_pct = CASE WHEN series.rn_5y_ago > 0 AND series.resultat_net > 0
          THEN (POWER(series.resultat_net::float / series.rn_5y_ago, 1.0/5) - 1) * 100 END,
        effectif_cagr_3y_pct = CASE WHEN series.eff_3y_ago > 0 AND series.effectif_moyen > 0
          THEN (POWER(series.effectif_moyen::float / series.eff_3y_ago, 1.0/3) - 1) * 100 END,
        has_grown_3y = (series.chiffre_affaires > series.ca_1 AND series.ca_1 > series.ca_2),
        is_loss_making_3y = (series.resultat_net < 0 AND series.rn_1 < 0 AND series.rn_2 < 0),
        is_high_growth = (s.chiffre_affaires_yoy_pct >= 30 AND s.chiffre_affaires >= 1000000)
      FROM series
      WHERE s.siren = series.siren AND s.exercise_year = series.exercise_year
        AND ${outer};
    `, params);

    done += 1;
    totalUpdated += r.rowCount ?? 0;
    const dtChunk = ((Date.now() - tc) / 1000).toFixed(1);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? Math.round((chunks.length - done) / rate) : 0;
    console.log(
      `[window] ${done.toString().padStart(3)}/${chunks.length}` +
      ` siren ${from}…${to ?? "∞"}` +
      ` updated=${(r.rowCount ?? 0).toLocaleString().padStart(8)}` +
      ` chunk=${dtChunk}s` +
      ` total=${Math.round(elapsed)}s` +
      ` ETA=${eta}s`,
    );
  }

  console.log(`[window] done in ${((Date.now() - t0) / 1000).toFixed(0)}s, total rows updated=${totalUpdated.toLocaleString()}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
