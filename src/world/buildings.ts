/**
 * Modèle de données des bâtiments.
 *
 * Chaque bâtiment porte deux choses distinctes qu'il ne faut jamais confondre :
 *  - son ÉTAT RÉEL (`state`, `damage`) : la vérité terrain de la simulation ;
 *  - ce que le détecteur en DIT (module diagnostic/detector.ts), qui peut se tromper.
 *
 * C'est cette séparation qui permet de mesurer la précision du diagnostic.
 */

/** Niveaux de dommage, par gravité croissante. */
export type DamageState = 'intact' | 'cracked' | 'partial' | 'collapsed' | 'burnt';

export const DAMAGE_ORDER: DamageState[] = ['intact', 'cracked', 'partial', 'collapsed', 'burnt'];

/** Libellés et couleurs associés à chaque état. */
export const DAMAGE_INFO: Record<
  DamageState,
  { label: string; short: string; color: string; rgb: [number, number, number]; severity: number }
> = {
  intact: {
    label: 'Intact',
    short: 'OK',
    color: '#00e676',
    rgb: [0, 230, 118],
    severity: 0,
  },
  cracked: {
    label: 'Fissuré',
    short: 'FISS',
    color: '#ffc400',
    rgb: [255, 196, 0],
    severity: 1,
  },
  partial: {
    label: 'Effondrement partiel',
    short: 'PART',
    color: '#ff6d00',
    rgb: [255, 109, 0],
    severity: 2,
  },
  collapsed: {
    label: 'Effondré',
    short: 'EFFO',
    color: '#ff1744',
    rgb: [255, 23, 68],
    severity: 3,
  },
  burnt: {
    label: 'Incendié',
    short: 'FEU',
    color: '#d500f9',
    rgb: [213, 0, 249],
    severity: 3,
  },
};

/** Type d'usage, qui conditionne la silhouette et la vulnérabilité. */
export type BuildingKind = 'residentiel' | 'commerce' | 'bureau' | 'industriel' | 'civique';

export interface Building {
  id: string;
  name: string;
  kind: BuildingKind;

  /** Position du centre de l'emprise au sol. */
  lon: number;
  lat: number;
  /** Altitude du pied du bâtiment (mètres, au-dessus de l'ellipsoïde). */
  baseHeight: number;

  /** Emprise au sol, en mètres. */
  width: number;
  depth: number;
  /** Hauteur nominale du bâtiment intact, en mètres. */
  height: number;
  floors: number;
  /** Rotation autour de la verticale, en degrés. */
  heading: number;

  /** Année de construction : sert à calculer la vulnérabilité. */
  year: number;
  /**
   * Vulnérabilité structurelle entre 0 et 1.
   * Utilisée par le simulateur de désastres (partie 2) via une courbe de fragilité.
   */
  vulnerability: number;

  /** Vérité terrain : état réel du bâtiment. */
  state: DamageState;
  /** Vérité terrain : sévérité continue entre 0 et 1. */
  damage: number;

  /** Débris au sol, générés quand le bâtiment s'effondre. */
  debris: Array<{ dx: number; dy: number; size: number; height: number; rot: number }>;
}

/** Hauteur effectivement debout, une fois le dommage appliqué. */
export function standingHeight(b: Building): number {
  switch (b.state) {
    case 'intact':
      return b.height;
    case 'cracked':
      return b.height * 0.97;
    case 'partial':
      return b.height * (0.45 + 0.2 * (1 - b.damage));
    case 'collapsed':
      return Math.max(3, b.height * 0.16);
    case 'burnt':
      return b.height * 0.82;
  }
}

/** Le bâtiment est-il considéré comme endommagé (pour le diagnostic) ? */
export function isDamaged(b: Building): boolean {
  return b.state !== 'intact';
}

/**
 * Vulnérabilité déduite de l'âge, de l'usage et de l'élancement.
 *
 * Le raisonnement est celui du génie parasismique : le bâti ancien en maçonnerie
 * non chaînée encaisse mal, le béton armé récent encaisse bien, et un bâtiment
 * élancé (haut sur une petite emprise) est plus sensible qu'un bâtiment trapu.
 */
export function computeVulnerability(
  year: number,
  kind: BuildingKind,
  height: number,
  footprint: number,
): number {
  // Avant 1960, pas de règles parasismiques ; après 2000, conception moderne.
  const age = 1 - Math.min(Math.max((year - 1880) / 145, 0), 1);
  const byAge = 0.25 + 0.55 * age;

  const byKind: Record<BuildingKind, number> = {
    residentiel: 1.0,
    commerce: 1.1, // rez-de-chaussée très ouvert : « étage souple »
    bureau: 0.85,
    industriel: 0.95,
    civique: 0.7, // bâtiments publics mieux dimensionnés
  };

  // Élancement : hauteur rapportée à la racine de l'emprise.
  const slenderness = Math.min(height / Math.sqrt(Math.max(footprint, 1)), 4) / 4;

  const v = byAge * byKind[kind] * (0.82 + 0.35 * slenderness);
  return Math.min(Math.max(v, 0.05), 0.98);
}
