/**
 * Moteur du simulateur : construction d'une chronologie, puis lecture.
 *
 * POURQUOI PRÉCALCULER PLUTÔT QUE SIMULER EN DIRECT
 * ------------------------------------------------
 * Toute la chronologie est calculée d'un coup, avant la première image, et
 * stockée comme une liste d'événements horodatés. Rien n'est décidé pendant la
 * lecture. Trois conséquences, et ce sont les trois choses qu'on veut :
 *
 *  1. REJOUABLE — même scénario, même graine, même sinistre au bâtiment près.
 *     Sans cela on ne peut rien comparer, et la partie diagnostic perd son sens.
 *  2. SCRUTABLE DANS LES DEUX SENS — on peut revenir en arrière, ce qu'une
 *     simulation incrémentale ne permet jamais sans tout rejouer.
 *  3. BILAN IMMÉDIAT — on connaît l'état final avant d'avoir joué une seconde,
 *     donc la comparaison avant/après est disponible tout de suite.
 *
 * Le coût est nul à notre échelle : quelques milliers d'opérations pour une
 * ville de 76 bâtiments.
 */

import { makeRandom } from '../core/math';
import { setDamage, type City } from '../world/city';
import { DAMAGE_ORDER, type Building, type DamageState } from '../world/buildings';
import {
  damagePath,
  dispersion,
  severityFromStress,
  stateFromStress,
  stressOf,
  THRESHOLDS,
} from '../world/fragility';
import {
  blastIntensity,
  floodIntensity,
  floodLevel,
  localOffset,
  seismicIntensity,
  type Scenario,
} from './scenario';

/** Un changement d'état, daté. */
export interface DamageEvent {
  /** Instant, en secondes depuis le début du sinistre. */
  t: number;
  id: string;
  state: DamageState;
  damage: number;
}

interface Snapshot {
  state: DamageState;
  damage: number;
}

export interface Timeline {
  scenario: Scenario;
  duration: number;
  events: DamageEvent[];
  /** État de la ville avant le sinistre, pour pouvoir revenir en arrière. */
  before: Map<string, Snapshot>;
  /** Répartition finale des états. */
  summary: Record<DamageState, number>;
  /** Nombre de bâtiments dont l'état a changé. */
  affected: number;
  /**
   * Bâtiments en feu : de l'embrasement (`from`) à la ruine calcinée (`to`).
   * Les événements ne datent que la fin ; les effets visuels ont besoin de
   * savoir aussi quand les flammes commencent.
   */
  fires: Array<{ id: string; from: number; to: number }>;
}

