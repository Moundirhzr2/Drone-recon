/**
 * Ville photoréaliste : le relevé 3D de Google (Photorealistic 3D Tiles), le
 * même que celui de Google Earth, à la place des bâtiments dessinés.
 *
 * CE QUI RESTE À LA SIMULATION
 * ----------------------------
 * Le maillage de Google est une peau d'un seul tenant : on ne peut ni y
 * effondrer un bâtiment, ni savoir où l'un finit et où l'autre commence. La
 * simulation reste donc entièrement sur les données de l'IGN — contours,
 * hauteurs, vulnérabilité —, et le maillage n'est qu'un décor, retouché là où
 * un bâtiment change d'état :
 *
 *  - effondré ou éventré : on l'efface du maillage en suivant son contour IGN,
 *    et on dessine à sa place notre version en ruine (`render.ts`) ; autour,
 *    la poussière retombée couvre le sol, les arbres et les voisins ;
 *  - incendié : on le noircit, par plaques et en traînées ;
 *  - fissuré : rien, des fissures ne se voient pas depuis un drone.
 *
 * Les vues techniques — diagnostic, fil de fer, scan — reviennent à la ville
 * dessinée : une classification se lit mieux sur des volumes nets que sur une
 * photographie.
 *
 * UNE CARTE DES RUINES, PAS DES DÉCOUPES
 * --------------------------------------
 * Effacer et noircir passent par une seule texture vue de dessus : le canal
 * rouge marque les contours à effacer, le vert ceux à noircir, l'alpha la
 * poussière. Un shader posé sur le relevé y lit, pour chaque pixel, ce qui se
 * trouve sous lui.
 *
 * La poussière a une seconde raison d'être : la photographie garde les ombres
 * que portaient les bâtiments effacés, et celles des cours étroites qu'ils
 * fermaient. Sans elle, ces taches bleu nuit restaient au sol près des
 * ruines, comme des lambeaux d'ombre sans rien pour les porter.
 *
 * Les découpes de Cesium (`ClippingPolygonCollection`) faisaient la même chose
 * pour un prix intenable : sur une GTX 1650, les 23 ruines du départ ajoutaient
 * 12 ms de processeur à chaque image, et la ville réelle plafonnait à 30 images
 * par seconde. La texture coûte une lecture par pixel, qu'il y ait une ruine ou
 * trois cents : 60 images par seconde, comme sans rien effacer.
 *
 * LE SOL
 * ------
 * En vue réaliste, tout le sol vient du relevé, et le globe de l'IGN est
 * masqué ; le fond de chaque ruine est un sol à nous, posé sur le relief. Le
 * garder en le découpant « à l'envers », pour ne le montrer qu'au fond des
 * ruines, plantait Cesium 1.145 au bout de quelques minutes (« Cannot read
 * properties of undefined (reading 'eastIndicesNorthToSouth') ») : une tuile
 * de sol entièrement hors des polygones n'est jamais dessinée, donc n'a aucun
 * maillage, et le remplissage de ses voisines allait le lire. Le laisser
 * entier sous le relevé coûtait six millisecondes par image, pour ne servir
 * qu'au travers des découpes : une simple nappe sous la ville en tient lieu
 * (voir `underlayOf`).
 *
 * ALTITUDES
 * ---------
 * L'IGN donne des altitudes au-dessus du niveau de la mer ; Google, des
 * hauteurs au-dessus de l'ellipsoïde. Toute la scène est dans la référence de
 * l'IGN (voir `viewer.ts`) : c'est le maillage de Google qu'on abaisse de
 * l'écart entre les deux, l'ondulation du géoïde (`CONFIG.photoreal`).
 *
 * CONDITIONS D'UTILISATION
 * ------------------------
 * Google impose d'afficher son logo et ses sources à l'écran — d'où les
 * crédits, masqués en ville dessinée et affichés ici — et interdit de stocker
 * les tuiles : elles sont lues en continu, jamais enregistrées.
 */

import * as Cesium from 'cesium';
import { CONFIG } from '../core/config';
import type { Building, DamageState } from './buildings';
import type { City } from './city';
import type { QualitySettings } from './quality';
import type { MaskJob, MaskResult } from './ruinsMask.worker';

