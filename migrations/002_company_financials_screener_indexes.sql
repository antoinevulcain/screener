-- migrations/data/006_company_financials_screener_indexes.sql
-- DRAFT — indexes for company_financials_screener.
-- All created CONCURRENTLY (won't block writes during creation).
-- Order matters: most-frequent screener queries first.

-- ─── Single-company lookup (the company page) ──────────────────
CREATE INDEX IF NOT EXISTS ix_screener_siren
  ON company_financials_screener (siren, exercise_year DESC);

-- ─── Year-anchored top-N by KPI (most common screen) ───────────
-- INCLUDE makes them index-only-scan candidates.
CREATE INDEX IF NOT EXISTS ix_screener_year_rn
  ON company_financials_screener (exercise_year, resultat_net DESC NULLS LAST)
  INCLUDE (siren, chiffre_affaires);

CREATE INDEX IF NOT EXISTS ix_screener_year_ca
  ON company_financials_screener (exercise_year, chiffre_affaires DESC NULLS LAST)
  INCLUDE (siren, resultat_net);

CREATE INDEX IF NOT EXISTS ix_screener_year_eq
  ON company_financials_screener (exercise_year, capitaux_propres DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_tb
  ON company_financials_screener (exercise_year, total_bilan DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_eff
  ON company_financials_screener (exercise_year, effectif_moyen DESC NULLS LAST)
  INCLUDE (siren);

-- ─── Margins / rentability screens ─────────────────────────────
CREATE INDEX IF NOT EXISTS ix_screener_year_mn
  ON company_financials_screener (exercise_year, marge_nette_pct DESC NULLS LAST)
  INCLUDE (siren, chiffre_affaires);

CREATE INDEX IF NOT EXISTS ix_screener_year_mexp
  ON company_financials_screener (exercise_year, marge_exploitation_pct DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_mebe
  ON company_financials_screener (exercise_year, marge_ebe_pct DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_roe
  ON company_financials_screener (exercise_year, roe_pct DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_roa
  ON company_financials_screener (exercise_year, roa_pct DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_ebe
  ON company_financials_screener (exercise_year, ebe DESC NULLS LAST)
  INCLUDE (siren);

-- ─── Growth screens ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ix_screener_year_yoy_ca
  ON company_financials_screener (exercise_year, chiffre_affaires_yoy_pct DESC NULLS LAST)
  INCLUDE (siren, chiffre_affaires);

CREATE INDEX IF NOT EXISTS ix_screener_year_yoy_rn
  ON company_financials_screener (exercise_year, resultat_net_yoy_pct DESC NULLS LAST)
  INCLUDE (siren, resultat_net);

CREATE INDEX IF NOT EXISTS ix_screener_year_cagr_ca_3y
  ON company_financials_screener (exercise_year, chiffre_affaires_cagr_3y_pct DESC NULLS LAST)
  INCLUDE (siren);

CREATE INDEX IF NOT EXISTS ix_screener_year_cagr_rn_3y
  ON company_financials_screener (exercise_year, resultat_net_cagr_3y_pct DESC NULLS LAST)
  INCLUDE (siren);

-- ─── Sector / geography filters ───────────────────────────────
CREATE INDEX IF NOT EXISTS ix_screener_naf_year
  ON company_financials_screener (naf_code, exercise_year, resultat_net DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS ix_screener_section_year
  ON company_financials_screener (naf_section, exercise_year, chiffre_affaires DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS ix_screener_dep_year
  ON company_financials_screener (departement, exercise_year);

-- ─── Boolean flags (partial indexes — small + fast) ───────────
CREATE INDEX IF NOT EXISTS ix_screener_growing
  ON company_financials_screener (exercise_year, chiffre_affaires DESC) WHERE has_grown_3y;

CREATE INDEX IF NOT EXISTS ix_screener_high_growth
  ON company_financials_screener (exercise_year) WHERE is_high_growth;

CREATE INDEX IF NOT EXISTS ix_screener_distressed
  ON company_financials_screener (exercise_year) WHERE is_distressed;

CREATE INDEX IF NOT EXISTS ix_screener_loss
  ON company_financials_screener (exercise_year) WHERE is_loss_making;

CREATE INDEX IF NOT EXISTS ix_screener_zombie
  ON company_financials_screener (exercise_year) WHERE is_zombie;

CREATE INDEX IF NOT EXISTS ix_screener_swung_profit
  ON company_financials_screener (exercise_year) WHERE swung_to_profit;

CREATE INDEX IF NOT EXISTS ix_screener_swung_loss
  ON company_financials_screener (exercise_year) WHERE swung_to_loss;

-- ─── Drill-down on long-tail cerfa lines ──────────────────────
-- GIN on liasse_postes for queries like
--   WHERE liasse_postes @> '[{"code":"AF"}]'
CREATE INDEX IF NOT EXISTS ix_screener_liasse_gin
  ON company_financials_screener USING gin (liasse_postes jsonb_path_ops);

-- ─── Refresh log ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_financials_screener_run_log (
  run_id        BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  since         TIMESTAMPTZ,
  rows_in       INTEGER,
  rows_upserted INTEGER,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS ix_screener_run_log_started ON company_financials_screener_run_log (started_at DESC);
