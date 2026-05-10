/**
 * One-shot: re-parse the raw INPI document stored in `compte_resultat`
 * to fill `liasse_postes` (and the 5 typed KPIs) for the ~6.5M rows where
 * the original ingest didn't extract them.
 *
 * This roughly doubles the screener's coverage from ~6.5M rows to ~13M.
 *
 * Source: `inpi_financial_statements_ftp.compte_resultat` is the raw INPI
 *   document (top-level keys: dateDepot, denomination, siren, bilanSaisi,
 *   typeBilan, …). The line items live nested inside
 *   `bilanSaisi.bilan.detail.pages` and can be re-extracted with the same
 *   parser used at ingest time.
 *
 * Algorithm:
 *   1. Cursor over rows where `liasse_postes IS NULL AND compte_resultat IS NOT NULL`
 *   2. For each row: call `buildRneLiasseFromRawPayload(compte_resultat)` and
 *      `extractFinancialsFromRneJson(compte_resultat)`
 *   3. UPDATE the row with `liasse_postes`, `chiffre_affaires`, `resultat_net`,
 *      `total_bilan`, `capitaux_propres`, `effectif_moyen` if extraction succeeded
 *   4. Skip rows where the parser returns null (e.g. truly redacted bilans)
 *
 * Note: the parser modules are vendored in `screener/src/lib/rne/`
 * (real-copy, not symlink — see CLAUDE.md memory rule). Keep them in
 * sync with `inpi/src/rne/` if the upstream parsers change.
 *
 * Run with `npm run screener:backfill-liasse`. Idempotent — only touches
 * rows still NULL.
 */
import { Pool } from "pg";
import { buildRneLiasseFromRawPayload } from "../src/lib/rne/rneFinancialLiasseFromRaw.js";
import { extractFinancialsFromRneJson } from "../src/lib/rne/extractFinancialsFromRneJson.js";
import { runMigrations } from "../src/runMigrations.js";

const BATCH_SIZE = 1000;

type Row = {
  id: string;
  siren: string;
  date_cloture: string;
  compte_resultat: Record<string, unknown> | null;
};

async function main() {
  const args = process.argv.slice(2);
  const limitStr = args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? null;
  const hardLimit = limitStr ? parseInt(limitStr, 10) : null;
  const dryRun = args.includes("--dry-run");

  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  // Same idempotent migrate pattern as the other entry points.
  await runMigrations(url);
  const pool = new Pool({ connectionString: url, max: 2 });
  let processed = 0, updated = 0, skipped = 0, errored = 0;
  if (dryRun) console.log("[dry-run] no UPDATEs will be issued");
  if (hardLimit) console.log(`[limit] stopping after ${hardLimit} rows`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const limitSql = hardLimit && hardLimit > 0 ? `LIMIT ${hardLimit}` : "";
    await client.query(`DECLARE c_backfill CURSOR FOR
      SELECT id, siren, date_cloture, compte_resultat
      FROM inpi_financial_statements_ftp
      WHERE liasse_postes IS NULL
        AND compte_resultat IS NOT NULL
      ${limitSql}
    `);

    let stop = false;
    while (!stop) {
      const r = await client.query<Row>(`FETCH ${BATCH_SIZE} FROM c_backfill`);
      if (r.rows.length === 0) break;

      for (const row of r.rows) {
        if (hardLimit && processed >= hardLimit) { stop = true; break; }
        processed++;
        if (!row.compte_resultat) { skipped++; continue; }

        let liasse: ReturnType<typeof buildRneLiasseFromRawPayload> = null;
        let fin: ReturnType<typeof extractFinancialsFromRneJson>[number] | null = null;
        try {
          liasse = buildRneLiasseFromRawPayload(row.compte_resultat);
          const allFin = extractFinancialsFromRneJson(row.compte_resultat);
          fin = allFin.find(f => f.dateCloture === row.date_cloture) ?? allFin[0] ?? null;
        } catch (e) {
          errored++;
          if (errored <= 3) console.error(`[parser-error] siren=${row.siren} date=${row.date_cloture}: ${(e as Error).message}`);
          continue;
        }

        const hasLiasse = liasse?.postes_liasse?.length;
        const hasKpi = fin && (fin.chiffreAffaires != null || fin.resultatNet != null
                            || fin.totalBilan != null || fin.capitauxPropres != null
                            || fin.effectifMoyen != null);
        if (!hasLiasse && !hasKpi) { skipped++; continue; }

        if (dryRun) {
          updated++;
          continue;
        }

        await client.query(
          `UPDATE inpi_financial_statements_ftp SET
             liasse_postes    = COALESCE($1::jsonb, liasse_postes),
             chiffre_affaires = COALESCE(chiffre_affaires, $2),
             resultat_net     = COALESCE(resultat_net,     $3),
             total_bilan      = COALESCE(total_bilan,      $4),
             capitaux_propres = COALESCE(capitaux_propres, $5),
             effectif_moyen   = COALESCE(effectif_moyen,   $6)
           WHERE id = $7`,
          [
            hasLiasse ? JSON.stringify(liasse!.postes_liasse) : null,
            fin?.chiffreAffaires ?? null,
            fin?.resultatNet ?? null,
            fin?.totalBilan ?? null,
            fin?.capitauxPropres ?? null,
            fin?.effectifMoyen ?? null,
            row.id,
          ],
        );
        updated++;
      }

      if (processed % 50000 === 0) {
        console.log(`processed=${processed} updated=${updated} skipped=${skipped} errored=${errored}`);
      }
    }

    await client.query("COMMIT");
    console.log(`DONE processed=${processed} updated=${updated} skipped=${skipped} errored=${errored}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
