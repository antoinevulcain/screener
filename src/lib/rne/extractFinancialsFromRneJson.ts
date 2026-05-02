import { extractBilanSaisiMetrics } from "./bilanSaisiMetrics.js";
import { resolveInpiDateForPg } from "./formaliteContextIsoDate.js";
import { fitPgInteger32 } from "./fitPgInteger32.js";
import { sirenFromRneJsonNode } from "./rneSirenFromNode.js";
import { pgSafeIsoDate } from "./pgSafeIsoDate.js";

/**
 * Extraction des données financières (comptes annuels / dépôts) depuis un JSON de formalité RNE.
 *
 * Les formalités INPI de type « dépôt de comptes » contiennent :
 * - Metadata : date de clôture, durée d'exercice, type, confidentialité
 * - Parfois des montants (chiffre d'affaires, résultat, bilan) dans des blocs "detailBilan" / "donneesFinancieres"
 *
 * On extrait ce qu'on peut ; les champs absents restent null.
 */

export type ExtractedFinancial = {
  siren: string;
  dateCloture: string | null;
  dureeExercice: number | null;
  typeComptes: string | null;
  confidentialite: string | null;
  chiffreAffaires: number | null;
  resultatNet: number | null;
  totalBilan: number | null;
  capitauxPropres: number | null;
  effectifMoyen: number | null;
  /** Bilan actif brut (JSONB persisté) — détails postes actif. */
  bilanActif: Record<string, unknown> | null;
  /** Bilan passif brut (JSONB persisté) — détails postes passif. */
  bilanPassif: Record<string, unknown> | null;
  /** Compte de résultat brut (JSONB persisté) — détails postes compte de résultat. */
  compteResultat: Record<string, unknown> | null;
  rawPayload: Record<string, unknown>;
};

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function financialDate(v: unknown, root: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  let raw: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) raw = s.slice(0, 10);
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split("/");
    raw = `${y}-${m}-${d}`;
  } else if (/^\d{8}$/.test(s)) raw = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (raw == null) return null;
  const resolved = resolveInpiDateForPg(raw, root, "financial");
  return resolved ?? pgSafeIsoDate(raw);
}

