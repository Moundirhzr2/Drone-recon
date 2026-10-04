/**
 * Dégâts posés à la main : on choisit des bâtiments, on leur donne un état.
 *
 * Ils prennent la forme d'événements ajoutés à la chronologie du sinistre,
 * APRÈS ceux de l'aléa : ils ont le dernier mot sur un bâtiment que l'aléa
 * avait aussi touché. Tout le reste en découle sans code de plus : l'avant /
 * après (B / N), la lecture, le curseur de temps, la poussière des
 * effondrements, les flammes, le bilan, et la sauvegarde du scénario.
 *
 * Sans aléa, la chronologie ne contient que ces dégâts, échelonnés sur deux
 * secondes : on les voit se produire, l'un après l'autre.
 */

import { makeRandom } from '../core/math';
import { DAMAGE_ORDER, type DamageState } from '../world/buildings';
import type { City } from '../world/city';
import { THRESHOLDS } from '../world/fragility';
import type { DamageEvent, Timeline } from './timeline';

/** Dégâts posés à la main : identifiant du bâtiment -> état voulu. */
export type ManualEdits = Map<string, DamageState>;

/**
 * Sévérité donnée à un état posé à la main : le milieu de sa plage sur la
 * courbe de fragilité, pour qu'il se dessine comme un dégât typique.
 */
const SEVERITY: Record<DamageState, number> = {
  intact: 0,
  cracked: (THRESHOLDS.cracked + THRESHOLDS.partial) / 2,
  partial: (THRESHOLDS.partial + THRESHOLDS.collapsed) / 2,
  collapsed: 0.8,
  burnt: 0.85,
};

/**
 * Délai avant le premier dégât posé à la main, en secondes. Sans lui, un dégât
 * daté de l'instant zéro ferait partie de la vue « avant ».
 */
const LEAD = 0.25;
/** Durée sur laquelle les dégâts posés à la main s'échelonnent, en secondes. */
const SPREAD = 2;
/** Temps laissé après le dernier, pour que la poussière retombe. */
const TAIL = 1.5;

/**
 * Ajoute les dégâts posés à la main à une chronologie, ou en fait une seule
 * s'il n'y a pas d'aléa.
 * @returns `base` tel quel sans dégâts à la main ; `null` s'il n'y a rien.
 */
export function withManualEdits(
  city: City,
  base: Timeline | null,
  edits: ManualEdits,
): Timeline | null {
  if (edits.size === 0) return base;

  const before =
    base?.before ??
    new Map(city.buildings.map((b) => [b.id, { state: b.state, damage: b.damage }]));
  const start = base?.duration ?? 0;
  const ids = [...edits.keys()];
  // Ordre de passage tiré une fois pour toutes : le même scénario rejoue la
  // même séquence.
  const rnd = makeRandom(ids.length * 7919 + 17);
  const order = ids.map((id) => ({ id, key: rnd() })).sort((a, b) => a.key - b.key);

  const manual: DamageEvent[] = order.map(({ id }, i) => ({
    t: start + LEAD + (order.length > 1 ? (i / (order.length - 1)) * SPREAD : 0),
    id,
    state: edits.get(id)!,
    damage: SEVERITY[edits.get(id)!],
  }));
  const end = start + LEAD + (order.length > 1 ? SPREAD : 0) + TAIL;

  // Un bâtiment incendié à la main brûle : ses flammes partent à l'instant de
  // son événement, et les effets les entretiennent un moment.
  const fires = [
    ...(base?.fires ?? []).filter((f) => !edits.has(f.id) || edits.get(f.id) === 'burnt'),
    ...manual.filter((e) => e.state === 'burnt').map((e) => ({ id: e.id, from: e.t, to: e.t })),
  ];

  const events = [...(base?.events ?? []), ...manual];

  // Bilan : l'état final de chaque bâtiment, comparé à celui d'avant.
  const final = new Map<string, DamageState>();
  for (const e of events) final.set(e.id, e.state);
  const summary = Object.fromEntries(DAMAGE_ORDER.map((s) => [s, 0])) as Record<
    DamageState,
    number
  >;
  let affected = 0;
  for (const b of city.buildings) {
    const state = final.get(b.id) ?? before.get(b.id)?.state ?? b.state;
    summary[state]++;
    if (state !== (before.get(b.id)?.state ?? 'intact')) affected++;
  }

  return {
    scenario: base?.scenario ?? null,
    duration: Math.max(base?.duration ?? 0, end),
    events,
    before,
    summary,
    affected,
    fires,
  };
}
