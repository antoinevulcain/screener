/**
 * api/scripts/buildScreener.ts
 *
 * DRAFT — nightly batch that rebuilds (or incrementally refreshes)
 * `company_financials_screener`.
 *
 * Modes:
 *   --full              Rebuild from scratch (TRUNCATE + bulk insert). ~12h on 6.5M rows.
 *   --since=YYYY-MM-DD  Refresh only rows where rne_updated_at > since.
 *   (default)           Refresh since the last successful run logged in
 *                       company_financials_screener_run_log.
 *
 * Pipeline (per batch of 5000 rows):
 *   1. SELECT from FROM_INPI_FINANCIAL_MERGED  (ftp ∪ api ∪ ex, deduped)
 *   2. For each row:
 *        a. parse `liasse_postes` → pivot { code → montant_n, montant_n1 }
 *        b. apply CERFA_CODE_MAP to get column-name keys
 *        c. fetch sirene context (cached in-memory by siren)
 *        d. call computeScreenerRow() to compute ratios + YoY + flags
 *   3. UPSERT batch via INSERT … ON CONFLICT (siren, exercise_year) DO UPDATE
 *
 * After all batches: a single UPDATE pass with window functions per siren
 * to fill CAGR and 3-year flags (has_grown_3y, is_loss_making_3y, etc.).
 *
 * Logging: row written to company_financials_screener_run_log on each run.
 *
 * Connection: uses DATABASE_URL_DATA (the prod data DB). Run with a low
 * statement_timeout per query (30s) to avoid pinning the shared replica.
 */

import { Pool } from "pg";
import { CERFA_CODE_MAP, type CerfaCodeMeta } from "../src/lib/cerfaCodeMap.js";
import { computeScreenerRow, type ScreenerRowInput } from "../src/lib/computeRatios.js";
import { runMigrations } from "../src/runMigrations.js";

type LiassePoste = {
  code: string;
  libelle: string;
  montant_exercice_N_euros: number | null;
  montant_exercice_N_moins_1_euros: number | null;
  colonnes_liasse: string;
  page: number;
};

type SirenContext = {
  naf_code: string | null;
  naf_section: string | null;
  forme_juridique: string | null;
  effectif_tranche: string | null;
  region_code: string | null;
  departement: string | null;
  insee_commune: string | null;
  date_creation: string | null;
  display_denomination: string | null;
};

type SourceRow = {
  fs_id: string;
  siren: string;
  date_cloture: string;
  duree_exercice: number | null;
  type_comptes: string | null;
  confidentialite: string | null;
  // BIGINTs come back as strings from node-postgres (preserves precision).
  // Run them through coerceMontant before any computation.
  chiffre_affaires: string | number | null;
  resultat_net: string | number | null;
  total_bilan: string | number | null;
  capitaux_propres: string | number | null;
  effectif_moyen: number | null;
  ocr_chiffre_affaires: string | number | null;
  ocr_resultat_net: string | number | null;
  ocr_total_bilan: string | number | null;
  ocr_capitaux_propres: string | number | null;
  ocr_effectif_moyen: number | null;
  liasse_postes: LiassePoste[] | null;
  rne_updated_at: string | null;
};

const BATCH_SIZE = 5000;

/**
 * Coerce a JSON montant value into a safe BIGINT-fittable integer or null.
 * Source `liasse_postes` was produced by various pipelines (RNE direct,
 * OCR fallback, retro-extraction) so values may arrive as numbers, numeric
 * strings, or malformed concatenations like "-130676108563-5". Anything
 * that doesn't parse cleanly as an int64 returns null.
 *
 * BIGINT range: ±9.22e18. We additionally cap at ±1e15 (a quadrillion €)
 * since real bilan amounts never exceed that.
 */
const BIGINT_SAFE_MAX = 1e15;
function coerceMontant(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= BIGINT_SAFE_MAX ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  // Reject anything with more than one minus or non-trailing non-digit
  const s = v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) && Math.abs(n) <= BIGINT_SAFE_MAX ? Math.round(n) : null;
}

