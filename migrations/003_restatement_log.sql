-- Audit log for every change to the 5 typed KPIs in company_financials_screener.
-- Captures the OLD value, the NEW value, the source filing's date_cloture +
-- rne_updated_at, and when the change was detected. So if a customer asks
-- "why did my 2024 RN change?", we can answer with a full history.
--
-- The trigger fires only on UPDATE (not INSERT) and only when at least one
-- of the 5 KPIs actually changes. So:
--   - First-time INSERT during initial import: no log rows (nothing to "restate")
--   - Re-import with identical data: WHEN clause filters it out
--   - Re-import with restated data: log row per changed field
--   - Window pass updating CAGR/flags: never touches the 5 KPIs, no log rows
--   - Manual UPDATE via psql: also captured

CREATE TABLE IF NOT EXISTS company_financials_restatement_log (
  id                       BIGSERIAL    PRIMARY KEY,
  siren                    VARCHAR(9)   NOT NULL,
  exercise_year            SMALLINT     NOT NULL,
  field_name               TEXT         NOT NULL,
  old_value                NUMERIC,
  new_value                NUMERIC,
  source_date_cloture      DATE,
  source_rne_updated_at    TIMESTAMPTZ,
  detected_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_restatement_log_siren_year
  ON company_financials_restatement_log (siren, exercise_year);
CREATE INDEX IF NOT EXISTS ix_restatement_log_detected
  ON company_financials_restatement_log (detected_at DESC);
CREATE INDEX IF NOT EXISTS ix_restatement_log_field
  ON company_financials_restatement_log (field_name);

-- Trigger function : insert one log row per changed KPI.
CREATE OR REPLACE FUNCTION log_screener_restatement() RETURNS trigger AS $$
BEGIN
  IF NEW.chiffre_affaires IS DISTINCT FROM OLD.chiffre_affaires THEN
    INSERT INTO company_financials_restatement_log
      (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
    VALUES (NEW.siren, NEW.exercise_year, 'chiffre_affaires',
            OLD.chiffre_affaires, NEW.chiffre_affaires,
            NEW.date_cloture, NEW.rne_updated_at);
  END IF;
  IF NEW.resultat_net IS DISTINCT FROM OLD.resultat_net THEN
    INSERT INTO company_financials_restatement_log
      (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
    VALUES (NEW.siren, NEW.exercise_year, 'resultat_net',
            OLD.resultat_net, NEW.resultat_net,
            NEW.date_cloture, NEW.rne_updated_at);
  END IF;
  IF NEW.total_bilan IS DISTINCT FROM OLD.total_bilan THEN
    INSERT INTO company_financials_restatement_log
      (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
    VALUES (NEW.siren, NEW.exercise_year, 'total_bilan',
            OLD.total_bilan, NEW.total_bilan,
            NEW.date_cloture, NEW.rne_updated_at);
  END IF;
  IF NEW.capitaux_propres IS DISTINCT FROM OLD.capitaux_propres THEN
    INSERT INTO company_financials_restatement_log
      (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
    VALUES (NEW.siren, NEW.exercise_year, 'capitaux_propres',
            OLD.capitaux_propres, NEW.capitaux_propres,
            NEW.date_cloture, NEW.rne_updated_at);
  END IF;
  IF NEW.effectif_moyen IS DISTINCT FROM OLD.effectif_moyen THEN
    INSERT INTO company_financials_restatement_log
      (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
    VALUES (NEW.siren, NEW.exercise_year, 'effectif_moyen',
            OLD.effectif_moyen, NEW.effectif_moyen,
            NEW.date_cloture, NEW.rne_updated_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger : AFTER UPDATE, only when at least one tracked KPI changes.
DROP TRIGGER IF EXISTS trg_log_restatement ON company_financials_screener;
CREATE TRIGGER trg_log_restatement
  AFTER UPDATE ON company_financials_screener
  FOR EACH ROW
  WHEN (
    OLD.chiffre_affaires IS DISTINCT FROM NEW.chiffre_affaires
    OR OLD.resultat_net      IS DISTINCT FROM NEW.resultat_net
    OR OLD.total_bilan       IS DISTINCT FROM NEW.total_bilan
    OR OLD.capitaux_propres  IS DISTINCT FROM NEW.capitaux_propres
    OR OLD.effectif_moyen    IS DISTINCT FROM NEW.effectif_moyen
  )
  EXECUTE FUNCTION log_screener_restatement();
