/**
 * Une ville quelconque, chargée au démarrage : depuis l'IGN en France, depuis
 * des sources mondiales ailleurs.
 *
 * Mulhouse est livrée toute prête dans `public/data/`, préparée par les scripts
 * `scripts/fetch-buildings.mjs` et `scripts/fetch-relief.mjs`. Pour une autre
 * ville, le navigateur fait le même travail lui-même, et produit les mêmes
 * fichiers : le reste du simulateur ne voit pas la différence.
 *
 *  - Bâtiments : la BD TOPO® par le service WFS de la Géoplateforme, sur un
 *    carré de 900 m centré sur le lieu choisi, par pages de mille.
 *  - Relief : le RGE ALTI® par le service WMS, en UNE image de 121 × 121
 *    altitudes (format BIL, flottants de 32 bits) sur 1 200 m de côté. Vérifié
 *    sur Mulhouse : 1 cm d'écart moyen avec la grille du script, qui
 *    interrogeait les 14 641 points un par un.
 *  - Photographie aérienne : la BD ORTHO®, déjà chargée en direct par le globe.
 *
 * Les services de l'IGN ne couvrent que la France. Ailleurs — ou à cheval sur
 * une frontière, quand le relief de l'IGN ne couvre pas toute la zone —, les
 * bâtiments viennent d'OpenStreetMap (`osmData.ts`), le relief des tuiles
 * mondiales Terrarium (`worldRelief.ts`), la photographie aérienne d'Esri.
 *
 * Les données téléchargées sont gardées dans le cache du navigateur : revenir
 * à une ville déjà visitée est immédiat.
 *
 * Source : IGN — BD TOPO®, RGE ALTI®, Licence Ouverte Etalab 2.0.
 */

import type { CityFile, RawBuilding } from './realCity';
import type { ReliefFile } from './terrain';
import type { Place } from './place';
import { fetchOsmBuildings } from './osmData';
import { fetchWorldRelief } from './worldRelief';

const METERS_PER_DEG = 111320;
/** Demi-côté de la zone bâtie, en mètres : comme `scripts/fetch-buildings.mjs`. */
export const CITY_HALF_SIZE = 450;
/** Demi-côté de la grille de relief, en mètres : 150 m de plus que la zone bâtie. */
const RELIEF_HALF_SIZE = 600;
const RELIEF_SPACING = 10;

const WFS = 'https://data.geopf.fr/wfs/ows';
const WMS = 'https://data.geopf.fr/wms-r/wms';
const LAYER = 'BDTOPO_V3:batiment';
const PAGE = 1000;
const FIELDS = [
  'cleabs',
  'hauteur',
  'nombre_d_etages',
  'usage_1',
  'usage_2',
  'nature',
  'date_d_apparition',
  'materiaux_des_murs',
  'materiaux_de_la_toiture',
  'altitude_minimale_sol',
  'altitude_maximale_toit',
  'construction_legere',
  'nombre_de_logements',
];
const CACHE = 'drone-recon-villes-v1';
/**
 * Part de la zone que le relief de l'IGN doit couvrir pour que la ville soit
 * prise à l'IGN : en deçà, on est hors de France ou à cheval sur une frontière.
 */
const IGN_COVERAGE = 0.95;

type Point = [number, number];

interface WfsFeature {
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
  properties: Record<string, unknown>;
}

/** Les données d'une ville, au format des fichiers livrés pour Mulhouse. */
export interface CityData {
  city: CityFile;
  relief: ReliefFile;
}

/**
 * Télécharge les bâtiments et le relief autour d'un lieu, ou les reprend du
 * cache du navigateur.
 * @param progress messages d'avancement, pour l'écran de démarrage.
 * @throws Error si l'IGN n'a pas de bâtiments ici, ou si le réseau échoue.
 */
export async function fetchCityData(
  place: Place,
  progress: (text: string) => void,
): Promise<CityData> {
  const key = `https://drone-recon.local/ville/${place.lat.toFixed(5)},${place.lon.toFixed(5)}`;
  const cache = await openCache();
  const hit = await cache?.match(key);
  if (hit) {
    progress(`${place.name}: data from the cache`);
    return (await hit.json()) as CityData;
  }

  progress(`${place.name}: relief (IGN, RGE ALTI®)…`);
  let data: CityData;
  const ign = await fetchRelief(place).catch(() => null);
  if (ign) {
    const city = await fetchBuildings(place, (n, total) =>
      progress(`${place.name}: buildings (IGN, BD TOPO®) ${n} / ${total}…`),
    );
    data = { city, relief: ign };
  } else {
    progress(`${place.name}: world relief (Terrarium)…`);
    const relief = await fetchWorldRelief(place);
    const city = await fetchOsmBuildings(place, (text) => progress(`${place.name}: ${text}`));
    data = { city, relief };
  }
  await cache?.put(
    key,
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }),
  );
  return data;
}

async function openCache(): Promise<Cache | null> {
  try {
    return 'caches' in window ? await caches.open(CACHE) : null;
  } catch {
    // Navigation privée ou stockage refusé : on télécharge à chaque fois.
    return null;
  }
}

// --- Relief -------------------------------------------------------------------

