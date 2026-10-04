/**
 * La forme des ruines, commune au rendu (`render.ts`) et aux collisions
 * (`obstacles.ts`) : le drone doit se poser sur les gravats qu'on voit, pas à
 * côté. Tout ce qui décide d'une forme — le tas, les murs restés debout, les
 * éclats projetés au sol — est donc calculé ici, une seule fois pour les deux.
 */

import { standingHeight, type Building } from './buildings';

/** Nombre entre 0 et 1, stable pour un identifiant donné. */
export function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 10007) / 10007;
}

/**
 * Le tas de gravats d'une ruine à contour réel. Effondrée : un tas de la
 * hauteur restante, qui déborde de 2,6 m sur la rue. Éventrée : un tas bas,
 * au pied des murs restés debout.
 */
export function heapOf(b: Building): { height: number; spill: number; seed: number } {
  const h = standingHeight(b);
  const seed = hash01(b.id + 'g');
  return b.state === 'collapsed'
    ? { height: h, spill: 2.6, seed }
    : { height: h * 0.3, spill: 0.8, seed };
}

/** Un éclat de gravats projeté au sol, en mètres autour du centre du bâtiment. */
export interface DebrisChunk {
  east: number;
  north: number;
  /** Longueur, largeur et épaisseur du bloc. */
  length: number;
  width: number;
  height: number;
  /** Cap du bloc, en degrés ; tangage et roulis, en radians. */
  heading: number;
  pitch: number;
  roll: number;
}

/**
 * Les éclats d'une ruine : chaque débris du simulateur devient un éclat plus
 * petit que lui, incliné au hasard et à moitié enfoncé. Des blocs droits et
 * entiers de plusieurs mètres faisaient des caisses posées là.
 */
export function debrisChunks(b: Building): DebrisChunk[] {
  return b.debris.map((d, i) => {
    const r1 = hash01(`${b.id}:${i}:a`);
    const r2 = hash01(`${b.id}:${i}:b`);
    const r3 = hash01(`${b.id}:${i}:c`);
    const size = d.size * (0.35 + 0.3 * r1);
    return {
      east: d.dx + (r2 - 0.5) * d.size,
      north: d.dy + (r3 - 0.5) * d.size,
      length: size,
      width: size * (0.5 + 0.4 * r3),
      height: Math.min(size * 0.7, 0.4 + d.height * 0.35 * r2),
      heading: d.rot,
      pitch: (r1 - 0.5) * 0.7,
      roll: (r3 - 0.5) * 0.7,
    };
  });
}

/** Le centre d'un éclat est enfoncé : il ne dépasse que de cette part de son épaisseur. */
export const CHUNK_SINK = 0.2;

/** Bruit lisse en une dimension, entre 0 et 1 : pour déchiqueter le haut des murs. */
export function noise1(x: number, salt: string): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash01(`${salt}:${i}`) * (1 - u) + hash01(`${salt}:${i + 1}`) * u;
}

/**
 * Les murs restés debout d'une ruine à contour réel, pour `brokenWalls` :
 * leur épaisseur, et leur hauteur à l'abscisse `s` du périmètre, à `corner`
 * mètres de l'angle numéro `index`, le plus proche.
 */
export function ruinWalls(b: Building): {
  thickness: number;
  heightAt: (s: number, corner: number, index: number) => number;
} {
  const h = standingHeight(b);
  if (b.state === 'collapsed') {
    // Des pans d'angle en marches : pleine hauteur contre l'angle, un palier
    // plus bas, puis plus rien.
    return {
      thickness: 0.4,
      heightAt: (s, corner, index) => {
        const r = hash01(`${b.id}:angle${index}`);
        if (r > 0.45) return 0;
        const reach = 1.8 + 3 * hash01(`${b.id}:long${index}`);
        if (corner >= reach) return 0;
        const tall = Math.min(b.height * 0.7, h + 1.5 + 6 * r);
        const step = corner < reach * 0.55 ? 1 : 0.5;
        return tall * step + 0.25 * (noise1(s * 1.7, b.id) - 0.5);
      },
    };
  }
  // Une maçonnerie casse par paliers, le long de ses rangs : des tronçons de
  // 2 à 6 m, chacun à sa hauteur, quelques brèches profondes, et des angles
  // qui tiennent mieux que le reste. Un bruit fin, de quelques décimètres
  // seulement, rend la cassure irrégulière sans la hérisser.
  const LEVELS = [0.35, 0.62, 0.8, 0.92, 1];
  return {
    thickness: 0.35,
    heightAt: (s, corner) => {
      const piece = Math.floor(s / 4 + 0.6 * noise1(s / 9, `${b.id}:troncon`));
      const level = LEVELS[Math.floor(hash01(`${b.id}:palier${piece}`) * LEVELS.length)];
      const solid = corner < 1.2 ? 1 : level;
      return h * solid + 0.3 * (noise1(s * 1.7, `${b.id}:cassure`) - 0.5);
    },
  };
}