function pivotLiasse(postes: LiassePoste[] | null): {
  cerfa: Record<string, number | null>;
  cerfa_n1: Record<string, number | null>;
} {
  const cerfa: Record<string, number | null> = {};
  const cerfa_n1: Record<string, number | null> = {};
  if (!postes) return { cerfa, cerfa_n1 };
  for (const p of postes) {
    const meta = CERFA_CODE_MAP[p.code];
    if (!meta) continue; // unknown code (long tail beyond inventory) — kept in liasse_postes JSONB
    cerfa[meta.column] = coerceMontant(p.montant_exercice_N_euros);
    cerfa_n1[meta.column] = coerceMontant(p.montant_exercice_N_moins_1_euros);
  }
  return { cerfa, cerfa_n1 };
}

function coalesce<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null) return v;
  return null;
}

async function fetchSirenContext(pool: Pool, sirens: string[]): Promise<Map<string, SirenContext>> {
  // sirene_companies has the legal-unit fields; sirene_establishments holds
  // the address fields on the siège (is_siege = true). Join keeps it to one
  // round-trip per batch.
  const result = await pool.query<{
    siren: string;
    naf_code: string | null;
    forme_juridique: string | null;
    tranche_effectifs: string | null;
    date_creation: string | null;
    denomination: string | null;
    nom_commercial: string | null;
    nom_unite_legale: string | null;
    prenom_unite_legale: string | null;
    adresse_code_postal: string | null;
    adresse_code_commune: string | null;
  }>(
    `SELECT c.siren,
            c.activite_principale         AS naf_code,
            c.forme_juridique,
            c.tranche_effectifs,
            c.date_creation,
            c.denomination,
            c.nom_commercial,
            c.nom_unite_legale,
            c.prenom_unite_legale,
            e.adresse_code_postal,
            e.adresse_code_commune
     FROM sirene_companies c
     LEFT JOIN LATERAL (
       SELECT adresse_code_postal, adresse_code_commune
       FROM sirene_establishments e
       WHERE e.siren = c.siren AND e.is_siege = true
       ORDER BY e.updated_at DESC NULLS LAST
       LIMIT 1
     ) e ON true
     WHERE c.siren = ANY($1)`,
    [sirens],
  );

  // NAF section letter: derive from the activité principale (NAF rev2 starts with
  // 2-digit division; sections are A..U groupings). For a v1, use the first 2
  // chars as proxy; a real lookup would need a NAF→section reference table.
  const nafSection = (naf: string | null): string | null => {
    if (!naf) return null;
    const div = parseInt(naf.slice(0, 2), 10);
    if (!Number.isFinite(div)) return null;
    if (div >= 1 && div <= 3) return "A";
    if (div >= 5 && div <= 9) return "B";
    if (div >= 10 && div <= 33) return "C";
    if (div === 35) return "D";
    if (div >= 36 && div <= 39) return "E";
    if (div >= 41 && div <= 43) return "F";
    if (div >= 45 && div <= 47) return "G";
    if (div >= 49 && div <= 53) return "H";
    if (div >= 55 && div <= 56) return "I";
    if (div >= 58 && div <= 63) return "J";
    if (div >= 64 && div <= 66) return "K";
    if (div === 68) return "L";
    if (div >= 69 && div <= 75) return "M";
    if (div >= 77 && div <= 82) return "N";
    if (div === 84) return "O";
    if (div === 85) return "P";
    if (div >= 86 && div <= 88) return "Q";
    if (div >= 90 && div <= 93) return "R";
    if (div >= 94 && div <= 96) return "S";
    if (div >= 97 && div <= 98) return "T";
    if (div === 99) return "U";
    return null;
  };

  // Département from postal code: 5-digit FR postal code → 2-digit dept.
  // Special cases: 20xxx → "2A" (Corse-du-Sud, 200/201xx) or "2B" (Haute-Corse, 202xx);
  // 97xxx / 98xxx → 3-digit DOM/COM ("971", "972", …).
  const deptFromCp = (cp: string | null): string | null => {
    if (!cp || cp.length < 2) return null;
    const head2 = cp.slice(0, 2);
    if (head2 === "20") {
      const n = parseInt(cp.slice(0, 3), 10);
      return Number.isFinite(n) && n >= 200 && n <= 201 ? "2A"
           : Number.isFinite(n) && n >= 202 && n <= 207 ? "2B"
           : "2A";
    }
    if (head2 === "97" || head2 === "98") return cp.slice(0, 3);
    return head2;
  };

  const displayDenom = (r: { denomination: string | null; nom_commercial: string | null; nom_unite_legale: string | null; prenom_unite_legale: string | null }): string | null => {
    if (r.denomination) return r.denomination;
    if (r.nom_commercial) return r.nom_commercial;
    if (r.nom_unite_legale || r.prenom_unite_legale)
      return [r.prenom_unite_legale, r.nom_unite_legale].filter(Boolean).join(" ").trim() || null;
    return null;
  };

  const m = new Map<string, SirenContext>();
  for (const r of result.rows) {
    m.set(r.siren, {
      naf_code: r.naf_code,
      naf_section: nafSection(r.naf_code),
      forme_juridique: r.forme_juridique,
      effectif_tranche: r.tranche_effectifs,
      region_code: null, // requires NAF/dept→region lookup table; left null in v1
      departement: deptFromCp(r.adresse_code_postal),
      insee_commune: r.adresse_code_commune,
      date_creation: r.date_creation,
      display_denomination: displayDenom(r),
    });
  }
  return m;
}

