/**
 * Rendu du bâti.
 *
 * Choix de performance : tous les bâtiments partent dans DEUX primitives
 * groupées (volumes pleins / arêtes) plutôt que dans des centaines d'entités.
 * Une entité Cesium, c'est un objet à évaluer à chaque image ; une instance de
 * géométrie dans un `Primitive`, c'est un bloc envoyé une fois au GPU. À ~600
 * instances la différence n'est pas subtile — et on garde malgré tout la
 * possibilité de recolorer un bâtiment isolé via ses attributs d'instance.
 */

import * as Cesium from 'cesium';
import { DAMAGE_INFO, standingHeight, type Building } from './buildings';
import type { City } from './city';
import { createFacadeAppearance, SURFACE, texturedBox } from './facade';

/** Modes de rendu, cyclés par la touche M. */
export type RenderMode = 'realiste' | 'wireframe' | 'scan';

export const RENDER_LABEL: Record<RenderMode, string> = {
  realiste: 'RÉALISTE',
  wireframe: 'FIL DE FER',
  scan: 'SCAN',
};

const DEG = Math.PI / 180;

/** Teintes de façade, par usage. Volontairement désaturées. */
const WALL_TINTS: Record<Building['kind'], string[]> = {
  residentiel: ['#b9ac97', '#a89a86', '#c6b9a4', '#9d9484'],
  commerce: ['#c2b6a6', '#b0a394', '#bdae9c'],
  bureau: ['#9fa8ad', '#8e979c', '#adb5b9'],
  industriel: ['#8c8e88', '#7d827c', '#9a9c94'],
  civique: ['#c8bda8', '#bdb098', '#d2c8b4'],
};

const ROOF_TINTS = ['#7a4a3c', '#6b5a52', '#5c5f63', '#8a5443', '#4f5358'];
const RUBBLE = '#6b6459';
const BURNT = '#2b2622';