/** États pour lesquels le bâtiment réel est effacé et redessiné par nous. */
export const REDRAWN: ReadonlySet<DamageState> = new Set<DamageState>(['partial', 'collapsed']);

/**
 * Débord de l'effacement autour d'une ruine, en mètres. Le relevé de Google et
 * le contour de l'IGN ne coïncident pas toujours, et les avant-toits dépassent
 * des murs : avec 60 cm de débord, des bords de toit restaient suspendus
 * au-dessus des gravats ; avec 1,5 m encore, là où le relevé était décalé de
 * 2,5 m. L'effacement déborde donc de 3 m vers la rue — les gravats y
 * débordent aussi, comme ceux d'un vrai effondrement recouvrent le trottoir —,
 * mais jamais sur un voisin resté debout (voir `NEIGHBOR_MARGIN` et
 * `FREE_MARGIN`).
 */
const CUT_MARGIN = 3;

/**
 * Marge laissée aux voisins debout, en mètres, du côté qu'ils partagent avec
 * la ruine. Leur relevé déborde souvent de leur contour IGN : les rogner au ras
 * du contour ouvrait leur peau, qui n'a rien derrière. Plus large, elle
 * laisserait debout un pan de la ruine contre eux ; leur mur mitoyen se dresse
 * juste au-delà (`render.ts`).
 */
export const NEIGHBOR_MARGIN = 0.6;

/**
 * Marge laissée aux voisins debout sur leurs autres côtés — rue, cour — où
 * elle ne peut rien garder de la ruine. Sur la place de la Réunion, 17 % des
 * surfaces hautes du relevé débordent des contours IGN : 4,7 points dans les
 * 60 premiers centimètres, 4,2 de plus jusqu'à 1,5 m. Avec la seule marge
 * mitoyenne, les ruines entamaient aussi la façade sur rue de leurs voisins,
 * ouverte de haut en bas.
 */
const FREE_MARGIN = 1.5;

/** Débord de la suie autour d'un bâtiment incendié, en mètres. */
const SOOT_MARGIN = 0.6;

/**
 * Finesse de la carte des ruines : un pixel pour tant de mètres, au mieux.
 * Un mètre suffit, les bords étant lissés par le filtrage de la texture ; à
 * 50 cm, chaque mise à jour coûtait quatre fois plus.
 */
const MASK_RESOLUTION = 1;
/** Côté maximal de la carte, en pixels. */
const MASK_MAX = 1536;
/** Délai minimal entre deux mises à jour de la carte, en millisecondes. */
const MASK_INTERVAL = 400;

/** Poussière au fond d'une ruine, sous les gravats. */
const DUST = Cesium.Color.fromCssColorString('#6d655b');

/**
 * Hauteur de ce fond par rapport au relief, en mètres. Il couvre la bande
 * effacée, où les marges des voisins gardent le sol du relevé : un peu plus
 * bas que lui (qui s'écarte du relief de 20 cm au plus, à 2 % près), il lui
 * laisse la place au lieu de le disputer pixel à pixel.
 */
const FLOOR_OFFSET = -0.15;

/**
 * Poussière retombée autour des ruines : étalement, en mètres (écart type du
 * flou), et gain, qui la rend pleine au bord de l'effacement. Elle s'estompe
 * sur une quinzaine de mètres : ce que couvrent les ombres des bâtiments
 * effacés, pour la plupart.
 */
const DUST_SPREAD = 8;
const DUST_GAIN = 2.5;
/**
 * Sa teinte sur le relevé, qui n'est pas éclairé par Cesium : celle des fonds
 * de ruine une fois éclairés (#786f64 à l'écran), pour qu'on ne voie pas où
 * le relevé s'arrête. En couleurs linéaires, comme le matériau que le shader
 * reçoit : la même valeur à l'écran ressortait deux fois trop claire.
 */
const DUST_TINT = new Cesium.Cartesian3(0.187, 0.159, 0.127);

/**
 * Sous-sol (voir `underlayOf`) : profondeur sous le relief et pas de sa
 * grille, en mètres, et couleur — de la terre dans l'ombre.
 */