function rowToInsertParams(row: SourceRow, ctx: SirenContext | null) {
  const { cerfa, cerfa_n1 } = pivotLiasse(row.liasse_postes);
  // node-postgres returns BIGINT as a string; corrupt source rows can have
  // values that overflow BIGINT (20+ digit strings) or have weird formatting.
  // coerceMontant rejects anything outside ±1e15 so PG never sees a bad bigint.
  const ca   = coerceMontant(coalesce(row.chiffre_affaires,  row.ocr_chiffre_affaires));
  const rn   = coerceMontant(coalesce(row.resultat_net,      row.ocr_resultat_net));
  const tb   = coerceMontant(coalesce(row.total_bilan,       row.ocr_total_bilan));
  const cp   = coerceMontant(coalesce(row.capitaux_propres,  row.ocr_capitaux_propres));
  const effRaw = coalesce(row.effectif_moyen, row.ocr_effectif_moyen);
  // effectif is INTEGER (32-bit) in PG; cap accordingly
  const eff: number | null = (() => {
    const n = coerceMontant(effRaw);
    if (n === null) return null;
    if (n < 0 || n > 2_147_483_647) return null;
    return n;
  })();

  // N-1 KPIs sourced from the liasse pivot via a known mapping
  const ca_n1 = coalesce(cerfa_n1.c_fj /* RN */, cerfa_n1.c_232 /* RS */);
  const rn_n1 = coalesce(cerfa_n1.c_hn /* RN */, cerfa_n1.c_310 /* RS */, cerfa_n1.c_di /* bilan */);
  const tb_n1 = coalesce(cerfa_n1.c_co /* RN */, cerfa_n1.c_110 /* RS */);
  const cp_n1 = coalesce(cerfa_n1.c_dl /* RN */, cerfa_n1.c_142 /* RS */);
  const eff_n1 = coalesce(cerfa_n1.c_376 /* RS */); // RN reports effectif elsewhere

  const dureeMois = row.duree_exercice != null ? Math.round(row.duree_exercice / 30) : null;

  const input: ScreenerRowInput = {
    chiffre_affaires: ca,
    resultat_net: rn,
    total_bilan: tb,
    capitaux_propres: cp,
    effectif_moyen: eff,
    chiffre_affaires_n1: ca_n1,
    resultat_net_n1: rn_n1,
    total_bilan_n1: tb_n1,
    capitaux_propres_n1: cp_n1,
    effectif_moyen_n1: eff_n1,
    cerfa,
    duree_exercice_mois: dureeMois,
  };

  const computed = computeScreenerRow(input);

  return {
    siren: row.siren,
    date_cloture: row.date_cloture,
    exercise_year: new Date(row.date_cloture).getUTCFullYear(),
    duree_exercice_mois: dureeMois,
    type_comptes: row.type_comptes,
    type_bilan: row.type_comptes === "consolide" ? "CONSO" :
                row.type_comptes === "simplifie" ? "RS" : "RN",
    is_confidential: row.confidentialite === "confidentiel",
    source: row.chiffre_affaires != null ? "rne" : (row.ocr_chiffre_affaires != null ? "ocr" : "rne"),
    naf_code: ctx?.naf_code ?? null,
    naf_section: ctx?.naf_section ?? null,
    forme_juridique: ctx?.forme_juridique ?? null,
    effectif_tranche: ctx?.effectif_tranche ?? null,
    region_code: ctx?.region_code ?? null,
    departement: ctx?.departement ?? null,
    insee_commune: ctx?.insee_commune ?? null,
    date_creation: ctx?.date_creation ?? null,
    age_years: ctx?.date_creation
      ? new Date(row.date_cloture).getUTCFullYear() - new Date(ctx.date_creation).getUTCFullYear()
      : null,
    display_denomination: ctx?.display_denomination ?? null,
    chiffre_affaires: ca, resultat_net: rn, total_bilan: tb, capitaux_propres: cp, effectif_moyen: eff,
    chiffre_affaires_n1: ca_n1, resultat_net_n1: rn_n1, total_bilan_n1: tb_n1, capitaux_propres_n1: cp_n1, effectif_moyen_n1: eff_n1,
    ...computed,
    cerfa,         // expanded into c_<CODE> columns at INSERT time
    cerfa_n1,      // expanded into c_<CODE>_n1 columns at INSERT time
    liasse_postes: row.liasse_postes, // store full JSONB for long-tail GIN queries
    fs_id: row.fs_id,
    rne_updated_at: row.rne_updated_at,
  };
}