function css(hex: string, alpha = 1): Cesium.Color {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

function hashPick(id: string, arr: string[]): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** Repère local est-nord-haut placé au centre d'une boîte, avec cap. */
function boxMatrix(lon: number, lat: number, height: number, headingDeg: number): Cesium.Matrix4 {
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  if (!headingDeg) return frame;
  const rot = Cesium.Matrix3.fromRotationZ(-headingDeg * DEG);
  return Cesium.Matrix4.multiplyByMatrix3(frame, rot, new Cesium.Matrix4());
}

interface Part {
  id: string;
  matrix: Cesium.Matrix4;
  dims: Cesium.Cartesian3;
  color: Cesium.Color;
  /** Style de surface, voir `SURFACE`. */
  style: number;
  /** Largeur de reference, en metres, pour espacer les travees. */
  bay: number;
}

/** Décompose un bâtiment en morceaux dessinables, dommages compris. */
function partsOf(b: Building): Part[] {
  const parts: Part[] = [];
  const h = standingHeight(b);
  const burnt = b.state === 'burnt';
  const ruined = b.state === 'collapsed' || b.state === 'partial';

  let wall = hashPick(b.id, WALL_TINTS[b.kind]);
  if (burnt) wall = BURNT;
  else if (b.state === 'collapsed') wall = RUBBLE;
  else if (b.state === 'partial') wall = '#8f8577';

  // Corps principal. Un batiment eventre n'a plus de trame de fenetres
  // lisible : on lui donne la surface d'une ruine, pas celle d'une facade.
  parts.push({
    id: `${b.id}:body`,
    matrix: boxMatrix(b.lon, b.lat, b.baseHeight + h / 2, b.heading),
    dims: new Cesium.Cartesian3(b.width, b.depth, h),
    color: css(wall),
    style: ruined || burnt ? SURFACE.rubble : SURFACE.facade,
    bay: (b.width + b.depth) / 2,
  });

  // Toiture : légèrement débordante, elle donne l'échelle vue du ciel.
  // Un bâtiment effondré n'a plus de toit lisible.
  if (!ruined) {
    parts.push({
      id: `${b.id}:roof`,
      matrix: boxMatrix(b.lon, b.lat, b.baseHeight + h + 0.55, b.heading),
      dims: new Cesium.Cartesian3(b.width + 1.4, b.depth + 1.4, 1.1),
      color: css(burnt ? '#1c1916' : hashPick(b.id + 'r', ROOF_TINTS)),
      style: SURFACE.roof,
      bay: b.depth + 1.4,
    });
  }

  // Gravats projetés au sol.
  b.debris.forEach((d, i) => {
    const mLat = d.dy / 111320;
    const mLon = d.dx / (111320 * Math.cos(b.lat * DEG));
    parts.push({
      id: `${b.id}:debris${i}`,
      matrix: boxMatrix(b.lon + mLon, b.lat + mLat, b.baseHeight + d.height / 2, d.rot),
      dims: new Cesium.Cartesian3(d.size, d.size * 0.7, d.height),
      color: css(burnt ? '#211d1a' : RUBBLE),
      style: SURFACE.rubble,
      bay: d.size,
    });
  });

  return parts;
}

export class BuildingRenderer {
  private solid: Cesium.Primitive | null = null;
  private edges: Cesium.Primitive | null = null;
  private mode: RenderMode = 'realiste';
  private diagnostic = false;
  /**
   * Des couleurs sont en attente d'application.
   *
   * Un `Primitive` ne compile sa géométrie qu'à sa PREMIÈRE passe de rendu :
   * avant cela, `getGeometryInstanceAttributes` lève une exception. On ne peut
   * donc pas colorer à la construction — il faut attendre que le primitive
   * concerné soit prêt, d'où ce drapeau consommé par `tick()`.
   */
  private dirty = true;
  /** Couleur « brute » de chaque morceau, pour pouvoir revenir en arrière. */
  private baseColors = new Map<string, Cesium.Color>();
  /** Style et métriques de surface d'origine, mêmes usages que `baseColors`. */
  private baseSurface = new Map<string, [number, number, number]>();
  /** Morceaux appartenant à chaque bâtiment. */
  private partsByBuilding = new Map<string, string[]>();

  constructor(
    private scene: Cesium.Scene,
    private city: City,
  ) {}

  /** (Re)construit toute la géométrie. À rappeler après un désastre. */
  build(): void {
    this.dispose();
    this.baseColors.clear();
    this.baseSurface.clear();
    this.partsByBuilding.clear();

    const solidInstances: Cesium.GeometryInstance[] = [];
    const edgeInstances: Cesium.GeometryInstance[] = [];

    for (const b of this.city.buildings) {
      const ids: string[] = [];
      for (const p of partsOf(b)) {
        ids.push(p.id);
        this.baseColors.set(p.id, p.color);
        this.baseSurface.set(p.id, [p.style, p.bay, p.dims.z]);

        solidInstances.push(
          new Cesium.GeometryInstance({
            id: p.id,
            geometry: texturedBox(p.dims, p.style, p.bay, p.dims.z),
            modelMatrix: p.matrix,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(p.color),
            },
          }),
        );

        // Les gravats n'ont pas d'arête utile : on allège le fil de fer.
        if (p.id.includes(':debris')) continue;
        edgeInstances.push(
          new Cesium.GeometryInstance({
            id: p.id,
            geometry: Cesium.BoxOutlineGeometry.fromDimensions({ dimensions: p.dims }),
            modelMatrix: p.matrix,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.CYAN),
            },
          }),
        );
      }
      this.partsByBuilding.set(b.id, ids);
    }

    this.solid = new Cesium.Primitive({
      geometryInstances: solidInstances,
      appearance: createFacadeAppearance(),
      asynchronous: false,
      releaseGeometryInstances: false,
    });

    this.edges = new Cesium.Primitive({
      geometryInstances: edgeInstances,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
      releaseGeometryInstances: false,
    });
    this.edges.show = false;

    this.scene.primitives.add(this.solid);
    this.scene.primitives.add(this.edges);
    this.dirty = true;
  }

  /**
   * À appeler une fois par image, après le rendu.
   * Applique les couleurs en attente dès que le primitive visible est compilé.
   */
  tick(): void {
    if (!this.dirty) return;
    const target = this.mode === 'realiste' ? this.solid : this.edges;
    if (!target || !target.ready) return;
    this.applyColors();
    this.dirty = false;
  }

  dispose(): void {
    if (this.solid) this.scene.primitives.remove(this.solid);
    if (this.edges) this.scene.primitives.remove(this.edges);
    this.solid = null;
    this.edges = null;
  }

  setRenderMode(mode: RenderMode): void {
    this.mode = mode;
    const globe = this.scene.globe;
    // En mode Google 3D Tiles il n'y a pas de couche d'imagerie, et
    // `skyAtmosphere` peut être absent selon la configuration de la scène.
    const base = this.scene.imageryLayers.get(0);
    const sky = this.scene.skyAtmosphere;
    const scan = mode === 'scan';

    // Relevé technique : plus d'imagerie, un sol neutre, du volume en moins.
    if (base) base.show = !scan;
    if (sky) sky.show = !scan;
    globe.baseColor = Cesium.Color.fromCssColorString(scan ? '#04080c' : '#1b2a1f');
    this.scene.fog.density = scan ? 0.0004 : 0.00012;

    if (this.solid) this.solid.show = mode === 'realiste';
    if (this.edges) this.edges.show = mode !== 'realiste';
    this.dirty = true;
  }

  getRenderMode(): RenderMode {
    return this.mode;
  }

  setDiagnostic(on: boolean): void {
    this.diagnostic = on;
    this.dirty = true;
  }

  /** Recolore un seul bâtiment — utilisé quand le simulateur le détruit. */
  refreshBuilding(id: string): void {
    const ids = this.partsByBuilding.get(id);
    if (!ids) return;
    const b = this.city.buildings.find((x) => x.id === id);
    if (!b) return;
    const target = this.mode === 'realiste' ? this.solid : this.edges;
    if (!target?.ready) {
      this.dirty = true;
      return;
    }
    for (const pid of ids) this.paint(pid, b);
  }

  private applyColors(): void {
    if (!this.solid || !this.edges) return;
    for (const b of this.city.buildings) {
      const ids = this.partsByBuilding.get(b.id);
      if (!ids) continue;
      for (const pid of ids) this.paint(pid, b);
    }
  }

  /**
   * Couleur finale d'un morceau.
   *
   * En vue brute on montre la ville telle qu'elle est : le sinistre se lit dans
   * la GÉOMÉTRIE (hauteur écrêtée, gravats), pas dans un code couleur. En vue
   * diagnostique on bascule sur la classification. C'est toute la différence
   * entre constater et interpréter.
   */
  private paint(pid: string, b: Building): void {
    // En diagnostic, les bâtiments INTACTS restent neutres. Les peindre en vert
    // vif noierait les quelques cibles qui comptent sous 130 aplats colorés :
    // une vue de diagnostic doit faire ressortir l'anomalie, pas la normalité.
    const classified =
      b.state === 'intact'
        ? css(this.mode === 'realiste' ? '#6f7a80' : '#2f4a52')
        : css(DAMAGE_INFO[b.state].color);

    const target =
      this.diagnostic || this.mode === 'scan'
        ? classified
        : this.mode === 'wireframe'
          ? css('#00e5ff')
          : (this.baseColors.get(pid) ?? Cesium.Color.GRAY);

    const prim = this.mode === 'realiste' ? this.solid : this.edges;
    if (!prim) return;
    try {
      const attrs = prim.getGeometryInstanceAttributes(pid);
      if (!attrs) return;
      // La texture doit disparaître en vue diagnostique : une trame de fenêtres
      // sous un aplat de classification brouillerait la lecture. Le diagnostic
      // répond « quel est l'état de ce bâtiment », pas « à quoi ressemble-t-il ».
      //
      // L'interrupteur voyage dans le canal ALPHA, seul canal encore libre qui
      // reste modifiable à chaud — l'attribut de surface, lui, est figé dans la
      // géométrie. Le rendu étant opaque, cet alpha n'a aucun autre effet.
      const flat = this.diagnostic || this.mode === 'scan';
      attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(
        target.withAlpha(flat ? 0.5 : 1),
        attrs.color,
      );
    } catch {
      // Un morceau sans arêtes (gravats) n'existe pas dans le primitive d'arêtes.
    }
  }
}