const UNDERLAY_DEPTH = 2;
const UNDERLAY_STEP = 10;
const UNDERLAY = Cesium.Color.fromCssColorString('#57514a');

/** Hauteur du sol, en référence IGN. */
type GroundAt = (lon: number, lat: number) => number;

/**
 * Pour chaque pixel du relevé : sa position dans le repère local du
 * centre-ville, puis ce que la carte des ruines dit de cet endroit.
 */
const RUINS_SHADER = /* glsl */ `
float ruinsHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float ruinsNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(ruinsHash(i), ruinsHash(i + vec2(1.0, 0.0)), u.x),
    mix(ruinsHash(i + vec2(0.0, 1.0)), ruinsHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 local = (u_eyeToLocal * vec4(fsInput.attributes.positionEC, 1.0)).xyz;
  // Orientation de la surface, que le relevé ne fournit pas : tirée des
  // dérivées de la position, avant tout branchement, où elles ne seraient
  // plus définies.
  vec3 facing = normalize(cross(dFdx(local), dFdy(local)));
  vec2 uv = (local.xy - u_extent.xy) / u_extent.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return;
  vec4 ruins = texture(u_ruins, uv);
  // La ruine elle-même.
  if (ruins.r > 0.75) discard;
  // La marge laissée à un voisin debout : ce qui dépasse son toit appartient à
  // la ruine, un bord de toit qui resterait suspendu au-dessus des gravats.
  if (ruins.r > 0.25 && local.z > u_heights.x + ruins.b * u_heights.y) discard;

  // Couleurs linéaires, comme celles du matériau.
  vec3 color = material.diffuse;
  // Poussière : elle se dépose sur ce qui regarde le ciel — sol, toits,
  // feuillage — bien moins sur les façades, par plaques, et d'autant plus sur
  // ce qui est sombre et bleuté : les ombres portées, éclairées par le seul
  // ciel.
  if (ruins.a > 0.0) {
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float shade = (1.0 - smoothstep(0.01, 0.06, lum)) * smoothstep(0.0, 0.02, color.b - color.r);
    float settle = mix(0.3, 1.0, smoothstep(0.45, 0.85, abs(facing.z)));
    float patches = 0.75 + 0.5 * ruinsNoise(local.xy * 0.15);
    float amount = clamp(ruins.a * settle * patches * (0.8 + 0.5 * shade), 0.0, 0.85);
    color = mix(color, u_dust * (0.75 + 1.5 * lum), amount);
  }
  // Suie : par plaques, et en traînées verticales, comme au-dessus des
  // fenêtres d'où sortaient les flammes.
  if (ruins.g > 0.0) {
    float streaks = ruinsNoise(vec2(local.x * 0.5, local.z * 0.12))
      + ruinsNoise(vec2(local.y * 0.5, local.z * 0.12 + 17.0));
    float soot = 0.55 + 0.25 * streaks + 0.2 * ruinsNoise(local.xy * 0.3 + local.z * 0.25);
    color *= 1.0 - ruins.g * clamp(soot, 0.0, 0.97);
  }
  material.diffuse = color;
}
`;

/** La ville photoréaliste est-elle demandée, et possible ? */
export function wantsPhotoreal(): boolean {
  if (new URLSearchParams(window.location.search).get('ville') === 'dessinee') return false;
  return Boolean(CONFIG.ionToken || CONFIG.googleKey);
}

