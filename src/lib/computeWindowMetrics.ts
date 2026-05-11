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
      has_grown_3y:
        ca == null || ca1 == null || ca2 == null ? null : (ca > ca1 && ca1 > ca2),
      is_loss_making_3y:
        rn == null || rn1 == null || rn2 == null ? null : (rn < 0 && rn1 < 0 && rn2 < 0),
      is_high_growth:
        yoy == null || ca == null ? null : (yoy >= 30 && ca >= 1_000_000),
    };
  }
  return out;
}
