/**
 * Rendu du bâti.
 *
 * CHOIX DE PERFORMANCE
 * --------------------
 * Les bâtiments sont regroupés dans des primitives Cesium plutôt que dans des
 * entités. Une entité est un objet réévalué à chaque image ; une instance de
 * géométrie dans un `Primitive` est un bloc envoyé une fois au GPU. On garde
 * malgré tout la possibilité de recolorer un bâtiment isolé, via ses attributs
 * d'instance.
 *
 * DÉCOUPAGE EN CARREAUX
 * ---------------------
 * Un effondrement change la géométrie — hauteur écrêtée, gravats — et la seule
 * façon de le montrer est de reconstruire la primitive qui contient le
 * bâtiment. Avec la ville générée (76 bâtiments), tout reconstruire coûtait
 * 20 ms. Avec les 2 282 bâtiments réels, ce serait plusieurs centaines de
 * millisecondes à chaque dégât.
 *
 * La ville est donc découpée en carreaux de 100 m, chacun avec ses propres
 * primitives. Un dégât ne reconstruit que le carreau touché, et les
 * reconstructions en attente sont étalées sur plusieurs images (`tick`) : une
 * explosion qui touche vingt carreaux se voit se propager en quelques dixièmes
 * de seconde au lieu de figer l'écran.
 */

import * as Cesium from 'cesium';
import { DAMAGE_INFO, standingHeight, type Building, type BuildingKind } from './buildings';
import type { City } from './city';
import { NEIGHBOR_MARGIN, REDRAWN } from './photoreal';
import {
  brokenWalls,
  createFacadeAppearance,
  exposedWall,
  FACADE_KIND,
  footprintOutline,
  footprintRoof,
  footprintWalls,
  ROOF_CODE,
  rubbleHeap,
  SURFACE,
  texturedBox,
  type FacadeVariant,
  type RoofVariant,
  type RubbleMaterial,
} from './facade';

/** Modes de rendu, cyclés par la touche M. */
export type RenderMode = 'realiste' | 'wireframe' | 'scan';

export const RENDER_LABEL: Record<RenderMode, string> = {
  realiste: 'RÉALISTE',
  wireframe: 'FIL DE FER',
  scan: 'SCAN',
};

const DEG = Math.PI / 180;

/** Côté d'un carreau, en mètres. */
const CHUNK = 100;

/**
 * Temps accordé par image à la construction des ruines, en millisecondes. Une
 * ruine coûte deux à trois millisecondes, puis autant à son premier rendu, où
 * Cesium assemble sa géométrie : une ou deux par image. Une explosion qui en
 * fait deux cents se propage ainsi en trois ou quatre secondes au lieu de
 * figer l'écran, et la vague se lit d'ailleurs mieux.
 */
const RUIN_BUDGET_MS = 3;

/**
 * Enduits de façade, par époque.
 *
 * La vieille ville de Mulhouse est un nuancier : ocres, roses, crèmes et
 * jaunes paille, souvent rehaussés de grès. Les immeubles d'après-guerre sont
 * plus sages, les récents franchement gris. Les teintes restent un peu sourdes :
 * l'éclairage de Cesium éclaircit d'environ moitié une façade tournée vers la
 * caméra.
 */
const PLASTERS: Record<0 | 1 | 2, string[]> = {
  0: ['#cdb58a', '#c7a57e', '#cba99a', '#c4917b', '#d4c9b1', '#bfb4a1', '#cdbf8b', '#b8a58b'],
  1: ['#c3beb2', '#bbb2a1', '#cbc5b6', '#aea79b', '#c4b89f', '#b7bab6'],
  2: ['#c5c5c1', '#b4b8ba', '#a7abad', '#cfccc5', '#9c9fa1', '#bdb9af'],
};

/** Matériaux propres à certains usages, quelle que soit l'époque. */
const SPECIAL_WALLS: Partial<Record<BuildingKind, string[]>> = {
  industriel: ['#9a816d', '#858a8e', '#a08c78'],
  // Le grès rose des Vosges : c'est celui du temple Saint-Étienne et de la
  // plupart des édifices anciens de la région.
  religieux: ['#b98a7a', '#a87c6e'],
  annexe: ['#a8a094', '#978f84', '#b2a898'],
  sportif: ['#b9bcbd', '#a9adaf'],
};

/**
 * Couvertures, par matériau. Les tuiles de terre cuite dominent la vieille
 * ville ; ardoises et zinc coiffent les immeubles bourgeois ; les terrasses
 * gravillonnées, les immeubles récents.
 */
const ROOF_TINTS_BY_CODE: Record<number, string[]> = {
  [ROOF_CODE.tuiles]: ['#8e503b', '#7f4636', '#98593f', '#744132', '#88513e', '#9c624a'],
  [ROOF_CODE.ardoises]: ['#51575e', '#5a6067', '#4b5057'],
  [ROOF_CODE.metal]: ['#8b9297', '#7f878d', '#979da1'],
  [ROOF_CODE.beton]: ['#8f8b83', '#86827b', '#98948c', '#7e7a73'],
  [ROOF_CODE.verre]: ['#3d4751'],
};

/**
 * Couverture d'un bâtiment : son matériau déclaré par l'IGN, et sa forme — en
 * pente si le faîte dépasse la gouttière d'au moins un mètre. Quand le matériau
 * manque (deux bâtiments sur trois), on le déduit : une terrasse est en béton,
 * un grand volume industriel en bac acier, et un toit en pente est en tuiles,
 * sauf un sur sept, en ardoises.
 */
