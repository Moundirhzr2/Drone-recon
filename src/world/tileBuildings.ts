/**
 * Bâtiments d'OpenStreetMap par tuiles vectorielles : le secours quand
 * Overpass ne répond pas.
 *
 * OpenFreeMap diffuse les données d'OpenStreetMap en tuiles vectorielles
 * (schéma OpenMapTiles), sans compte ni clé, par un réseau de diffusion :
 * c'est rapide et fiable. Mais la couche des bâtiments ne garde que la
 * hauteur : ni l'usage, ni l'année, ni les matériaux. Le simulateur les
 * déduit alors, et toutes les façades se ressemblent davantage.
 *
 * Une tuile coupe les bâtiments qui la débordent, avec une marge de
 * recouvrement : chaque contour est donc découpé au bord exact de sa tuile,
 * pour que les deux moitiés d'un bâtiment à cheval se rejoignent sans se
 * chevaucher.
 *
 * Source : © OpenStreetMap, licence ODbL ; tuiles OpenFreeMap (OpenMapTiles).
 */

import { classifyRings, VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { CityFile, RawBuilding } from './realCity';
import type { Place } from './place';

const ORIGIN = 'https://tiles.openfreemap.org/';
const TILEJSON = `${ORIGIN}planet`;
/** Seul niveau où la couche des bâtiments est complète. */
const ZOOM = 14;
const METERS_PER_DEG = 111320;

type Point = [number, number];

export async function fetchTileBuildings(place: Place, halfSize: number): Promise<CityFile> {
  const meta = (await (await fetch(TILEJSON)).json()) as { tiles: string[] };
  // Le chemin des tuiles change à chaque mise à jour de la carte, d'où la
  // TileJSON ; mais on ne suit que des tuiles du même serveur.
  const template = meta.tiles[0];
  if (!template?.startsWith(ORIGIN)) throw new Error('tuiles de bâtiments : adresse inattendue');
  const path = template.slice(ORIGIN.length);
  const cosLat = Math.cos((place.lat * Math.PI) / 180);
  const dLat = halfSize / METERS_PER_DEG;
  const dLon = halfSize / (METERS_PER_DEG * cosLat);
  const n = 2 ** ZOOM;
  const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const tileY = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  };
  const toLocal = (lon: number, lat: number): Point => [
    Math.round((lon - place.lon) * METERS_PER_DEG * cosLat * 10) / 10,
    Math.round((lat - place.lat) * METERS_PER_DEG * 10) / 10,
  ];

  const buildings: RawBuilding[] = [];
  const jobs: Array<Promise<void>> = [];
  for (let ty = tileY(place.lat + dLat); ty <= tileY(place.lat - dLat); ty++) {
    for (let tx = tileX(place.lon - dLon); tx <= tileX(place.lon + dLon); tx++) {
      jobs.push(
        (async () => {
          const tilePath = path
            .replace('{z}', String(ZOOM))
            .replace('{x}', String(tx))
            .replace('{y}', String(ty));
          const res = await fetch(`${ORIGIN}${tilePath}`);
          if (!res.ok) throw new Error(`tuile de bâtiments indisponible (HTTP ${res.status})`);
          const layer = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())))
            .layers.building;
          if (!layer) return;
          // Pixel de tuile -> degrés : inverse de la projection de Mercator.
          const lonLat = (px: number, py: number): Point => {
            const x = (tx + px / layer.extent) / n;
            const y = (ty + py / layer.extent) / n;
            const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
            return [x * 360 - 180, lat];
          };
          for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            const p = f.properties;
            // Un bâtiment décrit par parties : on garde les parties posées au
            // sol plutôt que son contour, et l'on écarte les parties en hauteur
            // (passerelles, avancées), que le simulateur ne sait pas extruder.
            if (f.type !== 3 || p.hide_3d === true || Number(p.render_min_height ?? 0) > 0)
              continue;
            for (const polygon of classifyRings(f.loadGeometry())) {
              const rings = polygon
                .map((ring) =>
                  clip(
                    ring.map((q): Point => [q.x, q.y]),
                    layer.extent,
                  ),
                )
                .map((ring) => tidy(ring.map(([x, y]) => toLocal(...lonLat(x, y)))))
                .filter((ring) => ring.length >= 3);
              const outer = rings[0];
              if (!outer || Math.abs(signedArea(outer)) < 4) continue;
              // Hors du carré de la zone : on ne garde que ce qui y est centré.
              const [cx, cy] = centroid(outer);
              if (Math.abs(cx) > halfSize || Math.abs(cy) > halfSize) continue;
              if (signedArea(outer) < 0) outer.reverse();
              const holes = rings.slice(1).filter((r) => Math.abs(signedArea(r)) >= 1);
              for (const h of holes) if (signedArea(h) > 0) h.reverse();
              const height = Number(p.render_height);
              buildings.push({
                id: `ofm-${tx}-${ty}-${i}-${buildings.length}`,
                eaves: Number.isFinite(height) && height > 0 ? height : null,
                ridge: null,
                floors: null,
                use: 'Indifférencié',
                year: null,
                walls: null,
                roof: null,
                ground: null,
                light: false,
                rings: [outer, ...holes],
              });
            }
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  if (!buildings.length)
    throw new Error('aucun bâtiment dans OpenStreetMap ici : choisir un lieu bâti');

  return {
    zone: { name: place.name, lat: place.lat, lon: place.lon, halfSize },
    attribution: '© les contributeurs d’OpenStreetMap (ODbL), tuiles OpenFreeMap',
    buildings,
  };
}

/** Découpe un anneau au carré de la tuile, [0, size]² (Sutherland-Hodgman). */
function clip(points: Point[], size: number): Point[] {
  const edges: Array<{ inside: (p: Point) => boolean; cut: (a: Point, b: Point) => Point }> = [
    { inside: (p) => p[0] >= 0, cut: (a, b) => lerp(a, b, (0 - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[0] <= size, cut: (a, b) => lerp(a, b, (size - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[1] >= 0, cut: (a, b) => lerp(a, b, (0 - a[1]) / (b[1] - a[1])) },
    { inside: (p) => p[1] <= size, cut: (a, b) => lerp(a, b, (size - a[1]) / (b[1] - a[1])) },
  ];
  let out = points;
  for (const edge of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (edge.inside(cur)) {
        if (!edge.inside(prev)) out.push(edge.cut(prev, cur));
        out.push(cur);
      } else if (edge.inside(prev)) {
        out.push(edge.cut(prev, cur));
      }
    }
    if (!out.length) break;
  }
  return out;
}

const lerp = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Retire les points répétés, et le point de fermeture que répètent les tuiles. */
function tidy(ring: Point[]): Point[] {
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

function centroid(ring: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

function signedArea(ring: Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}
