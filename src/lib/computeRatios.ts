/**
 * Pure computation of financial ratios + indicators + boolean flags.
 * Input: a row-shape with all cerfa values already pivoted from liasse_postes
 *        (see cerfaCodeMap.ts) plus the 5 typed KPIs and the prior year row.
 * Output: { ratios, indicators, flags } merged into the screener row.
 *
 * All NULL-safe: if any divisor is null/0/negative for a ratio,
 * the ratio returns null (not Inf, not 0). This avoids polluting the
 * indexes with sentinel values.
 */

const safeDiv = (num: number | null, den: number | null): number | null => {
  if (num == null || den == null || den === 0) return null;
  return num / den;
};

const safePct = (num: number | null, den: number | null): number | null => {
  const r = safeDiv(num, den);
  return r == null ? null : r * 100;
};

const safeYoyPct = (n: number | null, n1: number | null): number | null => {
  if (n == null || n1 == null) return null;
  if (n1 === 0) return null;
  // For YoY %, we use abs(n1) as denominator so a swing from -100 to +50 reads
  // as +150% rather than -150%. Store sign-conventional swings in flags instead.
  return ((n - n1) / Math.abs(n1)) * 100;
};

const safeYoyAbs = (n: number | null, n1: number | null): number | null => {
  if (n == null || n1 == null) return null;
  return n - n1;
};

const cagr = (latest: number | null, earliest: number | null, years: number): number | null => {
  if (latest == null || earliest == null) return null;
  if (latest <= 0 || earliest <= 0) return null; // CAGR meaningless on negative endpoints
  if (years <= 0) return null;
  return (Math.pow(latest / earliest, 1 / years) - 1) * 100;
};

export type ScreenerRowInput = {
  // 5 typed KPIs (current row)
  chiffre_affaires: number | null;
  resultat_net: number | null;
  total_bilan: number | null;
  capitaux_propres: number | null;
  effectif_moyen: number | null;
  // Same KPIs from N-1 (extracted from liasse postes' montant_exercice_N_moins_1_euros)
  chiffre_affaires_n1: number | null;
  resultat_net_n1: number | null;
  total_bilan_n1: number | null;
  capitaux_propres_n1: number | null;
  effectif_moyen_n1: number | null;
  // Cerfa values pivoted (only the codes used by ratio formulas listed here)
  cerfa: Record<string, number | null>; // keyed by column name (c_<CODE>)
  duree_exercice_mois: number | null;
};

export type ScreenerRowComputed = {
  // Indicators
  valeur_ajoutee: number | null;
  ebe: number | null;
  ebitda: number | null;
  caf: number | null;
  bfr: number | null;
  fonds_roulement: number | null;
  tresorerie_nette: number | null;

  // Margins
  marge_brute_pct: number | null;
  marge_commerciale_pct: number | null;
  marge_production_pct: number | null;
  marge_exploitation_pct: number | null;
  marge_nette_pct: number | null;
  marge_ebe_pct: number | null;
  marge_ebitda_pct: number | null;
  taux_va_pct: number | null;

  // Rentability
  roa_pct: number | null;
  roe_pct: number | null;
  roic_pct: number | null;
  roce_pct: number | null;

  // Structure financière
  autonomie_financiere_pct: number | null;
  taux_endettement_pct: number | null;
  taux_endettement_global_pct: number | null;
  capacite_remboursement_ans: number | null;
  couverture_charges_fin: number | null;

  // Liquidité
  liquidite_generale: number | null;
  liquidite_reduite: number | null;
  liquidite_immediate: number | null;

  // BFR / cycle
  bfr_jours_ca: number | null;
  dso_jours: number | null;
  dpo_jours: number | null;
  rotation_stocks_jours: number | null;

  // Productivité
  ca_par_salarie: number | null;
  va_par_salarie: number | null;
  resultat_par_salarie: number | null;

  // Composantes coûts
  poids_masse_salariale_pct: number | null;
  poids_dotations_pct: number | null;
  poids_charges_externes_pct: number | null;

  // YoY
  chiffre_affaires_yoy_pct: number | null;
  resultat_net_yoy_pct: number | null;
  total_bilan_yoy_pct: number | null;
  capitaux_propres_yoy_pct: number | null;
  effectif_yoy_pct: number | null;
  chiffre_affaires_yoy_abs: number | null;
  resultat_net_yoy_abs: number | null;
  total_bilan_yoy_abs: number | null;
  capitaux_propres_yoy_abs: number | null;

  // Annualization (when duree ≠ 12 months)
  chiffre_affaires_annualise: number | null;
  resultat_net_annualise: number | null;
  is_short_exercise: boolean;

  // Boolean flags (3y flags need history — set later in the windowing pass)
  is_loss_making: boolean | null;
  swung_to_profit: boolean | null;
  swung_to_loss: boolean | null;
};

