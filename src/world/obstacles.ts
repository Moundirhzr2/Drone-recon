/**
 * Ce que le drone peut heurter, et où il peut se poser.
 *
 * En tout point, on cherche l'altitude du plus haut solide, d'après ce que le
 * simulateur dessine :
 *
 *  - un bâtiment debout — intact, fissuré, incendié — : son toit plat, à sa
 *    hauteur ; les cours intérieures restent ouvertes ;
 *  - une ruine : la surface de son tas de gravats et le haut de ses murs
 *    restés debout, sur les mêmes triangles que le rendu (`ruins.ts`,
 *    `facade.ts`) ;
 *  - les éclats de gravats projetés autour d'une ruine.
 *
 * Avec la ville photoréaliste, les bâtiments debout sont ceux du relevé de
 * Google, aux toits en pente : on compte alors jusqu'au faîte, pour que le
 * drone ne s'enfonce pas dans une toiture.
 *
 * Le drone n'est pas un point : on sonde son centre et quatre points autour,
 * au rayon de ses hélices. La physique interroge ce module deux fois par pas,
 * cent vingt pas par seconde : chaque bâtiment et chaque éclat est d'abord
 * écarté sur sa distance, avant tout calcul de forme.
 */

import { standingHeight, type Building } from './buildings';
import type { City } from './city';
import {
  brokenWallHeightAt,
  rubbleGrid,
  rubbleHeightAt,
  wallLayout,
  type RubbleGrid,
  type WallRing,
} from './facade';
import { REDRAWN } from './photoreal';
import { CHUNK_SINK, debrisChunks, heapOf, ruinWalls } from './ruins';

/** Sur quoi le drone bute ou se pose. */
export type SolidKind = 'toit' | 'gravats' | 'mur';

export interface Solid {
  /** Altitude du dessus, en mètres, comme `DroneState.msl`. */
  top: number;
  kind: SolidKind;
  building: Building;
}

const METERS_PER_DEG = 111320;
/** Côté d'une case de l'index, en mètres. */
const CELL = 25;
/** Les quatre points sondés autour du centre, au rayon du drone. */
const PROBES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Un bâtiment de l'index, avec ses rayons d'exclusion au carré. */
interface Entry {
  b: Building;
  /** Debout : le cercle qui contient son rectangle. */
  standing2: number;
  /** En ruine : le même, élargi aux éclats projetés autour. */
  ruin2: number;
}

/** Un éclat prêt à tester : rectangle tourné, dessus, et cercle d'exclusion. */
interface Chunk {
  east: number;
  north: number;
  hx: number;
  hy: number;
  cos: number;
  sin: number;
  top: number;
  r2: number;
}

/** Ce qu'une ruine garde en mémoire tant que son état ne change pas. */
interface RuinShape {
  /** L'état d'où elle a été tirée : `setDamage` refait la liste des débris. */
  state: Building['state'];
  damage: number;
  debris: Building['debris'];
  grid: RubbleGrid | null;
  walls: (ReturnType<typeof ruinWalls> & { layout: WallRing[] }) | null;
  chunks: Chunk[];
}

export class Obstacles {
  private cells = new Map<string, Entry[]>();
  private ruins = new Map<string, RuinShape>();
  private readonly mLon: number;

  /**
   * @param photoreal vrai quand le relevé de Google remplace les bâtiments
   *   debout dessinés.
   */
  constructor(
    private city: City,
    private photoreal: () => boolean = () => false,
  ) {
    this.mLon = METERS_PER_DEG * Math.cos((city.center.lat * Math.PI) / 180);
    for (const b of city.buildings) {
      const standing = Math.hypot(b.width, b.depth) / 2 + 0.5;
      // Les éclats d'une ruine sont projetés jusqu'aux trois quarts du plus
      // grand côté, plus la taille d'un éclat.
      const reach = standing + 0.75 * Math.max(b.width, b.depth) + 7;
      const entry = { b, standing2: standing * standing, ruin2: reach * reach };
      const [cx, cy] = this.local(b.lon, b.lat);
      for (let i = Math.floor((cx - reach) / CELL); i <= Math.floor((cx + reach) / CELL); i++) {
        for (let j = Math.floor((cy - reach) / CELL); j <= Math.floor((cy + reach) / CELL); j++) {
          const key = `${i}:${j}`;
          const list = this.cells.get(key);
          if (list) list.push(entry);
          else this.cells.set(key, [entry]);
        }
      }
    }
  }

  /**
   * Le plus haut solide sous un disque de rayon `radius` centré en (lon, lat),
   * ou `null` au-dessus du sol nu.
   */
  under(lon: number, lat: number, radius = 0): Solid | null {
    let best = this.at(lon, lat);
    if (radius > 0) {
      const dLon = radius / this.mLon;
      const dLat = radius / METERS_PER_DEG;
      for (const [kx, ky] of PROBES) {
        const s = this.at(lon + kx * dLon, lat + ky * dLat);
        if (s && (!best || s.top > best.top)) best = s;
      }
    }
    return best;
  }

