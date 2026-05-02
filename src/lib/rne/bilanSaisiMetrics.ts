/**
 * Métriques financières depuis un dépôt `bilansSaisis` / stock RNE (bloc bilanSaisi + liasses cerfa).
 * Codes et pages : **documentation technique API comptes annuels v5 (juin 2025)**, § E
 * (bilan complet `C` vs simplifié `S` ; colonnes m1–m4 selon la page).
 */

export type BilanSaisiMetrics = {
  dateCloture: string | null;
  dureeExercice: number | null;
  typeComptes: string | null;
  confidentialite: string | null;
  chiffreAffaires: number | null;
  resultatNet: number | null;
  totalBilan: number | null;
  capitauxPropres: number | null;
  effectifMoyen: number | null;
};

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseCerfaAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/\s/g, "");
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function findLiasse(pages: unknown[], pageNum: number, code: string, col: string): number | null {
  if (!Array.isArray(pages)) return null;
  const page = (pages as Record<string, unknown>[]).find((p) => Number(p.numero) === pageNum);
  if (!page || !Array.isArray(page.liasses)) return null;
  const liasse = (page.liasses as Record<string, unknown>[]).find((l) => l.code === code);
  if (!liasse) return null;
  return parseCerfaAmount(liasse[col]);
}

/** Si la page attendue manque (stocks partiels), cherche la liasse sur toutes les pages. */
function findLiasseAnyPage(pages: unknown[], code: string, col: string): number | null {
  if (!Array.isArray(pages)) return null;
  const sorted = [...pages].sort(
    (a, b) => Number((a as Record<string, unknown>).numero) - Number((b as Record<string, unknown>).numero)
  );
  for (const page of sorted) {
    if (!page || typeof page !== "object") continue;
    const liasses = (page as Record<string, unknown>).liasses;
    if (!Array.isArray(liasses)) continue;
    const liasse = liasses as Record<string, unknown>[];
    const L = liasse.find((l) => l.code === code);
    if (L && L[col] != null && String(L[col]).trim() !== "") {
      const v = parseCerfaAmount(L[col]);
      if (v != null) return v;
    }
  }
  return null;
}

/**
 * Extrait CA, résultat, totaux, etc. depuis la racine d’un dépôt JSON (champ `bilanSaisi`).
 * Retourne `null` s’il n’y a pas de structure bilan saisi.
 */
export function extractBilanSaisiMetrics(raw: Record<string, unknown>): BilanSaisiMetrics | null {
  const bilanSaisi = raw.bilanSaisi as Record<string, unknown> | undefined;
  if (!bilanSaisi) return null;
  const bilan = bilanSaisi.bilan as Record<string, unknown> | undefined;
  if (!bilan) return null;
  const identite = bilan.identite as Record<string, unknown> | undefined;
  const detail = bilan.detail as Record<string, unknown> | undefined;
  const pages = detail?.pages as unknown[] | undefined;

  const dateCloture = asStr(raw.dateCloture) ?? asStr(identite?.dateClotureExercice);
  const typeComptes = asStr(raw.typeBilan) ?? asStr(identite?.codeTypeBilan);
  const isSimple = typeComptes === "S" || typeComptes === "AS";

  let ca: number | null = null;
  let resultat: number | null = null;
  let totalBilanActif: number | null = null;
  let capitauxPropres: number | null = null;
  let effectif: number | null = null;
  let duree: number | null = null;

  if (pages) {
    if (isSimple) {
      totalBilanActif = findLiasse(pages, 1, "110", "m3") ?? findLiasse(pages, 1, "BR", "m3");
      capitauxPropres = findLiasse(pages, 1, "142", "m3") ?? findLiasse(pages, 1, "CG", "m3");
      ca = findLiasse(pages, 2, "232", "m1") ?? findLiasseAnyPage(pages, "232", "m1");
      resultat =
        findLiasse(pages, 2, "310", "m1") ??
        findLiasse(pages, 2, "FJ", "m1") ??
        findLiasseAnyPage(pages, "310", "m1");
      effectif =
        findLiasse(pages, 2, "376", "m1") ??
        findLiasse(pages, 5, "376", "m1") ??
        findLiasseAnyPage(pages, "376", "m1");
    } else {
      totalBilanActif = findLiasse(pages, 1, "CO", "m3") ?? findLiasseAnyPage(pages, "CO", "m3");
      capitauxPropres = findLiasse(pages, 2, "DL", "m1") ?? findLiasseAnyPage(pages, "DL", "m1");
      ca =
        findLiasse(pages, 3, "FJ", "m3") ??
        findLiasseAnyPage(pages, "FJ", "m3") ??
        findLiasseAnyPage(pages, "FJ", "m1");
      resultat =
        findLiasse(pages, 4, "HN", "m1") ??
        findLiasse(pages, 2, "DI", "m1") ??
        findLiasseAnyPage(pages, "HN", "m1") ??
        findLiasseAnyPage(pages, "DI", "m1");
      effectif =
        findLiasse(pages, 11, "YP", "m1") ??
        findLiasse(pages, 16, "YP", "m1") ??
        findLiasseAnyPage(pages, "YP", "m1");
    }
  }

  if (identite) {
    const d = identite.dureeExerciceN;
    if (d != null) duree = parseInt(String(d), 10) || null;
  }

  const confCode = asStr(identite?.codeConfidentialite);
  const confLabel =
    confCode === "0"
      ? "Public"
      : confCode === "1"
        ? "Confidentiel"
        : confCode === "2"
          ? "Partiellement confidentiel"
          : confCode === "3"
            ? "Publication simplifiee"
            : asStr(raw.confidentiality);

  return {
    dateCloture,
    dureeExercice: duree,
    typeComptes,
    confidentialite: confLabel,
    chiffreAffaires: ca,
    resultatNet: resultat,
    totalBilan: totalBilanActif,
    capitauxPropres,
    effectifMoyen: effectif,
  };
}
