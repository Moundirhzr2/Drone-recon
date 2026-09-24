/**
 * Caméra d'observation.
 *
 * Deux vues, une seule caméra Cesium :
 *  - SUIVI : derrière et au-dessus du drone. C'est la vue par défaut, parce
 *    qu'on ne pilote pas bien un appareil qu'on ne voit pas.
 *  - FPV : à bord, regard vers l'avant.
 *
 * La caméra de suivi traîne volontairement derrière sa cible (lissage
 * exponentiel). Une caméra parfaitement rigide donne l'impression que le décor
 * bouge autour d'un drone immobile ; un peu de retard rend le mouvement lisible. *
 * LE REPÈRE LOCAL DE CESIUM — à lire avant de toucher aux décalages
 * -----------------------------------------------------------------
 * `Transforms.headingPitchRollToFixedFrame` utilise par défaut
 * `eastNorthUpToFixedFrame`. Le cap fait donc tourner un repère
 * **Est / Nord / Haut**, et les axes qui en sortent sont :
 *
 *     X = DROITE      Y = AVANT      Z = HAUT
 *
 * Ce n'est PAS la convention aéronautique (X avant) à laquelle on s'attend.
 * Une erreur de 90° ici ne provoque aucun message : la caméra vise
 * correctement mais se place à côté du drone, qui reste hors champ en
 * permanence. C'est exactement ce qui a fait croire pendant longtemps que le
 * châssis 3D ne se dessinait pas.
 */

import * as Cesium from 'cesium';
import { clamp, DEG } from '../core/math';
import type { DroneState } from './drone';

export type CameraMode = 'suivi' | 'fpv';

export class DroneCamera {
  // Vue embarquée par défaut : c'est la vue d'un vrai pilote de drone, et elle
  // ne dépend pas d'un châssis 3D à afficher.
  mode: CameraMode = 'fpv';
  /**
   * Distance de recul en vue de suivi, en mètres. Le drone mesure 1,2 m
   * d'envergure : à 12 m, on le voit en entier et on lit ses détails.
   */
  private distance = 12;
  /** Hauteur de la caméra au-dessus du drone, en mètres. */
  private lift = 4;
  /** Cap lissé de la caméra (le drone peut pivoter plus vite qu'elle). */
  private smoothHeading: number | null = null;

  constructor(
    private camera: Cesium.Camera,
    private state: DroneState,
  ) {}

  zoom(delta: number): void {
    this.distance = clamp(this.distance + delta, 8, 160);
    this.lift = clamp(this.distance * 0.34, 3, 60);
  }

  toggle(): CameraMode {
    this.mode = this.mode === 'suivi' ? 'fpv' : 'suivi';
    return this.mode;
  }

  /** Repositionne la caméra. À appeler une fois par image, avant le rendu. */
  update(dt: number): void {
    const s = this.state;
    const target = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.msl);

    if (this.mode === 'fpv') {
      // À bord : on regarde légèrement vers le bas, comme une nacelle de recon.
      const hpr = new Cesium.HeadingPitchRoll(
        s.heading * DEG,
        (-14 - s.pitch * 0.5) * DEG,
        s.roll * 0.35 * DEG,
      );
      const frame = Cesium.Transforms.headingPitchRollToFixedFrame(target, hpr);
      const eye = Cesium.Matrix4.multiplyByPoint(
        frame,
        // X = droite, Y = avant, Z = haut (voir la note sur le repère plus bas).
        new Cesium.Cartesian3(0, 1.4, 0.1),
        new Cesium.Cartesian3(),
      );
      this.camera.setView({
        destination: eye,
        orientation: {
          heading: hpr.heading,
          pitch: hpr.pitch,
          roll: hpr.roll,
        },
      });
      return;
    }

    // --- Vue de suivi -----------------------------------------------------
    // Lissage du cap en tenant compte du passage 359° -> 0°.
    if (this.smoothHeading === null) this.smoothHeading = s.heading;
    let delta = s.heading - this.smoothHeading;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    this.smoothHeading += delta * Math.min(1, dt * 3.2);

    const pitchDown = -Math.atan2(this.lift, this.distance);
    const hpr = new Cesium.HeadingPitchRoll(this.smoothHeading * DEG, 0, 0);
    const frame = Cesium.Transforms.headingPitchRollToFixedFrame(target, hpr);
    const eye = Cesium.Matrix4.multiplyByPoint(
      frame,
      // Y = avant : on recule donc en -Y, et on monte en Z.
      new Cesium.Cartesian3(0, -this.distance, this.lift),
      new Cesium.Cartesian3(),
    );

    this.camera.setView({
      destination: eye,
      orientation: {
        heading: this.smoothHeading * DEG,
        pitch: pitchDown,
        roll: 0,
      },
    });
  }

  /** Recale immédiatement la caméra derrière le drone. */

  snap(): void {
    this.smoothHeading = this.state.heading;
    this.update(1);
  }
}
