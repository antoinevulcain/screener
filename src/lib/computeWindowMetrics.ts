/**
 * Multi-year window metrics (CAGR + 3y flags) computed in Node from a
 * SIREN's full year series. Pure function — no DB. Replaces the SQL
 * LAG/CAGR logic that used to run inside Postgres, so the DB only does
 * plain reads and writes.
 *
 * Caller guarantees `rows` are all the same SIREN and ordered by
 * exercise_year ascending. Returns one metrics record per input row,
 * in the same order.
 *
 * NULL handling matches Postgres three-valued logic exactly — in
 * particular `FALSE AND NULL = FALSE` short-circuits to FALSE, not
 * NULL. Without this, re-runs would diverge against PG-stored values
 * (where the original CTE used `AND`) and write back NULL where PG
 * had stored FALSE — generating heavy trigger work for nothing.
 *
 * Float math note: storage type is REAL (32-bit). cagrPct() rounds to
 * float32 via Math.fround so the result compares cleanly against what
 * was read back from the DB — otherwise the diff would always fire.
 */

export interface WindowSourceRow {
  siren: string;
  exercise_year: number;
  chiffre_affaires:           number | null;
  resultat_net:               number | null;
  effectif_moyen:             number | null;
  chiffre_affaires_yoy_pct:   number | null;
}

export interface WindowMetrics {
  chiffre_affaires_cagr_3y_pct: number | null;
  chiffre_affaires_cagr_5y_pct: number | null;
  resultat_net_cagr_3y_pct:     number | null;
  resultat_net_cagr_5y_pct:     number | null;
  effectif_cagr_3y_pct:         number | null;
  has_grown_3y:                 boolean | null;
  is_loss_making_3y:            boolean | null;
  is_high_growth:               boolean | null;
}

type Tri = boolean | null;

function gt(a: number | null, b: number | null): Tri {
  return a == null || b == null ? null : a > b;
}

function lt(a: number | null, b: number | null): Tri {
  return a == null || b == null ? null : a < b;
}

function gte(a: number | null, b: number | null): Tri {
  return a == null || b == null ? null : a >= b;
}

/**
 * 3-valued AND matching Postgres:
 *   FALSE AND anything = FALSE   (short-circuit — this is the key
 *                                 case that pure null-propagation
 *                                 gets wrong)
 *   NULL  AND TRUE     = NULL
 *   NULL  AND NULL     = NULL
 *   TRUE  AND TRUE     = TRUE
 */
function and3(...vals: Tri[]): Tri {
  let result: Tri = true;
  for (const v of vals) {
    if (v === false) return false;
    if (v === null)  result = null;
  }
  return result;
}

function cagrPct(now: number | null, prior: number | null, years: number): number | null {
  if (now == null || prior == null || now <= 0 || prior <= 0) return null;
  return Math.fround((Math.pow(now / prior, 1 / years) - 1) * 100);
}

export function computeWindowMetricsForSiren(rows: WindowSourceRow[]): WindowMetrics[] {
  const out: WindowMetrics[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ca   = r.chiffre_affaires;
    const rn   = r.resultat_net;
    const eff  = r.effectif_moyen;
    const ca1  = i >= 1 ? rows[i - 1].chiffre_affaires : null;
    const ca2  = i >= 2 ? rows[i - 2].chiffre_affaires : null;
    const ca3  = i >= 3 ? rows[i - 3].chiffre_affaires : null;
    const ca5  = i >= 5 ? rows[i - 5].chiffre_affaires : null;
    const rn1  = i >= 1 ? rows[i - 1].resultat_net     : null;
    const rn2  = i >= 2 ? rows[i - 2].resultat_net     : null;
    const rn3  = i >= 3 ? rows[i - 3].resultat_net     : null;
    const rn5  = i >= 5 ? rows[i - 5].resultat_net     : null;
    const eff3 = i >= 3 ? rows[i - 3].effectif_moyen   : null;
    const yoy  = r.chiffre_affaires_yoy_pct;

    out[i] = {
      chiffre_affaires_cagr_3y_pct: cagrPct(ca,  ca3,  3),
      chiffre_affaires_cagr_5y_pct: cagrPct(ca,  ca5,  5),
      resultat_net_cagr_3y_pct:     cagrPct(rn,  rn3,  3),
      resultat_net_cagr_5y_pct:     cagrPct(rn,  rn5,  5),
      effectif_cagr_3y_pct:         cagrPct(eff, eff3, 3),
      has_grown_3y:                 and3(gt(ca,  ca1), gt(ca1, ca2)),
      is_loss_making_3y:            and3(lt(rn, 0), lt(rn1, 0), lt(rn2, 0)),
      is_high_growth:               and3(gte(yoy, 30), gte(ca, 1_000_000)),
    };
  }
  return out;
}
