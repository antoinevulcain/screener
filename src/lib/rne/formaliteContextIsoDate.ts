/**
 * Dates « sentinelle » INPI (ex. `0000-01-01`, équivalent .NET DateTime.MinValue) : non stockables en PostgreSQL.
 * Pour les champs **liés à la formalité** (mandat, dépôt, clôture déclarée), la valeur métier correcte est en pratique
 * celle du **dépôt / formalité** dans le même JSON (`formality.dateFormalite`, `dateDepot`, `updatedAt`, …).
 */

import { pgSafeIsoDate } from "./pgSafeIsoDate.js";

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** `0000-MM-DD` : année 0 hors plage SQL. */
function isYearZeroIsoDate(isoYmd: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(isoYmd) && isoYmd.startsWith("0000-");
}

/**
 * Première date calendaire exploitable depuis la racine d’un document formalité RNE
 * (même heuristique que la synthèse / `extractFormaliteMeta` dans extractSyntheseFromRneJson).
 */
export function formaliteContextIsoDateFromRoot(root: unknown): string | null {
  if (root === null || root === undefined || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }
  const o = root as Record<string, unknown>;

  const tryStringToPgDate = (s: string): string | null => {
    const t = s.trim();
    if (!t) return null;
    const ymd = t.match(/^(\d{4}-\d{2}-\d{2})/);
    if (ymd) {
      const iso = ymd[1];
      if (isYearZeroIsoDate(iso)) return null;
      return pgSafeIsoDate(iso);
    }
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    if (y < 1) return null;
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return pgSafeIsoDate(`${y}-${mo}-${day}`);
  };

  const candidates: string[] = [];
  const push = (v: unknown) => {
    const s = asStr(v);
    if (s) candidates.push(s);
  };

  push(o.updatedAt);
  const fm = o.formality ?? o.formalite;
  if (fm && typeof fm === "object" && !Array.isArray(fm)) {
    const f = fm as Record<string, unknown>;
    push(f.dateFormalite);
    push(f.dateDepot);
    push(f.dateCreationFormalite);
    push(f.dateFormaliteEffective);
  }

  for (const c of candidates) {
    const d = tryStringToPgDate(c);
    if (d) return d;
  }
  return null;
}

export type InpiDateSemantic = "mandate" | "filing" | "birth" | "financial";

/** Dernière ressource : PG accepte l’an 1 ; évite NULL quand l’INPI n’expose pas de naissance réelle. */
const PG_TECH_UNKNOWN_BIRTH = "0001-01-01";
const PG_TECH_UNKNOWN_GENERIC = "0001-01-01";

/**
 * Normalise une date extraite du JSON vers une valeur `date` PostgreSQL valide.
 * - Année ≥ 1 : inchangé (via {@link pgSafeIsoDate}).
 * - `0000-…` : selon le sens du champ — formalité pour mandat/dépôt/financier ; borne technique pour naissance.
 */
export function resolveInpiDateForPg(
  raw: string | null | undefined,
  root: unknown,
  semantic: InpiDateSemantic,
): string | null {
  if (raw == null || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let ymd = trimmed;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) ymd = trimmed.slice(0, 10);
  else if (/^\d{4}-\d{2}$/.test(trimmed)) ymd = `${trimmed}-01`;

  const direct = pgSafeIsoDate(ymd);
  if (direct != null) return direct;

  if (!isYearZeroIsoDate(ymd) && !ymd.startsWith("0000-")) return null;

  if (semantic === "birth") {
    return PG_TECH_UNKNOWN_BIRTH;
  }

  const fb = formaliteContextIsoDateFromRoot(root);
  if (fb) return fb;
  return PG_TECH_UNKNOWN_GENERIC;
}
