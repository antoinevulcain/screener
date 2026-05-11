-- migrations/005_drop_restatement_log.sql
-- Drops the AFTER UPDATE trigger + its function introduced in 003 / 004.
-- The trigger ran to_jsonb() over the full row (~700 columns) twice per
-- UPDATE — including UPDATEs that touched none of the columns it actually
-- tracked (window pass, etc.) — and dominated write time on the screener
-- table.
--
-- The log TABLE (company_financials_restatement_log) is kept. Restatement
-- detection moves out of the hot UPDATE path into:
--   - scripts/backfill-restatements.ts  (one-shot historical scan)
--   - scripts/restatements-cron.ts      (long-running cron, incremental)
-- Both write to the same log table; nothing else needs to change.

DROP TRIGGER IF EXISTS trg_log_restatement ON company_financials_screener;
DROP FUNCTION IF EXISTS log_screener_restatement();