/**
 * Static column list — the `siren` and `exercise_year` first (PK), then everything else.
 * Order matters because the INSERT VALUES tuples follow it.
 *
 * Cerfa columns (value, _n1, _yoy_pct) appear three times each — generated from
 * CERFA_CODE_MAP. YoY % is computed at INSERT time inside SQL so it stays
 * consistent with the typed value/n1 columns even if a future schema change
 * shifts how YoY is defined.
 */
const FIXED_COLUMNS: readonly string[] = [
  "siren", "exercise_year", "date_cloture", "duree_exercice_mois",
  "type_comptes", "type_bilan", "is_confidential", "is_short_exercise", "source",
  "naf_code", "naf_section", "forme_juridique", "effectif_tranche",
  "region_code", "departement", "insee_commune", "date_creation", "age_years",
  "display_denomination",
  "chiffre_affaires", "resultat_net", "total_bilan", "capitaux_propres", "effectif_moyen",
  "chiffre_affaires_n1", "resultat_net_n1", "total_bilan_n1", "capitaux_propres_n1", "effectif_moyen_n1",
  "chiffre_affaires_yoy_pct", "resultat_net_yoy_pct", "total_bilan_yoy_pct", "capitaux_propres_yoy_pct", "effectif_yoy_pct",
  "chiffre_affaires_yoy_abs", "resultat_net_yoy_abs", "total_bilan_yoy_abs", "capitaux_propres_yoy_abs",
  "chiffre_affaires_annualise", "resultat_net_annualise",
  "valeur_ajoutee", "ebe", "ebitda", "caf", "bfr", "fonds_roulement", "tresorerie_nette",
  "marge_brute_pct", "marge_commerciale_pct", "marge_production_pct",
  "marge_exploitation_pct", "marge_nette_pct", "marge_ebe_pct", "marge_ebitda_pct", "taux_va_pct",
  "roa_pct", "roe_pct", "roic_pct", "roce_pct",
  "autonomie_financiere_pct", "taux_endettement_pct", "taux_endettement_global_pct",
  "capacite_remboursement_ans", "couverture_charges_fin",
  "liquidite_generale", "liquidite_reduite", "liquidite_immediate",
  "bfr_jours_ca", "dso_jours", "dpo_jours", "rotation_stocks_jours",
  "ca_par_salarie", "va_par_salarie", "resultat_par_salarie",
  "poids_masse_salariale_pct", "poids_dotations_pct", "poids_charges_externes_pct",
  "is_loss_making", "swung_to_profit", "swung_to_loss",
  "liasse_postes", "fs_id", "rne_updated_at",
] as const;

const CERFA_VALUE_COLUMNS: string[] = Object.values(CERFA_CODE_MAP).map((m: CerfaCodeMeta) => m.column);
const CERFA_N1_COLUMNS: string[] = CERFA_VALUE_COLUMNS.map(c => `${c}_n1`);
const CERFA_YOY_COLUMNS: string[] = CERFA_VALUE_COLUMNS.map(c => `${c}_yoy_pct`);

