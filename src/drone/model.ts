/**
 * Représentation visuelle du drone : un quadricoptère d'inspection à la taille
 * réelle, chargé depuis `public/models/drone.glb`.
 *
 * Le modèle est généré par `scripts/build-drone.mjs` (`npm run model:drone`) :
 * fuselage, bras en carbone, moteurs, hélices vrillées de 21 pouces, nacelle
 * de caméra, patins et feux de navigation, avec des matériaux physiques que
 * Cesium éclaire comme le reste de la scène.
 *
 * Par image, rien n'est reconstruit : la pose du drone est une seule matrice,
 * que Cesium applique à tout le modèle, et chaque hélice tourne par la matrice
 * de son nœud. La précision n'est pas un problème : les sommets restent à
 * moins d'un mètre de l'origine locale, et c'est la `modelMatrix` — en double
 * précision côté processeur — qui porte les 6 366 km jusqu'au centre de la
 * Terre.
 *
 * NOTE SUR LES AXES
 * -----------------
 * Le châssis a longtemps été réputé « impossible à afficher » : c'était la
 * caméra de suivi qui se plaçait 90° à côté du drone, à cause d'une confusion
 * sur les axes du repère local de Cesium (voir `drone/camera.ts`). Dans le
 * repère du drone, X = droite, Y = avant, Z = haut. Le modèle glTF a son nez
 * sur +X ; Cesium, qui amène l'avant d'un glTF sur son axe +X, le fait tomber
 * sur +Y (le détail est en tête du script).
 */

import * as Cesium from 'cesium';
import { DEG } from '../core/math';
import type { DroneState } from './drone';

/** Nœuds des hélices dans le modèle, et leur sens de rotation vu de dessus. */
const PROPELLERS: Array<{ node: string; sens: 1 | -1 }> = [
  { node: 'helice_avant_droite', sens: 1 },
  { node: 'helice_arriere_droite', sens: -1 },
  { node: 'helice_arriere_gauche', sens: 1 },
  { node: 'helice_avant_gauche', sens: -1 },
];

/**
 * Vitesse de rotation affichée, en tours par seconde. Un vrai rotor tourne dix
 * fois plus vite : à 60 images par seconde, il paraîtrait immobile ou
 * tournerait à l'envers. Le disque translucide du modèle rend le flou de la
 * vraie vitesse ; les pales, elles, n'ont qu'à suggérer le mouvement.
 */
const SPIN = 5.5;

const TRIM = Cesium.Color.fromCssColorString('#00e5ff');

export class DroneModel {
  /** Le modèle, une fois chargé. */
  private model: Cesium.Model | null = null;
  /** Repère au sol : c'est lui qui donne le sens de l'altitude. */
  private ring: Cesium.Primitive;
  private visible = true;
  /** Angle courant des hélices, en radians. */
  private spin = 0;

  /** Repère monde du drone, recalculé une fois par image. */
  private frame = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  /** Repère du marqueur au sol : même position, sans rotation ni altitude. */
  private groundFrame = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  private spinMatrix = new Cesium.Matrix4();
  private nodeMatrix = new Cesium.Matrix4();

  constructor(
    private viewer: Cesium.Viewer,
    private state: DroneState,
  ) {
    this.computeFrames();

    this.ring = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.CylinderOutlineGeometry({
          length: 0.2,
          topRadius: 3.4,
          bottomRadius: 3.4,
          slices: 32,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(TRIM.withAlpha(0.7)),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
      asynchronous: false,
      modelMatrix: this.groundFrame,
    });
    viewer.scene.primitives.add(this.ring);

    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const model = await Cesium.Model.fromGltfAsync({
        url: `${import.meta.env.BASE_URL}models/drone.glb`,
        modelMatrix: this.frame,
        // De loin, le drone garde au moins cette taille à l'écran : sinon, à
        // 150 m de recul, il ne ferait plus que quelques pixels.
        minimumPixelSize: 48,
      });
      model.show = this.visible;
      this.viewer.scene.primitives.add(model);
      this.model = model;
    } catch (err) {
      console.warn('[drone] modèle 3D indisponible', err);
    }
  }

  /**
   * Recalcule la pose et fait tourner les hélices. À appeler une fois par
   * image, avant le rendu.
   */
  sync(dt: number): void {
    this.computeFrames();
    // La primitive détient sa propre copie de la matrice : il faut la lui
    // réécrire, l'affecter ne suffirait pas.
    Cesium.Matrix4.clone(this.groundFrame, this.ring.modelMatrix);

    const model = this.model;
    if (!model) return;
    model.modelMatrix = this.frame;
    if (!model.ready || !this.visible) return;

    this.spin = (this.spin + dt * SPIN * 2 * Math.PI) % (2 * Math.PI);
    for (const p of PROPELLERS) {
      const node = model.getNode(p.node);
      if (!node) continue;
      // Rotation autour de l'axe vertical du glTF (+Y), par-dessus la position
      // d'origine du moyeu.
      Cesium.Matrix4.fromRotationTranslation(
        Cesium.Matrix3.fromRotationY(p.sens * this.spin),
        Cesium.Cartesian3.ZERO,
        this.spinMatrix,
      );
      node.matrix = Cesium.Matrix4.multiply(node.originalMatrix, this.spinMatrix, this.nodeMatrix);
    }
  }

  /** Pose du drone et de son marqueur au sol. Ne touche à rien d'autre. */
  private computeFrames(): void {
    const s = this.state;
    const origin = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.msl);
    const hpr = new Cesium.HeadingPitchRoll(
      s.heading * DEG,
      // Un multirotor pique du nez pour avancer : le signe suit cette convention.
      -s.pitch * DEG,
      s.roll * DEG,
    );
    Cesium.Transforms.headingPitchRollToFixedFrame(
      origin,
      hpr,
      Cesium.Ellipsoid.WGS84,
      Cesium.Transforms.eastNorthUpToFixedFrame,
      this.frame,
    );

    Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.msl - s.agl + 0.3),
      Cesium.Ellipsoid.WGS84,
      this.groundFrame,
    );
  }

  get modelMatrix(): Cesium.Matrix4 {
    return this.frame;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.ring.show = v;
    if (this.model) this.model.show = v;
  }

  destroy(): void {
    this.viewer.scene.primitives.remove(this.ring);
    if (this.model) this.viewer.scene.primitives.remove(this.model);
  }
}
