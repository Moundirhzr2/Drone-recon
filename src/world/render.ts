/**
 * Rendu du bâti.
 *
 * CHOIX DE PERFORMANCE
 * --------------------
 * Les bâtiments sont regroupés dans des primitives Cesium plutôt que dans des
 * entités. Une entité est un objet réévalué à chaque image ; une instance de
 * géométrie dans un `Primitive` est un bloc envoyé une fois au GPU. On garde
 * malgré tout la possibilité de recolorer un bâtiment isolé, via ses attributs
 * d'instance.
 *
 * DÉCOUPAGE EN CARREAUX
 * ---------------------
 * Un effondrement change la géométrie — hauteur écrêtée, gravats — et la seule
 * façon de le montrer est de reconstruire la primitive qui contient le
 * bâtiment. Avec la ville générée (76 bâtiments), tout reconstruire coûtait
 * 20 ms. Avec les 2 282 bâtiments réels, ce serait plusieurs centaines de
 * millisecondes à chaque dégât.
 *
 * La ville est donc découpée en carreaux de 100 m, chacun avec ses propres
 * primitives. Un dégât ne reconstruit que le carreau touché, et les
 * reconstructions en attente sont étalées sur plusieurs images (`tick`) : une
 * explosion qui touche vingt carreaux se voit se propager en quelques dixièmes
 * de seconde au lieu de figer l'écran.
 */

import * as Cesium from 'cesium';
import { DAMAGE_INFO, standingHeight, type Building, type BuildingKind } from './buildings';
import type { City } from './city';
import {
  createFacadeAppearance,
  FACADE_KIND,
  footprintOutline,
  footprintRoof,
  footprintWalls,
  ROOF_CODE,
  SURFACE,
  texturedBox,
  type FacadeVariant,
  type RoofVariant,
} from './facade';

/** Modes de rendu, cyclés par la touche M. */
export type RenderMode = 'realiste' | 'wireframe' | 'scan';

export const RENDER_LABEL: Record<RenderMode, string> = {
  realiste: 'RÉALISTE',
  wireframe: 'FIL DE FER',
  scan: 'SCAN',
};

const DEG = Math.PI / 180;

/** Côté d'un carreau, en mètres. */
const CHUNK = 100;

/**
 * Reconstructions permises par image. Un carreau coûte ~3 ms à reconstruire,
 * puis autant à sa première passe de rendu, où Cesium assemble sa géométrie.
 * Mesuré sur une GTX 1650 pendant une explosion, deux par image faisaient des
 * pics de 20 ms ; une seule étale la vague, qui se lit d'ailleurs mieux.
 */
const REBUILDS_PER_FRAME = 1;

/**
 * Enduits de façade, par époque.
 *
 * La vieille ville de Mulhouse est un nuancier : ocres, roses, crèmes et
 * jaunes paille, souvent rehaussés de grès. Les immeubles d'après-guerre sont
 * plus sages, les récents franchement gris. Les teintes restent un peu sourdes :
 * l'éclairage de Cesium éclaircit d'environ moitié une façade tournée vers la
 * caméra.
 */
const PLASTERS: Record<0 | 1 | 2, string[]> = {
  0: ['#cdb58a', '#c7a57e', '#cba99a', '#c4917b', '#d4c9b1', '#bfb4a1', '#cdbf8b', '#b8a58b'],
  1: ['#c3beb2', '#bbb2a1', '#cbc5b6', '#aea79b', '#c4b89f', '#b7bab6'],
  2: ['#c5c5c1', '#b4b8ba', '#a7abad', '#cfccc5', '#9c9fa1', '#bdb9af'],
};

/** Matériaux propres à certains usages, quelle que soit l'époque. */
const SPECIAL_WALLS: Partial<Record<BuildingKind, string[]>> = {
  industriel: ['#9a816d', '#858a8e', '#a08c78'],
  // Le grès rose des Vosges : c'est celui du temple Saint-Étienne et de la
  // plupart des édifices anciens de la région.
  religieux: ['#b98a7a', '#a87c6e'],
  annexe: ['#a8a094', '#978f84', '#b2a898'],
  sportif: ['#b9bcbd', '#a9adaf'],
};

/**
 * Couvertures, par matériau. Les tuiles de terre cuite dominent la vieille
 * ville ; ardoises et zinc coiffent les immeubles bourgeois ; les terrasses
 * gravillonnées, les immeubles récents.
 */