// Total columns we INSERT into (yoy_pct columns are SET via SQL expressions, not parameters)
const PARAMETER_COLUMNS: string[] = [
  ...FIXED_COLUMNS,
  ...CERFA_VALUE_COLUMNS,
  ...CERFA_N1_COLUMNS,
];

const ALL_INSERT_COLUMNS: string[] = [
  ...PARAMETER_COLUMNS,
  ...CERFA_YOY_COLUMNS,
];

const PARAM_COUNT = PARAMETER_COLUMNS.length;

/** Build the per-row VALUES placeholder block: ($1, $2, ..., $K, <yoy expressions>) */
function buildValuesTuple(rowIdx: number): string {
  const offset = rowIdx * PARAM_COUNT;
  const params: string[] = [];
  for (let i = 0; i < PARAM_COUNT; i++) params.push(`$${offset + i + 1}`);
  // yoy expressions: ((value - n1) / NULLIF(ABS(n1), 0)) * 100
  // The value param index = FIXED_COLUMNS.length + i (within row offset)
  // The n1 param index    = FIXED_COLUMNS.length + CERFA_VALUE_COLUMNS.length + i
  const fixedLen = FIXED_COLUMNS.length;
  const cerfaLen = CERFA_VALUE_COLUMNS.length;
  const yoyExprs: string[] = [];
  for (let i = 0; i < cerfaLen; i++) {
    const valIdx = offset + fixedLen + i + 1;
    const n1Idx  = offset + fixedLen + cerfaLen + i + 1;
    yoyExprs.push(
      `CASE WHEN $${valIdx}::bigint IS NULL OR $${n1Idx}::bigint IS NULL OR $${n1Idx}::bigint = 0 THEN NULL ` +
      `ELSE (($${valIdx}::bigint - $${n1Idx}::bigint)::float / ABS($${n1Idx}::bigint)) * 100 END`
    );
  }
  return `(${[...params, ...yoyExprs].join(", ")})`;
}

/** Build the static INSERT prefix once. */
const INSERT_SQL_PREFIX = (() => {
  const cols = ALL_INSERT_COLUMNS.map(c => `"${c}"`).join(", ");
  // ON CONFLICT update set: every column except siren, exercise_year (the PK)
  // gets set to EXCLUDED.col. (We use computed_at = now() implicitly.)
  const updateSet = ALL_INSERT_COLUMNS
    .filter(c => c !== "siren" && c !== "exercise_year")
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(", ");
  return {
    head: `INSERT INTO company_financials_screener (${cols}) VALUES `,
    tail: ` ON CONFLICT (siren, exercise_year) DO UPDATE SET ${updateSet}, computed_at = now()`,
  };
})();

/** Convert a built row object into a flat parameter array matching PARAMETER_COLUMNS order. */
function rowToParams(row: Record<string, unknown>): unknown[] {
  const out: unknown[] = new Array(PARAM_COUNT);
  // Fixed columns
  for (let i = 0; i < FIXED_COLUMNS.length; i++) {
    const k = FIXED_COLUMNS[i];
    let v = row[k];
    if (k === "liasse_postes" && v != null) v = JSON.stringify(v);
    out[i] = v ?? null;
  }
  // Cerfa value columns
  const cerfa = (row.cerfa as Record<string, number | null>) ?? {};
  for (let i = 0; i < CERFA_VALUE_COLUMNS.length; i++) {
    out[FIXED_COLUMNS.length + i] = cerfa[CERFA_VALUE_COLUMNS[i]] ?? null;
  }
  // Cerfa N-1 columns
  const cerfa_n1 = (row.cerfa_n1 as Record<string, number | null>) ?? {};
  for (let i = 0; i < CERFA_N1_COLUMNS.length; i++) {
    out[FIXED_COLUMNS.length + CERFA_VALUE_COLUMNS.length + i] = cerfa_n1[CERFA_VALUE_COLUMNS[i]] ?? null;
  }
  return out;
}

// Postgres wire protocol uses int16 for parameter count → max 32767 per bind.
// At PARAM_COUNT params per row, INSERT_CHUNK rows per query stays safely under.
const PG_PARAM_HARD_LIMIT = 32000; // small safety margin under 32767
const INSERT_CHUNK = Math.max(1, Math.floor(PG_PARAM_HARD_LIMIT / PARAM_COUNT));

