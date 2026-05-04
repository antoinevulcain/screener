-- Replace the trigger to track *all* source-typed fields, not just the 5 KPIs.
-- Tracked set :
--   - 5 typed KPIs : chiffre_affaires, resultat_net, total_bilan, capitaux_propres, effectif_moyen
--   - their N-1 versions (chiffre_affaires_n1 etc.)
--   - all 355 cerfa value columns (c_xxx)
--   - all 355 cerfa N-1 columns (c_xxx_n1)
-- Skipped (derived from above; logging would be redundant):
--   - YoY % / CAGR % columns (recomputed from N + N-1)
--   - Ratio columns (marge_*, roe_pct, autonomie_*, …)
--   - Indicator columns (ebe, ebitda, caf, bfr, …) — recomputed each refresh
--   - Boolean flags (is_loss_making, has_grown_3y, …)
--   - Identity / sirene context / JSONB / provenance

-- Drop and recreate the function with JSONB iteration over all relevant fields.
DROP TRIGGER IF EXISTS trg_log_restatement ON company_financials_screener;

CREATE OR REPLACE FUNCTION log_screener_restatement() RETURNS trigger AS $$
DECLARE
  k        text;
  old_j    jsonb := to_jsonb(OLD);
  new_j    jsonb := to_jsonb(NEW);
  old_v    jsonb;
  new_v    jsonb;
  is_tracked boolean;
BEGIN
  FOR k IN SELECT jsonb_object_keys(new_j) LOOP
    -- Decide if this field is tracked.
    is_tracked := FALSE;

    IF k IN (
      'chiffre_affaires','resultat_net','total_bilan','capitaux_propres','effectif_moyen',
      'chiffre_affaires_n1','resultat_net_n1','total_bilan_n1','capitaux_propres_n1','effectif_moyen_n1'
    ) THEN
      is_tracked := TRUE;
    -- Cerfa value columns : starts with 'c_', not a derived suffix
    ELSIF k LIKE 'c\_%' ESCAPE '\'
      AND k NOT LIKE '%\_yoy\_pct' ESCAPE '\' THEN
      is_tracked := TRUE;
    END IF;

    IF NOT is_tracked THEN CONTINUE; END IF;

    old_v := old_j -> k;
    new_v := new_j -> k;
    IF old_v IS DISTINCT FROM new_v THEN
      INSERT INTO company_financials_restatement_log
        (siren, exercise_year, field_name, old_value, new_value, source_date_cloture, source_rne_updated_at)
      VALUES (
        NEW.siren, NEW.exercise_year, k,
        CASE WHEN old_v IS NULL OR old_v = 'null'::jsonb THEN NULL
             ELSE (old_v #>> '{}')::numeric END,
        CASE WHEN new_v IS NULL OR new_v = 'null'::jsonb THEN NULL
             ELSE (new_v #>> '{}')::numeric END,
        NEW.date_cloture, NEW.rne_updated_at
      );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New trigger : no WHEN clause filter on specific fields (because we'd have
-- to enumerate 360+ columns). The trigger function iterates and skips no-ops
-- internally. The cost is one trigger invocation per UPDATE row, even when
-- nothing tracked changed (e.g. window pass updating only CAGR fields) —
-- that's ~50µs of plpgsql overhead per row, acceptable.
CREATE TRIGGER trg_log_restatement
  AFTER UPDATE ON company_financials_screener
  FOR EACH ROW
  EXECUTE FUNCTION log_screener_restatement();