export class PhotorealCity {
  private shader: Cesium.CustomShader;
  /** Du repère de la caméra au repère local du centre-ville, pour le shader. */
  private eyeToLocal = new Cesium.Matrix4();
  private toLocal: Cesium.Matrix4;
  /** Emprise de la carte des ruines : origine et taille, en mètres locaux. */
  private extent: Cesium.Cartesian4;
  /** Codage des hauteurs dans la carte : altitude du niveau 0, étendue. */
  private heights: Cesium.Cartesian2;
  private maskSize: { width: number; height: number };
  private metersPerPixel: number;
  /** Sous le relevé, de quoi arrêter le regard au travers des découpes. */
  private underlay: Cesium.Primitive;
  /** Bâtiments effacés et noircis, tels qu'ils sont appliqués. */
  private applied = '';
  private lastMask = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Fonds des ruines, et leurs remplaçants en cours d'assemblage. */
  private floors: Cesium.Primitive | null = null;
  private nextFloors: Cesium.Primitive | null = null;
  /** Dessin de la carte hors du fil principal (voir `ruinsMask.worker.ts`). */
  private worker: Worker;
  private jobs = 0;
  /** Une carte est en cours de dessin ; une autre sera demandée à son retour. */
  private drawing = false;
  private again = false;
  /** Ruines de la carte en cours de dessin, pour leurs fonds. */
  private drawn: Building[] = [];
  /**
   * Contours élargis, par bâtiment et par marge, à plat pour le worker, et
   * leurs rectangles : ils ne changent jamais.
   */
  private outlines = new Map<string, Array<[number, number]>>();
  private flats = new Map<string, Float64Array>();
  private boxes = new Map<string, [number, number, number, number]>();
  /** Bâtiments par case de 50 m, pour trouver vite les voisins d'une ruine. */
  private grid = new Map<string, Building[]>();
  private visible = true;