function roofOf(b: Building, seed: number): RoofVariant {
  const pitched = (b.roofPitch ?? (eraOf(b.year) < 2 ? 3 : 0)) >= 1;
  let code: number;
  switch (b.roofMaterial) {
    case 'tuiles':
      code = ROOF_CODE.tuiles;
      break;
    case 'ardoises':
      code = ROOF_CODE.ardoises;
      break;
    case 'metal':
      code = ROOF_CODE.metal;
      break;
    case 'beton':
      code = ROOF_CODE.beton;
      break;
    case 'verre':
      code = ROOF_CODE.verre;
      break;
    default:
      if (!pitched) code = ROOF_CODE.beton;
      else if (b.kind === 'industriel' || b.kind === 'sportif') code = ROOF_CODE.metal;
      else code = seed < 0.15 ? ROOF_CODE.ardoises : ROOF_CODE.tuiles;
  }
  return [code + (pitched ? 10 : 0), seed];
}

/** Époque de construction, lue par le shader de façade. */
function eraOf(year: number): 0 | 1 | 2 {
  return year < 1914 ? 0 : year < 1975 ? 1 : 2;
}

/** Nombre entre 0 et 1, stable pour un identifiant donné. */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 10007) / 10007;
}

/**
 * Style de façade : époque, usage, graine, commerces au rez-de-chaussée. Un
 * immeuble d'habitation ancien ou d'après-guerre d'au moins trois niveaux a
 * une chance sur deux d'avoir des boutiques en pied : c'est la règle, plus que
 * l'exception, dans le centre de Mulhouse.
 */
function facadeVariant(b: Building): FacadeVariant {
  const era = eraOf(b.year);
  const seed = hash01(b.id);
  const shop =
    b.kind === 'commerce' || (b.kind === 'residentiel' && era < 2 && b.height >= 9 && seed < 0.5)
      ? 1
      : 0;
  return [era, FACADE_KIND[b.kind], seed, shop];
}

function wallTint(b: Building): string {
  return hashPick(b.id, SPECIAL_WALLS[b.kind] ?? PLASTERS[eraOf(b.year)]);
}

const ROOF_TINTS = ['#7a4a3c', '#6b5a52', '#5c5f63', '#8a5443', '#4f5358', '#7c5140'];
const RUBBLE = '#6b6459';
/** Maçonnerie noircie ; le shader y ajoute les baies vides et la suie. */
const BURNT = '#5b534b';

function css(hex: string, alpha = 1): Cesium.Color {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

function hashPick(id: string, arr: string[]): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** Repère local est-nord-haut en un point, avec une rotation éventuelle. */
function localFrame(lon: number, lat: number, height: number, headingDeg = 0): Cesium.Matrix4 {
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  if (!headingDeg) return frame;
  const rot = Cesium.Matrix3.fromRotationZ(-headingDeg * DEG);
  return Cesium.Matrix4.multiplyByMatrix3(frame, rot, new Cesium.Matrix4());
}

/** Un morceau dessinable d'un bâtiment. */
interface Part {
  id: string;
  solid: Cesium.GeometryInstance;
  /** Arêtes pour les vues techniques ; absentes pour les gravats. */
  edge?: Cesium.GeometryInstance;
  base: Cesium.Color;
}

/**
 * Signature géométrique d'un bâtiment : si elle change, son carreau doit être
 * reconstruit. La couleur n'en fait pas partie, elle se change à chaud.
 */
function signature(b: Building): string {
  return `${b.state}|${Math.round(b.damage * 20)}|${b.debris.length}`;
}

/** Bruit lisse en une dimension, entre 0 et 1 : pour déchiqueter le haut des murs. */
function noise1(x: number, salt: string): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash01(`${salt}:${i}`) * (1 - u) + hash01(`${salt}:${i + 1}`) * u;
}

/**
 * Carré de la distance d'un point à un segment. Le carré, pour une seule
 * racine au bout d'une recherche : `Math.hypot`, à chaque segment, pesait
 * lourd.
 */
function segmentDistance2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x: number,
  y: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  const ex = x - ax - t * dx;
  const ey = y - ay - t * dy;
  return ex * ex + ey * ey;
}

/** Distance d'un point au contour d'un anneau, en mètres. */
function ringDistance(ring: Array<[number, number]>, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, segmentDistance2(ring[i][0], ring[i][1], ring[j][0], ring[j][1], x, y));
  }
  return Math.sqrt(best);
}

/**
 * Côtés d'un anneau qui passent à moins de `reach` mètres d'un rectangle
 * (x0, y0, x1, y1), sommets à plat : ax, ay, bx, by…
 */
function sidesNear(
  ring: Array<[number, number]>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  reach: number,
): number[] {
  const sides: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (Math.max(xi, xj) < x0 - reach || Math.min(xi, xj) > x1 + reach) continue;
    if (Math.max(yi, yj) < y0 - reach || Math.min(yi, yj) > y1 + reach) continue;
    sides.push(xi, yi, xj, yj);
  }
  return sides;
}

/** Distance d'un point au plus proche de ces côtés, en mètres. */
function sidesDistance(sides: number[], x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k < sides.length; k += 4) {
    best = Math.min(
      best,
      segmentDistance2(sides[k], sides[k + 1], sides[k + 2], sides[k + 3], x, y),
    );
  }
  return Math.sqrt(best);
}

/** Côté des cases de l'index des voisins, en mètres. */
const NEIGHBOR_CELL = 25;

