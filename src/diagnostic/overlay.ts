/**
 * Surcouche de diagnostic : les boîtes, les étiquettes et les scores.
 *
 * Deux surfaces différentes, deux méthodes de projection :
 *
 *  - Sur la VIGNETTE NADIR, les boîtes arrivent déjà projetées : le détecteur
 *    les a calculées analytiquement depuis la géométrie de prise de vue (voir
 *    `projectNadir`). La caméra n'est plus en position au moment du dessin, et
 *    une photo archivée doit rester annotable des minutes plus tard — le calcul
 *    doit donc être indépendant de l'état de la scène. On ne fait ici que
 *    tracer.
 *
 *  - Sur la VUE PRINCIPALE, on passe par la projection de Cesium, puisque la
 *    caméra y est précisément celle qu'on regarde.
 */

import * as Cesium from 'cesium';
import { DAMAGE_INFO, isDamaged, standingHeight, type Building } from '../world/buildings';
import type { NadirGeometry } from '../drone/nadir';
import type { Detection } from './detector';
import { CONFIG } from '../core/config';
import { groundDistance } from '../core/math';

const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cartouche d'étiquette, dessiné au-dessus d'une boîte.
 *
 * Avec `placed`, il n'est posé que s'il ne chevauche aucun cartouche déjà
 * posé, et y est alors ajouté. Renvoie vrai s'il a été dessiné.
 */
