/**
 * Ville réelle : les bâtiments de la BD TOPO® de l'IGN.
 *
 * Le fichier `public/data/mulhouse-centre.json` est produit par
 * `scripts/fetch-buildings.mjs`. Il contient les attributs bruts de l'IGN ; tout
 * ce qui relève de l'interprétation se fait ici, et chaque choix est justifié.
 *
 * TROIS INTERPRÉTATIONS À CONNAÎTRE
 * ---------------------------------
 * 1. HAUTEUR. L'IGN publie la hauteur à la gouttière et, séparément, l'altitude
 *    du faîte. Nos toits sont plats : on les place à mi-chemin entre gouttière et
 *    faîte, ce qui conserve à peu près le volume d'un toit à deux pans.
 *
 * 2. ANNÉE. Elle n'est connue que pour moins de la moitié des bâtiments. Pour
 *    les autres, on prend la médiane des années connues du voisinage : les
 *    bâtiments d'un même îlot ont presque toujours été construits à la même
 *    époque. Le champ `yearKnown` garde la trace de cette déduction.
 *
 * 3. CORRECTIONS. Une seule hauteur est corrigée à la main, celle de la tour de
 *    l'Europe (voir `LANDMARKS`). C'est la seule erreur flagrante relevée dans
 *    la zone, et elle concerne le repère le plus visible de la ville.
 */

import { CONFIG } from '../core/config';
import { makeRandom } from '../core/math';
import {
  computeVulnerability,
  type Building,
  type BuildingKind,
  type WallMaterial,
} from './buildings';
import { seedInitialDamage, type City, type DamageFocus } from './city';
import type { Relief } from './terrain';

/** Bâtiment tel qu'écrit par `scripts/fetch-buildings.mjs`. */
interface RawBuilding {
  id: string;
  eaves: number | null;
  ridge: number | null;
  floors: number | null;
  use: string | null;
  year: number | null;
  walls: string | null;
  ground: number | null;
  light: boolean;
  rings: Array<Array<[number, number]>>;
}

interface RawFile {
  zone: { lat: number; lon: number; halfSize: number };
  attribution: string;
  buildings: RawBuilding[];
}

const METERS_PER_DEG = 111320;

/**
 * Repères identifiés à la main.
 *
 * La BD TOPO® attribue 53 m à la tour de l'Europe. Elle culmine en réalité vers
 * 100 m (112 m antenne comprise) : c'est la seule erreur flagrante de la zone,
 * et elle touche le bâtiment le plus reconnaissable de Mulhouse. Le temple
 * Saint-Étienne, lui, garde sa hauteur IGN : sa flèche de 97 m est trop fine pour
 * qu'on l'obtienne en extrudant l'emprise de tout l'édifice.
 */
const LANDMARKS: Array<{
  name: string;
  lat: number;
  lon: number;
  /** Rayon de recherche autour du point, en mètres. */
  radius: number;
  /** Ne retenir que les bâtiments d'au moins cette hauteur de rendu, en mètres. */
  minHeight?: number;
  use?: string;
  height?: number;
}> = [
  { name: "Tour de l'Europe", lat: 47.74962, lon: 7.33527, radius: 25, minHeight: 45, height: 100 },
  { name: 'Temple Saint-Étienne', lat: 47.7472, lon: 7.33878, radius: 30, use: 'Religieux' },
];

/**
 * Foyers de dégâts initiaux, ceux que la mission de reconnaissance doit
 * retrouver. Bien plus serrés que ceux de la ville générée : la vieille ville
 * est trente fois plus dense, et un foyer de 185 m y toucherait des centaines
 * de bâtiments — trop pour qu'une reconnaissance ait encore un sens.
 */
const REAL_FOCI: DamageFocus[] = [
  { east: 120, north: 90, radius: 110, intensity: 1.45, fire: false },
  { east: -210, north: -150, radius: 90, intensity: 1.55, fire: true },
];

// --- Géométrie -----------------------------------------------------------------

type P = [number, number];

