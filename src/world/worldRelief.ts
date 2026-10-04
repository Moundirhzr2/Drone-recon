/**
 * Relief hors de France : les tuiles d'altitude « Terrarium ».
 *
 * Elles couvrent le monde entier, sans compte ni clé : des images PNG au
 * découpage habituel des cartes web, dont chaque pixel code une altitude dans
 * ses trois couleurs, au mètre près divisé par 256 :
 *
 *     altitude = rouge × 256 + vert + bleu / 256 − 32 768
 *
 * Les données viennent de plusieurs sources assemblées (SRTM, ETOPO1, EU-DEM,
 * NED…), d'une résolution de 30 m environ selon les régions : moins fine que
 * le RGE ALTI® de l'IGN, assez pour poser une ville et faire monter une crue.
 * Les altitudes sont au-dessus du géoïde, comme celles de l'IGN.
 *
 * On produit la même grille que pour la France — 121 × 121 points au pas de
 * 10 m — par interpolation dans les tuiles du niveau 14 (6 m par pixel environ).
 *
 * Source : Mapzen, tuiles d'altitude ouvertes, hébergées par Amazon (Registry
 * of Open Data on AWS).
 */

import type { Place } from './place';
import type { ReliefFile } from './terrain';

const TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ZOOM = 14;
const TILE = 256;
const METERS_PER_DEG = 111320;
const HALF_SIZE = 600;
const SPACING = 10;

/** Position d'un point dans l'image du monde entier au niveau ZOOM, en pixels. */
function worldPixel(lon: number, lat: number): [number, number] {
  const scale = TILE * 2 ** ZOOM;
  const x = ((lon + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** Lit une tuile et la décode en altitudes, ligne par ligne. */
async function tile(x: number, y: number): Promise<Float32Array> {
  const res = await fetch(`${TILES}/${ZOOM}/${x}/${y}.png`);
  if (!res.ok) throw new Error(`relief mondial indisponible (HTTP ${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas indisponible');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, TILE, TILE);
  const heights = new Float32Array(TILE * TILE);
  for (let i = 0; i < heights.length; i++) {
    heights[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return heights;
}

export async function fetchWorldRelief(place: Place): Promise<ReliefFile> {
  const size = Math.round((HALF_SIZE * 2) / SPACING) + 1;
  const cosLat = Math.cos((place.lat * Math.PI) / 180);
  const at = (east: number, north: number) =>
    worldPixel(place.lon + east / (METERS_PER_DEG * cosLat), place.lat + north / METERS_PER_DEG);

  // Les tuiles qui couvrent la grille, marge d'un pixel comprise pour
  // l'interpolation.
  const [x0, y0] = at(-HALF_SIZE, HALF_SIZE);
  const [x1, y1] = at(HALF_SIZE, -HALF_SIZE);
  const tx0 = Math.floor((x0 - 1) / TILE);
  const tx1 = Math.floor((x1 + 1) / TILE);
  const ty0 = Math.floor((y0 - 1) / TILE);
  const ty1 = Math.floor((y1 + 1) / TILE);
  const tiles = new Map<string, Float32Array>();
  const jobs: Array<Promise<void>> = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(tile(tx, ty).then((h) => void tiles.set(`${tx}/${ty}`, h)));
    }
  }
  await Promise.all(jobs);

  const pixel = (px: number, py: number): number => {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const h = tiles.get(`${tx}/${ty}`);
    if (!h) return Number.NaN;
    return h[(py - ty * TILE) * TILE + (px - tx * TILE)];
  };
  // Interpolation bilinéaire entre les centres de pixels.
  const sample = (x: number, y: number): number => {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const u = fx - ix;
    const v = fy - iy;
    const a = pixel(ix, iy);
    const b = pixel(ix + 1, iy);
    const c = pixel(ix, iy + 1);
    const d = pixel(ix + 1, iy + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };

  const heights: number[] = [];
  for (let row = 0; row < size; row++) {
    const north = -HALF_SIZE + row * SPACING;
    for (let col = 0; col < size; col++) {
      const east = -HALF_SIZE + col * SPACING;
      const [x, y] = at(east, north);
      heights.push(Math.round(sample(x, y) * 100));
    }
  }
  if (heights.some((h) => !Number.isFinite(h))) throw new Error('relief mondial incomplet');

  return {
    zone: { lat: place.lat, lon: place.lon, halfSize: HALF_SIZE },
    spacing: SPACING,
    size,
    unit: 'cm',
    heights,
    attribution: 'Relief : Mapzen, Terrarium (AWS Open Data)',
  };
}
