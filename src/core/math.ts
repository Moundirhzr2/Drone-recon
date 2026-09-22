/** Utilitaires numériques et géodésiques. */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Nombre de mètres par degré de latitude. Constant à notre échelle. */
const METERS_PER_DEG_LAT = 111320;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ramène un angle dans [0, 360[. */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Convertit un déplacement en mètres (est, nord) en delta de degrés.
 * Valable à l'échelle d'une ville : on néglige la courbure.
 */
export function metersToDegrees(east: number, north: number, atLat: number) {
  return {
    dLon: east / (METERS_PER_DEG_LAT * Math.cos(atLat * DEG)),
    dLat: north / METERS_PER_DEG_LAT,
  };
}

/** Distance horizontale approximative entre deux points, en mètres. */
export function groundDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const east = (lon2 - lon1) * METERS_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * DEG);
  const north = (lat2 - lat1) * METERS_PER_DEG_LAT;
  return Math.hypot(east, north);
}

/** Formate un angle décimal en degrés / minutes / secondes. */
export function toDMS(value: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'O';
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}° ${String(m).padStart(2, '0')}' ${s.toFixed(1).padStart(4, '0')}" ${hemi}`;
}

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 * Une graine donnée produit toujours la même ville : indispensable pour
 * pouvoir rejouer un scénario et comparer deux exécutions.
 */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tirage gaussien centré réduit (Box-Muller), pour bruiter les scores. */
export function gaussian(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Filtre One Euro.
 *
 * MediaPipe tremble en permanence, même main immobile. Un lissage à coefficient
 * fixe forcerait à choisir entre « ça tremble » et « ça traîne ». Le One Euro
 * résout le compromis : il lisse fort quand le mouvement est lent (donc quand le
 * tremblement se voit) et relâche dès que le mouvement est rapide (donc quand la
 * latence se voit). C'est ce qui rend le pilotage gestuel réellement utilisable.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.007,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, timestampMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = timestampMs;
      return x;
    }
    const dt = Math.max((timestampMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = timestampMs;

    // Vitesse lissée, qui pilote l'agressivité du filtre.
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = OneEuroFilter.alpha(cutoff, dt);
    this.xPrev = a * x + (1 - a) * this.xPrev;
    return this.xPrev;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}