  /** Le plus haut solide exactement en (lon, lat). */
  at(lon: number, lat: number): Solid | null {
    const [px, py] = this.local(lon, lat);
    const list = this.cells.get(`${Math.floor(px / CELL)}:${Math.floor(py / CELL)}`);
    if (!list) return null;
    let best: Solid | null = null;
    for (const entry of list) {
      const { b } = entry;
      const x = (lon - b.lon) * this.mLon;
      const y = (lat - b.lat) * METERS_PER_DEG;
      const d2 = x * x + y * y;
      const ruin = REDRAWN.has(b.state);
      if (d2 > (ruin ? entry.ruin2 : entry.standing2)) continue;
      const s = ruin ? this.ruinAt(b, x, y) : this.roofAt(b, x, y);
      if (s !== null && (!best || b.baseHeight + s.top > best.top)) {
        best = { top: b.baseHeight + s.top, kind: s.kind, building: b };
      }
    }
    return best;
  }

  /** Le toit d'un bâtiment debout en (x, y) mètres autour de son centre. */
  private roofAt(b: Building, x: number, y: number): { top: number; kind: SolidKind } | null {
    const inside = b.footprint
      ? inRings(b.footprint, x, y)
      : inBox(x, y, b.width / 2, b.depth / 2, b.heading);
    if (!inside) return null;
    const ridge = this.photoreal() ? (b.roofPitch ?? 0) / 2 : 0;
    return { top: b.height + ridge, kind: 'toit' };
  }

  /** Le dessus d'une ruine en (x, y) : tas, murs restés debout, éclats. */
  private ruinAt(b: Building, x: number, y: number): { top: number; kind: SolidKind } | null {
    const shape = this.shapeOf(b);
    let top = -Infinity;
    let kind: SolidKind = 'gravats';
    if (shape.grid) top = rubbleHeightAt(shape.grid, x, y) ?? -Infinity;
    if (shape.walls) {
      const { layout, thickness, heightAt } = shape.walls;
      const wall = brokenWallHeightAt(layout, thickness, heightAt, x, y);
      if (wall !== null && wall > top) {
        top = wall;
        kind = 'mur';
      }
    }
    if (!b.footprint && inBox(x, y, b.width / 2, b.depth / 2, b.heading)) {
      // Bâtiment généré : sa ruine est sa boîte écrêtée.
      top = standingHeight(b);
    }
    for (const c of shape.chunks) {
      if (c.top <= top) continue;
      const dx = x - c.east;
      const dy = y - c.north;
      if (dx * dx + dy * dy > c.r2) continue;
      if (Math.abs(dx * c.cos - dy * c.sin) > c.hx || Math.abs(dx * c.sin + dy * c.cos) > c.hy) {
        continue;
      }
      top = c.top;
      kind = 'gravats';
    }
    return top > 0 ? { top, kind } : null;
  }

  /** La forme d'une ruine, recalculée seulement quand son état change. */
  private shapeOf(b: Building): RuinShape {
    const known = this.ruins.get(b.id);
    if (known?.state === b.state && known.damage === b.damage && known.debris === b.debris) {
      return known;
    }
    let grid: RubbleGrid | null = null;
    let walls: RuinShape['walls'] = null;
    if (b.footprint) {
      const heap = heapOf(b);
      grid = rubbleGrid(b.footprint, heap.height, heap.spill, heap.seed);
      walls = { ...ruinWalls(b), layout: wallLayout(b.footprint) };
    }
    const chunks = debrisChunks(b).map((c): Chunk => {
      const h = (c.heading * Math.PI) / 180;
      // Le bloc est incliné : un de ses coins dépasse un peu plus.
      const tilt = Math.max(
        c.length * Math.abs(Math.sin(c.pitch)),
        c.width * Math.abs(Math.sin(c.roll)),
      );
      return {
        east: c.east,
        north: c.north,
        hx: c.length / 2,
        hy: c.width / 2,
        cos: Math.cos(h),
        sin: Math.sin(h),
        top: c.height * (CHUNK_SINK + 0.5) + tilt / 2,
        r2: (c.length * c.length + c.width * c.width) / 4,
      };
    });
    const shape = { state: b.state, damage: b.damage, debris: b.debris, grid, walls, chunks };
    this.ruins.set(b.id, shape);
    return shape;
  }

  private local(lon: number, lat: number): [number, number] {
    return [
      (lon - this.city.center.lon) * this.mLon,
      (lat - this.city.center.lat) * METERS_PER_DEG,
    ];
  }
}

/**
 * Le point (x, y) est-il dans le contour ? Règle de parité : une cour
 * intérieure, deuxième anneau, compte comme dehors. Sans distance à calculer,
 * c'est bien plus rapide que `signedDistance`.
 */
function inRings(rings: Array<Array<[number, number]>>, x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Le point (x, y) est-il dans un rectangle de demi-côtés (hx, hy) tourné de
 * `heading` degrés ? Même sens de rotation que les repères de Cesium.
 */
function inBox(x: number, y: number, hx: number, hy: number, heading: number): boolean {
  const h = (heading * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return Math.abs(x * c - y * s) <= hx && Math.abs(x * s + y * c) <= hy;
}