/** Résultat brut d'un aléa, avant expansion en événements. */
interface Impact {
  b: Building;
  /** État final visé. */
  state: DamageState;
  damage: number;
  /** Début et fin de l'aggravation, en secondes. */
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function buildTimeline(city: City, scenario: Scenario): Timeline {
  const rnd = makeRandom(scenario.seed + scenario.kind.length * 977);

  const before = new Map<string, Snapshot>();
  for (const b of city.buildings) before.set(b.id, { state: b.state, damage: b.damage });

  let impacts: Impact[];
  switch (scenario.kind) {
    case 'seisme':
      impacts = quake(city, scenario, rnd);
      break;
    case 'explosion':
      impacts = blast(city, scenario, rnd);
      break;
    case 'inondation':
      impacts = flood(city, scenario, rnd);
      break;
    case 'incendie':
      impacts = wildfire(city, scenario, rnd);
      break;
  }

  // --- Expansion en événements ---------------------------------------------
  const events: DamageEvent[] = [];
  for (const im of impacts) {
    const start = before.get(im.b.id)?.state ?? 'intact';
    const path = damagePath(start, im.state);
    if (path.length === 0) continue;

    const span = Math.max(im.to - im.from, 0.001);
    path.forEach((state, i) => {
      // Les étapes se répartissent sur l'intervalle, la dernière à la fin.
      const frac = path.length === 1 ? 1 : (i + 1) / path.length;
      events.push({
        t: im.from + span * frac,
        id: im.b.id,
        state,
        damage: im.damage * (0.5 + 0.5 * frac),
      });
    });
  }

  events.sort((a, b) => a.t - b.t);

  // --- Bilan ----------------------------------------------------------------
  const finalState = new Map<string, DamageState>();
  for (const [id, snap] of before) finalState.set(id, snap.state);
  for (const e of events) finalState.set(e.id, e.state);

  const summary = Object.fromEntries(DAMAGE_ORDER.map((s) => [s, 0])) as Record<
    DamageState,
    number
  >;
  let affected = 0;
  for (const [id, state] of finalState) {
    summary[state]++;
    if (state !== before.get(id)?.state) affected++;
  }

  const fires = impacts
    .filter((im) => im.state === 'burnt' && before.get(im.b.id)?.state !== 'burnt')
    .map((im) => ({ id: im.b.id, from: im.from, to: im.to }));

  return { scenario, duration: scenario.duration, events, before, summary, affected, fires };
}

// ---------------------------------------------------------------------------
// Les quatre aléas
// ---------------------------------------------------------------------------

/**
 * Séisme.
 *
 * La secousse forte occupe le premier tiers de la durée : c'est là que tout se
 * joue. Les quelques effondrements tardifs qui suivent sont ceux des bâtiments
 * déjà blessés qui cèdent après coup — un phénomène bien réel, et la raison
 * pour laquelle on n'entre pas dans un bâtiment fissuré juste après un séisme.
 */
function quake(city: City, s: Scenario, rnd: () => number): Impact[] {
  const out: Impact[] = [];
  const strong = s.duration * 0.34;

  for (const b of city.buildings) {
    const { east, north } = localOffset(b, city.center.lon, city.center.lat);
    const dist = Math.hypot(east - s.east, north - s.north);
    const intensity = seismicIntensity(dist, s.magnitude);
    if (intensity <= 0) continue;

    const stress = stressOf(intensity, b.vulnerability, rnd);
    // Un incendie après séisme part des réseaux de gaz : c'est minoritaire
    // mais systématique, et c'est ce qui a détruit San Francisco en 1906.
    const state = stateFromStress(stress, rnd, { fire: 0.14 });
    if (!state) continue;

    // Plus la contrainte est forte, plus la ruine est précoce.
    const urgency = Math.min(stress / THRESHOLDS.collapsed, 1.6);
    const from = 1.2 + rnd() * strong * (1.15 - urgency * 0.55);
    const late = state === 'collapsed' && rnd() < 0.22;

    out.push({
      b,
      state,
      damage: severityFromStress(stress),
      from,
      to: late ? from + 6 + rnd() * (s.duration * 0.4) : from + 1.5 + rnd() * 3.5,
    });
  }
  return out;
}

/**
 * Explosion.
 *
 * Tout se produit en moins de deux secondes : l'onde de choc parcourt 300 m en
 * une seconde. Les seuls délais réels sont les effondrements secondaires des
 * structures ébranlées, et les départs de feu.
 */
function blast(city: City, s: Scenario, rnd: () => number): Impact[] {
  const out: Impact[] = [];

  for (const b of city.buildings) {
    const { east, north } = localOffset(b, city.center.lon, city.center.lat);
    const dist = Math.hypot(east - s.east, north - s.north);
    const intensity = blastIntensity(dist, s.magnitude);
    if (intensity <= 0.05) continue;

    const stress = stressOf(intensity, b.vulnerability, rnd);
    const state = stateFromStress(stress, rnd, { fire: 0.3 });
    if (!state) continue;

    // L'onde met ~1 s pour 340 m ; on garde cette vitesse, elle se voit.
    const arrival = 0.4 + dist / 340;
    const secondary = state === 'collapsed' && rnd() < 0.3;

    out.push({
      b,
      state,
      damage: severityFromStress(stress),
      from: arrival,
      to: secondary ? arrival + 3 + rnd() * 9 : arrival + 0.6,
    });
  }
  return out;
}

/**
 * Inondation — modèle « de la baignoire » sur le relief réel.
 *
 * La surface de l'eau est PLANE : c'est ce qui distingue une crue de tous les
 * autres aléas. Elle monte depuis le point le plus bas de la zone, et chaque
 * bâtiment se retrouve sous une hauteur d'eau égale à la différence entre ce
 * niveau et l'altitude de son pied, mesurée par l'IGN. Deux bâtiments voisins
 * peuvent donc avoir des sorts opposés : l'un est dans un creux, l'autre sur
 * un léger relief.
 *
 * C'est le modèle des cartes réglementaires de zones inondables dans leur forme
 * la plus simple. Sa limite est connue : il ignore la connectivité — un creux
 * isolé se remplit comme s'il était relié à la rivière — et la dynamique de
 * l'écoulement. Il reste le bon ordre de grandeur pour une crue lente de
 * plaine, comme celles de l'Ill.
 *
 * C'est aussi le seul aléa où le temps fait partie de la physique : la même
 * crue, plus lente, produit les mêmes dégâts, simplement plus tard.
 *
 * Plafond à l'effondrement partiel : une crue noie un rez-de-chaussée, ruine
 * des planchers et affouille des fondations, mais n'aplatit pas un immeuble.
 * Seul le bâti très vulnérable en eau profonde peut aller jusqu'à la ruine.
 */
function flood(city: City, s: Scenario, rnd: () => number): Impact[] {
  const out: Impact[] = [];
  const bottom = floodBottom(city);
  const steps = 60;

  for (const b of city.buildings) {
    // Dispersion tirée UNE fois : le bâtiment doit s'aggraver de façon
    // monotone pendant que l'eau monte, pas osciller.
    const disp = dispersion(rnd);
    const fragile = b.vulnerability > 0.7;

    let reached: DamageState | null = null;
    let reachedAt = 0;
    let reachedStress = 0;

    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * s.duration;
      const depth = floodLevel(s, t, bottom) - b.baseHeight;
      if (depth <= 0) continue;

      const stress = floodIntensity(depth) * b.vulnerability * disp;
      const state = stateFromStress(stress, rnd, {
        cap: fragile && depth > 2.5 ? 'collapsed' : 'partial',
      });
      if (!state) continue;

      if (!reached || DAMAGE_ORDER.indexOf(state) > DAMAGE_ORDER.indexOf(reached)) {
        reached = state;
        reachedAt = reachedAt || t;
        reachedStress = stress;
      }
    }

    if (!reached) continue;
    out.push({
      b,
      state: reached,
      damage: severityFromStress(reachedStress),
      from: reachedAt,
      to: Math.min(s.duration, reachedAt + 8),
    });
  }
  return out;
}

