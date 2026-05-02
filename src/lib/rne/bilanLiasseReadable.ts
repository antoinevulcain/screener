/**
 * Conversion des liasses `bilanSaisi.bilan.detail.pages[].liasses[]` (codes CERFA)
 * vers des lignes lisibles : libellé + montants exercice N / N-1.
 *
 * Libellés : **documentation technique API comptes annuels v5 (juin 2025)**, § E
 * (`inpiComptesAnnuelsV5CerfaLibelles.ts`), selon `typeBilan` (C, S, B, K, …).
 *
 * Les montants bruts INPI sont des **chaînes d’entiers** (souvent 15 chiffres paddés) : valeur = euros entiers
 * (ex. "000000000001000" → 1 000 €), pas des centimes.
 *
 * Colonnes m1–m4 : la sémantique exacte dépend de la page / type de comptes (voir la même doc § E).
 * Règle d’affichage N / N-1 : si la liasse contient `m3` ou `m4`, prendre (m3, m4) ; sinon (m1, m2).
 */
import { cerfaLibelleV5 } from "./inpiComptesAnnuelsV5CerfaLibelles.js";

export type LiasseReadableRow = {
  page: number;
  code: string;
  libelle: string;
  /** Exercice courant (N), euros entiers */
  montantN: number | null;
  /** Exercice précédent (N-1), euros entiers */
  montantNMoins1: number | null;
  /** Indication colonnes sources, ex. "m3/m4" ou "m1/m2" */
  colonnes: string;
};

function parseMontantEuros(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).replace(/\s/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function pickNMoins1(liasse: Record<string, unknown>): {
  montantN: number | null;
  montantNMoins1: number | null;
  colonnes: string;
} {
  const keys = Object.keys(liasse);
  const hasM34 = keys.includes("m3") || keys.includes("m4");
  if (hasM34) {
    return {
      montantN: parseMontantEuros(liasse.m3),
      montantNMoins1: parseMontantEuros(liasse.m4),
      colonnes: "m3/m4",
    };
  }
  return {
    montantN: parseMontantEuros(liasse.m1),
    montantNMoins1: parseMontantEuros(liasse.m2),
    colonnes: "m1/m2",
  };
}

/**
 * À partir de `bilan.detail.pages` (tableau), produit une liste de lignes lisibles.
 * `typeBilan` : ex. `C`, `S`, `K`, `B` (identite.codeTypeBilan / racine typeBilan).
 */
export function pagesToLiasseReadableRows(
  pages: unknown[] | undefined,
  typeBilan?: string | null,
): LiasseReadableRow[] {
  if (!Array.isArray(pages)) return [];
  const out: LiasseReadableRow[] = [];
  for (const p of pages) {
    if (!p || typeof p !== "object") continue;
    const pg = p as Record<string, unknown>;
    const num = Number(pg.numero);
    const pageNum = Number.isFinite(num) ? num : 0;
    const liasses = pg.liasses;
    if (!Array.isArray(liasses)) continue;
    for (const L of liasses) {
      if (!L || typeof L !== "object") continue;
      const liasse = L as Record<string, unknown>;
      const code = typeof liasse.code === "string" ? liasse.code.trim() : "";
      if (!code) continue;
      const { montantN, montantNMoins1, colonnes } = pickNMoins1(liasse);
      out.push({
        page: pageNum,
        code,
        libelle: cerfaLibelleV5(code, typeBilan),
        montantN,
        montantNMoins1,
        colonnes,
      });
    }
  }
  return out;
}

/** Format type tableau : "125 210 €" */
export function formatEurosFr(n: number | null): string {
  if (n == null) return "—";
  return `${n.toLocaleString("fr-FR")} €`;
}

/**
 * Rendu texte proche du collage utilisateur (une ligne par poste).
 * `anneeN` / `anneeN1` : libellés de colonnes, ex. 2024 et 2023.
 */
export function liasseRowsToTextTable(
  rows: LiasseReadableRow[],
  anneeN: string,
  anneeN1: string
): string {
  const header = `Poste\tCode\t${anneeN} (N)\t${anneeN1} (N-1)`;
  const lines = rows.map(
    (r) =>
      `${r.libelle}\t${r.code}\t${formatEurosFr(r.montantN)}\t${formatEurosFr(r.montantNMoins1)}`
  );
  return [header, ...lines].join("\n");
}