  private constructor(
    private scene: Cesium.Scene,
    private city: City,
    private groundAt: GroundAt,
    readonly tileset: Cesium.Cesium3DTileset,
  ) {
    const center = Cesium.Cartesian3.fromDegrees(city.center.lon, city.center.lat, 0);
    this.toLocal = Cesium.Matrix4.inverseTransformation(
      Cesium.Transforms.eastNorthUpToFixedFrame(center),
      new Cesium.Matrix4(),
    );

    // Emprise : tous les bâtiments, plus de quoi loger leurs gravats.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of city.buildings) {
      if (!b.footprint) continue;
      for (const [x, y] of this.outline(b, CUT_MARGIN)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const pad = 30;
    const width = maxX - minX + 2 * pad;
    const height = maxY - minY + 2 * pad;
    const metersPerPixel = Math.max(MASK_RESOLUTION, Math.max(width, height) / MASK_MAX);
    this.metersPerPixel = metersPerPixel;
    this.maskSize = {
      width: Math.ceil(width / metersPerPixel),
      height: Math.ceil(height / metersPerPixel),
    };
    this.extent = new Cesium.Cartesian4(minX - pad, minY - pad, width, height);
    // Hauteurs codées dans la carte : de sous le plus bas des bâtiments, sur
    // 128 m, soit un demi-mètre par niveau. Le repère local a son origine sur
    // l'ellipsoïde : z y est, à quelques centimètres près, l'altitude de la
    // scène.
    let lowest = Infinity;
    for (const b of city.buildings) lowest = Math.min(lowest, b.baseHeight);
    this.heights = new Cesium.Cartesian2(lowest - 5, 128);

    this.shader = new Cesium.CustomShader({
      uniforms: {
        u_eyeToLocal: { type: Cesium.UniformType.MAT4, value: this.eyeToLocal },
        u_extent: { type: Cesium.UniformType.VEC4, value: this.extent },
        u_heights: { type: Cesium.UniformType.VEC2, value: this.heights },
        u_dust: { type: Cesium.UniformType.VEC3, value: DUST_TINT },
        u_ruins: {
          type: Cesium.UniformType.SAMPLER_2D,
          value: new Cesium.TextureUniform({
            typedArray: new Uint8Array(this.maskSize.width * this.maskSize.height * 4),
            width: this.maskSize.width,
            height: this.maskSize.height,
            repeat: false,
          }),
        },
      },
      fragmentShaderText: RUINS_SHADER,
    });
    tileset.customShader = this.shader;

    // Avant chaque rendu — la vue principale comme la vue nadir, qui n'ont pas
    // la même caméra —, le passage de l'œil au repère local.
    scene.preRender.addEventListener(() => {
      Cesium.Matrix4.multiply(this.toLocal, scene.camera.inverseViewMatrix, this.eyeToLocal);
      this.shader.setUniform('u_eyeToLocal', this.eyeToLocal);
      this.swapFloors();
    });

    this.worker = new Worker(new URL('./ruinsMask.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<MaskResult>) => this.onMask(event.data);

    this.underlay = scene.primitives.add(this.underlayOf());
    this.apply();
    this.sync();
  }

  /**
   * Charge le relevé, par Cesium ion (jeton) ou directement chez Google (clé).
   * Renvoie `null` s'il est inaccessible : la ville dessinée prend le relais.
   */
  static async load(
    scene: Cesium.Scene,
    city: City,
    groundAt: GroundAt,
    quality: QualitySettings,
  ): Promise<PhotorealCity | null> {
    const cache = quality.photorealCacheMB * 1024 * 1024;
    try {
      const tileset = await Cesium.createGooglePhotorealistic3DTileset(
        {
          key: CONFIG.googleKey || undefined,
          // Le simulateur n'a pas de recherche d'adresse : aucun autre
          // géocodeur que celui de Google n'est employé avec ces tuiles.
          onlyUsingWithGoogleGeocoder: true,
        },
        {
          maximumScreenSpaceError: quality.photorealDetail,
          // Par défaut, 1,5 Go de cache plus 1 Go de débordement : trop pour
          // une carte graphique de 4 Go qui dessine aussi tout le reste.
          cacheBytes: cache,
          maximumCacheOverflowBytes: cache / 2,
          enableCollision: false,
          showCreditsOnScreen: true,
        },
      );
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        Cesium.Cartesian3.fromDegrees(city.center.lon, city.center.lat),
        new Cesium.Cartesian3(),
      );
      tileset.modelMatrix = Cesium.Matrix4.fromTranslation(
        Cesium.Cartesian3.multiplyByScalar(up, -CONFIG.photoreal.geoidOffset, up),
      );
      scene.primitives.add(tileset);
      return new PhotorealCity(scene, city, groundAt, tileset);
    } catch (err) {
      console.warn('[ville] relevé photoréaliste indisponible, ville dessinée', err);
      return null;
    }
  }

  /**
   * Accorde le décor aux états de dommage : efface les ruines, noircit les
   * bâtiments incendiés. À appeler après chaque changement d'état.
   *
   * Pendant un sinistre, les états changent presque à chaque image : la carte
   * n'est redemandée qu'une fois toutes les 400 ms au plus, et jamais tant que
   * la précédente est en cours de dessin.
   */
  sync(): void {
    if (this.drawing) {
      this.again = true;
      return;
    }
    const wait = this.lastMask + MASK_INTERVAL - performance.now();
    if (wait > 0) {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.sync();
      }, wait);
      return;
    }

    const ruined = this.city.buildings.filter((b) => b.footprint && REDRAWN.has(b.state));
    const burnt = this.city.buildings.filter((b) => b.footprint && b.state === 'burnt');
    const key = `${ruined.map((b) => b.id).join()}|${burnt.map((b) => b.id).join()}`;
    if (key === this.applied) return;
    this.applied = key;
    this.lastMask = performance.now();

    const encode = (altitude: number) => {
      const level = Math.round(((altitude - this.heights.x) / this.heights.y) * 255);
      return Math.min(255, Math.max(0, level));
    };
    const flat = (b: Building, margin: number) => {
      const key = `${b.id}|${margin}`;
      let ring = this.flats.get(key);
      if (!ring) {
        ring = Float64Array.from(this.outline(b, margin).flat());
        this.flats.set(key, ring);
      }
      return ring;
    };
    const job: MaskJob = {
      id: ++this.jobs,
      width: this.maskSize.width,
      height: this.maskSize.height,
      extent: [this.extent.x, this.extent.y, this.extent.z, this.extent.w],
      ruined: ruined.map((b) => ({ band: flat(b, CUT_MARGIN), core: flat(b, 0) })),
      standing: this.standingNear(ruined).map((b) => ({
        party: flat(b, NEIGHBOR_MARGIN),
        free: flat(b, FREE_MARGIN),
        reach: flat(b, FREE_MARGIN + 1),
        level: encode(b.baseHeight + roofTop(b) + 1.5),
        // Le sommet de leur mur mitoyen à son plus bas : 50 cm au-dessus de
        // leur gouttière (`render.ts`).
        eave: encode(b.baseHeight + b.height - (b.roofPitch ?? 0) / 2 + 0.5),
      })),
      burnt: burnt.map((b) => flat(b, SOOT_MARGIN)),
      dust: { spread: DUST_SPREAD / this.metersPerPixel, gain: DUST_GAIN },
    };
    this.drawing = true;
    this.drawn = ruined;
    // Copiés, et non transférés : les contours restent en cache pour la
    // prochaine carte.
    this.worker.postMessage(job);
  }