/**
 * Altitude du point le plus bas de la ville, d'où l'eau commence à monter.
 * Exportée pour que l'effet visuel de la crue parte exactement du même niveau
 * que la simulation.
 */
export function floodBottom(city: City): number {
  let bottom = Infinity;
  for (const b of city.buildings) if (b.baseHeight < bottom) bottom = b.baseHeight;
  return Number.isFinite(bottom) ? bottom : city.ground;
}

/**
 * Incendie — propagation de proche en proche.
 *
 * Le seul aléa sans champ d'intensité : ce qui brûle dépend de ce qui a déjà
 * brûlé. La forme de la zone sinistrée n'est donc pas un disque mais une
 * langue étirée dans le sens du vent, et elle s'arrête net sur une rue large.
 *
 * Trois facteurs décident d'une propagation :
 *   - la DISTANCE entre façades (et non entre centres : deux immeubles longs
 *     mitoyens se touchent même si leurs centres sont à 40 m) ;
 *   - le VENT, qui couche les flammes et projette les brandons ;
 *   - la COMBUSTIBILITÉ, où le bâti ancien à charpente bois l'emporte de loin
 *     sur une structure béton récente.
 *
 * Calage mesuré sur les 2 282 bâtiments réels, moyenne sur cinq graines, part
 * du bâti détruit :
 *
 *     vigueur 0,5 ......  1 %   le feu s'éteint sur place
 *     vigueur 1,2 ...... 12 %   un grand incendie de quartier
 *     vigueur 2,0 ...... 48 %   l'embrasement général
 *
 * L'écart entre ces trois valeurs n'est pas un défaut de réglage, c'est un
 * seuil de percolation, propre à tout feu urbain : dans une vieille ville aux
 * bâtiments mitoyens, en dessous d'une certaine vigueur le feu meurt, au-dessus
 * il trouve toujours un voisin à allumer. Londres en 1666 en reste l'exemple.
 */