function asInt(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "string") {
    const n = parseInt(v.replace(/\s/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sirenFromObject(o: Record<string, unknown>): string | null {
  return sirenFromRneJsonNode(o);
}

function isFinancialBlock(o: Record<string, unknown>): boolean {
  if (o.bilanSaisi != null && typeof o.bilanSaisi === "object") return true;
  const markers = [
    "dateCloture", "dateClotureExercice", "dateClotureComptes",
    "typeComptes", "typeDepot", "natureComptes",
    "chiffreAffaires", "totalBilan", "resultatNet", "resultat",
    "detailBilan", "donneesFinancieres", "bilanActif", "bilanPassif",
    "compteResultat", "comptesAnnuels",
    "dureeExercice", "confidentialite",
  ];
  return markers.some((k) => o[k] !== undefined);
}

function extractFromBlock(o: Record<string, unknown>, siren: string, root: unknown): ExtractedFinancial | null {
  const dateCloture =
    financialDate(o.dateCloture, root) ??
    financialDate(o.dateClotureExercice, root) ??
    financialDate(o.dateClotureComptes, root) ??
    financialDate(o.dateFin, root) ??
    null;

  const dureeExercice =
    asInt(o.dureeExercice) ?? asInt(o.duree) ?? null;

  const typeComptes =
    asStr(o.typeComptes) ?? asStr(o.typeDepot) ?? asStr(o.natureComptes) ?? null;

  const confidentialite =
    asStr(o.confidentialite) ?? asStr(o.niveauConfidentialite) ?? null;

  const fin = typeof o.donneesFinancieres === "object" && o.donneesFinancieres
    ? o.donneesFinancieres as Record<string, unknown>
    : o;
  const bilan = typeof o.detailBilan === "object" && o.detailBilan
    ? o.detailBilan as Record<string, unknown>
    : fin;

  const chiffreAffaires =
    asInt(fin.chiffreAffaires) ?? asInt(bilan.chiffreAffaires) ?? null;
  const resultatNet =
    asInt(fin.resultatNet) ?? asInt(fin.resultat) ?? asInt(bilan.resultatNet) ?? asInt(bilan.resultat) ?? null;
  const totalBilan =
    asInt(fin.totalBilan) ?? asInt(bilan.totalBilan) ?? asInt(bilan.totalActif) ?? null;
  const capitauxPropres =
    asInt(fin.capitauxPropres) ?? asInt(bilan.capitauxPropres) ?? null;
  const effectifMoyen =
    asInt(fin.effectifMoyen) ?? asInt(fin.effectif) ?? asInt(o.effectifMoyen) ?? null;

  const fromLiasse = extractBilanSaisiMetrics(o);
  const merged = fromLiasse
    ? {
        dateCloture: dateCloture ?? fromLiasse.dateCloture,
        dureeExercice: dureeExercice ?? fromLiasse.dureeExercice,
        typeComptes: typeComptes ?? fromLiasse.typeComptes,
        confidentialite: confidentialite ?? fromLiasse.confidentialite,
        chiffreAffaires: chiffreAffaires ?? fromLiasse.chiffreAffaires,
        resultatNet: resultatNet ?? fromLiasse.resultatNet,
        totalBilan: totalBilan ?? fromLiasse.totalBilan,
        capitauxPropres: capitauxPropres ?? fromLiasse.capitauxPropres,
        effectifMoyen: effectifMoyen ?? fromLiasse.effectifMoyen,
      }
    : {
        dateCloture,
        dureeExercice,
        typeComptes,
        confidentialite,
        chiffreAffaires,
        resultatNet,
        totalBilan,
        capitauxPropres,
        effectifMoyen,
      };

  const dateClotureResolved =
    merged.dateCloture != null && merged.dateCloture !== ""
      ? financialDate(String(merged.dateCloture), root)
      : null;

  // Capture des sous-blocs bruts (colonnes JSONB dédiées). Sans ça, ces
  // structures ne sont accessibles qu'en `parsed_data` (non persisté ici) —
  // les liasses actif/passif détaillées étaient donc perdues pour les
  // analyses poste-par-poste alors que la table a trois colonnes JSONB
  // prévues à cet effet.
  const bilanActifRaw =
    typeof o.bilanActif === "object" && o.bilanActif !== null
      ? (o.bilanActif as Record<string, unknown>)
      : typeof bilan.bilanActif === "object" && bilan.bilanActif !== null
        ? (bilan.bilanActif as Record<string, unknown>)
        : null;
  const bilanPassifRaw =
    typeof o.bilanPassif === "object" && o.bilanPassif !== null
      ? (o.bilanPassif as Record<string, unknown>)
      : typeof bilan.bilanPassif === "object" && bilan.bilanPassif !== null
        ? (bilan.bilanPassif as Record<string, unknown>)
        : null;
  const compteResultatRaw =
    typeof o.compteResultat === "object" && o.compteResultat !== null
      ? (o.compteResultat as Record<string, unknown>)
      : typeof bilan.compteResultat === "object" && bilan.compteResultat !== null
        ? (bilan.compteResultat as Record<string, unknown>)
        : null;

  if (
    !dateClotureResolved &&
    merged.chiffreAffaires == null &&
    merged.resultatNet == null &&
    merged.totalBilan == null &&
    bilanActifRaw == null &&
    bilanPassifRaw == null &&
    compteResultatRaw == null
  ) {
    return null;
  }

  return {
    siren,
    dateCloture: dateClotureResolved,
    dureeExercice: fitPgInteger32(merged.dureeExercice),
    typeComptes: merged.typeComptes,
    confidentialite: merged.confidentialite,
    chiffreAffaires: merged.chiffreAffaires,
    resultatNet: merged.resultatNet,
    totalBilan: merged.totalBilan,
    capitauxPropres: merged.capitauxPropres,
    effectifMoyen: fitPgInteger32(merged.effectifMoyen),
    bilanActif: bilanActifRaw,
    bilanPassif: bilanPassifRaw,
    compteResultat: compteResultatRaw,
    rawPayload: o,
  };
}

function visit(node: unknown, inheritedSiren: string | null, out: ExtractedFinancial[], docRoot: unknown): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) visit(el, inheritedSiren, out, docRoot);
    return;
  }

  const o = node as Record<string, unknown>;
  const siren = sirenFromObject(o) ?? inheritedSiren;

  if (siren && isFinancialBlock(o)) {
    const f = extractFromBlock(o, siren, docRoot);
    if (f) out.push(f);
  }

  for (const k of Object.keys(o)) {
    visit(o[k], siren, out, docRoot);
  }
}

const FINANCIAL_MARKER_KEYS = new Set<string>([
  "bilanSaisi",
  "dateCloture", "dateClotureExercice", "dateClotureComptes",
  "typeComptes", "typeDepot", "natureComptes",
  "chiffreAffaires", "totalBilan", "resultatNet", "resultat",
  "detailBilan", "donneesFinancieres", "bilanActif", "bilanPassif",
  "compteResultat", "comptesAnnuels",
  "dureeExercice", "confidentialite",
]);

// Fast pre-check: iterative tree walk that returns as soon as any known financial
// marker key is seen. For formalités docs that carry no financial data, this skips
// the heavier visit() pass entirely (which does siren + marker checks at every node).
function hasAnyFinancialMarker(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === null || n === undefined || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
      continue;
    }
    const o = n as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (FINANCIAL_MARKER_KEYS.has(k)) return true;
      stack.push(o[k]);
    }
  }
  return false;
}

export function extractFinancialsFromRneJson(root: unknown): ExtractedFinancial[] {
  if (!hasAnyFinancialMarker(root)) return [];
  const out: ExtractedFinancial[] = [];
  visit(root, null, out, root);

  const seen = new Set<string>();
  const dedup: ExtractedFinancial[] = [];
  for (const r of out) {
    const k = `${r.siren}|${r.dateCloture ?? ""}|${r.typeComptes ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(r);
  }
  return dedup;
}
