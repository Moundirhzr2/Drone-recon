/**
 * Courbe de fragilité.
 *
 * C'est la pièce centrale du simulateur, et elle vient directement du génie
 * parasismique. L'idée : un bâtiment ne s'effondre pas « parce que le séisme
 * était fort », mais parce que l'INTENSITÉ SUBIE a croisé sa VULNÉRABILITÉ
 * PROPRE. Une église de 1890 en maçonnerie non chaînée tombe là où un immeuble
 * de bureaux de 2005 se fissure à peine, sous exactement la même secousse.
 *
 * On ramène donc les deux à un seul nombre :
 *
 *     contrainte = intensité × vulnérabilité × dispersion
 *
 * puis on lit l'état dans un jeu de seuils. La dispersion est indispensable :
 * sans elle, deux bâtiments identiques à la même distance subiraient toujours
 * le même sort, et la ville sinistrée aurait des frontières géométriques
 * parfaitement nettes — ce qui ne ressemble à aucun sinistre réel.
 *
 * Ce module vit dans `world/` et non dans `disaster/` à dessein : il décrit
 * comment un bâtiment ENCAISSE, ce qui est une propriété du bâti, pas de
 * l'aléa. Il est partagé par la génération initiale de la ville et par le
 * simulateur, de sorte qu'un même bâtiment réagisse de la même façon quelle
 * que soit l'origine du dommage — et qu'il n'existe qu'UNE courbe dans tout
 * le projet, impossible à faire diverger par inadvertance.
 */

import { DAMAGE_ORDER, type DamageState } from './buildings';

/**
 * Seuils de contrainte. Calibrés pour qu'une vulnérabilité moyenne (~0,55)
 * commence à casser vers une intensité de 0,6 et s'effondre vers 1,1.
 */
export const THRESHOLDS = {
  cracked: 0.18,
  partial: 0.34,
  collapsed: 0.52,
} as const;

/**
 * Tirage de dispersion, autour de 1.
 *
 * ±28 % : assez pour brouiller les frontières de la zone sinistrée, pas assez
 * pour qu'un bâtiment neuf tombe à côté d'une ruine restée debout.
 *
 * Il est exposé séparément parce que certains aléas doivent le tirer UNE FOIS
 * par bâtiment puis le réutiliser. Une inondation, par exemple, réévalue le
 * même bâtiment à chaque pas pendant que l'eau monte : retirer la dispersion à
 * chaque fois le ferait osciller entre deux états au lieu de s'aggraver.
 */
export function dispersion(rnd: () => number): number {
  return 0.72 + rnd() * 0.56;
}

/** Contrainte subie par un bâtiment, dispersion comprise. */
export function stressOf(intensity: number, vulnerability: number, rnd: () => number): number {
  return intensity * vulnerability * dispersion(rnd);
}

export interface OutcomeOptions {
  /** Probabilité qu'un dommage grave se manifeste par le feu, entre 0 et 1. */
  fire?: number;
  /** État le plus grave atteignable — une crue n'aplatit pas un immeuble. */
  cap?: DamageState;
}

/** Rang d'un état dans l'échelle de gravité. */
function rank(state: DamageState): number {
  return DAMAGE_ORDER.indexOf(state);
}

/** Limite un état à la gravité maximale autorisée par le scénario. */
function capped(state: DamageState, cap: DamageState | undefined): DamageState {
  if (!cap) return state;
  // `burnt` est hors échelle : il partage la gravité de `collapsed` sans être
  // un degré d'écrasement. On ne le rabaisse que si le plafond l'exclut.
  if (state === 'burnt') return rank(cap) >= rank('collapsed') ? state : cap;
  return rank(state) > rank(cap) ? cap : state;
}

/**
 * État résultant d'une contrainte. `null` si le bâtiment tient bon.
 */
export function stateFromStress(
  stress: number,
  rnd: () => number,
  opts: OutcomeOptions = {},
): DamageState | null {
  const fire = opts.fire ?? 0;

  if (stress > THRESHOLDS.collapsed) {
    return capped(fire > 0 && rnd() < fire ? 'burnt' : 'collapsed', opts.cap);
  }
  if (stress > THRESHOLDS.partial) {
    return capped(fire > 0 && rnd() < fire * 0.8 ? 'burnt' : 'partial', opts.cap);
  }
  if (stress > THRESHOLDS.cracked) {
    return capped('cracked', opts.cap);
  }
  return null;
}

/**
 * Sévérité continue associée à une contrainte, entre 0 et 1.
 * Elle nourrit la quantité de débris et la hauteur restante.
 */
export function severityFromStress(stress: number): number {
  return Math.min(stress / 0.6, 1);
}

/**
 * Chemin d'aggravation d'un bâtiment, de son état actuel à son état final.
 *
 * Un bâtiment ne passe pas d'intact à effondré d'un coup : pendant une
 * secousse il se fissure, puis s'écroule partiellement, puis cède. Restituer
 * ces étapes est ce qui rend la chronologie lisible — sans elles le désastre
 * se résumerait à une image avant et une image après.
 */
export function damagePath(from: DamageState, to: DamageState): DamageState[] {
  // Le feu n'a pas d'étape intermédiaire d'écrasement : on brûle ou non.
  if (to === 'burnt') return from === 'burnt' ? [] : ['burnt'];
  const a = rank(from);
  const b = rank(to);
  if (b <= a) return [];
  return DAMAGE_ORDER.slice(a + 1, b + 1).filter((s) => s !== 'burnt');
}