  /** Une carte dessinée : on la téléverse, et l'on refait les fonds des ruines. */
  private onMask(result: MaskResult): void {
    this.drawing = false;
    if (result.id === this.jobs) {
      this.shader.setUniform(
        'u_ruins',
        new Cesium.TextureUniform({
          typedArray: new Uint8Array(result.pixels),
          width: this.maskSize.width,
          height: this.maskSize.height,
          repeat: false,
        }),
      );
      if (this.nextFloors) this.scene.primitives.remove(this.nextFloors);
      this.nextFloors = this.drawn.length
        ? this.scene.primitives.add(this.floorsUnder(this.drawn))
        : null;
      if (this.nextFloors) this.nextFloors.show = false;
      else this.swapFloors(true);
    }
    if (this.again) {
      this.again = false;
      this.sync();
    }
  }

  /**
   * Les nouveaux fonds remplacent les anciens une fois assemblés, hors du fil
   * principal : jamais d'image sans fond sous une ruine.
   */
  private swapFloors(empty = false): void {
    if (!empty && !this.nextFloors?.ready) return;
    if (this.floors) this.scene.primitives.remove(this.floors);
    this.floors = this.nextFloors;
    this.nextFloors = null;
    if (this.floors) this.floors.show = this.visible;
  }

  /** Le décor en vue réaliste ; la ville dessinée, entière, dans les vues techniques. */
  setVisible(on: boolean): void {
    this.visible = on;
    this.apply();
  }

  /**
   * Rend la vue nadir avec des tuiles deux fois moins fines. Elle ne fait que
   * quelques centaines de pixels à l'écran, mais elle est rendue à la taille
   * de la fenêtre : à pleine finesse, chacun de ses rafraîchissements coûtait
   * une seconde image entière. Un niveau de détail de moins, c'est aussi bien
   * moins de tuiles à charger sous le drone, hors du champ de la vue
   * principale.
   */
  coarser<T>(render: () => T): T {
    const detail = this.tileset.maximumScreenSpaceError;
    this.tileset.maximumScreenSpaceError = detail * 2;
    try {
      return render();
    } finally {
      this.tileset.maximumScreenSpaceError = detail;
    }
  }

  /** Vrai quand les tuiles nécessaires à la vue courante sont chargées. */
  get tilesLoaded(): boolean {
    return !this.visible || this.tileset.tilesLoaded;
  }

  private apply(): void {
    const on = this.visible;
    this.tileset.show = on;
    this.underlay.show = on;
    if (this.floors) this.floors.show = on;
    // Le sol vient du relevé en vue réaliste, de l'IGN dans les vues
    // techniques (voir l'en-tête).
    this.scene.globe.show = !on;
  }

