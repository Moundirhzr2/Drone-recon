/**
 * Relief réel de la zone, et terrain Cesium construit à partir de lui.
 *
 * La grille vient du RGE ALTI® de l'IGN, échantillonnée tous les 10 m par
 * `scripts/fetch-relief.mjs`. Elle sert à trois choses :
 *
 *  1. le TERRAIN affiché, pour que les bâtiments soient posés sur le sol au
 *     lieu de flotter au-dessus d'un globe plat ;
 *  2. l'ALTITUDE SOL sous le drone, qui donne sa hauteur au-dessus du sol ;
 *  3. l'INONDATION, dont la surface d'eau est plane : c'est le relief qui décide
 *     où elle affleure.
 *
 * POURQUOI UN TERRAIN MAISON
 * --------------------------
 * Le terrain mondial de Cesium exige un compte et un jeton ; celui de l'IGN
 * n'existe pas au format attendu par Cesium. `CustomHeightmapTerrainProvider`
 * comble l'écart : Cesium demande des tuiles d'altitudes, on les calcule par
 * interpolation dans notre grille. Hors de la zone, le relief se raccorde en
 * douceur à l'altitude médiane, pour qu'aucune marche n'apparaisse au bord.
 */

import * as Cesium from 'cesium';

/** Grille telle qu'écrite par `scripts/fetch-relief.mjs`. */
interface ReliefFile {
  zone: { lat: number; lon: number; halfSize: number };
  spacing: number;
  size: number;
  unit: 'cm';
  heights: number[];
  attribution: string;
}

const METERS_PER_DEG = 111320;

/** Distance, en mètres hors de la grille, sur laquelle on rejoint la médiane. */
const FADE = 250;

export class Relief {
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly median: number;
  readonly attribution: string;
  readonly centerLat: number;
  readonly centerLon: number;
  readonly halfSize: number;

  private readonly size: number;
  private readonly spacing: number;
  private readonly heights: Float32Array;
  private readonly cosLat: number;

  constructor(file: ReliefFile) {
    this.size = file.size;
    this.spacing = file.spacing;
    this.halfSize = file.zone.halfSize;
    this.centerLat = file.zone.lat;
    this.centerLon = file.zone.lon;
    this.cosLat = Math.cos((this.centerLat * Math.PI) / 180);
    this.attribution = file.attribution;
    this.heights = Float32Array.from(file.heights, (cm) => cm / 100);

    const sorted = Array.from(this.heights).sort((a, b) => a - b);
    this.minHeight = sorted[0];
    this.maxHeight = sorted[sorted.length - 1];
    this.median = sorted[sorted.length >> 1];
  }

  /** Altitude en un point exprimé en mètres locaux (est, nord) autour du centre. */
  heightAtLocal(east: number, north: number): number {
    const x = (east + this.halfSize) / this.spacing;
    const y = (north + this.halfSize) / this.spacing;
    const last = this.size - 1;

    // Hors de la grille : on prend le bord le plus proche, puis on glisse vers
    // la médiane à mesure qu'on s'éloigne.
    const cx = Math.min(Math.max(x, 0), last);
    const cy = Math.min(Math.max(y, 0), last);
    const edge = this.bilinear(cx, cy);
    const outside = Math.hypot(x - cx, y - cy) * this.spacing;
    if (outside <= 0) return edge;
    const w = Math.min(outside / FADE, 1);
    return edge * (1 - w) + this.median * w;
  }

  /** Altitude en un point géographique. */
  heightAt(lon: number, lat: number): number {
    return this.heightAtLocal(
      (lon - this.centerLon) * METERS_PER_DEG * this.cosLat,
      (lat - this.centerLat) * METERS_PER_DEG,
    );
  }

  private bilinear(x: number, y: number): number {
    const last = this.size - 1;
    const c0 = Math.min(Math.floor(x), last);
    const r0 = Math.min(Math.floor(y), last);
    const c1 = Math.min(c0 + 1, last);
    const r1 = Math.min(r0 + 1, last);
    const fx = x - c0;
    const fy = y - r0;
    const h = this.heights;
    const n = this.size;
    return (
      h[r0 * n + c0] * (1 - fx) * (1 - fy) +
      h[r0 * n + c1] * fx * (1 - fy) +
      h[r1 * n + c0] * (1 - fx) * fy +
      h[r1 * n + c1] * fx * fy
    );
  }
}

/** Charge la grille de relief livrée avec l'application. */
export async function loadRelief(url = 'data/mulhouse-relief.json'): Promise<Relief | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Relief((await res.json()) as ReliefFile);
  } catch (err) {
    console.warn('[relief] grille indisponible, terrain plat', err);
    return null;
  }
}

/**
 * Terrain Cesium tiré de la grille.
 *
 * 32 échantillons par côté de tuile suffisent : aux niveaux de détail où les
 * tuiles deviennent plus fines que la grille (10 m), on ne ferait
 * qu'interpoler davantage entre les mêmes points.
 */
export function createReliefTerrain(relief: Relief): Cesium.TerrainProvider {
  const SAMPLES = 32;
  const tiling = new Cesium.GeographicTilingScheme();
  const R2D = 180 / Math.PI;

  return new Cesium.CustomHeightmapTerrainProvider({
    width: SAMPLES,
    height: SAMPLES,
    tilingScheme: tiling,
    credit: relief.attribution,
    callback: (x, y, level) => {
      const rect = tiling.tileXYToRectangle(x, y, level);
      const out = new Float32Array(SAMPLES * SAMPLES);
      for (let j = 0; j < SAMPLES; j++) {
        // Les lignes d'une tuile de hauteurs vont du nord vers le sud.
        const lat = (rect.north - (j / (SAMPLES - 1)) * (rect.north - rect.south)) * R2D;
        for (let i = 0; i < SAMPLES; i++) {
          const lon = (rect.west + (i / (SAMPLES - 1)) * (rect.east - rect.west)) * R2D;
          out[j * SAMPLES + i] = relief.heightAt(lon, lat);
        }
      }
      return out;
    },
  });
}