function signedArea(ring: P[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Enveloppe convexe (chaîne monotone d'Andrew). */
function convexHull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Plus petit rectangle orienté contenant le contour.
 *
 * Il est forcément aligné sur l'un des côtés de l'enveloppe convexe (théorème
 * des pieds à coulisse tournants) : on essaie donc chaque côté.
 */
function orientedBox(ring: P[]) {
  const hull = convexHull(ring);
  let best = { area: Infinity, width: 0, depth: 0, heading: 0, cx: 0, cy: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) {
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      best = {
        area,
        width: maxU - minU,
        depth: maxV - minV,
        heading: (theta * 180) / Math.PI,
        cx: mu * cos - mv * sin,
        cy: mu * sin + mv * cos,
      };
    }
  }
  return best;
}

// --- Interprétation des attributs ----------------------------------------------------

function kindOf(use: string | null): BuildingKind {
  switch (use) {
    case 'Résidentiel':
      return 'residentiel';
    case 'Commercial et services':
      return 'commerce';
    case 'Religieux':
      return 'religieux';
    case 'Annexe':
      return 'annexe';
    case 'Industriel':
      return 'industriel';
    case 'Sportif':
      return 'sportif';
    default:
      // « Indifférencié » : en centre-ville, c'est très majoritairement de
      // l'habitat mixte.
      return 'residentiel';
  }
}

/** Premier chiffre du code IGN, qui désigne le matériau principal. */
function wallsOf(code: string | null): WallMaterial {
  switch (code?.[0]) {
    case '1':
      return 'pierre';
    case '2':
      return 'meuliere';
    case '3':
      return 'beton';
    case '4':
      return 'brique';
    case '5':
      return 'agglomere';
    case '6':
      return 'bois';
    case '9':
      return 'autre';
    default:
      return 'inconnu';
  }
}

function labelOf(kind: BuildingKind, floors: number): string {
  switch (kind) {
    case 'residentiel':
      return floors >= 3 ? 'Immeuble résidentiel' : 'Maison';
    case 'commerce':
      return 'Commerces et services';
    case 'religieux':
      return 'Édifice religieux';
    case 'annexe':
      return 'Annexe';
    case 'industriel':
      return 'Bâtiment industriel';
    case 'sportif':
      return 'Équipement sportif';
    default:
      return 'Bâtiment';
  }
}

/** Hauteur de rendu : à mi-chemin entre gouttière et faîte, voir l'en-tête. */
function heightOf(raw: RawBuilding): number {
  const { eaves, ridge, floors } = raw;
  let h: number;
  if (eaves != null && ridge != null) h = eaves + 0.5 * Math.max(0, ridge - eaves);
  else if (eaves != null) h = eaves;
  else if (ridge != null) h = ridge * 0.85;
  else if (floors != null) h = floors * 3;
  else h = 5;
  return Math.max(h, 2.5);
}

// --- Chargement ----------------------------------------------------------------

export async function loadRealCity(
  relief: Relief | null,
  url = 'data/mulhouse-centre.json',
): Promise<City | null> {
  let file: RawFile;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    file = (await res.json()) as RawFile;
  } catch (err) {
    console.warn('[ville] données IGN indisponibles, ville générée à la place', err);
    return null;
  }

  const { zone } = file;
  const cosLat = Math.cos((zone.lat * Math.PI) / 180);
  const toLonLat = (east: number, north: number) => ({
    lon: zone.lon + east / (METERS_PER_DEG * cosLat),
    lat: zone.lat + north / METERS_PER_DEG,
  });

  const buildings: Building[] = [];
  const localCenters: P[] = [];

  file.buildings.forEach((raw, i) => {
    const outer = raw.rings[0];
    const box = orientedBox(outer);
    // Le centre du bâtiment est celui de son rectangle orienté : le détecteur
    // trace ses boîtes autour de ce point, elles tombent donc juste.
    const { lon, lat } = toLonLat(box.cx, box.cy);
    const footprint = raw.rings.map((ring) =>
      ring.map(([x, y]) => [x - box.cx, y - box.cy] as [number, number]),
    );
    const area =
      Math.abs(signedArea(outer)) -
      raw.rings.slice(1).reduce((s, r) => s + Math.abs(signedArea(r)), 0);

    const kind = kindOf(raw.use);
    const height = heightOf(raw);
    const floors = raw.floors ?? Math.max(1, Math.round(height / 3.2));
    const walls = wallsOf(raw.walls);

    buildings.push({
      id: `B${String(i + 1).padStart(4, '0')}`,
      sourceId: raw.id,
      name: labelOf(kind, floors),
      kind,
      lon,
      lat,
      // Le point le plus bas du pied, tel que mesuré par l'IGN : sur une pente,
      // le bâtiment s'enfonce légèrement côté amont plutôt que de flotter côté
      // aval.
      baseHeight: raw.ground ?? relief?.heightAt(lon, lat) ?? CONFIG.city.groundHeight,
      width: Math.max(box.width, 1),
      depth: Math.max(box.depth, 1),
      heading: box.heading,
      height,
      floors,
      year: raw.year ?? 0,
      yearKnown: raw.year != null,
      walls,
      light: raw.light,
      area,
      footprint,
      vulnerability: 0,
      state: 'intact',
      damage: 0,
      debris: [],
    });
    localCenters.push([box.cx, box.cy]);
  });

  imputeYears(buildings, localCenters);
  applyLandmarks(buildings, localCenters, zone, cosLat);

  for (const b of buildings) {
    b.vulnerability = computeVulnerability(
      b.year,
      b.kind,
      b.height,
      b.area ?? b.width * b.depth,
      b.walls,
      b.light,
    );
  }

  seedInitialDamage(buildings, makeRandom(CONFIG.city.seed), REAL_FOCI);

  const known = buildings.filter((b) => b.yearKnown).length;
  console.info(
    `[ville] ${buildings.length} bâtiments IGN, année connue pour ${known} ` +
      `(${Math.round((100 * known) / buildings.length)} %), déduite pour les autres`,
  );

  return {
    buildings,
    center: { lon: zone.lon, lat: zone.lat },
    ground: relief?.median ?? CONFIG.city.groundHeight,
    attribution: file.attribution,
  };
}

/**
 * Année déduite du voisinage, pour les bâtiments où l'IGN ne la donne pas.
 * Médiane des six voisins datés les plus proches à moins de 80 m ; à défaut,
 * médiane de toute la zone.
 */
function imputeYears(buildings: Building[], centers: P[]): void {
  const CELL = 40;
  const RADIUS = 80;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

  const dated: number[] = [];
  buildings.forEach((b, i) => {
    if (!b.yearKnown) return;
    dated.push(b.year);
    const k = key(centers[i][0], centers[i][1]);
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  });
  dated.sort((a, b) => a - b);
  const fallback = dated.length ? dated[dated.length >> 1] : 1900;

  const reach = Math.ceil(RADIUS / CELL);
  buildings.forEach((b, i) => {
    if (b.yearKnown) return;
    const [x, y] = centers[i];
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    const near: Array<[number, number]> = [];
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const d = Math.hypot(centers[j][0] - x, centers[j][1] - y);
          if (d <= RADIUS) near.push([d, buildings[j].year]);
        }
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    const years = near
      .slice(0, 6)
      .map((n) => n[1])
      .sort((a, b) => a - b);
    b.year = years.length ? years[years.length >> 1] : fallback;
  });
}

function applyLandmarks(
  buildings: Building[],
  centers: P[],
  zone: RawFile['zone'],
  cosLat: number,
): void {
  for (const lm of LANDMARKS) {
    const east = (lm.lon - zone.lon) * METERS_PER_DEG * cosLat;
    const north = (lm.lat - zone.lat) * METERS_PER_DEG;
    const matches = buildings
      .map((b, i) => ({ b, d: Math.hypot(centers[i][0] - east, centers[i][1] - north) }))
      .filter(
        ({ b, d }) =>
          d <= lm.radius &&
          (lm.minHeight == null || b.height >= lm.minHeight) &&
          (lm.use == null || b.kind === kindOf(lm.use)),
      );
    if (!matches.length) {
      console.warn(`[ville] repère introuvable : ${lm.name}`);
      continue;
    }
    for (const { b } of matches) {
      b.name = lm.name;
      if (lm.height) {
        b.height = lm.height;
        b.floors = Math.round(lm.height / 3.2);
      }
    }
  }
}