  /**
   * Fond de chaque ruine : le contour effacé, posé sur le relief. Les gravats
   * en couvrent l'essentiel ; il comble la marge autour, où l'on verrait sinon
   * à travers le sol.
   */
  private floorsUnder(buildings: Building[]): Cesium.Primitive {
    const toWorld = Cesium.Matrix4.inverseTransformation(this.toLocal, new Cesium.Matrix4());
    return new Cesium.Primitive({
      geometryInstances: buildings.map((b) => {
        const positions = this.outline(b, CUT_MARGIN).map(([x, y]) => {
          const world = Cesium.Matrix4.multiplyByPoint(
            toWorld,
            new Cesium.Cartesian3(x, y, 0),
            new Cesium.Cartesian3(),
          );
          const c = Cesium.Cartographic.fromCartesian(world);
          const lon = Cesium.Math.toDegrees(c.longitude);
          const lat = Cesium.Math.toDegrees(c.latitude);
          return Cesium.Cartesian3.fromDegrees(lon, lat, this.groundAt(lon, lat) + FLOOR_OFFSET);
        });
        return new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(positions),
            perPositionHeight: true,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(DUST) },
        });
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: false, closed: false }),
      // Des polygones de Cesium : il sait les assembler dans ses web workers.
      asynchronous: true,
    });
  }

  /**
   * Sous-sol : une nappe qui suit le relief deux mètres sous le sol, sur toute
   * l'emprise de la carte. Le relevé n'est qu'une peau, sans rien dessous : là
   * où il est effacé, le regard passerait au travers — par le jour entre son
   * sol et le fond d'une ruine, qui ne sont jamais tout à fait à la même
   * hauteur, dans un arbre coupé, dans un voisin ouvert — et l'on verrait le
   * ciel. Partout ailleurs, le sol du relevé la cache : elle ne coûte presque
   * rien.
   *
   * Son sol est pris au plus bas des nœuds voisins : entre deux nœuds, la
   * nappe reste sous le relief même au bord d'un creux. Celui du relevé s'en
   * écarte de 20 cm au plus, à quelques exceptions près (mesuré sur 300
   * points du centre-ville).
   */
  private underlayOf(): Cesium.Primitive {
    const toWorld = Cesium.Matrix4.inverseTransformation(this.toLocal, new Cesium.Matrix4());
    const nx = Math.ceil(this.extent.z / UNDERLAY_STEP) + 1;
    const ny = Math.ceil(this.extent.w / UNDERLAY_STEP) + 1;
    const lon = new Float64Array(nx * ny);
    const lat = new Float64Array(nx * ny);
    const ground = new Float64Array(nx * ny);
    const point = new Cesium.Cartesian3();
    const carto = new Cesium.Cartographic();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        point.x = this.extent.x + i * UNDERLAY_STEP;
        point.y = this.extent.y + j * UNDERLAY_STEP;
        point.z = 0;
        Cesium.Matrix4.multiplyByPoint(toWorld, point, point);
        Cesium.Cartographic.fromCartesian(point, Cesium.Ellipsoid.WGS84, carto);
        lon[k] = Cesium.Math.toDegrees(carto.longitude);
        lat[k] = Cesium.Math.toDegrees(carto.latitude);
        ground[k] = this.groundAt(lon[k], lat[k]);
      }
    }

    const positions = new Float64Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let low = Infinity;
        for (let b = Math.max(0, j - 1); b <= Math.min(ny - 1, j + 1); b++) {
          for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) {
            low = Math.min(low, ground[b * nx + a]);
          }
        }
        const k = j * nx + i;
        Cesium.Cartesian3.fromDegrees(lon[k], lat[k], low - UNDERLAY_DEPTH, undefined, point);
        positions[k * 3] = point.x;
        positions[k * 3 + 1] = point.y;
        positions[k * 3 + 2] = point.z;
      }
    }
    const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let n = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const k = j * nx + i;
        indices.set([k, k + 1, k + nx + 1, k, k + nx + 1, k + nx], n);
        n += 6;
      }
    }

    const attributes = new Cesium.GeometryAttributes();
    attributes.position = new Cesium.GeometryAttribute({
      componentDatatype: Cesium.ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: positions,
    });
    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.Geometry({
          attributes,
          indices,
          primitiveType: Cesium.PrimitiveType.TRIANGLES,
          boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(UNDERLAY) },
      }),
      // Sans éclairage : on ne la voit que par des interstices, dans l'ombre.
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
      // Une géométrie à nous, que les web workers de Cesium ne savent pas
      // assembler ; construite une fois pour toutes, au chargement.
      asynchronous: false,
    });
  }

  /**
   * Contour extérieur d'un bâtiment, élargi de `margin` mètres, dans le repère
   * local du centre-ville — celui du shader. Chaque sommet est poussé le long
   * de la bissectrice de ses deux côtés, d'autant qu'il faut pour que chaque
   * côté recule de `margin` ; limité aux angles très aigus, où ce déplacement
   * exploserait.
   *
   * Le contour de l'IGN est exprimé dans le repère local du bâtiment, comme
   * pour son dessin (`render.ts`) : on passe par ce repère plutôt que par une
   * approximation en degrés, qui décalerait les bâtiments du bord de la ville
   * d'un mètre.
   */
  private outline(b: Building, margin: number): Array<[number, number]> {
    const key = `${b.id}|${margin}`;
    const cached = this.outlines.get(key);
    if (cached) return cached;
    const ring = b.footprint![0].slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) ring.pop();

    // Sens du tracé, pour savoir de quel côté est l'extérieur.
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      area += x0 * y1 - x1 * y0;
    }
    const out = area >= 0 ? 1 : -1;
    const normal = (a: [number, number], c: [number, number]): [number, number] => {
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return [(out * dy) / len, (-out * dx) / len];
    };

    const frame = Cesium.Matrix4.multiply(
      this.toLocal,
      Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.baseHeight),
      ),
      new Cesium.Matrix4(),
    );
    const point = new Cesium.Cartesian3();
    const result = ring.map((p, i): [number, number] => {
      const n1 = normal(ring[(i + ring.length - 1) % ring.length], p);
      const n2 = normal(p, ring[(i + 1) % ring.length]);
      const k = margin / Math.max(1 + n1[0] * n2[0] + n1[1] * n2[1], 0.25);
      point.x = p[0] + (n1[0] + n2[0]) * k;
      point.y = p[1] + (n1[1] + n2[1]) * k;
      point.z = 0;
      const local = Cesium.Matrix4.multiplyByPoint(frame, point, new Cesium.Cartesian3());
      return [local.x, local.y];
    });
    this.outlines.set(key, result);
    return result;
  }

  /** Bâtiments debout dont l'emprise approche l'effacement d'une ruine. */
  private standingNear(ruined: Building[]): Building[] {
    if (!this.grid.size) {
      for (const b of this.city.buildings) {
        if (!b.footprint) continue;
        const [x0, y0, x1, y1] = this.box(b, 0);
        for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) {
          for (let cy = Math.floor(y0 / 50); cy <= Math.floor(y1 / 50); cy++) {
            const list = this.grid.get(`${cx}:${cy}`);
            if (list) list.push(b);
            else this.grid.set(`${cx}:${cy}`, [b]);
          }
        }
      }
    }
    const found = new Set<Building>();
    for (const r of ruined) {
      const [a0, b0, a1, b1] = this.box(r, CUT_MARGIN + FREE_MARGIN + 1);
      for (let cx = Math.floor(a0 / 50); cx <= Math.floor(a1 / 50); cx++) {
        for (let cy = Math.floor(b0 / 50); cy <= Math.floor(b1 / 50); cy++) {
          for (const b of this.grid.get(`${cx}:${cy}`) ?? []) {
            if (found.has(b) || REDRAWN.has(b.state)) continue;
            const [x0, y0, x1, y1] = this.box(b, 0);
            if (x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0) found.add(b);
          }
        }
      }
    }
    return [...found];
  }

  /** Rectangle englobant d'un contour élargi, mis en cache. */
  private box(b: Building, margin: number): [number, number, number, number] {
    const key = `${b.id}|${margin}`;
    let box = this.boxes.get(key);
    if (!box) {
      box = bounds(this.outline(b, margin));
      this.boxes.set(key, box);
    }
    return box;
  }
}

/** Rectangle englobant d'un contour : xmin, ymin, xmax, ymax. */
function bounds(points: Array<[number, number]>): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/**
 * Hauteur du faîtage d'un bâtiment debout, au-dessus de sa base. La hauteur de
 * l'IGN est prise à mi-pente : on y ajoute la moitié de la pente du toit, 1,5 m
 * quand elle est inconnue.
 *
 * Le bâtiment entier, quel que soit son état : un bâtiment incendié ou fissuré
 * n'est pas redessiné, le relevé le montre tel qu'il est. Réduite comme dans la
 * ville dessinée (82 % pour un incendié), cette hauteur rognait le haut de son
 * toit partout où une ruine le touchait, et en laissait des lambeaux.
 */
function roofTop(b: Building): number {
  return b.height + (b.roofPitch ?? 3) / 2;
}
