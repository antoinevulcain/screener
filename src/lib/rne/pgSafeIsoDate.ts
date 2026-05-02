/**
 * Normalise `YYYY-MM-DD` pour PostgreSQL : l’INPI peut envoyer `0000-01-01` ou mois/jour à 00,
 * ce qui provoque `date/time field value out of range` (SQLSTATE 22008).
 * On renvoie `null` pour les dates non représentables (année &lt; 1, mois/jour hors plage).
 */
export function pgSafeIsoDate(s: string | null | undefined): string | null {
  if (s == null || typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (y < 1) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
