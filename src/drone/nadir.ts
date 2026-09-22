/**
 * Caméra nadir — la vue verticale, en haut à droite.
 *
 * Comment c'est rendu, et pourquoi ainsi :
 *
 * On aurait pu instancier un second `Viewer` Cesium. Ce serait doubler la
 * mémoire GPU et recharger tous les tilesets pour une vignette de 340 px.
 * À la place, on réutilise la SEULE scène existante : on bascule la caméra à la
 * verticale, on rend, on copie le canvas, on remet la caméra où elle était.
 * Coût réel : une passe de rendu supplémentaire, et seulement 10 fois par
 * seconde (voir CONFIG.nadir.fps) au lieu de 60.
 *
 * Le canvas de Cesium fait la taille de la fenêtre, donc pas carré : on en
 * découpe le carré central. L'angle vertical du tronc de vision étant conservé,
 * le carré découpé couvre exactement `2·h·tan(fovy/2)` mètres de côté — ce qui
 * donne une emprise au sol calculable, et donc des photos mesurables.
 */

import * as Cesium from 'cesium';
import { CONFIG } from '../core/config';
import { DEG } from '../core/math';
import type { DroneState } from './drone';

/** Géométrie de prise de vue : tout ce qu'il faut pour reprojeter la scène. */
export interface NadirGeometry {
  lon: number;
  lat: number;
  /** Hauteur de la caméra au-dessus du sol, en mètres. */
  agl: number;
  /** Cap de l'image : la direction qui pointe vers le haut du cadre. */
  heading: number;
  /** Côté de l'emprise au sol, en mètres. */
  footprint: number;
  /** Angle vertical du tronc de vision, en radians. */
  fovy: number;
  /** Côté de l'image, en pixels. */
  size: number;
}

export class NadirView {
  private lastRender = 0;
  private interval = 1000 / CONFIG.nadir.fps;
  /** Dernière géométrie de prise de vue, pour l'overlay de diagnostic. */
  geometry: NadirGeometry | null = null;

  constructor(
    private scene: Cesium.Scene,
    private state: DroneState,
  ) {}

  /** L'aperçu doit-il être rafraîchi maintenant ? */
  due(nowMs: number): boolean {
    return nowMs - this.lastRender >= this.interval;
  }

  /**
   * Rend la scène vue du dessus et la recopie dans `dest`.
   * La caméra principale est restaurée avant de rendre la main.
   */
  render(dest: HTMLCanvasElement, markRendered = true): NadirGeometry {
    const cam = this.scene.camera;
    const frustum = cam.frustum as Cesium.PerspectiveFrustum;
    const s = this.state;

    // --- Sauvegarde de la vue courante -----------------------------------
    const savePos = Cesium.Cartesian3.clone(cam.positionWC, new Cesium.Cartesian3());
    const saveDir = Cesium.Cartesian3.clone(cam.directionWC, new Cesium.Cartesian3());
    const saveUp = Cesium.Cartesian3.clone(cam.upWC, new Cesium.Cartesian3());
    const saveFov = frustum.fov;

    // --- Mise en place de la vue verticale --------------------------------
    // On se place juste sous le châssis pour ne pas photographier le drone.
    const eye = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.msl - 0.9);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(eye);

    // Direction : la verticale descendante du lieu.
    const direction = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(0, 0, -1),
      new Cesium.Cartesian3(),
    );
    // Haut de l'image : le cap du drone. La vignette se lit donc comme la vue
    // pilote — ce qui est devant l'appareil est en haut du cadre.
    const h = s.heading * DEG;
    const up = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(Math.sin(h), Math.cos(h), 0),
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(direction, direction);
    Cesium.Cartesian3.normalize(up, up);

    // `frustum.fov` est l'angle sur la dimension la plus large. On le règle pour
    // que l'angle VERTICAL vaille exactement celui demandé en configuration.
    const wantFovy = CONFIG.nadir.fov * DEG;
    const aspect = frustum.aspectRatio ?? 1;
    frustum.fov = aspect >= 1 ? 2 * Math.atan(Math.tan(wantFovy / 2) * aspect) : wantFovy;

    cam.setView({ destination: eye, orientation: { direction, up } });

    // --- Passe de rendu ----------------------------------------------------
    this.scene.render();

    const src = this.scene.canvas;
    const side = Math.min(src.width, src.height);
    const sx = (src.width - side) / 2;
    const sy = (src.height - side) / 2;

    // Un canvas de taille nulle (fenêtre minimisée, scène pas encore
    // dimensionnée) ferait lever `drawImage`. On rend la main proprement.
    const ctx = side > 0 ? dest.getContext('2d') : null;
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, dest.width, dest.height);
      ctx.drawImage(src, sx, sy, side, side, 0, 0, dest.width, dest.height);
    }

    // `fovy` est dérivé de `fov` et de l'aspect : il n'est indéfini que si la
    // scène n'a jamais été dimensionnée. On retombe alors sur la valeur voulue.
    const fovy = frustum.fovy ?? wantFovy;
    const footprint = 2 * s.agl * Math.tan(fovy / 2);

    // --- Restauration ------------------------------------------------------
    frustum.fov = saveFov;
    cam.setView({ destination: savePos, orientation: { direction: saveDir, up: saveUp } });

    if (markRendered) this.lastRender = performance.now();

    const geometry: NadirGeometry = {
      lon: s.lon,
      lat: s.lat,
      agl: s.agl,
      heading: s.heading,
      footprint,
      fovy,
      size: dest.width,
    };
    this.geometry = geometry;
    return geometry;
  }
}

/**
 * Projette un point au sol (coordonnées géographiques) dans l'image nadir.
 *
 * On ne passe pas par `SceneTransforms` : la caméra n'est plus en position au
 * moment où l'on dessine l'overlay, et une photo enregistrée doit rester
 * reprojetable longtemps après. La géométrie de prise de vue étant entièrement
 * connue, la projection est un simple changement de repère — exact, et gratuit.
 *
 * @param height hauteur du point au-dessus du sol : un toit est plus proche de
 *               la caméra que la rue, donc plus grand à l'image.
 */
export function projectNadir(
  g: NadirGeometry,
  lon: number,
  lat: number,
  height = 0,
): { x: number; y: number; scale: number } {
  const mPerDegLat = 111320;
  const east = (lon - g.lon) * mPerDegLat * Math.cos(g.lat * DEG);
  const north = (lat - g.lat) * mPerDegLat;

  // Rotation inverse du cap : on passe du repère terrain au repère image.
  const h = g.heading * DEG;
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  const xImg = east * cos - north * sin;
  const yImg = east * sin + north * cos;

  // Emprise à la hauteur considérée : elle rétrécit quand on s'approche.
  const distance = Math.max(g.agl - height, 1);
  const halfSpan = distance * Math.tan(g.fovy / 2);
  const pxPerMeter = g.size / 2 / halfSpan;

  return {
    x: g.size / 2 + xImg * pxPerMeter,
    y: g.size / 2 - yImg * pxPerMeter,
    scale: pxPerMeter,
  };
}
