/**
 * Représentation visuelle du drone.
 *
 * POURQUOI CE FICHIER A ÉTÉ RÉÉCRIT
 * ---------------------------------
 * Pendant longtemps le châssis a été réputé « impossible à afficher » : trois
 * approches (entités, primitives, polylignes) semblaient ne dessiner aucun
 * pixel alors que les positions étaient vérifiées correctes.
 *
 * Le diagnostic était faux. Le châssis se dessinait ; c'est la CAMÉRA DE SUIVI
 * qui se plaçait 90° à côté du drone, à cause d'une confusion sur les axes du
 * repère local de Cesium (voir la note en tête de `drone/camera.ts`). Le drone
 * était donc systématiquement hors champ, et aucune des trois approches n'était
 * en cause.
 *
 * Reste alors le vrai critère : le coût. Mesuré sur cette scène, image médiane
 * complète, en vue de suivi :
 *
 *     sans châssis ................  1,8 ms
 *     châssis en entités Cesium ... 11,0 ms   (+9,2 ms)
 *
 * Les entités coûtent cher pour une raison structurelle : une position qui
 * change à chaque image force Cesium à RECONSTRUIRE la géométrie à chaque
 * image. La primitive, elle, construit une fois et ne déplace qu'une matrice.
 *
 * La précision n'est pas un problème ici, contrairement à ce qui avait été
 * supposé : les sommets restent à quelques mètres de l'origine LOCALE, et c'est
 * la `modelMatrix` — en double précision côté processeur — qui porte les
 * 6 366 km jusqu'au centre de la Terre. C'est exactement l'usage prévu.
 */

import * as Cesium from 'cesium';
import { DEG } from '../core/math';
import type { DroneState } from './drone';

const ARM = 1.7; // demi-envergure, en mètres

/** Une pièce du châssis, exprimée dans le repère local du drone. */
interface Part {
  /** Dimensions (largeur, longueur, hauteur) en mètres. */
  size: Cesium.Cartesian3;
  /** Décalage (droite, avant, haut) en mètres. */
  at: Cesium.Cartesian3;
  /** Rotation propre autour de la verticale, en degrés. */
  yaw?: number;
  color: string;
  /** Tracer aussi les arêtes : ce qui donne la lisibilité à distance. */
  edges?: boolean;
}

const PARTS: Part[] = [
  // Corps.
  {
    size: new Cesium.Cartesian3(1.6, 2.3, 0.6),
    at: new Cesium.Cartesian3(0, 0, 0),
    color: '#242b31',
    edges: true,
  },
  // Nez rouge : sans lui, impossible de lire l'orientation en vol.
  {
    size: new Cesium.Cartesian3(1, 0.7, 0.34),
    at: new Cesium.Cartesian3(0, 1.35, 0.05),
    color: '#ff1744',
  },
  // Les deux bras en croix, qui donnent la silhouette de quadricoptère.
  {
    size: new Cesium.Cartesian3(0.36, ARM * 2.9, 0.26),
    at: new Cesium.Cartesian3(0, 0, 0),
    yaw: 45,
    color: '#12161a',
    edges: true,
  },
  {
    size: new Cesium.Cartesian3(0.36, ARM * 2.9, 0.26),
    at: new Cesium.Cartesian3(0, 0, 0),
    yaw: -45,
    color: '#12161a',
    edges: true,
  },
];

const TRIM = Cesium.Color.fromCssColorString('#00e5ff');

export class DroneModel {
  /** Volumes pleins du châssis : une seule primitive, un seul appel de dessin. */
  private body: Cesium.Primitive;
  /** Arêtes cyan, qui détachent le drone du décor. */
  private edges: Cesium.Primitive;
  /** Repère au sol : c'est lui qui donne le sens de l'altitude. */
  private ring: Cesium.Primitive;

  /** Repère monde du drone, recalculé une fois par image. */
  private frame = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
  /** Repère du marqueur au sol : même position, sans rotation ni altitude. */
  private groundFrame = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

  constructor(
    private viewer: Cesium.Viewer,
    private state: DroneState,
  ) {
    // On calcule la pose AVANT de construire les primitives : elles reçoivent
    // ainsi une matrice correcte dès leur première image.
    this.computeFrames();

    const solid: Cesium.GeometryInstance[] = [];
    const wire: Cesium.GeometryInstance[] = [];

    for (const p of PARTS) {
      // La pose de chaque pièce est cuite dans ses sommets une fois pour
      // toutes : les coordonnées restent petites, donc parfaitement précises.
      const pose = Cesium.Matrix4.fromRotationTranslation(
        Cesium.Matrix3.fromRotationZ((p.yaw ?? 0) * DEG),
        p.at,
      );

      solid.push(
        new Cesium.GeometryInstance({
          geometry: Cesium.BoxGeometry.fromDimensions({
            dimensions: p.size,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          modelMatrix: pose,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(p.color),
            ),
          },
        }),
      );

      if (p.edges) {
        wire.push(
          new Cesium.GeometryInstance({
            geometry: Cesium.BoxOutlineGeometry.fromDimensions({ dimensions: p.size }),
            modelMatrix: pose,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(TRIM.withAlpha(0.85)),
            },
          }),
        );
      }
    }

    // `asynchronous: false` : le drone doit exister dès la première image, pas
    // deux secondes plus tard.
    this.body = new Cesium.Primitive({
      geometryInstances: solid,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: true }),
      asynchronous: false,
      modelMatrix: this.frame,
    });

    this.edges = new Cesium.Primitive({
      geometryInstances: wire,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
      modelMatrix: this.frame,
    });

    // Anneau au sol, sous le drone. Il ne suit pas le cap — un cercle n'a pas
    // d'orientation — d'où son repère séparé.
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

    viewer.scene.primitives.add(this.body);
    viewer.scene.primitives.add(this.edges);
    viewer.scene.primitives.add(this.ring);
  }

  /**
   * Recalcule les repères. À appeler une fois par image, avant le rendu.
   * C'est tout le travail par image : deux matrices, aucune géométrie.
   */
  sync(_dt: number): void {
    this.computeFrames();
    // Les primitives détiennent leur propre copie de la matrice : il faut la
    // leur réécrire, les affecter ne suffirait pas.
    Cesium.Matrix4.clone(this.frame, this.body.modelMatrix);
    Cesium.Matrix4.clone(this.frame, this.edges.modelMatrix);
    Cesium.Matrix4.clone(this.groundFrame, this.ring.modelMatrix);
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
    this.body.show = v;
    this.edges.show = v;
    this.ring.show = v;
  }

  destroy(): void {
    for (const p of [this.body, this.edges, this.ring]) {
      this.viewer.scene.primitives.remove(p);
    }
  }
}
