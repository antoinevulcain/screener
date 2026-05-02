/**
 * Extraction liasse lisible + métadonnées document depuis `rawPayload` INPI (bilanSaisi).
 * Utilisé par le dump RNE et l’import formalités → `inpi_financial_statements`.
 */
import {
  liasseRowsToTextTable,
  pagesToLiasseReadableRows,
} from "./bilanLiasseReadable.js";

export function pagesFromBilanRaw(raw: Record<string, unknown>): unknown[] | undefined {
  const bs = raw.bilanSaisi;
  if (!bs || typeof bs !== "object") return undefined;
  const bilan = (bs as Record<string, unknown>).bilan;
  if (!bilan || typeof bilan !== "object") return undefined;
  const detail = (bilan as Record<string, unknown>).detail;
  if (!detail || typeof detail !== "object") return undefined;
  const pages = (detail as Record<string, unknown>).pages;
  return Array.isArray(pages) ? pages : undefined;
}

export function anneesDepuisIdentiteBilan(
  raw: Record<string, unknown>
): { anneeN: string; anneeN1: string } {
  const bs = raw.bilanSaisi;
  if (!bs || typeof bs !== "object") return { anneeN: "?", anneeN1: "?" };
  const bilan = (bs as Record<string, unknown>).bilan;
  if (!bilan || typeof bilan !== "object") return { anneeN: "?", anneeN1: "?" };
  const identite = (bilan as Record<string, unknown>).identite;
  if (!identite || typeof identite !== "object") return { anneeN: "?", anneeN1: "?" };
  const id = identite as Record<string, unknown>;
  const y = (v: unknown) => (typeof v === "string" && v.length >= 4 ? v.slice(0, 4) : "?");
  return { anneeN: y(id.dateClotureExercice), anneeN1: y(id.dateClotureExerciceNMoins1) };
}

export type RneLiassePosteJson = {
  page: number;
  code: string;
  libelle: string;
  montant_exercice_N_euros: number | null;
  montant_exercice_N_moins_1_euros: number | null;
  colonnes_liasse: string;
};

export type RneLiasseFromRaw = {
  postes_liasse: RneLiassePosteJson[];
  tableau_bilan_tsv: string | null;
  annee_exercice: string;
  annee_exercice_precedent: string;
  inpi_document_id: string | null;
  rne_updated_at: string | null;
};

/**
 * La « meta document » vient de deux chemins distincts dans les payloads INPI :
 *
 *   - **Formality RNE** (wrapper API / diff) : `raw.id` + `raw.updatedAt` en
 *     racine du document. C'est le cas moderne.
 *   - **Liasse saisie directe** (exports FTP historiques) : pas de `id` ni de
 *     `updatedAt`, mais `raw.dateDepot` (date de dépôt greffe) et
 *     `raw.infoTraitement` (souvent vide). Sans fallback, ~50 % des lignes
 *     ressortaient `rne_updated_at IS NULL` alors que `dateDepot` est
 *     disponible 100 % du temps (cf. audit 2026-04 : 12.9 M lignes).
 *
 * On étend donc la résolution aux clés alternatives ; la sémantique reste
 * « date la plus récente associée au document » — `dateDepot` s'approche
 * davantage de `updatedAt` que de la date de clôture d'exercice.
 */
export function rneDocumentMetaFromRaw(raw: Record<string, unknown>): {
  inpi_document_id: string | null;
  rne_updated_at: string | null;
} {
  const asNonEmptyString = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const id =
    asNonEmptyString(raw.id) ??
    asNonEmptyString((raw.infoTraitement as Record<string, unknown> | undefined)?.numeroDepot) ??
    asNonEmptyString(raw.numeroDepot) ??
    null;

  const rne_updated_at =
    asNonEmptyString(raw.updatedAt) ??
    asNonEmptyString(raw.dateDepot) ??
    asNonEmptyString((raw.formality as Record<string, unknown> | undefined)?.dateDepot) ??
    asNonEmptyString((raw.formalite as Record<string, unknown> | undefined)?.dateDepot) ??
    null;

  return { inpi_document_id: id, rne_updated_at };
}

/** Retourne null si aucune page liasse (pas de bilan saisi structuré). */
function typeBilanFromRaw(raw: Record<string, unknown>): string | null {
  const root = typeof raw.typeBilan === "string" && raw.typeBilan.trim() ? raw.typeBilan.trim() : null;
  if (root) return root;
  const bs = raw.bilanSaisi;
  if (!bs || typeof bs !== "object") return null;
  const bilan = (bs as Record<string, unknown>).bilan;
  if (!bilan || typeof bilan !== "object") return null;
  const identite = (bilan as Record<string, unknown>).identite;
  if (!identite || typeof identite !== "object") return null;
  const c = (identite as Record<string, unknown>).codeTypeBilan;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

export function buildRneLiasseFromRawPayload(raw: Record<string, unknown>): RneLiasseFromRaw | null {
  const pages = pagesFromBilanRaw(raw);
  if (!pages?.length) return null;
  const { anneeN, anneeN1 } = anneesDepuisIdentiteBilan(raw);
  const meta = rneDocumentMetaFromRaw(raw);
  const liasseRows = pagesToLiasseReadableRows(pages, typeBilanFromRaw(raw));
  const postes_liasse: RneLiassePosteJson[] = liasseRows.map((r) => ({
    page: r.page,
    code: r.code,
    libelle: r.libelle,
    montant_exercice_N_euros: r.montantN,
    montant_exercice_N_moins_1_euros: r.montantNMoins1,
    colonnes_liasse: r.colonnes,
  }));
  const tableau_bilan_tsv =
    liasseRows.length > 0 ? liasseRowsToTextTable(liasseRows, anneeN, anneeN1) : null;
  return {
    postes_liasse,
    tableau_bilan_tsv,
    annee_exercice: anneeN,
    annee_exercice_precedent: anneeN1,
    inpi_document_id: meta.inpi_document_id,
    rne_updated_at: meta.rne_updated_at,
  };
}
