/**
 * Les quatre scénarios de désastre, et le champ d'intensité de chacun.
 *
 * Chaque aléa a sa propre physique, et c'est précisément l'intérêt de les
 * mettre côte à côte : ils ne produisent pas du tout la même carte de dégâts.
 *
 *   SÉISME      — atténuation lente, toute la ville est touchée, gradient doux.
 *   EXPLOSION   — décroissance très raide, destruction totale sur un rayon
 *                 court, rien au-delà. C'est l'inverse exact du séisme.
 *   INONDATION  — ce n'est pas la distance qui compte mais l'ALTITUDE réelle
 *                 du pied de chaque bâtiment : deux voisins peuvent avoir des
 *                 sorts opposés.
 *   INCENDIE    — pas de champ du tout : une propagation de proche en proche,
 *                 orientée par le vent. La forme de la zone brûlée dépend de
 *                 l'histoire, pas de la géométrie.
 *
 * UNE HONNÊTETÉ D'ÉCHELLE
 * -----------------------
 * La ville simulée fait ~700 m de côté. Un vrai séisme a son foyer à 5-15 km
 * de profondeur et frappe une agglomération de cette taille de façon quasi
 * UNIFORME : il n'y aurait aucun gradient à voir. On place donc le foyer à
 * 220 m, ce qui est physiquement faux mais rend l'atténuation lisible à
 * l'échelle du quartier. Les lois de décroissance, elles, gardent leur forme.
 */

import type { Building } from '../world/buildings';

export type DisasterKind = 'seisme' | 'inondation' | 'incendie' | 'explosion';

export interface Scenario {
  kind: DisasterKind;
  /**
   * Grandeur principale. Son sens dépend de l'aléa :
   *   séisme      — intensité épicentrale EMS-98 (V à X)
   *   explosion   — charge équivalente, en tonnes de TNT
   *   inondation  — hauteur d'eau maximale à la source, en mètres
   *   incendie    — vigueur de propagation (0,5 à 2)
   */
  magnitude: number;
  /** Foyer, en mètres depuis le centre-ville (est, nord). */
  east: number;
  north: number;
  /** Direction d'où vient le vent, en degrés. Utile à l'incendie seul. */
  windFrom: number;
  /** Graine : deux lectures du même scénario donnent le même résultat. */
  seed: number;
  /** Durée simulée, en secondes. */
  duration: number;
}

export interface DisasterMeta {
  label: string;
  /** Nom de la grandeur réglable, tel qu'affiché. */
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Ce que le scénario fait, en une phrase. */
  blurb: string;
}

export const DISASTERS: Record<DisasterKind, DisasterMeta> = {
  seisme: {
    label: 'Séisme',
    unit: 'Intensité EMS-98',
    min: 5,
    max: 10,
    step: 0.5,
    blurb: 'Toute la ville encaisse, le bâti ancien cède en premier. Référence : Bâle, 1356.',
  },
  explosion: {
    label: 'Explosion',
    unit: 'Charge (t TNT)',
    min: 0.5,
    max: 20,
    step: 0.5,
    blurb: 'Rayon net et brutal. Doubler la charge ne l’élargit que de 26 % (loi en W^1/3).',
  },
  inondation: {
    label: 'Inondation',
    unit: 'Crue (m)',
    min: 0.5,
    max: 6,
    // Le vieux centre est si plat qu'un quart de mètre fait passer de 5 % à
    // 19 % de bâtiments les pieds dans l'eau : un pas plus grossier sauterait
    // les situations intermédiaires.
    step: 0.25,
    blurb: 'L’eau monte à niveau plat et remplit d’abord les creux du relief réel.',
  },
  incendie: {
    label: 'Incendie',
    unit: 'Vigueur',
    min: 0.5,
    max: 2,
    step: 0.1,
    blurb: 'Propagation de proche en proche, étirée par le vent.',
  },
};

/** Scénario par défaut d'un aléa donné. */
export function defaultScenario(kind: DisasterKind): Scenario {
  const common = { kind, east: 60, north: 40, windFrom: 225, seed: 7301, duration: 45 };
  switch (kind) {
    // Intensité VII : l'ordre de grandeur estimé pour Mulhouse lors du séisme
    // de Bâle de 1356, la référence historique du fossé rhénan. Une estimation
    // tirée des témoignages de l'époque, pas une mesure.
    case 'seisme':
      return { ...common, magnitude: 7, duration: 30 };
    // Une tonne : l'ordre de grandeur d'un camion piégé. Six tonnes rasaient la
    // moitié de la vieille ville, trop pour une mission de reconnaissance.
    case 'explosion':
      return { ...common, magnitude: 1, duration: 20 };
    // Trois mètres au-dessus du point le plus bas : 25 % des bâtiments ont les
    // pieds dans l'eau, dont une soixantaine sous plus d'un mètre. La position
    // du foyer ne sert pas, c'est le relief qui décide.
    case 'inondation':
      return { ...common, magnitude: 3, duration: 60 };
    case 'incendie':
      return { ...common, magnitude: 1.2, east: -150, north: -110, duration: 90 };
  }
}