const ROOF_TINTS_BY_CODE: Record<number, string[]> = {
  [ROOF_CODE.tuiles]: ['#8e503b', '#7f4636', '#98593f', '#744132', '#88513e', '#9c624a'],
  [ROOF_CODE.ardoises]: ['#51575e', '#5a6067', '#4b5057'],
  [ROOF_CODE.metal]: ['#8b9297', '#7f878d', '#979da1'],
  [ROOF_CODE.beton]: ['#8f8b83', '#86827b', '#98948c', '#7e7a73'],
  [ROOF_CODE.verre]: ['#3d4751'],
};

/**
 * Couverture d'un bâtiment : son matériau déclaré par l'IGN, et sa forme — en
 * pente si le faîte dépasse la gouttière d'au moins un mètre. Quand le matériau
 * manque (deux bâtiments sur trois), on le déduit : une terrasse est en béton,
 * un grand volume industriel en bac acier, et un toit en pente est en tuiles,
 * sauf un sur sept, en ardoises.
 */
function roofOf(b: Building, seed: number): RoofVariant {
  const pitched = (b.roofPitch ?? (eraOf(b.year) < 2 ? 3 : 0)) >= 1;
  let code: number;
  switch (b.roofMaterial) {
    case 'tuiles':
      code = ROOF_CODE.tuiles;
      break;
    case 'ardoises':
      code = ROOF_CODE.ardoises;
      break;
    case 'metal':
      code = ROOF_CODE.metal;
      break;
    case 'beton':
      code = ROOF_CODE.beton;
      break;
    case 'verre':
      code = ROOF_CODE.verre;
      break;
    default:
      if (!pitched) code = ROOF_CODE.beton;
      else if (b.kind === 'industriel' || b.kind === 'sportif') code = ROOF_CODE.metal;
      else code = seed < 0.15 ? ROOF_CODE.ardoises : ROOF_CODE.tuiles;
  }
  return [code + (pitched ? 10 : 0), seed];
}

/** Époque de construction, lue par le shader de façade. */
function eraOf(year: number): 0 | 1 | 2 {
  return year < 1914 ? 0 : year < 1975 ? 1 : 2;
}

/** Nombre entre 0 et 1, stable pour un identifiant donné. */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 10007) / 10007;
}

/**
 * Style de façade : époque, usage, graine, commerces au rez-de-chaussée. Un
 * immeuble d'habitation ancien ou d'après-guerre d'au moins trois niveaux a
 * une chance sur deux d'avoir des boutiques en pied : c'est la règle, plus que
 * l'exception, dans le centre de Mulhouse.
 */
function facadeVariant(b: Building): FacadeVariant {
  const era = eraOf(b.year);
  const seed = hash01(b.id);
  const shop =
    b.kind === 'commerce' || (b.kind === 'residentiel' && era < 2 && b.height >= 9 && seed < 0.5)
      ? 1
      : 0;
  return [era, FACADE_KIND[b.kind], seed, shop];
}

function wallTint(b: Building): string {
  return hashPick(b.id, SPECIAL_WALLS[b.kind] ?? PLASTERS[eraOf(b.year)]);
}

const ROOF_TINTS = ['#7a4a3c', '#6b5a52', '#5c5f63', '#8a5443', '#4f5358', '#7c5140'];
const RUBBLE = '#6b6459';
/** Maçonnerie noircie ; le shader y ajoute les baies vides et la suie. */
const BURNT = '#5b534b';

