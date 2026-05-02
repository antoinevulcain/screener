/**
 * Colonnes PostgreSQL `INTEGER` (32 bits signé). Hors plage → `null` (évite SQLSTATE 22003).
 * Les montants financiers vont en `BIGINT` ; `duree_exercice` / `effectif_moyen` restent en `INTEGER`.
 */

const PG_INT32_MAX = 2147483647;
const PG_INT32_MIN = -2147483648;

export function fitPgInteger32(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const x = Math.round(n);
  if (x < PG_INT32_MIN || x > PG_INT32_MAX) return null;
  return x;
}
