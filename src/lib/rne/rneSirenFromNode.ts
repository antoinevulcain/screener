/**
 * Extraction normalisée du SIREN (9 chiffres) depuis des fragments JSON **RNE / formalités INPI**.
 * Aligné sur les trous corrigés côté BODACC : `numeroImmatriculation.numeroIdentification`,
 * `numeroIdentificationRCS`, champs sous `identite` / `content.personneMorale`, etc.
 */

/** Chaîne → SIREN français 9 chiffres, ou null si format inutilisable. */
export function normSirenFr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.replace(/\D/g, "");
  return d.length === 9 ? d : null;
}

/** SIRET (14 chiffres) → SIREN = 9 premiers ; chaîne déjà 9 chiffres acceptée. */
export function sirenFromSiretField(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = String(v).replace(/\D/g, "");
  if (d.length >= 14) return d.slice(0, 9);
  if (d.length === 9) return d;
  return null;
}

/**
 * Bloc `numeroImmatriculation` RNE (souvent `numeroIdentification` ou `numeroIdentificationRCS`).
 */
export function sirenFromNumeroImmatriculationBlock(ni: unknown): string | null {
  if (ni == null || typeof ni !== "object" || Array.isArray(ni)) return null;
  const rec = ni as Record<string, unknown>;
  for (const key of [
    "numeroIdentification",
    "numeroIdentificationRCS",
    "numeroIdentificationRM",
    "numeroSiren",
  ] as const) {
    const x = normSirenFr(rec[key]);
    if (x) return x;
  }
  return null;
}

/**
 * Un nœud objet JSON (fragment formalité) : SIREN explicite ou via immatriculation / identité / entreprise.
 * Utilisé par les parcours récursifs (`extractDirectorsFromRneJson`, etc.) et par {@link sirenFromRneJsonRoot}.
 */
export function sirenFromRneJsonNode(o: Record<string, unknown>): string | null {
  const direct =
    normSirenFr(o.siren) ??
    normSirenFr(o.sirenFormate) ??
    normSirenFr(o.numeroSiren) ??
    sirenFromSiretField(o.siret) ??
    sirenFromSiretField(o.siretSiege) ??
    sirenFromNumeroImmatriculationBlock(o.numeroImmatriculation);

  if (direct) return direct;

  if (typeof o.identite === "object" && o.identite !== null && !Array.isArray(o.identite)) {
    const id = o.identite as Record<string, unknown>;
    const fromId =
      normSirenFr(id.siren) ?? sirenFromNumeroImmatriculationBlock(id.numeroImmatriculation);
    if (fromId) return fromId;
  }

  if (typeof o.entreprise === "object" && o.entreprise !== null && !Array.isArray(o.entreprise)) {
    const ent = o.entreprise as Record<string, unknown>;
    const fromEnt =
      normSirenFr(ent.siren) ?? sirenFromNumeroImmatriculationBlock(ent.numeroImmatriculation);
    if (fromEnt) return fromEnt;
  }

  return null;
}

/**
 * SIREN du **document** racine (`{ siren, formality: { siren, content: { personneMorale|Physique }}}`).
 */
export function sirenFromRneJsonRoot(root: unknown): string | null {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return null;
  const o = root as Record<string, unknown>;

  let s = sirenFromRneJsonNode(o);
  if (s) return s;

  const f = o.formality;
  if (f && typeof f === "object" && !Array.isArray(f)) {
    const fm = f as Record<string, unknown>;
    s =
      normSirenFr(fm.siren) ??
      sirenFromNumeroImmatriculationBlock(fm.numeroImmatriculation) ??
      sirenFromRneJsonNode(fm);
    if (s) return s;

    const content = fm.content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      const c = content as Record<string, unknown>;
      for (const key of ["personneMorale", "personnePhysique"] as const) {
        const block = c[key];
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const fromBlock = sirenFromRneJsonNode(block as Record<string, unknown>);
          if (fromBlock) return fromBlock;
        }
      }
    }
  }

  return null;
}