function wildfire(city: City, s: Scenario, rnd: () => number): Impact[] {
  const STEP = 2; // pas de propagation, en secondes
  const REACH = 52; // portée maximale entre façades, en mètres
  // Taux de propagation, calé sur la ville réelle (voir l'en-tête).
  const SPREAD = 0.035;

  // Direction VERS laquelle le vent pousse (windFrom est la provenance).
  const blow = ((s.windFrom + 180) * Math.PI) / 180;
  const blowE = Math.sin(blow);
  const blowN = Math.cos(blow);

  const cells = city.buildings.map((b) => {
    const { east, north } = localOffset(b, city.center.lon, city.center.lat);
    return {
      b,
      east,
      north,
      // Demi-emprise MOYENNE, pas la demi-diagonale : celle-ci surestime la
      // taille d'un rectangle allongé au point que tous les écarts entre
      // façades tombaient à zéro, et que le feu sautait partout d'un coup.
      radius: (b.width + b.depth) / 4,
      // Le bois et les planchers anciens brûlent ; le béton nu beaucoup moins.
      fuel: Math.min(1, b.vulnerability * (b.kind === 'industriel' ? 1.25 : 1)),
      ignitedAt: -1,
    };
  });

  // Foyer initial : le bâtiment le plus proche du point de départ.
  let seed = cells[0];
  let best = Infinity;
  for (const c of cells) {
    const d = Math.hypot(c.east - s.east, c.north - s.north);
    if (d < best) {
      best = d;
      seed = c;
    }
  }
  seed.ignitedAt = 0;

  // Voisins précalculés une fois pour toutes, grâce à une grille. Comparer
  // chaque bâtiment à tous les autres à chaque pas coûtait 1,2 s sur les
  // 2 282 bâtiments de la ville réelle ; chacun n'a en fait qu'une poignée de
  // voisins à portée.
  const GRID = 60;
  const grid = new Map<string, number[]>();
  const keyOf = (e: number, n: number) => `${Math.floor(e / GRID)}:${Math.floor(n / GRID)}`;
  cells.forEach((c, i) => {
    const k = keyOf(c.east, c.north);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  // Chaque paire n'est cherchée que depuis le PLUS GRAND des deux bâtiments,
  // avec une portée qui couvre son rayon plus celui de ses voisins courants :
  // un grand bâtiment trouve tous ses voisins, et un petit n'a pas à chercher
  // aussi loin que le plus grand bâtiment de la ville. On range ensuite la paire
  // dans les deux sens.
  const radii = cells.map((c) => c.radius).sort((a, b) => a - b);
  const r95 = radii[Math.floor(radii.length * 0.95)] ?? 0;
  const neighbours: Array<Array<{ j: number; gap: number; ux: number; uy: number }>> = cells.map(
    () => [],
  );
  const paired = new Set<number>();
  cells.forEach((a, i) => {
    const reach = Math.ceil((REACH + a.radius + Math.max(a.radius, r95)) / GRID);
    const cx = Math.floor(a.east / GRID);
    const cy = Math.floor(a.north / GRID);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (j === i) continue;
          const key = i < j ? i * cells.length + j : j * cells.length + i;
          if (paired.has(key)) continue;
          const b = cells[j];
          const len = Math.hypot(b.east - a.east, b.north - a.north) || 1;
          const gap = Math.max(1, len - a.radius - b.radius);
          if (gap > REACH) continue;
          paired.add(key);
          const ux = (b.east - a.east) / len;
          const uy = (b.north - a.north) / len;
          neighbours[i].push({ j, gap, ux, uy });
          neighbours[j].push({ j: i, gap, ux: -ux, uy: -uy });
        }
      }
    }
  });

  // Le plancher est ce que reçoit un voisin situé À CONTRE-VENT, par
  // rayonnement seul. Il croît avec la vigueur : un brasier chauffe ses voisins
  // dans toutes les directions, un feu mou ne part que sous le vent. Sans cette
  // dépendance, le feu se réduit toujours à la même langue quelle que soit la
  // vigueur, et le réglage ne sert à rien.
  const floor = 0.22 + 0.16 * s.magnitude;

  for (let t = STEP; t <= s.duration; t += STEP) {
    // On fige la liste des foyers du pas courant : sans cela un bâtiment
    // allumé à ce pas propagerait déjà, et le feu traverserait la ville
    // en une seule itération.
    const sources: number[] = [];
    cells.forEach((c, i) => {
      if (c.ignitedAt >= 0 && t - c.ignitedAt <= 34) sources.push(i);
    });

    for (const i of sources) {
      for (const { j, gap, ux, uy } of neighbours[i]) {
        const dst = cells[j];
        if (dst.ignitedAt >= 0) continue;
        const align = ux * blowE + uy * blowN;
        const wind = floor + 1.2 * Math.max(0, align);
        const p = SPREAD * s.magnitude * Math.exp(-gap / 16) * wind * dst.fuel;
        if (rnd() < p * (STEP / 2)) dst.ignitedAt = t;
      }
    }
  }

  const out: Impact[] = [];
  for (const c of cells) {
    if (c.ignitedAt < 0) continue;
    // Un bâtiment met d'autant plus longtemps à être consumé qu'il est grand.
    const burn = 16 + c.b.height * 0.55 + rnd() * 10;
    out.push({
      b: c.b,
      state: 'burnt',
      damage: 0.75 + rnd() * 0.25,
      from: c.ignitedAt,
      to: c.ignitedAt + burn,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Lecteur de chronologie.
 *
 * Il ne détient aucune physique : il applique ou retire des événements déjà
 * calculés. Sa seule subtilité est de signaler quand la GÉOMÉTRIE doit être
 * reconstruite — un effondrement change la hauteur du bâtiment et fait
 * apparaître des gravats, ce qu'un simple changement de couleur ne suffit pas
 * à montrer. Reconstruire coûte ~30 ms, donc on ne le fait que si nécessaire.
 */
export class DisasterPlayer {
  private timeline: Timeline | null = null;
  private cursor = 0;
  /** Nombre d'événements déjà appliqués. */
  private applied = 0;
  private rnd = makeRandom(4242);

  playing = false;
  /** Multiplicateur de vitesse de lecture. */
  speed = 1;
  /**
   * Événements appliqués par le dernier déplacement vers l'avant, et l'écart
   * de temps qu'il a couvert. Les effets ponctuels (poussière d'un
   * effondrement) s'en servent ; un saut de plusieurs secondes — « Après » —
   * ne doit pas déclencher des centaines de nuages à la fois.
   */
  recent: DamageEvent[] = [];
  recentSpan = 0;

  constructor(private city: City) {}

  get current(): Timeline | null {
    return this.timeline;
  }

  get time(): number {
    return this.cursor;
  }

  get finished(): boolean {
    return this.timeline !== null && this.cursor >= this.timeline.duration;
  }

  /** Charge une chronologie et remet la ville dans son état d'avant. */
  load(timeline: Timeline): void {
    this.restore();
    this.timeline = timeline;
    this.cursor = 0;
    this.applied = 0;
    this.playing = false;
  }

  /** Décharge tout et rend la ville à son état d'origine. */
  clear(): boolean {
    if (!this.timeline) return false;
    this.restore();
    this.timeline = null;
    this.cursor = 0;
    this.applied = 0;
    this.playing = false;
    return true;
  }

  /**
   * Avance la lecture.
   * @returns vrai si la géométrie doit être reconstruite.
   */
  update(dt: number): boolean {
    // Ce qui était « récent » à l'image précédente ne l'est plus : sans cette
    // remise à zéro, une pause laisserait croire aux effets que les mêmes
    // bâtiments s'effondrent à chaque image.
    this.recent = [];
    this.recentSpan = 0;
    if (!this.timeline || !this.playing) return false;
    const end = this.timeline.duration;
    if (this.cursor >= end) {
      this.playing = false;
      return false;
    }
    return this.seek(Math.min(end, this.cursor + dt * this.speed));
  }

  /**
   * Place la lecture à un instant donné, en avant comme en arrière.
   * @returns vrai si la géométrie doit être reconstruite.
   */
  seek(t: number): boolean {
    const tl = this.timeline;
    if (!tl) return false;

    const target = Math.max(0, Math.min(t, tl.duration));
    this.recent = [];
    this.recentSpan = target - this.cursor;
    // Reculer impose de repartir de l'état initial : les événements ne sont
    // pas réversibles un par un (un bâtiment effondré ne se souvient pas de sa
    // fissure précédente). Rejouer depuis zéro reste instantané.
    if (target < this.cursor) {
      this.restore();
      this.applied = 0;
    }
    this.cursor = target;

    const start = this.applied;
    while (this.applied < tl.events.length && tl.events[this.applied].t <= target) {
      const e = tl.events[this.applied];
      const b = this.city.buildings.find((x) => x.id === e.id);
      if (b) setDamage(b, e.state, e.damage, this.rnd);
      if (this.recentSpan > 0) this.recent.push(e);
      this.applied++;
    }
    return this.applied !== start;
  }

  /** Saute directement à la fin : la vue « après ». */
  jumpToEnd(): boolean {
    return this.timeline ? this.seek(this.timeline.duration) : false;
  }

  /** Revient à l'instant zéro : la vue « avant ». */
  jumpToStart(): boolean {
    return this.seek(0);
  }

  /** Remet chaque bâtiment dans l'état mémorisé avant le sinistre. */
  private restore(): void {
    const before = this.timeline?.before;
    if (!before) return;
    for (const b of this.city.buildings) {
      const snap = before.get(b.id);
      if (snap) setDamage(b, snap.state, snap.damage, this.rnd);
    }
  }
}
