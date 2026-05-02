# komply-screener

Independent workspace producing `company_financials_screener`: a denormalized
table with one row per `(siren, exercise_year)` and ~1180 typed columns —
355 cerfa-coded line items × (current value, N-1 value, YoY %), plus the
5 INPI top-level KPIs, ~30 financial ratios, multi-year CAGR, and boolean
screening flags.

The table is built nightly from the deduped
`inpi_financial_statements_{ftp,api,ex}` merged view; sirene context is
denormalized in for index-only filter queries.

## Layout

| Path | Role |
|---|---|
| `migrations/001_company_financials_screener.sql` | Wide table DDL (355 cerfa cols + ratios + flags) |
| `migrations/002_company_financials_screener_indexes.sql` | 25 indexes + run-log table |
| `src/lib/cerfaCodeMap.ts` | Cerfa code → column name mapping (single source of truth) |
| `src/lib/computeRatios.ts` | NULL-safe per-row ratio + YoY computation, RN/RS regime fallback |
| `src/runMigrations.ts` | SQL migration runner (advisory-locked, idempotent) |
| `scripts/build-screener.ts` | Batch build / incremental refresh (cursor-streamed, 5000-row batches, window-pass for CAGR) |
| `scripts/build-screener-cron.ts` | Long-running cron loop (one nightly run + sleep) |
| `scripts/backfill-liasse-from-compte-resultat.ts` | One-shot: re-parse the ~6.5M `compte_resultat` raw docs to fill `liasse_postes` + 5 KPIs (doubles screener coverage) |

## Run

```sh
cp .env.example .env             # then fill DATABASE_URL_DATA
npm install
npm run migrate                  # creates table + indexes
npm run screener:smoke           # 1000-row dry run
npm run screener:full            # full backfill (~6.5M rows, ~hours)
npm run screener:cron            # nightly loop (Railway service)
```

## Design notes

- **Source-of-truth boundary**: this workspace only **reads** from
  `inpi_financial_statements_*` and `sirene_companies`; never writes back.
- **Coverage**: ~50% of bilan rows have parsed `liasse_postes`. The other
  ~6.5M rows store only the raw INPI doc in `compte_resultat`. Run
  `screener:backfill-liasse` to extract the missing line items by re-parsing
  the raw doc — doubles screener coverage.
- **Régime normal vs simplifié**: both code spaces coexist in `liasse_postes`
  (RN = 2-letter codes like `BJ`, `DA`, `CO`; RS = 3-digit codes like
  `044`, `120`, `110`). The screener stores both as separate columns; ratio
  formulas use `pickRnRs()` to fall back across regimes.
- **No commits/branches/destructive ops** are performed by this workspace
  on its own. Migrations are advisory-locked so two concurrent runs serialize.