function css(hex: string, alpha = 1): Cesium.Color {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

function hashPick(id: string, arr: string[]): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** Repère local est-nord-haut en un point, avec une rotation éventuelle. */
function localFrame(lon: number, lat: number, height: number, headingDeg = 0): Cesium.Matrix4 {
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  if (!headingDeg) return frame;
  const rot = Cesium.Matrix3.fromRotationZ(-headingDeg * DEG);
  return Cesium.Matrix4.multiplyByMatrix3(frame, rot, new Cesium.Matrix4());
}

/** Un morceau dessinable d'un bâtiment. */
interface Part {
  id: string;
  solid: Cesium.GeometryInstance;
  /** Arêtes pour les vues techniques ; absentes pour les gravats. */
  edge?: Cesium.GeometryInstance;
  base: Cesium.Color;
}

/**
 * Signature géométrique d'un bâtiment : si elle change, son carreau doit être
 * reconstruit. La couleur n'en fait pas partie, elle se change à chaud.
 */
function signature(b: Building): string {
  return `${b.state}|${Math.round(b.damage * 20)}|${b.debris.length}`;
}

interface Chunk {
  key: string;
  buildings: Building[];
  solid: Cesium.Primitive | null;
  edges: Cesium.Primitive | null;
  /** Morceaux de chaque bâtiment, par identifiant. */
  parts: Map<string, string[]>;
  base: Map<string, Cesium.Color>;
  signatures: Map<string, string>;
  /** Centre du carreau, pour reconstruire d'abord ce qui est près de la caméra. */
  center: Cesium.Cartesian3;
  dirty: boolean;
  repaint: boolean;
}

export class BuildingRenderer {
  private chunks = new Map<string, Chunk>();
  private chunkOf = new Map<string, Chunk>();
  private mode: RenderMode = 'realiste';
  private diagnostic = false;
  /** Densité du brouillard hors vue scan, fixée par le profil de qualité. */
  private fogBeforeScan: number | null = null;
  private appearance = createFacadeAppearance();

  constructor(
    private scene: Cesium.Scene,
    city: City,
  ) {
    const mLon = 111320 * Math.cos((city.center.lat * Math.PI) / 180);
    for (const b of city.buildings) {
      const east = (b.lon - city.center.lon) * mLon;
      const north = (b.lat - city.center.lat) * 111320;
      const key = `${Math.floor(east / CHUNK)}:${Math.floor(north / CHUNK)}`;
      let chunk = this.chunks.get(key);
      if (!chunk) {
        const [cx, cy] = key.split(':').map(Number);
        chunk = {
          key,
          buildings: [],
          solid: null,
          edges: null,
          parts: new Map(),
          base: new Map(),
          signatures: new Map(),
          center: Cesium.Cartesian3.fromDegrees(
            city.center.lon + ((cx + 0.5) * CHUNK) / mLon,
            city.center.lat + ((cy + 0.5) * CHUNK) / 111320,
            b.baseHeight,
          ),
          dirty: true,
          repaint: false,
        };
        this.chunks.set(key, chunk);
      }
      chunk.buildings.push(b);
      this.chunkOf.set(b.id, chunk);
    }
  }

  /** Nombre de carreaux, et combien attendent une reconstruction. */
  get stats(): { chunks: number; pending: number } {
    let pending = 0;
    for (const c of this.chunks.values()) if (c.dirty) pending++;
    return { chunks: this.chunks.size, pending };
  }

  /**
   * Construit toute la ville d'un coup. Réservé au démarrage : ensuite, les
   * changements passent par `sync` et sont étalés par `tick`.
   */
  build(): void {
    for (const chunk of this.chunks.values()) this.rebuild(chunk);
  }

  /**
   * Repère les bâtiments dont la géométrie a changé et marque leurs carreaux.
   * À appeler quand le simulateur de désastres a modifié des états.
   */
  sync(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.dirty) continue;
      for (const b of chunk.buildings) {
        if (chunk.signatures.get(b.id) !== signature(b)) {
          chunk.dirty = true;
          break;
        }
      }
    }
  }

  /**
   * À appeler une fois par image, après le rendu : reconstruit quelques
   * carreaux en attente, les plus proches de la caméra d'abord, et applique les
   * couleurs en attente.
   */
  tick(): void {
    const pending = [...this.chunks.values()].filter((c) => c.dirty);
    if (pending.length) {
      const eye = this.scene.camera.positionWC;
      pending.sort(
        (a, b) =>
          Cesium.Cartesian3.distanceSquared(a.center, eye) -
          Cesium.Cartesian3.distanceSquared(b.center, eye),
      );
      for (const chunk of pending.slice(0, REBUILDS_PER_FRAME)) this.rebuild(chunk);
    }

    for (const chunk of this.chunks.values()) {
      if (!chunk.repaint) continue;
      const target = this.mode === 'realiste' ? chunk.solid : chunk.edges;
      if (!target || !target.ready) continue;
      for (const b of chunk.buildings) {
        for (const pid of chunk.parts.get(b.id) ?? []) this.paint(chunk, pid, b);
      }
      chunk.repaint = false;
    }
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) this.drop(chunk);
  }

  setRenderMode(mode: RenderMode): void {
    this.mode = mode;
    const globe = this.scene.globe;
    const sky = this.scene.skyAtmosphere;
    const scan = mode === 'scan';

    // Relevé technique : plus d'imagerie, un sol neutre, du volume en moins.
    for (let i = 0; i < this.scene.imageryLayers.length; i++) {
      this.scene.imageryLayers.get(i).show = !scan;
    }
    if (sky) sky.show = !scan;
    globe.baseColor = Cesium.Color.fromCssColorString(scan ? '#04080c' : '#1b2a1f');
    // Brouillard plus dense en scan, puis celui du profil de qualité au retour.
    const fog = this.scene.fog;
    if (scan && this.fogBeforeScan === null) {
      this.fogBeforeScan = fog.density;
      fog.density = 0.0004;
    } else if (!scan && this.fogBeforeScan !== null) {
      fog.density = this.fogBeforeScan;
      this.fogBeforeScan = null;
    }

    for (const chunk of this.chunks.values()) {
      if (chunk.solid) chunk.solid.show = mode === 'realiste';
      if (chunk.edges) chunk.edges.show = mode !== 'realiste';
      chunk.repaint = true;
    }
  }

  getRenderMode(): RenderMode {
    return this.mode;
  }

  setDiagnostic(on: boolean): void {
    this.diagnostic = on;
    for (const chunk of this.chunks.values()) chunk.repaint = true;
  }

  // ------------------------------------------------------------------------
  // Construction d'un carreau
  // ------------------------------------------------------------------------

  private rebuild(chunk: Chunk): void {
    const solids: Cesium.GeometryInstance[] = [];
    const edges: Cesium.GeometryInstance[] = [];
    chunk.parts.clear();
    chunk.base.clear();

    for (const b of chunk.buildings) {
      const ids: string[] = [];
      for (const part of this.partsOf(b)) {
        ids.push(part.id);
        chunk.base.set(part.id, part.base);
        solids.push(part.solid);
        if (part.edge) edges.push(part.edge);
      }
      chunk.parts.set(b.id, ids);
      chunk.signatures.set(b.id, signature(b));
    }

    // L'ancien carreau reste affiché jusqu'ici : le nouveau est construit au
    // rendu suivant, de manière synchrone, donc sans image vide entre les deux.
    this.drop(chunk);

    chunk.solid = new Cesium.Primitive({
      geometryInstances: solids,
      appearance: this.appearance,
      asynchronous: false,
      releaseGeometryInstances: false,
      // Les ombres portées ne coûtent que si le profil de rendu les active.
      shadows: Cesium.ShadowMode.ENABLED,
    });
    chunk.edges = new Cesium.Primitive({
      geometryInstances: edges,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
      releaseGeometryInstances: false,
    });
    chunk.solid.show = this.mode === 'realiste';
    chunk.edges.show = this.mode !== 'realiste';

    this.scene.primitives.add(chunk.solid);
    this.scene.primitives.add(chunk.edges);
    chunk.dirty = false;
    chunk.repaint = false;
  }

  private drop(chunk: Chunk): void {
    if (chunk.solid) this.scene.primitives.remove(chunk.solid);
    if (chunk.edges) this.scene.primitives.remove(chunk.edges);
    chunk.solid = null;
    chunk.edges = null;
  }

  /** Décompose un bâtiment en morceaux dessinables, dommages compris. */
  private partsOf(b: Building): Part[] {
    const parts: Part[] = [];
    const h = standingHeight(b);
    const burnt = b.state === 'burnt';
    const ruined = b.state === 'collapsed' || b.state === 'partial';

    let wall = wallTint(b);
    if (burnt) wall = BURNT;
    else if (b.state === 'collapsed') wall = RUBBLE;
    else if (b.state === 'partial') wall = '#8f8577';
    const roofVariant = roofOf(b, hash01(b.id + 'r'));
    const roofTints = b.footprint ? ROOF_TINTS_BY_CODE[roofVariant[0] % 10] : ROOF_TINTS;
    const roof = burnt ? '#1c1916' : ruined ? RUBBLE : hashPick(b.id + 'r', roofTints);

    // Un bâtiment éventré n'a plus de trame de fenêtres lisible : on lui donne
    // la surface d'une ruine, pas celle d'une façade. Un bâtiment incendié, lui,
    // garde ses murs : ce sont ses baies vides et noircies qui le signalent.
    const wallStyle = burnt ? SURFACE.charred : ruined ? SURFACE.rubble : SURFACE.facade;
    const roofStyle = ruined || burnt ? SURFACE.rubble : SURFACE.roof;

    if (b.footprint) {
      // Bâtiment réel : son contour exact, posé sur son altitude IGN, et sa
      // couverture réelle tant qu'il est debout.
      const frame = localFrame(b.lon, b.lat, b.baseHeight);
      const variant = facadeVariant(b);
      parts.push(
        this.part(
          `${b.id}:body`,
          b,
          footprintWalls(b.footprint, h, wallStyle, variant),
          frame,
          wall,
          () => footprintOutline(b.footprint!, h),
        ),
        this.part(
          `${b.id}:roof`,
          b,
          footprintRoof(
            b.footprint,
            h,
            roofStyle === SURFACE.roof ? SURFACE.roofReal : roofStyle,
            roofVariant,
          ),
          frame,
          roof,
        ),
      );
    } else {
      // Bâtiment généré : une boîte, et une toiture légèrement débordante qui
      // donne l'échelle vue du ciel.
      const dims = new Cesium.Cartesian3(b.width, b.depth, h);
      const bodyFrame = localFrame(b.lon, b.lat, b.baseHeight + h / 2, b.heading);
      parts.push(
        this.part(
          `${b.id}:body`,
          b,
          texturedBox(dims, wallStyle, (b.width + b.depth) / 2, h, facadeVariant(b)),
          bodyFrame,
          wall,
          () =>
            Cesium.BoxOutlineGeometry.createGeometry(
              Cesium.BoxOutlineGeometry.fromDimensions({ dimensions: dims }),
            )!,
        ),
      );
      if (!ruined) {
        const roofDims = new Cesium.Cartesian3(b.width + 1.4, b.depth + 1.4, 1.1);
        parts.push(
          this.part(
            `${b.id}:roof`,
            b,
            texturedBox(roofDims, SURFACE.roof, b.depth + 1.4, 1.1),
            localFrame(b.lon, b.lat, b.baseHeight + h + 0.55, b.heading),
            roof,
          ),
        );
      }
    }

    // Gravats projetés au sol.
    b.debris.forEach((d, i) => {
      const mLat = d.dy / 111320;
      const mLon = d.dx / (111320 * Math.cos(b.lat * DEG));
      const dims = new Cesium.Cartesian3(d.size, d.size * 0.7, d.height);
      parts.push(
        this.part(
          `${b.id}:debris${i}`,
          b,
          texturedBox(dims, SURFACE.rubble, d.size, d.height),
          localFrame(b.lon + mLon, b.lat + mLat, b.baseHeight + d.height / 2, d.rot),
          burnt ? '#211d1a' : RUBBLE,
        ),
      );
    });

    return parts;
  }

  private part(
    id: string,
    b: Building,
    geometry: Cesium.Geometry,
    modelMatrix: Cesium.Matrix4,
    hex: string,
    outline?: () => Cesium.Geometry,
  ): Part {
    const base = css(hex);
    return {
      id,
      base,
      solid: new Cesium.GeometryInstance({
        id,
        geometry,
        modelMatrix,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(this.colorFor(b, base, 'solid')),
        },
      }),
      edge: outline
        ? new Cesium.GeometryInstance({
            id,
            geometry: outline(),
            modelMatrix,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                this.colorFor(b, base, 'edge'),
              ),
            },
          })
        : undefined,
    };
  }

  // ------------------------------------------------------------------------
  // Couleurs
  // ------------------------------------------------------------------------

  /**
   * Couleur finale d'un morceau.
   *
   * En vue brute on montre la ville telle qu'elle est : le sinistre se lit dans
   * la GÉOMÉTRIE (hauteur écrêtée, gravats), pas dans un code couleur. En vue
   * diagnostique on bascule sur la classification. C'est toute la différence
   * entre constater et interpréter.
   *
   * Le canal ALPHA porte l'interrupteur de texture du shader de façades : il
   * est le seul encore modifiable à chaud, `surf` étant figé dans la géométrie.
   * Le rendu étant opaque, cet alpha n'a aucun autre effet.
   */
  private colorFor(b: Building, base: Cesium.Color, target: 'solid' | 'edge'): Cesium.Color {
    // En diagnostic, les bâtiments INTACTS restent neutres. Les peindre en vert
    // vif noierait les quelques cibles qui comptent sous des centaines
    // d'aplats : une vue de diagnostic doit faire ressortir l'anomalie.
    const classified =
      b.state === 'intact'
        ? css(target === 'solid' ? '#6f7a80' : '#2f4a52')
        : css(DAMAGE_INFO[b.state].color);

    const flat = this.diagnostic || this.mode === 'scan';
    if (target === 'edge') {
      return flat ? classified : this.mode === 'wireframe' ? css('#00e5ff') : base;
    }
    return (flat ? classified : base).withAlpha(flat ? 0.5 : 1);
  }

  private paint(chunk: Chunk, pid: string, b: Building): void {
    const prim = this.mode === 'realiste' ? chunk.solid : chunk.edges;
    if (!prim) return;
    const base = chunk.base.get(pid) ?? Cesium.Color.GRAY;
    try {
      const attrs = prim.getGeometryInstanceAttributes(pid);
      if (!attrs) return;
      attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(
        this.colorFor(b, base, this.mode === 'realiste' ? 'solid' : 'edge'),
        attrs.color,
      );
    } catch {
      // Un morceau sans arêtes (toit, gravats) n'existe pas dans le primitive
      // d'arêtes.
    }
  }
}