/** Relief de l'IGN, ou `null` s'il ne couvre pas toute la zone (hors de France). */
async function fetchRelief(place: Place): Promise<ReliefFile | null> {
  const size = Math.round((RELIEF_HALF_SIZE * 2) / RELIEF_SPACING) + 1;
  // L'emprise de l'image va d'un BORD de pixel à l'autre : élargie d'un
  // demi-pas, elle met le centre de chaque pixel sur un point de la grille.
  const half = RELIEF_HALF_SIZE + RELIEF_SPACING / 2;
  const cosLat = Math.cos((place.lat * Math.PI) / 180);
  const dLat = half / METERS_PER_DEG;
  const dLon = half / (METERS_PER_DEG * cosLat);
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
    STYLES: '',
    CRS: 'EPSG:4326',
    BBOX: [place.lat - dLat, place.lon - dLon, place.lat + dLat, place.lon + dLon]
      .map((v) => v.toFixed(7))
      .join(','),
    WIDTH: String(size),
    HEIGHT: String(size),
    FORMAT: 'image/x-bil;bits=32',
  });
  const res = await fetch(`${WMS}?${params}`);
  if (!res.ok) throw new Error(`relief unavailable (HTTP ${res.status})`);
  const raw = new Float32Array(await res.arrayBuffer());
  if (raw.length !== size * size) throw new Error('incomplete relief');

  // Hors couverture, le service rend -99999. Quelques trous sont remplacés par
  // la médiane, comme dans le script ; au-delà, le lieu n'est pas en France.
  const valid = [...raw].filter((h) => h > -1000).sort((a, b) => a - b);
  if (valid.length < raw.length * IGN_COVERAGE) return null;
  const median = valid[valid.length >> 1];
  // L'image se lit du nord au sud ; la grille du simulateur, du sud au nord.
  const heights: number[] = [];
  for (let row = size - 1; row >= 0; row--) {
    for (let col = 0; col < size; col++) {
      const h = raw[row * size + col];
      heights.push(Math.round((h > -1000 ? h : median) * 100));
    }
  }
  return {
    zone: { lat: place.lat, lon: place.lon, halfSize: RELIEF_HALF_SIZE },
    spacing: RELIEF_SPACING,
    size,
    unit: 'cm',
    heights,
    attribution: '© IGN — RGE ALTI®',
  };
}

// --- Bâtiments ----------------------------------------------------------------
// Même traitement que `scripts/fetch-buildings.mjs` : à garder identiques.

async function fetchBuildings(
  place: Place,
  progress: (n: number, total: number) => void,
): Promise<CityFile> {
  const cosLat = Math.cos((place.lat * Math.PI) / 180);
  const dLat = CITY_HALF_SIZE / METERS_PER_DEG;
  const dLon = CITY_HALF_SIZE / (METERS_PER_DEG * cosLat);
  const bbox = [place.lat - dLat, place.lon - dLon, place.lat + dLat, place.lon + dLon];

  const features: WfsFeature[] = [];
  for (let start = 0; ; start += PAGE) {
    const params = new URLSearchParams({
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      REQUEST: 'GetFeature',
      TYPENAMES: LAYER,
      OUTPUTFORMAT: 'application/json',
      SRSNAME: 'EPSG:4326',
      BBOX: `${bbox.join(',')},urn:ogc:def:crs:EPSG::4326`,
      PROPERTYNAME: [...FIELDS, 'geometrie'].join(','),
      SORTBY: 'cleabs',
      COUNT: String(PAGE),
      STARTINDEX: String(start),
    });
    const res = await fetch(`${WFS}?${params}`);
    if (!res.ok) throw new Error(`buildings unavailable (HTTP ${res.status})`);
    const page = (await res.json()) as { features: WfsFeature[]; numberMatched?: number };
    features.push(...page.features);
    progress(features.length, Number(page.numberMatched ?? features.length));
    if (page.features.length < PAGE) break;
  }
  if (!features.length) throw new Error('no IGN building here: choose a built-up place in France');

  const toLocal = ([lon, lat]: number[]): Point => [
    Math.round((lon - place.lon) * METERS_PER_DEG * cosLat * 10) / 10,
    Math.round((lat - place.lat) * METERS_PER_DEG * 10) / 10,
  ];

  const buildings: RawBuilding[] = [];
  for (const f of features) {
    const p = f.properties;
    const polygons = (
      f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]
    ) as number[][][][];
    for (const [pi, polygon] of polygons.entries()) {
      const rings = polygon.map((ring) => cleanRing(ring.map(toLocal)));
      const outer = rings[0];
      // Moins de 3 points ou de 4 m² : un artefact de numérisation.
      if (!outer || outer.length < 3 || Math.abs(signedArea(outer)) < 4) continue;
      // Extérieur dans le sens trigonométrique, trous dans le sens horaire.
      if (signedArea(outer) < 0) outer.reverse();
      const holes = rings.slice(1).filter((r) => r.length >= 3 && Math.abs(signedArea(r)) >= 1);
      for (const h of holes) if (signedArea(h) > 0) h.reverse();

      const ground = num(p.altitude_minimale_sol);
      const roofTop = num(p.altitude_maximale_toit);
      const id = String(p.cleabs);
      buildings.push({
        id: polygons.length > 1 ? `${id}#${pi}` : id,
        eaves: num(p.hauteur),
        ridge: ground != null && roofTop != null ? Math.round((roofTop - ground) * 10) / 10 : null,
        floors: num(p.nombre_d_etages),
        use: str(p.usage_1),
        use2: str(p.usage_2),
        nature: str(p.nature),
        year: p.date_d_apparition ? Number(String(p.date_d_apparition).slice(0, 4)) : null,
        walls: str(p.materiaux_des_murs),
        roof: str(p.materiaux_de_la_toiture),
        ground,
        light: p.construction_legere === true,
        homes: num(p.nombre_de_logements),
        rings: [outer, ...holes],
      });
    }
  }

  return {
    zone: { name: place.name, lat: place.lat, lon: place.lon, halfSize: CITY_HALF_SIZE },
    attribution: '© IGN — BD TOPO®',
    buildings,
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Aire signée d'un anneau, en m² : positive dans le sens trigonométrique. */
function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Retire le point de fermeture et les doublons consécutifs créés par l'arrondi. */
function cleanRing(ring: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}