async function processBatch(pool: Pool, batch: SourceRow[]): Promise<number> {
  if (batch.length === 0) return 0;
  const sirens = [...new Set(batch.map(r => r.siren))];
  const ctxMap = await fetchSirenContext(pool, sirens);

  // Pre-compute the built rows once (parsing + ratios + sirene context)
  const allBuilt = batch.map(r => rowToInsertParams(r, ctxMap.get(r.siren) ?? null));

  // Dedupe within the batch on (siren, exercise_year). Two source rows can share
  // an exercise year when a company filed twice (e.g. 06-30 + 12-31 closures in
  // the same calendar year). Keep the most recent by date_cloture; tie-break by
  // rne_updated_at. ON CONFLICT can only affect a row once per command.
  const dedupeMap = new Map<string, ReturnType<typeof rowToInsertParams>>();
  for (const built of allBuilt) {
    const key = `${built.siren}|${built.exercise_year}`;
    const prev = dedupeMap.get(key);
    if (!prev) { dedupeMap.set(key, built); continue; }
    const a = built.date_cloture ?? "";
    const b = prev.date_cloture ?? "";
    if (a > b) { dedupeMap.set(key, built); continue; }
    if (a === b) {
      const ra = built.rne_updated_at ?? "";
      const rb = prev.rne_updated_at ?? "";
      if (ra > rb) dedupeMap.set(key, built);
    }
  }
  const builtRows = [...dedupeMap.values()];

  // Build one chunk's SQL + params
  const buildChunk = (chunk: typeof builtRows): { sql: string; params: unknown[] } => {
    const allParams: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const params = rowToParams(chunk[i]);
      for (const p of params) allParams.push(p);
      tuples.push(buildValuesTuple(i));
    }
    return { sql: INSERT_SQL_PREFIX.head + tuples.join(", ") + INSERT_SQL_PREFIX.tail, params: allParams };
  };

  // Split into chunks first
  const chunks: typeof builtRows[] = [];
  for (let s = 0; s < builtRows.length; s += INSERT_CHUNK) {
    chunks.push(builtRows.slice(s, s + INSERT_CHUNK));
  }

  // Run INSERT chunks in pools of CONCURRENCY to amortize the 40ms RTT to Railway.
  // ON CONFLICT DO UPDATE makes them order-independent within a single batch
  // (after dedupe), so parallelism is safe.
  const CONCURRENCY = 4;
  let totalUpserted = 0;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const slice = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async chunk => {
        const { sql, params } = buildChunk(chunk);
        const r = await pool.query(sql, params);
        return r.rowCount ?? chunk.length;
      }),
    );
    totalUpserted += results.reduce((a, b) => a + b, 0);
  }
  return totalUpserted;
}

async function* streamSource(pool: Pool, since: Date | null, hardLimit: number | null = null) {
  // Cursor over the merged view to avoid loading 6.5M rows in memory.
  // The merged view is `_ftp ∪ _api ∪ _ex` deduped by (siren, date_cloture).
  // For nightly incremental refresh, `since` is set and the WHERE pushes
  // the predicate down through the UNION. For full backfill, we walk the
  // entire population — Postgres uses idx_inpi_financials_date for the
  // ORDER BY when scanning is naturally clustered.
  //
  // The `hardLimit` arg adds a SQL-level LIMIT — used by `--limit=N` smoke
  // tests so we don't sort the whole 13M rows when we only want N.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params: unknown[] = [];
    let where = "fs.liasse_postes IS NOT NULL";
    if (since) { params.push(since.toISOString()); where += ` AND fs.rne_updated_at > $${params.length}`; }
    const limitClause = hardLimit && hardLimit > 0 ? `LIMIT ${hardLimit}` : "";
    await client.query(
      `DECLARE c_screener CURSOR FOR
       SELECT
         fs.id AS fs_id, fs.siren, fs.date_cloture, fs.duree_exercice,
         fs.type_comptes, fs.confidentialite,
         fs.chiffre_affaires, fs.resultat_net, fs.total_bilan, fs.capitaux_propres, fs.effectif_moyen,
         fs.ocr_chiffre_affaires, fs.ocr_resultat_net, fs.ocr_total_bilan, fs.ocr_capitaux_propres, fs.ocr_effectif_moyen,
         fs.liasse_postes, fs.rne_updated_at
       FROM (
         SELECT * FROM inpi_financial_statements_ftp
         UNION ALL SELECT * FROM inpi_financial_statements_api
         UNION ALL SELECT * FROM inpi_financial_statements_ex
       ) fs
       WHERE ${where}
       ${limitClause}`,
      params,
    );
    while (true) {
      const r = await client.query<SourceRow>(`FETCH ${BATCH_SIZE} FROM c_screener`);
      if (r.rows.length === 0) break;
      yield r.rows;
    }
    await client.query("COMMIT");
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* fine if already committed */ }
    client.release();
  }
}

