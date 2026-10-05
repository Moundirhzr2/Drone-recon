/**
 * Bâtiments hors de France : OpenStreetMap, par l'API Overpass, ou à défaut
 * par tuiles vectorielles (`tileBuildings.ts`).
 *
 * Le simulateur lit le format de la BD TOPO® de l'IGN (`realCity.ts`). Les
 * étiquettes d'OpenStreetMap y sont traduites :
 *
 *  - la hauteur (`height`), à défaut le nombre d'étages (`building:levels`) ;
 *    sans l'un ni l'autre, le simulateur déduit une hauteur de l'usage ;
 *  - l'usage, du type de bâtiment (`building=house`, `church`, `warehouse`…)
 *    vers les catégories de l'IGN : résidentiel, commerces et services,
 *    industriel, religieux, sportif, annexe ;
 *  - l'année (`start_date`) et les matériaux (`building:material`,
 *    `roof:material`) quand ils sont renseignés, ce qui est rare : le
 *    simulateur complète alors d'après le voisinage, comme pour l'IGN.
 *
 * Overpass est un service gratuit, souvent saturé, et ses miroirs ne répondent
 * pas toujours : passé un délai, on se rabat sur les tuiles vectorielles
 * d'OpenFreeMap, rapides et fiables, mais qui ne gardent que la hauteur.
 *
 * Source : © les contributeurs d'OpenStreetMap, licence ODbL.
 */

import type { CityFile, RawBuilding } from './realCity';
import type { Place } from './place';
import { CITY_HALF_SIZE } from './ignData';
import { fetchTileBuildings } from './tileBuildings';

const SERVERS = ['https://overpass-api.de/api/interpreter'];
/** Délai d'Overpass avant de passer aux tuiles vectorielles, en millisecondes. */
const TIMEOUT = 15_000;
const METERS_PER_DEG = 111320;

type Point = [number, number];

interface OsmGeometry {
  lat: number;
  lon: number;
}

interface OsmElement {
  type: 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmGeometry[];
  members?: Array<{ role: string; geometry?: OsmGeometry[] }>;
}