interface Chunk {
  key: string;
  buildings: Building[];
  /**
   * Le bâti debout : chaque bâtiment tel qu'avant tout sinistre, construit une
   * fois pour toutes. Un bâtiment en ruine y est seulement masqué, un bâtiment
   * incendié recoloré : pendant un sinistre, rien ici n'est reconstruit.
   * Reconstruire tout le carreau à chaque ruine coûtait jusqu'à 200 ms, le
   * temps que Cesium réassemble ses soixante-dix bâtiments.
   */
  solid: Cesium.Primitive | null;
  edges: Cesium.Primitive | null;
  /** Morceaux debout de chaque bâtiment. */
  parts: Map<string, string[]>;
  base: Map<string, Cesium.Color>;
  /** État de chaque bâtiment à son dernier coloriage. */
  states: Map<string, string>;
  center: Cesium.Cartesian3;
  repaint: boolean;
}

/**
 * Une ruine : sa propre primitive, construite une fois. Rassembler les ruines
 * d'un carreau obligeait à toutes les régénérer et les réassembler à chaque
 * nouvelle ruine : pendant une explosion, cent reconstructions de carreau et
 * 2,3 s de calcul pour quatre secondes de sinistre.
 */
interface Ruin {
  /** Signature du bâtiment, voisins compris, à la construction. */
  signature: string;
  solid: Cesium.Primitive | null;
  edges: Cesium.Primitive | null;
  parts: string[];
  base: Map<string, Cesium.Color>;
}

export class BuildingRenderer {
  private chunks = new Map<string, Chunk>();
  private chunkOf = new Map<string, Chunk>();
  /** Les ruines construites, et les bâtiments dont la ruine est à (re)faire. */
  private ruins = new Map<string, Ruin>();
  private ruinQueue = new Set<Building>();
  private byId = new Map<string, Building>();
  private mode: RenderMode = 'realiste';
  private diagnostic = false;
  /** Ville photoréaliste : en vue réaliste, Google montre les bâtiments debout. */
  private photoreal = false;
  /** Les ruines sont à recolorer (changement de vue). */
  private ruinRepaint = false;
  /** Densité du brouillard hors vue scan, fixée par le profil de qualité. */
  private fogBeforeScan: number | null = null;
  private appearance = createFacadeAppearance();
  private edgeAppearance = new Cesium.PerInstanceColorAppearance({
    flat: true,
    translucent: false,
  });
  /**
   * Contours des bâtiments dans le repère du centre-ville, et leur index par
   * cases : de quoi trouver les voisins mitoyens d'une ruine.
   */
  private cityRings = new Map<string, Array<[number, number]>>();
  private offsets = new Map<string, [number, number]>();
  private cells = new Map<string, Building[]>();
  private neighborCache = new Map<string, Building[]>();
  private ridges = new Map<
    string,
    { cx: number; cy: number; ux: number; uy: number; half: number }
  >();

  constructor(
    private scene: Cesium.Scene,
    city: City,
  ) {
    const mLon = 111320 * Math.cos((city.center.lat * Math.PI) / 180);
    for (const b of city.buildings) {
      const east = (b.lon - city.center.lon) * mLon;
      const north = (b.lat - city.center.lat) * 111320;
      this.offsets.set(b.id, [east, north]);
      if (b.footprint) {
        const ring = b.footprint[0].map(([x, y]) => [east + x, north + y] as [number, number]);
        this.cityRings.set(b.id, ring);
        const xs = ring.map((p) => p[0]);
        const ys = ring.map((p) => p[1]);
        for (
          let cx = Math.floor(Math.min(...xs) / NEIGHBOR_CELL);
          cx <= Math.floor(Math.max(...xs) / NEIGHBOR_CELL);
          cx++
        ) {
          for (
            let cy = Math.floor(Math.min(...ys) / NEIGHBOR_CELL);
            cy <= Math.floor(Math.max(...ys) / NEIGHBOR_CELL);
            cy++
          ) {
            const key = `${cx}:${cy}`;
            const list = this.cells.get(key);
            if (list) list.push(b);
            else this.cells.set(key, [b]);
          }
        }
      }
      const key = `${Math.floor(east / CHUNK)}:${Math.floor(north / CHUNK)}`;
      let chunk = this.chunks.get(key);
      if (!chunk) {
        const [cx, cy] = key.split(':').map(Number);
        chunk = {
          key,
          buildings: [],
          solid: null,
          edges: null,
          parts: new Map(),
          base: new Map(),
          states: new Map(),
          center: Cesium.Cartesian3.fromDegrees(
            city.center.lon + ((cx + 0.5) * CHUNK) / mLon,
            city.center.lat + ((cy + 0.5) * CHUNK) / 111320,
            b.baseHeight,
          ),
          repaint: false,
        };
        this.chunks.set(key, chunk);
      }
      chunk.buildings.push(b);
      this.chunkOf.set(b.id, chunk);
      this.byId.set(b.id, b);
    }
  }

  /** Nombre de carreaux, et combien de ruines attendent d'être construites. */
  get stats(): { chunks: number; pending: number } {
    return { chunks: this.chunks.size, pending: this.ruinQueue.size };
  }

  /**
   * Construit toute la ville d'un coup. Réservé au démarrage : ensuite, les
   * changements passent par `sync` et sont étalés par `tick`.
   */
  build(): void {
    for (const chunk of this.chunks.values()) this.buildStanding(chunk);
    this.sync();
    for (const b of this.ruinQueue) this.buildRuin(b);
    this.ruinQueue.clear();
  }