/**
 * Map each ratio to the cerfa code(s) it depends on.
 * Régime normal codes (2 letters) are preferred; régime simplifié codes
 * (3 digits) provide fallback for the same logical metric.
 *
 *   CA          → typed `chiffre_affaires` (already aggregated by INPI)
 *   Résultat net → typed `resultat_net`
 *   Achats marchandises → c_fs+c_ft (RN) or c_234+c_236 (RS)
 *   Achats matières     → c_fu+c_fv (RN) or c_238+c_240 (RS)
 *   Salaires            → c_fy (RN) or c_250 (RS)
 *   Charges sociales    → c_fz (RN) or c_252 (RS)
 *   Dotations amort     → c_ga (RN) or c_254 (RS)
 *   Impôts/taxes        → c_fx (RN) or c_244 (RS)
 *   REX                 → c_gg (RN) or c_270 (RS)
 *   Charges financières → c_gr+c_gs+c_gt (RN) or c_294 (RS)
 *   Stocks              → c_bl+c_bn+c_bp+c_br+c_bt (RN) or c_050+c_060 (RS)
 *   Clients             → c_bx (RN) or c_068 (RS)
 *   Disponibilités      → c_cf (RN) or c_084 (RS)
 *   Actif circulant     → c_cj (RN) or c_096 (RS)
 *   Total actif         → c_co (RN) or c_110 (RS)
 *   Capitaux propres    → c_dl (RN) or c_142 (RS)
 *   Total dettes        → c_ec (RN) or c_176 (RS)
 *   Dettes financières  → c_ds+c_dt+c_du+c_dv (RN) or part of c_156 (RS)
 *   Dettes fournisseurs → c_dx (RN) or c_166 (RS)
 *
 * Helper: `pickRnRs(cerfa, rn, rs)` returns the RN value if present, else
 * sums the RS codes. Make this resilient to multi-code aggregations.
 */
function pickRnRs(cerfa: Record<string, number | null>, rnCols: string[], rsCols: string[]): number | null {
  const sumPresent = (cols: string[]): number | null => {
    let total = 0;
    let any = false;
    for (const c of cols) {
      const v = cerfa[c];
      if (v != null) { total += v; any = true; }
    }
    return any ? total : null;
  };
  return sumPresent(rnCols) ?? sumPresent(rsCols);
}

