-- migrations/006_type_comptes_in_pk.sql
--
-- Goal — separate comptes sociaux from comptes consolidés in the screener
-- and the restatement log. Pre-006, the PK was (siren, exercise_year),
-- so a holding that filed BOTH sociaux + consolidés for the same year
-- had one of them upserted-over by the other depending on import order.
-- Cf. siren 452847130 (BONNEUIL EXPANSION, holding du groupe Bouygues) :
-- 2024 = consolidé K (~230 Md€) ate the sociaux C (~700 k€). The /screener
-- listing then showed BONNEUIL on top with absurd numbers, and the
-- restatement log emitted fake "CA 700K → 230B" events whenever the
-- import order flipped between filings.
--
-- After 006:
--   - PK includes type_comptes
--   - Existing NULL type_comptes default to 'C' (most common, sociaux)
--   - restatement_log gains a type_comptes column to disambiguate
--
-- After applying this migration we must:
--   - Re-run `screener:full` to repopulate the K rows that got lost
--   - TRUNCATE company_financials_restatement_log and re-run
--     `screener:backfill-restatements` (the log is corrupted by the
--     historical mixing — any 'CA 700K → 230B' diff in there is fake).
-- These two re-runs are out-of-band of the migration; they each take
-- a few hours and are safe to run while the table stays online.

BEGIN;

-- 1. Existing NULL type_comptes → 'C' (Complets / sociaux).
--    'C' is the dominant type in the FTP source (~5M rows out of 6.5M)
--    so it's the safest default. The ~9M NULL rows in the screener are
--    rows where the source FTP row also had NULL (most are likely
--    sociaux that the INPI export didn't tag explicitly).
UPDATE company_financials_screener
   SET type_comptes = 'C'
 WHERE type_comptes IS NULL;

-- 2. NOT NULL with default so future inserts always carry a type.
ALTER TABLE company_financials_screener
  ALTER COLUMN type_comptes SET NOT NULL,
  ALTER COLUMN type_comptes SET DEFAULT 'C';

-- 3. Replace the PK so (siren, exercise_year, type_comptes) is the new
--    unique key. Two rows per (siren, year) are now allowed when the
--    entity files both sociaux and consolidé.
ALTER TABLE company_financials_screener
  DROP CONSTRAINT company_financials_screener_pkey;
ALTER TABLE company_financials_screener
  ADD CONSTRAINT company_financials_screener_pkey
  PRIMARY KEY (siren, exercise_year, type_comptes);

-- 4. Add type_comptes to the restatement log so we record WHICH series
--    was restated. Without this, a 'social CA changed' and a 'consolidé
--    CA changed' on the same (siren, year) are indistinguishable in
--    the log.
ALTER TABLE company_financials_restatement_log
  ADD COLUMN IF NOT EXISTS type_comptes VARCHAR(20);

-- 5. Index the new column on the log for filtering / dashboards.
CREATE INDEX IF NOT EXISTS ix_restatement_log_type_comptes
  ON company_financials_restatement_log (type_comptes);

COMMIT;