  /**
   * Repère les ruines à construire, à refaire ou à retirer, et les carreaux
   * dont un bâtiment a changé d'état, à recolorer. À appeler quand le
   * simulateur de désastres a modifié des états.
   */
  sync(): void {
    for (const chunk of this.chunks.values()) {
      for (const b of chunk.buildings) {
        if (chunk.states.get(b.id) !== b.state) chunk.repaint = true;
        const ruin = this.ruins.get(b.id);
        if (REDRAWN.has(b.state)) {
          if (!ruin || ruin.signature !== this.signatureOf(b)) this.ruinQueue.add(b);
        } else if (ruin) {
          this.dropRuin(b.id);
          this.ruinQueue.delete(b);
        }
      }
    }
  }

  /**
   * À appeler une fois par image, après le rendu : construit les ruines en
   * attente, les plus proches de la caméra d'abord, dans la limite du budget,
   * et applique les couleurs en attente.
   */
  tick(): void {
    if (this.ruinQueue.size) {
      const eye = this.scene.camera.positionWC;
      const at = (b: Building) =>
        Cesium.Cartesian3.distanceSquared(Cesium.Cartesian3.fromDegrees(b.lon, b.lat), eye);
      const queue = [...this.ruinQueue].sort((a, b) => at(a) - at(b));
      const start = performance.now();
      for (const b of queue) {
        this.ruinQueue.delete(b);
        this.buildRuin(b);
        if (performance.now() - start > RUIN_BUDGET_MS) break;
      }
    }

    const realistic = this.mode === 'realiste';
    for (const chunk of this.chunks.values()) {
      if (!chunk.repaint) continue;
      const standing = realistic ? chunk.solid : chunk.edges;
      if (standing && !standing.ready) continue;
      for (const b of chunk.buildings) {
        for (const pid of chunk.parts.get(b.id) ?? []) this.paint(standing, chunk.base, pid, b);
        chunk.states.set(b.id, b.state);
      }
      chunk.repaint = false;
    }
    if (this.ruinRepaint) {
      let done = true;
      for (const [id, ruin] of this.ruins) {
        const prim = realistic ? ruin.solid : ruin.edges;
        if (prim && !prim.ready) {
          done = false;
          continue;
        }
        const b = this.byId.get(id)!;
        for (const pid of ruin.parts) this.paint(prim, ruin.base, pid, b);
      }
      this.ruinRepaint = !done;
    }
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      for (const p of [chunk.solid, chunk.edges]) if (p) this.scene.primitives.remove(p);
    }
    for (const id of [...this.ruins.keys()]) this.dropRuin(id);
  }

  setRenderMode(mode: RenderMode): void {
    this.mode = mode;
    const globe = this.scene.globe;
    const sky = this.scene.skyAtmosphere;
    const scan = mode === 'scan';

    // Relevé technique : plus d'imagerie, un sol neutre, du volume en moins.
    for (let i = 0; i < this.scene.imageryLayers.length; i++) {
      this.scene.imageryLayers.get(i).show = !scan;
    }
    if (sky) sky.show = !scan;
    globe.baseColor = Cesium.Color.fromCssColorString(scan ? '#04080c' : '#1b2a1f');
    // Brouillard plus dense en scan, puis celui du profil de qualité au retour.
    const fog = this.scene.fog;
    if (scan && this.fogBeforeScan === null) {
      this.fogBeforeScan = fog.density;
      fog.density = 0.0004;
    } else if (!scan && this.fogBeforeScan !== null) {
      fog.density = this.fogBeforeScan;
      this.fogBeforeScan = null;
    }

    this.applyShows();
  }

  getRenderMode(): RenderMode {
    return this.mode;
  }

  setDiagnostic(on: boolean): void {
    this.diagnostic = on;
    this.applyShows();
  }

  /**
   * Ville photoréaliste : en vue réaliste, Google montre le bâti debout, et
   * l'on ne dessine plus que les ruines (voir `photoreal.ts`). Les vues
   * techniques réaffichent la ville dessinée sans rien reconstruire.
   */
  setPhotoreal(on: boolean): void {
    this.photoreal = on;
    this.applyShows();
  }

  /** Visibilité de chaque primitive selon la vue, puis coloriage. */
  private applyShows(): void {
    const realistic = this.mode === 'realiste';
    const standing = realistic && (!this.photoreal || this.diagnostic);
    for (const chunk of this.chunks.values()) {
      if (chunk.solid) chunk.solid.show = standing;
      if (chunk.edges) chunk.edges.show = !realistic;
      chunk.repaint = true;
    }
    for (const ruin of this.ruins.values()) {
      if (ruin.solid) ruin.solid.show = realistic;
      if (ruin.edges) ruin.edges.show = !realistic;
    }
    this.ruinRepaint = true;
  }

  /**
   * Ce morceau est-il dessiné ? Le bâti debout d'un bâtiment en ruine s'efface
   * devant sa ruine. Les murs mitoyens ne servent qu'à fermer les voisins de
   * la ville photoréaliste : dans la ville dessinée, chaque voisin a déjà ses
   * propres murs, qu'ils doubleraient.
   */
  private shows(b: Building, pid: string): boolean {
    if (pid.includes(':mitoyen')) {
      return this.photoreal && this.mode === 'realiste' && !this.diagnostic;
    }
    return pid.includes(':ruine') || !REDRAWN.has(b.state);
  }

  /** Signature d'un bâtiment ; pour une ruine, l'état de ses voisins en fait partie. */
  private signatureOf(b: Building): string {
    const own = signature(b);
    if (!REDRAWN.has(b.state)) return own;
    // Seul compte, pour les murs mitoyens, qu'un voisin soit debout ou en
    // ruine. Tenir compte de tout changement d'état — intact, puis fissuré —
    // reconstruisait les ruines presque deux fois chacune pendant un sinistre.
    return `${own}|${this.neighborsOf(b)
      .map((n) => (REDRAWN.has(n.state) ? 'r' : 'd'))
      .join('')}`;
  }

  /**
   * Faîtage supposé d'un bâtiment : parallèle à son plus grand côté — la
   * ligne d'égout, le plus souvent —, passant par son centre, à `half` mètres
   * de ses bords les plus éloignés. Dans le repère du centre-ville.
   */
  private ridgeOf(b: Building): { cx: number; cy: number; ux: number; uy: number; half: number } {
    const cached = this.ridges.get(b.id);
    if (cached) return cached;
    const ring = this.cityRings.get(b.id)!;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of ring) {
      cx += x / ring.length;
      cy += y / ring.length;
    }
    let ux = 1;
    let uy = 0;
    let longest = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len > longest) {
        longest = len;
        ux = (x1 - x0) / len;
        uy = (y1 - y0) / len;
      }
    }
    let half = 1;
    for (const [x, y] of ring) half = Math.max(half, Math.abs((x - cx) * -uy + (y - cy) * ux));
    const ridge = { cx, cy, ux, uy, half };
    this.ridges.set(b.id, ridge);
    return ridge;
  }

  /** Bâtiments dont le contour touche celui de `b`, à 80 cm près. */
  private neighborsOf(b: Building): Building[] {
    const cached = this.neighborCache.get(b.id);
    if (cached) return cached;
    const ring = this.cityRings.get(b.id);
    const found: Building[] = [];
    if (ring) {
      const seen = new Set<string>([b.id]);
      const xs = ring.map((p) => p[0]);
      const ys = ring.map((p) => p[1]);
      for (
        let cx = Math.floor((Math.min(...xs) - 1) / NEIGHBOR_CELL);
        cx <= Math.floor((Math.max(...xs) + 1) / NEIGHBOR_CELL);
        cx++
      ) {
        for (
          let cy = Math.floor((Math.min(...ys) - 1) / NEIGHBOR_CELL);
          cy <= Math.floor((Math.max(...ys) + 1) / NEIGHBOR_CELL);
          cy++
        ) {
          for (const n of this.cells.get(`${cx}:${cy}`) ?? []) {
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            const other = this.cityRings.get(n.id)!;
            const near =
              ring.some(([x, y]) => ringDistance(other, x, y) < 0.8) ||
              other.some(([x, y]) => ringDistance(ring, x, y) < 0.8);
            if (near) found.push(n);
          }
        }
      }
    }
    this.neighborCache.set(b.id, found);
    return found;
  }

  // ------------------------------------------------------------------------
  // Construction d'un carreau
  // ------------------------------------------------------------------------

  /** Primitive au rendu synchrone : le carreau n'a jamais d'image vide. */
  private primitive(
    instances: Cesium.GeometryInstance[],
    appearance: Cesium.Appearance,
  ): Cesium.Primitive | null {
    if (!instances.length) return null;
    // Cesium ne sait assembler hors du fil principal que ses propres types de
    // géométrie, pas une géométrie déjà construite comme celles-ci.
    const primitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance,
      asynchronous: false,
      releaseGeometryInstances: false,
      // Les ombres portées ne coûtent que si le profil de rendu les active.
      shadows: Cesium.ShadowMode.ENABLED,
    });
    this.scene.primitives.add(primitive);
    return primitive;
  }

  /** Le bâti debout d'un carreau, une fois pour toutes (voir `Chunk`). */
  private buildStanding(chunk: Chunk): void {
    const solids: Cesium.GeometryInstance[] = [];
    const edges: Cesium.GeometryInstance[] = [];
    for (const b of chunk.buildings) {
      const ids: string[] = [];
      for (const part of this.standingParts(b)) {
        ids.push(part.id);
        chunk.base.set(part.id, part.base);
        solids.push(part.solid);
        if (part.edge) edges.push(part.edge);
      }
      chunk.parts.set(b.id, ids);
      chunk.states.set(b.id, b.state);
    }
    chunk.solid = this.primitive(solids, this.appearance);
    chunk.edges = this.primitive(edges, this.edgeAppearance);
    const realistic = this.mode === 'realiste';
    if (chunk.solid) chunk.solid.show = realistic && (!this.photoreal || this.diagnostic);
    if (chunk.edges) chunk.edges.show = !realistic;
  }

  /**
   * La ruine d'un bâtiment. L'ancienne, s'il y en avait une, reste affichée
   * jusqu'ici : la nouvelle est construite au rendu suivant, de manière
   * synchrone, donc sans image vide entre les deux.
   */
  private buildRuin(b: Building): void {
    this.dropRuin(b.id);
    const parts = this.ruinPartsOf(b);
    const base = new Map<string, Cesium.Color>();
    for (const part of parts) base.set(part.id, part.base);
    const solid = this.primitive(
      parts.map((p) => p.solid),
      this.appearance,
    );
    const edges = this.primitive(
      parts.flatMap((p) => (p.edge ? [p.edge] : [])),
      this.edgeAppearance,
    );
    const realistic = this.mode === 'realiste';
    if (solid) solid.show = realistic;
    if (edges) edges.show = !realistic;
    this.ruins.set(b.id, {
      signature: this.signatureOf(b),
      solid,
      edges,
      parts: parts.map((p) => p.id),
      base,
    });
    // Son bâti debout est à masquer.
    const chunk = this.chunkOf.get(b.id);
    if (chunk) chunk.repaint = true;
  }

  private dropRuin(id: string): void {
    const ruin = this.ruins.get(id);
    if (!ruin) return;
    for (const p of [ruin.solid, ruin.edges]) if (p) this.scene.primitives.remove(p);
    this.ruins.delete(id);
  }

  /**
   * Un bâtiment tel qu'avant tout sinistre : ses murs et sa toiture. Son état
   * n'y entre pas : un bâtiment incendié est recoloré à chaud (`colorFor`), un
   * bâtiment en ruine masqué au profit de sa ruine (`ruinPartsOf`).
   */
  private standingParts(b: Building): Part[] {
    const parts: Part[] = [];
    const h = b.height;
    const wall = wallTint(b);
    const roofVariant = roofOf(b, hash01(b.id + 'r'));
    const roofTints = b.footprint ? ROOF_TINTS_BY_CODE[roofVariant[0] % 10] : ROOF_TINTS;
    const roof = hashPick(b.id + 'r', roofTints);

    if (b.footprint) {
      // Bâtiment réel : son contour exact, posé sur son altitude IGN, et sa
      // couverture réelle.
      const frame = localFrame(b.lon, b.lat, b.baseHeight);
      parts.push(
        this.part(
          `${b.id}:body`,
          b,
          footprintWalls(b.footprint, h, SURFACE.facade, facadeVariant(b)),
          frame,
          wall,
          () => footprintOutline(b.footprint!, h),
        ),
        this.part(
          `${b.id}:roof`,
          b,
          footprintRoof(b.footprint, h, SURFACE.roofReal, roofVariant),
          frame,
          roof,
        ),
      );
    } else {
      // Bâtiment généré : une boîte, et une toiture légèrement débordante qui
      // donne l'échelle vue du ciel.
      const dims = new Cesium.Cartesian3(b.width, b.depth, h);
      parts.push(
        this.part(
          `${b.id}:body`,
          b,
          texturedBox(dims, SURFACE.facade, (b.width + b.depth) / 2, h, facadeVariant(b)),
          localFrame(b.lon, b.lat, b.baseHeight + h / 2, b.heading),
          wall,
          () =>
            Cesium.BoxOutlineGeometry.createGeometry(
              Cesium.BoxOutlineGeometry.fromDimensions({ dimensions: dims }),
            )!,
        ),
      );
      const roofDims = new Cesium.Cartesian3(b.width + 1.4, b.depth + 1.4, 1.1);
      parts.push(
        this.part(
          `${b.id}:roof`,
          b,
          texturedBox(roofDims, SURFACE.roof, b.depth + 1.4, 1.1),
          localFrame(b.lon, b.lat, b.baseHeight + h + 0.55, b.heading),
          roof,
        ),
      );
    }
    return parts;
  }

  /** Une ruine : ce qui reste du bâtiment, et ses gravats projetés au sol. */
  private ruinPartsOf(b: Building): Part[] {
    const parts: Part[] = [];
    const h = standingHeight(b);
    const roofVariant = roofOf(b, hash01(b.id + 'r'));

    if (b.footprint) {
      parts.push(...this.ruinParts(b, h, roofVariant));
    } else {
      // Bâtiment généré : sa boîte écrêtée, sans trame de fenêtres.
      const dims = new Cesium.Cartesian3(b.width, b.depth, h);
      parts.push(
        this.part(
          `${b.id}:ruine:tas`,
          b,
          texturedBox(dims, SURFACE.rubble, (b.width + b.depth) / 2, h),
          localFrame(b.lon, b.lat, b.baseHeight + h / 2, b.heading),
          RUBBLE,
          () =>
            Cesium.BoxOutlineGeometry.createGeometry(
              Cesium.BoxOutlineGeometry.fromDimensions({ dimensions: dims }),
            )!,
        ),
      );
    }

    // Gravats projetés au sol : chaque débris du simulateur devient un éclat
    // plus petit que lui, incliné au hasard et à moitié enfoncé. Des blocs
    // droits et entiers de plusieurs mètres faisaient des caisses posées là.
    const mLon = 111320 * Math.cos(b.lat * DEG);
    const chunk: FacadeVariant = [roofVariant[0], 0.45, hash01(b.id + 'g'), 0];
    b.debris.forEach((d, i) => {
      const r1 = hash01(`${b.id}:${i}:a`);
      const r2 = hash01(`${b.id}:${i}:b`);
      const r3 = hash01(`${b.id}:${i}:c`);
      const size = d.size * (0.35 + 0.3 * r1);
      const height = Math.min(size * 0.7, 0.4 + d.height * 0.35 * r2);
      const east = d.dx + (r2 - 0.5) * d.size;
      const north = d.dy + (r3 - 0.5) * d.size;
      const frame = Cesium.Transforms.headingPitchRollToFixedFrame(
        Cesium.Cartesian3.fromDegrees(
          b.lon + east / mLon,
          b.lat + north / 111320,
          b.baseHeight + height * 0.2,
        ),
        new Cesium.HeadingPitchRoll(d.rot * DEG, (r1 - 0.5) * 0.7, (r3 - 0.5) * 0.7),
      );
      parts.push(
        this.part(
          `${b.id}:ruine:gravats${i}`,
          b,
          texturedBox(
            new Cesium.Cartesian3(size, size * (0.5 + 0.4 * r3), height),
            SURFACE.rubble,
            size,
            height,
            chunk,
          ),
          frame,
          RUBBLE,
        ),
      );
    });

    return parts;
  }

  /**
   * Un bâtiment réel en ruine. Effondré : un tas de gravats qui déborde sur la
   * rue, et quelques angles encore debout, les points les plus solides d'une
   * maçonnerie. Éventré : ses murs, au sommet déchiqueté et percé de brèches,
   * autour d'un tas plus bas. Dans les deux cas, les murs mitoyens des voisins
   * restés debout.
   */
  private ruinParts(b: Building, h: number, roofVariant: RoofVariant): Part[] {
    const rings = b.footprint!;
    const frame = localFrame(b.lon, b.lat, b.baseHeight);
    const material: RubbleMaterial = { roof: roofVariant[0], seed: hash01(b.id + 'g') };
    const parts: Part[] = [];
    const outline = () => footprintOutline(rings, h);

    let walls: ReturnType<typeof brokenWalls>;
    if (b.state === 'collapsed') {
      parts.push(
        this.part(
          `${b.id}:ruine:tas`,
          b,
          rubbleHeap(rings, h, 2.6, material),
          frame,
          RUBBLE,
          outline,
        ),
      );
      // Des pans d'angle en marches : pleine hauteur contre l'angle, un palier
      // plus bas, puis plus rien.
      walls = brokenWalls(rings, 0.4, b.height, facadeVariant(b), material, (s, corner, index) => {
        const r = hash01(`${b.id}:angle${index}`);
        if (r > 0.45) return 0;
        const reach = 1.8 + 3 * hash01(`${b.id}:long${index}`);
        if (corner >= reach) return 0;
        const tall = Math.min(b.height * 0.7, h + 1.5 + 6 * r);
        const step = corner < reach * 0.55 ? 1 : 0.5;
        return tall * step + 0.25 * (noise1(s * 1.7, b.id) - 0.5);
      });
    } else {
      // Une maçonnerie casse par paliers, le long de ses rangs : des tronçons
      // de 2 à 6 m, chacun à sa hauteur, quelques brèches profondes, et des
      // angles qui tiennent mieux que le reste. Un bruit fin, de quelques
      // décimètres seulement, rend la cassure irrégulière sans la hérisser.
      const LEVELS = [0.35, 0.62, 0.8, 0.92, 1];
      walls = brokenWalls(rings, 0.35, b.height, facadeVariant(b), material, (s, corner) => {
        const piece = Math.floor(s / 4 + 0.6 * noise1(s / 9, `${b.id}:troncon`));
        const level = LEVELS[Math.floor(hash01(`${b.id}:palier${piece}`) * LEVELS.length)];
        const solid = corner < 1.2 ? 1 : level;
        return h * solid + 0.3 * (noise1(s * 1.7, `${b.id}:cassure`) - 0.5);
      });
      parts.push(
        this.part(`${b.id}:ruine:tas`, b, rubbleHeap(rings, h * 0.3, 0.8, material), frame, RUBBLE),
      );
    }
    if (walls.outer) {
      const edges = b.state === 'partial' ? outline : undefined;
      parts.push(this.part(`${b.id}:ruine:murs`, b, walls.outer, frame, wallTint(b), edges));
    }
    if (walls.inner) parts.push(this.part(`${b.id}:ruine:dedans`, b, walls.inner, frame, RUBBLE));

    for (const [k, wall] of this.partyWalls(b, material).entries()) {
      parts.push(this.part(`${b.id}:ruine:mitoyen${k}`, b, wall, frame, RUBBLE));
    }
    return parts;
  }

  /**
   * Murs mitoyens mis à nu. Dans la ville photoréaliste, un voisin resté debout
   * n'est qu'une peau, ouverte du côté de la ruine : sans ce mur, on verrait à
   * travers. On le dresse le long des côtés que la ruine partage avec lui,
   * jusqu'à sa hauteur — en pignon quand son toit est en pente, le faîtage
   * courant le plus souvent le long de la rue.
   */
  private partyWalls(b: Building, material: RubbleMaterial): Cesium.Geometry[] {
    const standing = this.neighborsOf(b).filter((n) => n.footprint && !REDRAWN.has(n.state));
    if (!standing.length) return [];
    const ring = b.footprint![0];
    const [ox, oy] = this.offsets.get(b.id)!;
    const walls: Cesium.Geometry[] = [];

    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1) continue;
      const samples = Math.max(2, Math.round(L / 0.5));
      let start = 0;
      let owner: Building | null = null;
      const close = (end: number) => {
        if (!owner || ((end - start) * L) / samples < 1) return;
        const t0 = start / samples;
        const t1 = end / samples;
        const nb = owner;
        // Le voisin entier, quel que soit son état : c'est le relevé qui le
        // montre, pas notre version endommagée (voir `roofTop`, dans
        // `photoreal.ts`).
        const pitch = nb.roofPitch ?? 0;
        const eave = nb.height - pitch / 2;
        const top = nb.height + pitch / 2;
        const ridge = this.ridgeOf(nb);
        // Devant tout ce qui reste du voisin : au-delà de la marge qui lui est
        // laissée, de 60 cm encore. Posé sur sa façade réelle, le mur plat se
        // mêlait aux triangles irréguliers du relevé, qui le traversaient en
        // dents de scie claires et sombres.
        const inset = NEIGHBOR_MARGIN + 0.6;
        const ix = (-(by - ay) / L) * inset;
        const iy = ((bx - ax) / L) * inset;
        const a: [number, number] = [ax + (bx - ax) * t0 + ix, ay + (by - ay) * t0 + iy];
        const e: [number, number] = [ax + (bx - ax) * t1 + ix, ay + (by - ay) * t1 + iy];
        walls.push(
          exposedWall(
            a,
            e,
            (t) => {
              // Hauteur de son toit à cet endroit : pleine au faîtage, à la
              // gouttière sur ses bords. 50 cm au-dessus, comme les murs
              // coupe-feu de la vieille ville : plus bas, on verrait
              // par-dessus l'intérieur vide du relevé.
              const x = ox + a[0] + (e[0] - a[0]) * t;
              const y = oy + a[1] + (e[1] - a[1]) * t;
              const d = Math.abs((x - ridge.cx) * -ridge.uy + (y - ridge.cy) * ridge.ux);
              const k = pitch > 0.5 ? Math.max(0, 1 - d / ridge.half) : 1;
              return eave + (top - eave) * k + 0.5;
            },
            { roof: material.roof, seed: hash01(nb.id + 'm') },
          ),
        );
      };
      // Les seuls côtés des voisins qui passent près de celui-ci : mesurée à
      // tous les côtés de tous les voisins, la distance de chaque échantillon
      // coûtait jusqu'à 100 ms à une ruine voisine d'un grand bâtiment au
      // contour détaillé, en une seule image.
      const near = standing
        .map((n) => ({
          n,
          sides: sidesNear(
            this.cityRings.get(n.id)!,
            ox + Math.min(ax, bx),
            oy + Math.min(ay, by),
            ox + Math.max(ax, bx),
            oy + Math.max(ay, by),
            0.7,
          ),
        }))
        .filter((m) => m.sides.length);
      if (!near.length) continue;
      for (let k = 0; k < samples; k++) {
        const t = (k + 0.5) / samples;
        const x = ox + ax + (bx - ax) * t;
        const y = oy + ay + (by - ay) * t;
        let best: Building | null = null;
        for (const { n, sides } of near) {
          if (sidesDistance(sides, x, y) < 0.7 && (!best || n.height > best.height)) best = n;
        }
        if (best !== owner) {
          close(k);
          start = k;
          owner = best;
        }
      }
      close(samples);
    }
    return walls;
  }

  private part(
    id: string,
    b: Building,
    geometry: Cesium.Geometry,
    modelMatrix: Cesium.Matrix4,
    hex: string,
    outline?: () => Cesium.Geometry,
  ): Part {
    const base = css(hex);
    return {
      id,
      base,
      solid: new Cesium.GeometryInstance({
        id,
        geometry,
        modelMatrix,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            this.colorFor(b, base, 'solid', id),
          ),
          show: new Cesium.ShowGeometryInstanceAttribute(this.shows(b, id)),
        },
      }),
      edge: outline
        ? new Cesium.GeometryInstance({
            id,
            geometry: outline(),
            modelMatrix,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                this.colorFor(b, base, 'edge', id),
              ),
              show: new Cesium.ShowGeometryInstanceAttribute(this.shows(b, id)),
            },
          })
        : undefined,
    };
  }

  // ------------------------------------------------------------------------
  // Couleurs
  // ------------------------------------------------------------------------

  /**
   * Couleur finale d'un morceau.
   *
   * En vue brute on montre la ville telle qu'elle est : le sinistre se lit dans
   * la GÉOMÉTRIE (hauteur écrêtée, gravats), pas dans un code couleur. En vue
   * diagnostique on bascule sur la classification. C'est toute la différence
   * entre constater et interpréter.
   *
   * Le canal ALPHA porte les interrupteurs du shader de façades : ils sont les
   * seuls encore modifiables à chaud, `surf` étant figé dans la géométrie. À 1,
   * la texture ; vers 0,96, les pans de façade d'une ruine, sans vitres et
   * couverts de poussière ; vers 0,85, des façades calcinées ; sous 0,75,
   * l'aplat du diagnostic. Le rendu étant opaque, cet alpha n'a aucun autre
   * effet.
   */
  private colorFor(
    b: Building,
    base: Cesium.Color,
    target: 'solid' | 'edge',
    pid: string,
  ): Cesium.Color {
    // En diagnostic, les bâtiments INTACTS restent neutres. Les peindre en vert
    // vif noierait les quelques cibles qui comptent sous des centaines
    // d'aplats : une vue de diagnostic doit faire ressortir l'anomalie.
    const classified =
      b.state === 'intact'
        ? css(target === 'solid' ? '#6f7a80' : '#2f4a52')
        : css(DAMAGE_INFO[b.state].color);

    // Un bâtiment incendié garde la géométrie du bâtiment debout : seules sa
    // teinte et, par l'alpha, ses façades changent.
    const roofPart = pid.endsWith(':roof');
    const burnt = b.state === 'burnt' && !pid.includes(':ruine');
    const tint = burnt ? css(roofPart ? '#1c1916' : BURNT) : base;

    const flat = this.diagnostic || this.mode === 'scan';
    if (target === 'edge') {
      return flat ? classified : this.mode === 'wireframe' ? css('#00e5ff') : tint;
    }
    const ruinWall = pid.includes(':ruine:murs');
    const alpha = flat ? 0.5 : burnt && !roofPart ? 0.85 : ruinWall ? 0.96 : 1;
    return (flat ? classified : tint).withAlpha(alpha);
  }

  private paint(
    prim: Cesium.Primitive | null,
    bases: Map<string, Cesium.Color>,
    pid: string,
    b: Building,
  ): void {
    if (!prim) return;
    const base = bases.get(pid) ?? Cesium.Color.GRAY;
    try {
      const attrs = prim.getGeometryInstanceAttributes(pid);
      if (!attrs) return;
      attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(
        this.colorFor(b, base, this.mode === 'realiste' ? 'solid' : 'edge', pid),
        attrs.color,
      );
      attrs.show = Cesium.ShowGeometryInstanceAttribute.toValue(this.shows(b, pid), attrs.show);
    } catch {
      // Un morceau sans arêtes (toit, gravats) n'existe pas dans le primitive
      // d'arêtes.
    }
  }
}