export function computeScreenerRow(input: ScreenerRowInput): ScreenerRowComputed {
  const { cerfa: c } = input;
  const ca = input.chiffre_affaires;
  const rn = input.resultat_net;
  const tb = input.total_bilan;
  const cp = input.capitaux_propres;
  const eff = input.effectif_moyen;

  // ── Pull "pivoted" indicators using RN→RS fallback ────────────
  const achatsMarchandises = pickRnRs(c, ['c_fs','c_ft'], ['c_234','c_236']);
  const achatsMatieres     = pickRnRs(c, ['c_fu','c_fv'], ['c_238','c_240']);
  const autresAchats       = pickRnRs(c, ['c_fw'],        ['c_242']);
  const impotsTaxes        = pickRnRs(c, ['c_fx'],        ['c_244']);
  const salaires           = pickRnRs(c, ['c_fy'],        ['c_250']);
  const chargesSoc         = pickRnRs(c, ['c_fz'],        ['c_252']);
  const dotAmort           = pickRnRs(c, ['c_ga'],        ['c_254']);
  const dotProv            = pickRnRs(c, ['c_gb','c_gc','c_gd'], ['c_256']);
  const rex                = pickRnRs(c, ['c_gg'],        ['c_270']);
  const chargesFin         = pickRnRs(c, ['c_gr','c_gs','c_gt'], ['c_294']);
  const stocks             = pickRnRs(c, ['c_bl','c_bn','c_bp','c_br','c_bt'], ['c_050','c_060']);
  const clients            = pickRnRs(c, ['c_bx'],        ['c_068']);
  const dispos             = pickRnRs(c, ['c_cf'],        ['c_084']);
  const actifCirculant     = pickRnRs(c, ['c_cj'],        ['c_096']);
  const totalDettes        = pickRnRs(c, ['c_ec'],        ['c_176']);
  const dettesFin          = pickRnRs(c, ['c_ds','c_dt','c_du','c_dv'], ['c_156']);
  const dettesFourn        = pickRnRs(c, ['c_dx'],        ['c_166']);
  const ventesMarch        = pickRnRs(c, ['c_fa','c_fb'], ['c_209','c_210']);
  const productionVendue   = pickRnRs(c, ['c_fc','c_fd','c_fe','c_ff'], ['c_214','c_217','c_218']);

  // ── SIG (Soldes Intermédiaires de Gestion) ────────────────────
  // Production = production vendue + production stockée + production immo
  const productionStockee = pickRnRs(c, ['c_fm'], ['c_222']);
  const productionImmo    = pickRnRs(c, ['c_fn'], ['c_224']);
  const production = (productionVendue ?? 0) + (productionStockee ?? 0) + (productionImmo ?? 0);

  // Marge commerciale = ventes_march - achats_march
  const margeCommerciale = ventesMarch != null && achatsMarchandises != null
    ? ventesMarch - achatsMarchandises : null;

  // Marge production = production - achats_matieres - autres_achats
  const margeProduction = production != null && achatsMatieres != null
    ? production - achatsMatieres - (autresAchats ?? 0) : null;

  // VA = marge_commerciale + marge_production
  const valeur_ajoutee = (margeCommerciale ?? 0) + (margeProduction ?? 0) || null;

  // EBE = VA - charges personnel - impôts/taxes
  const chargesPersonnel = (salaires ?? 0) + (chargesSoc ?? 0);
  const ebe = valeur_ajoutee != null
    ? valeur_ajoutee - chargesPersonnel - (impotsTaxes ?? 0)
    : null;

  // EBITDA ≈ REX + dotations amort
  const ebitda = rex != null && dotAmort != null ? rex + dotAmort : null;

  // CAF (capacité d'autofinancement) ≈ RN + dotations - reprises (simplifié)
  const caf = rn != null && dotAmort != null ? rn + dotAmort + (dotProv ?? 0) : null;

  // BFR = (stocks + créances + charges_avance) - (dettes_fourn + dettes_fisc + autres_dettes)
  const creancesAutres   = pickRnRs(c, ['c_bz'], ['c_072']);
  const chargesAvance    = pickRnRs(c, ['c_ch'], ['c_092']);
  const dettesFiscales   = pickRnRs(c, ['c_dy'], ['c_8d','c_8e']);
  const autresDettes     = pickRnRs(c, ['c_ea'], ['c_172']);
  const bfr = ((stocks ?? 0) + (clients ?? 0) + (creancesAutres ?? 0) + (chargesAvance ?? 0))
            - ((dettesFourn ?? 0) + (dettesFiscales ?? 0) + (autresDettes ?? 0)) || null;

  // FR = capitaux permanents - actif immobilisé
  const totalActifImmo = pickRnRs(c, ['c_bj'], ['c_044']);
  const capitauxPermanents = (cp ?? 0) + (dettesFin ?? 0); // approx. medium-/long-term
  const fonds_roulement = capitauxPermanents - (totalActifImmo ?? 0) || null;

  // Trésorerie nette = FR - BFR (also = dispos - dettes_court_terme bancaires)
  const tresorerie_nette = fonds_roulement != null && bfr != null
    ? fonds_roulement - bfr : null;

  // ── Margins ───────────────────────────────────────────────────
  const marge_brute_pct = ca != null
    ? safePct(ca - (achatsMarchandises ?? 0) - (achatsMatieres ?? 0), ca) : null;
  const marge_commerciale_pct = safePct(margeCommerciale, ventesMarch);
  const marge_production_pct  = safePct(margeProduction, production);
  const marge_exploitation_pct = safePct(rex, ca);
  const marge_nette_pct       = safePct(rn, ca);
  const marge_ebe_pct         = safePct(ebe, ca);
  const marge_ebitda_pct      = safePct(ebitda, ca);
  const taux_va_pct           = safePct(valeur_ajoutee, production);

  // ── Rentability ───────────────────────────────────────────────
  const roa_pct = safePct(rn, tb);
  const roe_pct = safePct(rn, cp);
  const capitauxEmployes = (cp ?? 0) + (dettesFin ?? 0) || null;
  const roic_pct = safePct(rex != null ? rex * 0.75 : null, capitauxEmployes); // approx 25% IS
  const roce_pct = safePct(rex, capitauxEmployes);

  // ── Structure financière ──────────────────────────────────────
  const autonomie_financiere_pct = safePct(cp, tb);
  const taux_endettement_pct = safePct(dettesFin, cp);
  const taux_endettement_global_pct = safePct(totalDettes, tb);
  const capacite_remboursement_ans = safeDiv(dettesFin, caf);
  const couverture_charges_fin = safeDiv(rex, chargesFin);

  // ── Liquidité (use total dettes as approximation when CT split unavailable) ──
  // Note: this is an approximation; the true denominator is dettes_court_terme
  // which requires splitting EC/176 by maturity (not all bilans expose this).
  const dettesCt = totalDettes; // TODO: refine via "dont à moins d'un an" cerfa codes
  const liquidite_generale = safeDiv(actifCirculant, dettesCt);
  const liquidite_reduite  = safeDiv((clients ?? 0) + (dispos ?? 0), dettesCt);
  const liquidite_immediate = safeDiv(dispos, dettesCt);

  // ── BFR / cycle (en jours) ────────────────────────────────────
  const bfr_jours_ca = ca != null && bfr != null ? safeDiv(bfr * 365, ca) : null;
  const dso_jours = ca != null && clients != null ? safeDiv(clients * 365, ca * 1.2) : null; // CA TTC ~= CA × 1.2 (TVA 20%)
  const totalAchats = (achatsMarchandises ?? 0) + (achatsMatieres ?? 0) + (autresAchats ?? 0) || null;
  const dpo_jours = totalAchats != null && dettesFourn != null
    ? safeDiv(dettesFourn * 365, totalAchats * 1.2) : null;
  const rotation_stocks_jours = totalAchats != null && stocks != null
    ? safeDiv(stocks * 365, totalAchats) : null;

  // ── Productivité ──────────────────────────────────────────────
  const ca_par_salarie       = eff != null && eff > 0 && ca != null ? Math.round(ca / eff) : null;
  const va_par_salarie       = eff != null && eff > 0 && valeur_ajoutee != null ? Math.round(valeur_ajoutee / eff) : null;
  const resultat_par_salarie = eff != null && eff > 0 && rn != null ? Math.round(rn / eff) : null;

  // ── Composantes coûts ─────────────────────────────────────────
  const poids_masse_salariale_pct = safePct(chargesPersonnel, ca);
  const poids_dotations_pct       = safePct(dotAmort, ca);
  const poids_charges_externes_pct = safePct(autresAchats, ca);

  // ── YoY ──────────────────────────────────────────────────────
  const chiffre_affaires_yoy_pct = safeYoyPct(ca, input.chiffre_affaires_n1);
  const resultat_net_yoy_pct     = safeYoyPct(rn, input.resultat_net_n1);
  const total_bilan_yoy_pct      = safeYoyPct(tb, input.total_bilan_n1);
  const capitaux_propres_yoy_pct = safeYoyPct(cp, input.capitaux_propres_n1);
  const effectif_yoy_pct         = safeYoyPct(eff, input.effectif_moyen_n1);

  const chiffre_affaires_yoy_abs = safeYoyAbs(ca, input.chiffre_affaires_n1);
  const resultat_net_yoy_abs     = safeYoyAbs(rn, input.resultat_net_n1);
  const total_bilan_yoy_abs      = safeYoyAbs(tb, input.total_bilan_n1);
  const capitaux_propres_yoy_abs = safeYoyAbs(cp, input.capitaux_propres_n1);

  // ── Annualization ─────────────────────────────────────────────
  const duree = input.duree_exercice_mois ?? 12;
  const is_short_exercise = duree !== 12;
  const factor = duree > 0 ? 12 / duree : 1;
  const chiffre_affaires_annualise = ca != null ? Math.round(ca * factor) : null;
  const resultat_net_annualise     = rn != null ? Math.round(rn * factor) : null;

  // ── Flags ─────────────────────────────────────────────────────
  const is_loss_making = rn != null ? rn < 0 : null;
  const n1Profit = input.resultat_net_n1 != null ? input.resultat_net_n1 > 0 : null;
  const nProfit  = rn != null ? rn > 0 : null;
  const swung_to_profit = (n1Profit === false && nProfit === true) ? true
                        : (n1Profit != null && nProfit != null) ? false : null;
  const swung_to_loss   = (n1Profit === true && nProfit === false) ? true
                        : (n1Profit != null && nProfit != null) ? false : null;

  return {
    valeur_ajoutee, ebe, ebitda, caf, bfr, fonds_roulement, tresorerie_nette,
    marge_brute_pct, marge_commerciale_pct, marge_production_pct,
    marge_exploitation_pct, marge_nette_pct, marge_ebe_pct, marge_ebitda_pct, taux_va_pct,
    roa_pct, roe_pct, roic_pct, roce_pct,
    autonomie_financiere_pct, taux_endettement_pct, taux_endettement_global_pct,
    capacite_remboursement_ans, couverture_charges_fin,
    liquidite_generale, liquidite_reduite, liquidite_immediate,
    bfr_jours_ca, dso_jours, dpo_jours, rotation_stocks_jours,
    ca_par_salarie, va_par_salarie, resultat_par_salarie,
    poids_masse_salariale_pct, poids_dotations_pct, poids_charges_externes_pct,
    chiffre_affaires_yoy_pct, resultat_net_yoy_pct, total_bilan_yoy_pct,
    capitaux_propres_yoy_pct, effectif_yoy_pct,
    chiffre_affaires_yoy_abs, resultat_net_yoy_abs, total_bilan_yoy_abs, capitaux_propres_yoy_abs,
    chiffre_affaires_annualise, resultat_net_annualise, is_short_exercise,
    is_loss_making, swung_to_profit, swung_to_loss,
  };
}

/**
 * After per-row computation, run a SECOND pass per siren ordered by year
 * to fill the multi-year flags (CAGR 3y/5y, has_grown_3y, is_loss_making_3y,
 * is_zombie, is_high_growth, is_distressed). These need 3-5 prior rows.
 *
 * Implement as an UPDATE with window functions on the screener table itself
 * (post-insert), not in this file.
 */
export const NEEDS_WINDOW_PASS = [
  'chiffre_affaires_cagr_3y_pct',
  'chiffre_affaires_cagr_5y_pct',
  'resultat_net_cagr_3y_pct',
  'resultat_net_cagr_5y_pct',
  'effectif_cagr_3y_pct',
  'has_grown_3y',
  'is_loss_making_3y',
  'is_zombie',
  'is_high_growth',
  'is_distressed',
];
