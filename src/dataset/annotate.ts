/**
 * Annotations d'une image nadir, d'après la vérité du simulateur.
 *
 * Contrairement au détecteur (`diagnostic/detector.ts`), rien n'est bruité :
 * c'est la réponse exacte, celle qui sert à entraîner et à évaluer un vrai
 * détecteur. Chaque bâtiment visible reçoit :
 *
 *  - son contour de toit, projeté à la hauteur qui lui reste (un bâtiment
 *    effondré n'a plus que quelques mètres) et découpé au cadre ;
 *  - une boîte qui englobe le toit ET le pied : loin du centre de l'image,
 *    la perspective montre une façade, qui fait partie du bâtiment vu ;
 *  - sa classe, l'un des cinq états de dommage.
 *
 * Un bâtiment coupé par le bord n'est annoté que s'il en reste une part
 * suffisante dans le cadre (`CONFIG.dataset.minVisible`). Les occultations
 * entre bâtiments sont ignorées : vue du dessus, elles sont rares.
 */

import { CONFIG } from '../core/config';
import { DEG } from '../core/math';
import { projectNadir, type NadirGeometry } from '../drone/nadir';
import { DAMAGE_ORDER, standingHeight, type Building, type DamageState } from '../world/buildings';

export interface Annotation {
  buildingId: string;
  /** Identifiant dans la BD TOPO®, pour remonter à la donnée de l'IGN. */
  sourceId?: string;
  state: DamageState;
  /** Rang de la classe : 0 intact, 1 fissuré, 2 partiel, 3 effondré, 4 incendié. */
  classId: number;
  /** Sévérité continue, entre 0 et 1. */
  damage: number;
  /** Boîte dans l'image, en pixels : [x, y, largeur, hauteur]. */
  bbox: [number, number, number, number];
  /** Contour du toit dans l'image, découpé au cadre : [x1, y1, x2, y2, …]. */
  polygon: number[];
  /** Part de la boîte restée dans le cadre, entre 0 et 1. */
  visible: number;
}

type Point = [number, number];

/** Contour extérieur au sol, en mètres (est, nord) autour du centre. */
function outline(b: Building): Point[] {
  if (b.footprint?.[0]?.length) return b.footprint[0];
  // Bâtiment généré : son rectangle orienté, comme le détecteur.
  const cos = Math.cos(b.heading * DEG);
  const sin = Math.sin(b.heading * DEG);
  const hw = b.width / 2;
  const hd = b.depth / 2;
  return (
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as Point[]
  ).map(([sx, sy]) => [sx * hw * cos - sy * hd * sin, sx * hw * sin + sy * hd * cos]);
}

/** Découpe un polygone au carré [0, size]² (Sutherland-Hodgman). */
function clipToFrame(points: Point[], size: number): Point[] {
  const edges: Array<{ inside: (p: Point) => boolean; cut: (a: Point, b: Point) => Point }> = [
    { inside: (p) => p[0] >= 0, cut: (a, b) => lerpAt(a, b, (0 - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[0] <= size, cut: (a, b) => lerpAt(a, b, (size - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[1] >= 0, cut: (a, b) => lerpAt(a, b, (0 - a[1]) / (b[1] - a[1])) },
    { inside: (p) => p[1] <= size, cut: (a, b) => lerpAt(a, b, (size - a[1]) / (b[1] - a[1])) },
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
    if (out.length === 0) break;
  }
  return out;
}

function lerpAt(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Annote tous les bâtiments visibles sur une prise de vue. */
export function annotate(buildings: Building[], g: NadirGeometry): Annotation[] {
  const size = g.size;
  const mLon = 111320 * Math.cos(g.lat * DEG);
  // Au-delà de cette distance au centre de l'image, un bâtiment ne peut pas
  // entrer dans le cadre : on ne le projette pas.
  const reach = g.footprint;

  const result: Annotation[] = [];
  for (const b of buildings) {
    const dx = (b.lon - g.lon) * mLon;
    const dy = (b.lat - g.lat) * 111320;
    const radius = Math.max(b.width, b.depth);
    if (Math.abs(dx) > reach + radius || Math.abs(dy) > reach + radius) continue;

    const bLon = 111320 * Math.cos(b.lat * DEG);
    const project = (altitude: number) =>
      outline(b).map(([east, north]): Point => {
        const p = projectNadir(g, b.lon + east / bLon, b.lat + north / 111320, altitude);
        return [p.x, p.y];
      });
    const roof = project(b.baseHeight + standingHeight(b));
    const foot = project(b.baseHeight);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of [...roof, ...foot]) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const fullArea = (maxX - minX) * (maxY - minY);
    const x0 = Math.max(0, minX);
    const y0 = Math.max(0, minY);
    const x1 = Math.min(size, maxX);
    const y1 = Math.min(size, maxY);
    if (x1 - x0 < 4 || y1 - y0 < 4 || fullArea <= 0) continue;

    const visible = ((x1 - x0) * (y1 - y0)) / fullArea;
    if (visible < CONFIG.dataset.minVisible) continue;

    const clipped = clipToFrame(roof, size);
    result.push({
      buildingId: b.id,
      sourceId: b.sourceId,
      state: b.state,
      classId: DAMAGE_ORDER.indexOf(b.state),
      damage: Math.round(b.damage * 1000) / 1000,
      bbox: [round1(x0), round1(y0), round1(x1 - x0), round1(y1 - y0)],
      polygon: clipped.length >= 3 ? clipped.flatMap(([x, y]) => [round1(x), round1(y)]) : [],
      visible: Math.round(visible * 100) / 100,
    });
  }
  return result;
}