function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size = 10,
  placed?: Rect[],
): boolean {
  ctx.font = `600 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + 8;
  const h = size + 6;
  // On garde le cartouche dans le cadre, sinon il se coupe en bord d'image.
  const ly = y - h < 0 ? y + 2 : y - h - 1;
  if (placed) {
    const overlaps = placed.some(
      (r) => x < r.x + r.w + 2 && x + w + 2 > r.x && ly < r.y + r.h + 1 && ly + h + 1 > r.y,
    );
    if (overlaps) return false;
    placed.push({ x, y: ly, w, h });
  }
  ctx.fillStyle = color;
  ctx.fillRect(x, ly, w, h);
  ctx.fillStyle = '#04070b';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 4, ly + h / 2 + 0.5);
  return true;
}

/**
 * Étiquettes au plus sur la vue principale. Avec les 2 282 bâtiments réels, un
 * séisme en endommage plus de mille : les étiqueter tous recouvrait l'image
 * d'une centaine de cartouches superposés, illisibles.
 */
const MAX_LABELS = 30;

/** Boîtes et scores sur la vignette nadir. */
export function drawNadirOverlay(
  canvas: HTMLCanvasElement,
  detections: Detection[],
  geometry: NadirGeometry | null,
  active: boolean,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!active || !geometry) return;

  for (const d of detections) {
    const info = DAMAGE_INFO[d.predicted];
    const { x, y, w, h } = d.box;

    // Masque translucide : il rend la zone lisible sans cacher l'image.
    ctx.fillStyle = `rgba(${info.rgb[0]}, ${info.rgb[1]}, ${info.rgb[2]}, 0.16)`;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = info.color;
    ctx.lineWidth = d.falsePositive ? 1 : 1.8;
    // Un faux positif se dessine en pointillés : on voit le détecteur se
    // tromper, ce qui est tout l'intérêt de la démonstration.
    ctx.setLineDash(d.falsePositive ? [3, 3] : []);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    if (w > 34) {
      label(ctx, `${info.short} ${(d.score * 100).toFixed(0)}%`, x, y, info.color, 9);
    }
  }

  // Cadre et échelle.
  ctx.strokeStyle = 'rgba(0,229,255,.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
}

/** Position écran d'un point, quelle que soit la version de Cesium. */
function toWindow(scene: Cesium.Scene, position: Cesium.Cartesian3): Cesium.Cartesian2 | undefined {
  const T = Cesium.SceneTransforms as unknown as Record<string, unknown>;
  const fn = (T.worldToWindowCoordinates ?? T.wgs84ToWindowCoordinates) as
    ((s: Cesium.Scene, p: Cesium.Cartesian3) => Cesium.Cartesian2 | undefined) | undefined;
  return fn ? fn(scene, position) : undefined;
}

/**
 * Boîtes sur la vue principale.
 *
 * On ne projette que les bâtiments ENDOMMAGÉS et à portée : projeter les huit
 * sommets de chaque bâtiment de la ville à chaque image coûterait plus cher que
 * le rendu lui-même, pour un résultat illisible.
 */
export function drawMainOverlay(
  canvas: HTMLCanvasElement,
  scene: Cesium.Scene,
  buildings: Building[],
  droneLon: number,
  droneLat: number,
  active: boolean,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Dimensionnement de la surcouche.
  //
  // PIÈGE : ne JAMAIS déduire `canvas.width` de `canvas.clientWidth`. Un canvas
  // est un élément remplacé ; en position absolue avec `width: auto`, CSS
  // résout sa largeur par sa largeur INTRINSÈQUE — c'est-à-dire l'attribut
  // `width` lui-même. Chaque image amplifiait donc la précédente, jusqu'à
  // dépasser la taille maximale d'un canvas : Chrome peint alors un bitmap
  // blanc opaque, qui recouvrait toute la scène.
  //
  // On prend la taille du canvas de Cesium, qui fait autorité : c'est dans son
  // repère que `worldToWindowCoordinates` renvoie ses coordonnées.
  const dpr = window.devicePixelRatio || 1;
  const cw = scene.canvas.clientWidth || window.innerWidth;
  const ch = scene.canvas.clientHeight || window.innerHeight;
  if (cw <= 0 || ch <= 0) return;

  const bw = Math.round(cw * dpr);
  const bh = Math.round(ch * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    // Taille CSS explicite : elle coupe définitivement la boucle décrite ci-dessus.
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!active) return;

  const camPos = scene.camera.positionWC;

  // Du plus lointain au plus proche : les boîtes proches sont dessinées en
  // dernier, donc par-dessus, et ce sont elles qui reçoivent une étiquette
  // quand la place manque.
  const nearby: Array<{ b: Building; dist: number }> = [];
  for (const b of buildings) {
    if (!isDamaged(b)) continue;
    const dist = groundDistance(droneLon, droneLat, b.lon, b.lat);
    if (dist <= CONFIG.detector.range) nearby.push({ b, dist });
  }
  nearby.sort((a, b) => b.dist - a.dist);
  const labelled = new Set(nearby.slice(-MAX_LABELS * 3).map((n) => n.b));
  const placed: Rect[] = [];
  const labels: Array<{ text: string; x: number; y: number; color: string }> = [];

  for (const { b, dist } of nearby) {
    const h = standingHeight(b);
    const rad = (b.heading * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const mLon = 111320 * Math.cos((b.lat * Math.PI) / 180);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let visible = false;

    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as Array<[number, number]>) {
      const east = ((sx * b.width) / 2) * cos - ((sy * b.depth) / 2) * sin;
      const north = ((sx * b.width) / 2) * sin + ((sy * b.depth) / 2) * cos;
      const lon = b.lon + east / mLon;
      const lat = b.lat + north / 111320;

      for (const z of [b.baseHeight, b.baseHeight + h]) {
        const world = Cesium.Cartesian3.fromDegrees(lon, lat, z);
        // Rejet des points derrière la caméra : leur projection est trompeuse.
        if (
          Cesium.Cartesian3.dot(
            Cesium.Cartesian3.subtract(world, camPos, new Cesium.Cartesian3()),
            scene.camera.directionWC,
          ) <= 0
        ) {
          continue;
        }
        const win = toWindow(scene, world);
        if (!win) continue;
        visible = true;
        minX = Math.min(minX, win.x);
        maxX = Math.max(maxX, win.x);
        minY = Math.min(minY, win.y);
        maxY = Math.max(maxY, win.y);
      }
    }

    if (!visible || maxX < 0 || maxY < 0 || minX > cw || minY > ch) continue;

    const info = DAMAGE_INFO[b.state];
    const w = maxX - minX;
    const hh = maxY - minY;

    ctx.strokeStyle = info.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.95;
    // Coins seulement : plus lisible qu'un rectangle plein sur une scène chargée.
    const c = Math.min(12, w / 3, hh / 3);
    for (const [cx, cy, dx, dy] of [
      [minX, minY, 1, 1],
      [maxX, minY, -1, 1],
      [minX, maxY, 1, -1],
      [maxX, maxY, -1, -1],
    ] as Array<[number, number, number, number]>) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * c, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * c);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.12;
    ctx.fillStyle = info.color;
    ctx.fillRect(minX, minY, w, hh);
    ctx.globalAlpha = 1;

    if (w > 40 && labelled.has(b)) {
      labels.push({
        text: `${info.short}  ${b.id}  ${dist.toFixed(0)}m`,
        x: minX,
        y: minY,
        color: info.color,
      });
    }
  }

  // Les cartouches en dernier, par-dessus toutes les boîtes, du plus proche au
  // plus lointain : un cartouche qui en chevaucherait un autre est sauté.
  let count = 0;
  for (let i = labels.length - 1; i >= 0 && count < MAX_LABELS; i--) {
    const l = labels[i];
    if (label(ctx, l.text, l.x, l.y, l.color, 10, placed)) count++;
  }
}