/** Position d'un bâtiment en mètres depuis le centre-ville. */
export function localOffset(
  b: Building,
  centerLon: number,
  centerLat: number,
): { east: number; north: number } {
  const mLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return {
    east: (b.lon - centerLon) * mLon,
    north: (b.lat - centerLat) * 111320,
  };
}

// ---------------------------------------------------------------------------
// Champs d'intensité
// ---------------------------------------------------------------------------

/** Profondeur focale retenue, en mètres. Voir la note d'échelle en tête. */
const FOCAL_DEPTH = 220;

/**
 * Séisme — atténuation macrosismique.
 *
 * Forme classique `I = I0 - k·log10(R_hypo / h)` : l'intensité perd un degré
 * EMS-98 chaque fois que la distance hypocentrale double, à peu près. On
 * convertit ensuite le degré en facteur de contrainte, en prenant V comme
 * seuil de ressenti sans dégât et IX comme destruction généralisée.
 */
export function seismicIntensity(distance: number, magnitude: number): number {
  const hypo = Math.sqrt(distance * distance + FOCAL_DEPTH * FOCAL_DEPTH);
  const degree = magnitude - 3.0 * Math.log10(hypo / FOCAL_DEPTH);
  return Math.max(0, (degree - 5) / 4);
}

/**
 * Explosion — surpression, en bars.
 *
 * Loi d'échelle de Hopkinson-Cranz : deux charges différentes produisent la
 * même surpression à la même DISTANCE RÉDUITE `Z = R / W^(1/3)`. C'est
 * pourquoi doubler la charge n'élargit le rayon de destruction que de 26 %.
 *
 * Repères usuels : 0,07 bar brise les vitres, 0,25 bar ruine la maçonnerie,
 * 0,50 bar effondre un bâtiment courant.
 *
 * La constante et l'exposant sont ajustés sur les abaques de Kingery-Bulmash,
 * et non choisis à vue. Vérification sur toute la plage utile :
 *
 *     Z (m/kg^1/3)      1      2      5     10     20     40
 *     abaque (bar)     20     5     0,9    0,30   0,12   0,05
 *     ce modèle       8,4    3,2    0,90   0,34   0,13   0,05
 *
 * L'écart en champ très proche (Z < 2) est sans conséquence : à cette distance
 * tout est détruit de toute façon. Contrôle à l'autre bout de l'échelle — pour
 * la charge de Beyrouth en 2020 (~1 000 t), le modèle donne un rayon
 * d'effondrement de 1 074 m, contre ~1 km constaté.
 */
export function blastOverpressure(distance: number, tonnesTnt: number): number {
  const kg = Math.max(tonnesTnt, 0.01) * 1000;
  const z = Math.max(distance, 1) / Math.cbrt(kg);
  return 8.4 / Math.pow(Math.max(z, 0.5), 1.39);
}

/** Convertit une surpression en facteur de contrainte pour la fragilité. */
export function blastIntensity(distance: number, tonnesTnt: number): number {
  return blastOverpressure(distance, tonnesTnt) / 0.33;
}

/**
 * Inondation — niveau de l'eau à un instant donné, en altitude absolue.
 *
 * L'eau monte depuis `bottom`, le point le plus bas de la ville, jusqu'à
 * `magnitude` mètres au-dessus, qu'elle atteint aux trois quarts de la durée.
 * Une seule fonction pour la simulation et pour l'effet visuel : la surface
 * affichée est exactement celle qui fait les dégâts.
 */
export function floodLevel(s: Scenario, t: number, bottom: number): number {
  const rise = s.duration * 0.72;
  return bottom + s.magnitude * Math.min(1, Math.max(t, 0) / rise);
}

/**
 * Convertit une hauteur d'eau en facteur de contrainte.
 *
 * Une crue agresse le bâtiment par le bas : affouillement des fondations,
 * poussée sur les murs, imbibition des maçonneries. Le dégât croît vite sur le
 * premier mètre — le rez-de-chaussée est perdu — puis beaucoup plus lentement.
 */
export function floodIntensity(depth: number): number {
  if (depth <= 0) return 0;
  return 0.42 * Math.sqrt(depth);
}