async function runWindowPass(pool: Pool) {
  // CAGR + 3y flags rely on LAG(N) per siren — needs the full series.
  // Chunk by siren-prefix bucket : siren >= 'XX0000000' AND siren < 'YY0000000'.
  // Same logic as scripts/window-pass.ts (kept in sync — change both together).
  console.log("[window] computing CAGR + 3y flags in 50 chunks…");
  const t0 = Date.now();

  const N_CHUNKS = 50;
  const step = Math.ceil(100 / N_CHUNKS);
  const chunks: { from: string; to: string | null }[] = [];
  for (let i = 0; i < 100; i += step) {
    const from = i.toString().padStart(2, "0");
    const next = i + step;
    const to = next >= 100 ? null : next.toString().padStart(2, "0");
    chunks.push({ from, to });
  }
  console.log(`[window] ${chunks.length} chunks (siren prefix buckets)`);

  let done = 0;
  let totalUpdated = 0;
  for (const { from, to } of chunks) {
    const tc = Date.now();
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
               chiffre_affaires_yoy_pct,
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
      ),
      new_vals AS (
        SELECT siren, exercise_year,
          (CASE WHEN ca_3y_ago > 0 AND chiffre_affaires > 0
            THEN (POWER(chiffre_affaires::float / ca_3y_ago, 1.0/3) - 1) * 100 END)::real AS ca_cagr_3y,
          (CASE WHEN ca_5y_ago > 0 AND chiffre_affaires > 0
            THEN (POWER(chiffre_affaires::float / ca_5y_ago, 1.0/5) - 1) * 100 END)::real AS ca_cagr_5y,
          (CASE WHEN rn_3y_ago > 0 AND resultat_net > 0
            THEN (POWER(resultat_net::float / rn_3y_ago, 1.0/3) - 1) * 100 END)::real AS rn_cagr_3y,
          (CASE WHEN rn_5y_ago > 0 AND resultat_net > 0
            THEN (POWER(resultat_net::float / rn_5y_ago, 1.0/5) - 1) * 100 END)::real AS rn_cagr_5y,
          (CASE WHEN eff_3y_ago > 0 AND effectif_moyen > 0
            THEN (POWER(effectif_moyen::float / eff_3y_ago, 1.0/3) - 1) * 100 END)::real AS eff_cagr_3y,
          (chiffre_affaires > ca_1 AND ca_1 > ca_2) AS has_grown_3y,
          (resultat_net < 0 AND rn_1 < 0 AND rn_2 < 0) AS is_loss_making_3y,
          (chiffre_affaires_yoy_pct >= 30 AND chiffre_affaires >= 1000000) AS is_high_growth
        FROM series
      )
      UPDATE company_financials_screener s SET
        chiffre_affaires_cagr_3y_pct = nv.ca_cagr_3y,
        chiffre_affaires_cagr_5y_pct = nv.ca_cagr_5y,
        resultat_net_cagr_3y_pct     = nv.rn_cagr_3y,
        resultat_net_cagr_5y_pct     = nv.rn_cagr_5y,
        effectif_cagr_3y_pct         = nv.eff_cagr_3y,
        has_grown_3y                 = nv.has_grown_3y,
        is_loss_making_3y            = nv.is_loss_making_3y,
        is_high_growth               = nv.is_high_growth
      FROM new_vals nv
      WHERE s.siren = nv.siren AND s.exercise_year = nv.exercise_year
        AND ${outer}
        AND (
          s.chiffre_affaires_cagr_3y_pct IS DISTINCT FROM nv.ca_cagr_3y OR
          s.chiffre_affaires_cagr_5y_pct IS DISTINCT FROM nv.ca_cagr_5y OR
          s.resultat_net_cagr_3y_pct     IS DISTINCT FROM nv.rn_cagr_3y OR
          s.resultat_net_cagr_5y_pct     IS DISTINCT FROM nv.rn_cagr_5y OR
          s.effectif_cagr_3y_pct         IS DISTINCT FROM nv.eff_cagr_3y OR
          s.has_grown_3y                 IS DISTINCT FROM nv.has_grown_3y OR
          s.is_loss_making_3y            IS DISTINCT FROM nv.is_loss_making_3y OR
          s.is_high_growth               IS DISTINCT FROM nv.is_high_growth
        );
    `, params);

    done += 1;
    totalUpdated += r.rowCount ?? 0;
    const dt = ((Date.now() - tc) / 1000).toFixed(1);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? Math.round((chunks.length - done) / rate) : 0;
    console.log(
      `[window] ${done.toString().padStart(3)}/${chunks.length}` +
      ` siren ${from}…${to ?? "∞"}` +
      ` updated=${(r.rowCount ?? 0).toLocaleString().padStart(8)}` +
      ` chunk=${dt}s` +
      ` total=${Math.round(elapsed)}s` +
      ` ETA=${eta}s`,
    );
  }
  console.log(`[window] done in ${((Date.now() - t0) / 1000).toFixed(0)}s, total rows updated=${totalUpdated.toLocaleString()}`);
}

export type RunOptions = { full?: boolean; sinceISO?: string | null; limit?: number | null };

export async function runScreener(url: string, opts: RunOptions = {}): Promise<void> {
  // max=8 : 1 cursor + 4 parallel INSERTs + a little headroom for misc queries
  const pool = new Pool({ connectionString: url, max: 8 });
  const startedAt = new Date();
  let rowsIn = 0, rowsUpserted = 0;

  let since: Date | null = opts.sinceISO ? new Date(opts.sinceISO) : null;
  if (!since && !opts.full) {
    const last = await pool.query<{ since: string }>(
      `SELECT MAX(finished_at) AS since FROM company_financials_screener_run_log
       WHERE error IS NULL`,
    );
    since = last.rows[0]?.since ? new Date(last.rows[0].since) : null;
  }
  if (opts.full) {
    await pool.query("TRUNCATE company_financials_screener");
    since = null;
  }

  const runId = (await pool.query<{ run_id: number }>(
    `INSERT INTO company_financials_screener_run_log (started_at, since)
     VALUES ($1, $2) RETURNING run_id`,
    [startedAt, since],
  )).rows[0].run_id;

  try {
    for await (const batch of streamSource(pool, since, opts.limit ?? null)) {
      rowsIn += batch.length;
      rowsUpserted += await processBatch(pool, batch);
      if (rowsIn % 50000 === 0) console.log(`processed ${rowsIn} rows…`);
      if (opts.limit && rowsIn >= opts.limit) {
        console.log(`[smoke] reached --limit=${opts.limit}, stopping early`);
        break;
      }
    }
    await runWindowPass(pool);
    await pool.query(
      `UPDATE company_financials_screener_run_log
       SET finished_at = $1, rows_in = $2, rows_upserted = $3
       WHERE run_id = $4`,
      [new Date(), rowsIn, rowsUpserted, runId],
    );
    console.log(`done — rows_in=${rowsIn}, rows_upserted=${rowsUpserted}`);
  } catch (e) {
    await pool.query(
      `UPDATE company_financials_screener_run_log
       SET finished_at = $1, error = $2 WHERE run_id = $3`,
      [new Date(), (e as Error).message, runId],
    );
    throw e;
  } finally {
    await pool.end();
  }
}

export async function runIncremental(url: string): Promise<void> {
  return runScreener(url, {});
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const sinceISO = args.find(a => a.startsWith("--since="))?.split("=")[1] ?? null;
  const limitStr = args.find(a => a.startsWith("--limit="))?.split("=")[1] ?? null;
  const limit = limitStr ? parseInt(limitStr, 10) : null;
  const url = process.env.DATABASE_URL_DATA;
  if (!url) throw new Error("DATABASE_URL_DATA required");
  // Apply pending migrations idempotently — same behavior as the cron
  // entry point (build-screener-cron.ts). Without this, running
  // `screener:full` on a fresh DB or after a schema migration was added
  // fails with a missing-column / missing-table error. The migration
  // runner is advisory-locked, so concurrent invocations serialize.
  await runMigrations(url);
  await runScreener(url, { full, sinceISO, limit });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