/** Type de bâtiment OpenStreetMap -> usage de l'IGN. */
const USES: Array<[string, string[]]> = [
  [
    'Résidentiel',
    [
      'house',
      'residential',
      'apartments',
      'detached',
      'semidetached_house',
      'terrace',
      'bungalow',
      'dormitory',
      'cabin',
    ],
  ],
  [
    'Commercial et services',
    [
      'commercial',
      'retail',
      'office',
      'hotel',
      'supermarket',
      'kiosk',
      'public',
      'civic',
      'government',
      'school',
      'university',
      'college',
      'kindergarten',
      'hospital',
      'train_station',
      'transportation',
      'fire_station',
    ],
  ],
  ['Industriel', ['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'depot']],
  [
    'Religieux',
    [
      'church',
      'cathedral',
      'chapel',
      'mosque',
      'temple',
      'synagogue',
      'shrine',
      'monastery',
      'religious',
    ],
  ],
  ['Agricole', ['barn', 'farm', 'farm_auxiliary', 'greenhouse', 'stable', 'cowshed', 'silo']],
  ['Sportif', ['sports_hall', 'stadium', 'grandstand', 'sports_centre']],
  [
    'Annexe',
    [
      'garage',
      'garages',
      'shed',
      'carport',
      'roof',
      'hut',
      'outbuilding',
      'service',
      'toilets',
      'parking',
    ],
  ],
];

/** Matériaux OpenStreetMap -> premier chiffre du code de l'IGN (voir `realCity.ts`). */
const WALLS: Record<string, string> = {
  stone: '1',
  sandstone: '1',
  limestone: '1',
  concrete: '3',
  reinforced_concrete: '3',
  brick: '4',
  cement_block: '5',
  wood: '6',
  timber_framing: '6',
};
const ROOFS: Record<string, string> = {
  roof_tiles: '1',
  tile: '1',
  tiles: '1',
  clay: '1',
  slate: '2',
  metal: '3',
  metal_sheet: '3',
  copper: '3',
  tin: '3',
  zinc: '3',
  concrete: '4',
  glass: '5',
};

export async function fetchOsmBuildings(
  place: Place,
  progress: (text: string) => void,
): Promise<CityFile> {
  const cosLat = Math.cos((place.lat * Math.PI) / 180);
  const dLat = CITY_HALF_SIZE / METERS_PER_DEG;
  const dLon = CITY_HALF_SIZE / (METERS_PER_DEG * cosLat);
  const bbox = [place.lat - dLat, place.lon - dLon, place.lat + dLat, place.lon + dLon]
    .map((v) => v.toFixed(6))
    .join(',');
  const query =
    `[out:json][timeout:25];(way["building"](${bbox});` +
    `relation["building"]["type"="multipolygon"](${bbox}););out tags geom;`;

  let elements: OsmElement[];
  try {
    elements = await overpass(query, progress);
  } catch (err) {
    console.warn('[ville] Overpass indisponible, tuiles vectorielles', err);
    progress('buildings (OpenStreetMap, OpenFreeMap tiles)…');
    return fetchTileBuildings(place, CITY_HALF_SIZE);
  }
  const toLocal = ({ lat, lon }: OsmGeometry): Point => [
    Math.round((lon - place.lon) * METERS_PER_DEG * cosLat * 10) / 10,
    Math.round((lat - place.lat) * METERS_PER_DEG * 10) / 10,
  ];

  const buildings: RawBuilding[] = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    const outers: Point[][] = [];
    const holes: Point[][] = [];
    if (e.type === 'way' && e.geometry) outers.push(e.geometry.map(toLocal));
    for (const m of e.members ?? []) {
      // Seuls les anneaux fermés d'un seul tenant sont repris : recoudre les
      // morceaux d'un multipolygone ne vaut pas, pour de rares bâtiments.
      const g = m.geometry;
      if (
        !g ||
        g.length < 4 ||
        g[0].lat !== g[g.length - 1].lat ||
        g[0].lon !== g[g.length - 1].lon
      )
        continue;
      (m.role === 'inner' ? holes : outers).push(g.map(toLocal));
    }
    outers.forEach((raw, i) => {
      const outer = cleanRing(raw);
      if (outer.length < 3 || Math.abs(signedArea(outer)) < 4) return;
      if (signedArea(outer) < 0) outer.reverse();
      const inner = outers.length === 1 ? holes.map(cleanRing).filter((r) => r.length >= 3) : [];
      for (const h of inner) if (signedArea(h) > 0) h.reverse();
      buildings.push(
        toRaw(`osm-${e.type}-${e.id}${outers.length > 1 ? `#${i}` : ''}`, tags, [outer, ...inner]),
      );
    });
  }
  if (!buildings.length) throw new Error('no OpenStreetMap building here: choose a built-up place');

  return {
    zone: { name: place.name, lat: place.lat, lon: place.lon, halfSize: CITY_HALF_SIZE },
    attribution: '© OpenStreetMap contributors (ODbL)',
    buildings,
  };
}

/** Interroge Overpass, en passant au serveur suivant si l'un tarde ou refuse. */
async function overpass(query: string, progress: (text: string) => void): Promise<OsmElement[]> {
  let last: unknown = null;
  for (const [i, server] of SERVERS.entries()) {
    progress(`buildings (OpenStreetMap), server ${i + 1} of ${SERVERS.length}…`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT);
    try {
      const res = await fetch(server, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { elements: OsmElement[] }).elements;
    } catch (err) {
      last = err;
    } finally {
      clearTimeout(timer);
    }
  }
  const reason = last instanceof Error ? last.message : String(last);
  throw new Error(`OpenStreetMap is not responding (${reason}): try again in a moment`);
}

/** Un bâtiment OpenStreetMap, au format de la BD TOPO® qu'attend `realCity.ts`. */
function toRaw(id: string, tags: Record<string, string>, rings: Point[][]): RawBuilding {
  const height = meters(tags.height);
  const roofHeight = meters(tags['roof:height']);
  const levels = count(tags['building:levels']);
  const kind = tags.building;
  const use =
    USES.find(([, kinds]) => kinds.includes(kind))?.[0] ??
    (tags.amenity === 'place_of_worship' ? 'Religieux' : 'Indifférencié');
  const year = (tags.start_date ?? tags['building:start_date'] ?? '').match(/\d{4}/)?.[0];
  return {
    id,
    eaves: height != null && roofHeight != null ? Math.max(height - roofHeight, 2) : height,
    ridge: height,
    floors: levels,
    use,
    year: year ? Number(year) : null,
    walls: WALLS[tags['building:material']] ?? null,
    roof: ROOFS[tags['roof:material']] ?? null,
    ground: null,
    light: kind === 'roof' || kind === 'carport',
    rings,
  };
}

/** Une hauteur OpenStreetMap — « 12 », « 12 m », « 40 ft » — en mètres. */
function meters(value: string | undefined): number | null {
  const m = value?.trim().match(/^(\d+(?:[.,]\d+)?)\s*(m|ft|')?$/);
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  return m[2] === 'ft' || m[2] === "'" ? v * 0.3048 : v;
}

function count(value: string | undefined): number | null {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

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
