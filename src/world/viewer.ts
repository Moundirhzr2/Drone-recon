/**
 * Création et configuration de la scène Cesium.
 *
 * Deux décisions structurantes sont prises ici :
 *
 *  1. `preserveDrawingBuffer: true`. Sans cette option, lire le canvas WebGL
 *     (pour l'aperçu nadir ou une photo) renvoie une image noire. C'est le piège
 *     le plus courant de tout ce projet, et il ne se corrige qu'à la création.
 *
 *  2. `useDefaultRenderLoop = false`. On veut rendre la scène DEUX fois par
 *     image quand la vue nadir se rafraîchit : une fois caméra en bas, une fois
 *     caméra normale. Impossible avec la boucle interne de Cesium, qui ne rend
 *     qu'une fois et ne laisse pas de point d'accroche entre les deux.
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CONFIG } from '../core/config';
import { createReliefTerrain, type Relief } from './terrain';

export interface World {
  viewer: Cesium.Viewer;
  scene: Cesium.Scene;
  /** Vrai si un fond 3D externe (ion ou Google) a pu être chargé. */
  hasExternalTileset: boolean;
  /** Message décrivant le fond réellement utilisé. */
  backendLabel: string;
  /** Moteur de rendu réellement employé par le navigateur. */
  gpu: GpuReport;
}

export interface GpuReport {
  /** Nom du moteur tel que WebGL le déclare, ou `inconnu`. */
  renderer: string;
  /** Vrai si la 3D est calculée par le processeur au lieu de la carte graphique. */
  software: boolean;
}

export async function createWorld(
  container: string,
  onProgress: (msg: string, pct: number) => void,
  relief: Relief | null = null,
): Promise<World> {
  onProgress('Initialisation du moteur 3D…', 0.1);

  if (CONFIG.ionToken) {
    Cesium.Ion.defaultAccessToken = CONFIG.ionToken;
  }

  const viewer = new Cesium.Viewer(container, {
    // Tous les widgets d'origine sont coupés : le HUD est notre interface.
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: true,
    // `false` empeche Cesium de creer sa couche d'imagerie par defaut, qui
    // passerait par Cesium ion et echouerait sans token. On fournit la notre.
    baseLayer: false,
    contextOptions: {
      webgl: {
        // Indispensable pour la vue nadir et les photos.
        preserveDrawingBuffer: true,
        alpha: false,
      },
    },
    // Relief réel de l'IGN, livré avec l'application : aucune dépendance réseau
    // au démarrage. Sans lui, on retombe sur un globe plat.
    //
    // Les altitudes de l'IGN sont des altitudes au-dessus du niveau de la mer,
    // pas des hauteurs au-dessus de l'ellipsoïde WGS84 qu'attend Cesium (l'écart
    // est d'environ 49 m en Alsace). Ce n'est pas un problème tant que le
    // terrain, les bâtiments et le drone partagent la même référence — c'est
    // le cas en mode hors-ligne. Les modes `ion` et `google`, qui apportent leur
    // propre terrain, n'utilisent pas ce relief.
    terrainProvider: relief ? createReliefTerrain(relief) : new Cesium.EllipsoidTerrainProvider(),
  });

  // On prend la main sur la boucle de rendu (voir l'en-tête du fichier).
  viewer.useDefaultRenderLoop = false;

  const scene = viewer.scene;
  const globe = scene.globe;

  // Les réglages qui dépendent de la machine — résolution, ombres,
  // anticrénelage, finesse du sol — sont posés par `quality.ts`, une fois la
  // carte graphique identifiée.

  globe.baseColor = Cesium.Color.fromCssColorString('#1b2a1f');
  // Sur un globe plat, ce test ne change rien à l'image et coûte ~8 % du temps
  // de rendu. Dès qu'il y a un relief, il devient indispensable : sans lui, ce
  // qui passe sous le sol — la surface d'une inondation dans les quartiers
  // hauts, par exemple — resterait visible à travers.
  globe.depthTestAgainstTerrain =
    CONFIG.performance.depthTestTerrain || CONFIG.backend !== 'offline' || relief !== null;

  // Le brouillard fond le lointain dans le ciel, et c'est lui qui borne la
  // distance de vue : Cesium ne charge ni ne dessine les tuiles entièrement
  // noyées. Sa densité dépend du profil de qualité.
  //
  // On ne raccourcit PAS la distance de vue de la caméra (`frustum.far`) : la
  // coupole du ciel est à des centaines de kilomètres, elle disparaîtrait, et
  // l'horizon deviendrait un mur noir.
  scene.fog.enabled = true;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

  // Chargement des tuiles : c'est lui qui produit les pires pics (jusqu'à 60 ms
  // sur une image), car le décodage des images se fait sur le thread principal.
  // Couper le préchargement des voisines étale la charge dans le temps. La
  // taille du cache dépend du profil de qualité (voir `quality.ts`).
  globe.preloadSiblings = false;
  globe.preloadAncestors = false;
  Cesium.RequestScheduler.throttleRequests = true;
  Cesium.RequestScheduler.maximumRequestsPerServer = 8;

  scene.screenSpaceCameraController.enableCollisionDetection = true;
  // Le pilotage se fait au drone : la souris ne doit pas voler la caméra.
  scene.screenSpaceCameraController.enableInputs = false;

  scene.light = new Cesium.DirectionalLight({ direction: sunDirection(215, 40), intensity: 2.1 });

  let hasExternalTileset = false;
  let backendLabel = 'Hors-ligne (imagerie satellite)';

  // --- Fond de scène ----------------------------------------------------
  try {
    if (CONFIG.backend === 'google' && CONFIG.googleKey) {
      onProgress('Chargement des tuiles photoréalistes Google…', 0.35);
      const tileset = await createGoogleTileset(CONFIG.googleKey);
      scene.primitives.add(tileset);
      hasExternalTileset = true;
      backendLabel = 'Google Photorealistic 3D Tiles';
    } else if (CONFIG.backend === 'ion' && CONFIG.ionToken) {
      onProgress('Chargement du terrain et des bâtiments OSM…', 0.35);
      viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
      const osm = await Cesium.createOsmBuildingsAsync();
      scene.primitives.add(osm);
      await addOsmImagery(viewer);
      hasExternalTileset = true;
      backendLabel = 'Cesium World Terrain + OSM Buildings';
    } else {
      onProgress('Chargement de l’imagerie satellite…', 0.35);
      await addOsmImagery(viewer);
    }
  } catch (err) {
    console.warn('[viewer] fond externe indisponible, repli hors-ligne', err);
    await addOsmImagery(viewer).catch(() => undefined);
    backendLabel = 'Hors-ligne (repli)';
  }

  onProgress('Scène prête', 0.5);

  const gpu = reportGpu(scene);

  return { viewer, scene, hasExternalTileset, backendLabel, gpu };
}

/**
 * Direction de la lumière d'un soleil placé à `azimuth` degrés (depuis le
 * nord, sens horaire) et `elevation` degrés au-dessus de l'horizon, au-dessus
 * de la ville.
 *
 * Cesium attend un vecteur du repère terrestre : on le construit donc dans le
 * repère local est-nord-haut, puis on l'y convertit. Écrit directement en
 * coordonnées terrestres, un « soleil » se retrouve à une hauteur qu'on ne
 * choisit pas — l'ancien réglage tombait à 16° au-dessus de l'horizon, et les
 * ombres portées noyaient toutes les rues.
 *
 * Un après-midi, soleil au sud-ouest à 40° : des ombres assez longues pour
 * lire les volumes, assez courtes pour laisser voir le sol.
 */
function sunDirection(azimuth: number, elevation: number): Cesium.Cartesian3 {
  const a = Cesium.Math.toRadians(azimuth);
  const e = Cesium.Math.toRadians(elevation);
  // Vers le soleil, en est-nord-haut ; la lumière va dans l'autre sens.
  const toSun = new Cesium.Cartesian3(
    Math.sin(a) * Math.cos(e),
    Math.cos(a) * Math.cos(e),
    Math.sin(e),
  );
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(CONFIG.city.lon, CONFIG.city.lat),
  );
  const world = Cesium.Matrix4.multiplyByPointAsVector(frame, toSun, new Cesium.Cartesian3());
  return Cesium.Cartesian3.normalize(Cesium.Cartesian3.negate(world, world), world);
}

/**
 * Identifie le moteur de rendu réellement utilisé.
 *
 * Un écart énorme entre le coût mesuré d'une image et la cadence observée a
 * presque toujours la même cause : le navigateur n'utilise pas la carte
 * graphique et calcule la 3D sur le processeur (SwiftShader, llvmpipe...).
 * On obtient alors 5 à 10 images par seconde quoi qu'on optimise — autant le
 * savoir plutôt que d'accuser le code.
 *
 * Le verdict est RENVOYÉ, pas affiché ici. Une première version l'émettait sur
 * le bus d'événements pendant la création de la scène, c'est-à-dire avant que
 * le moindre panneau n'écoute : l'avertissement se perdait à chaque fois, et
 * une machine en rendu logiciel tournait au ralenti sans jamais le signaler.
 * C'est `main.ts` qui l'affiche, une fois l'interface prête.
 */
function reportGpu(scene: Cesium.Scene): GpuReport {
  try {
    // `scene.context` existe à l'exécution mais n'est pas déclaré publiquement.
    const internal = (scene as unknown as { context?: { _gl?: WebGLRenderingContext } }).context;
    const ctx =
      internal?._gl ?? (scene.canvas.getContext('webgl2') as WebGLRenderingContext | null);
    if (!ctx) return { renderer: 'inconnu', software: false };

    const info = ctx.getExtension('WEBGL_debug_renderer_info');
    const renderer = info
      ? String(ctx.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : String(ctx.getParameter(ctx.RENDERER));

    // « Microsoft Basic Render Driver » est le moteur de secours de Windows
    // (WARP) : Chrome s'y replie quand son accélération est coupée, ou après
    // plusieurs plantages de son processus graphique.
    const software = /swiftshader|llvmpipe|software|microsoft basic/i.test(renderer);
    console.info(`[gpu] moteur de rendu : ${renderer}`);

    if (software) {
      console.warn(
        [
          '[gpu] RENDU LOGICIEL DÉTECTÉ — la 3D est calculée par le processeur.',
          "Aucune optimisation du code ne compensera cela. Activer l'accélération",
          'matérielle du navigateur (chrome://settings/system), puis le redémarrer.',
          'Le détail est consultable sur chrome://gpu.',
        ].join('\n'),
      );
    }
    return { renderer, software };
  } catch {
    // Diagnostic optionnel : son échec ne doit jamais empêcher le démarrage.
    return { renderer: 'inconnu', software: false };
  }
}

/**
 * Sol photographique, sans aucune clé d'API.
 *
 * Le choix de la source n'est pas cosmétique. Avec une carte routière OSM, le
 * drone survole un PLAN : rues nommées, aplats de couleur, bâtiments déjà
 * dessinés en 2D sous nos volumes 3D — l'effet est celui d'une carte, pas d'un
 * survol. L'imagerie satellite donne au contraire un sol photographique sur
 * lequel les bâtiments générés viennent se poser, ce qui est exactement la
 * lecture recherchée.
 *
 * On garde OSM en repli : si la source satellite est injoignable, mieux vaut
 * une carte qu'un globe uni.
 */
async function addOsmImagery(viewer: Cesium.Viewer): Promise<void> {
  viewer.imageryLayers.removeAll();

  // Fond mondial : Esri World Imagery. Attention à l'ordre des axes, {z}/{y}/{x}.
  let base: Cesium.ImageryProvider;
  try {
    base = new Cesium.UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: new Cesium.Credit('Esri, Maxar, Earthstar Geographics'),
    });
  } catch {
    base = new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      maximumLevel: 19,
    });
  }
  tone(viewer.imageryLayers.addImageryProvider(base));

  // Par-dessus, sur la région : la photo aérienne de l'IGN (BD ORTHO®). Sur une
  // même tuile, elle est nettement plus précise que l'imagerie mondiale — on y
  // lit les arêtes des toits et les fenêtres de toit. Elle ne couvre que la
  // France, d'où le rectangle : on ne lui demande rien au-delà.
  const { lon, lat } = CONFIG.city;
  const ign = new Cesium.UrlTemplateImageryProvider({
    url:
      'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg' +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    maximumLevel: 20,
    rectangle: Cesium.Rectangle.fromDegrees(lon - 0.35, lat - 0.25, lon + 0.35, lat + 0.25),
    credit: new Cesium.Credit('© IGN — BD ORTHO®'),
  });
  tone(viewer.imageryLayers.addImageryProvider(ign));
}

/**
 * Léger assombrissement : le drone survole une zone sinistrée, et cela fait
 * ressortir les volumes bâtis par-dessus le sol.
 */
function tone(layer: Cesium.ImageryLayer): void {
  layer.brightness = 0.88;
  layer.saturation = 0.9;
  layer.contrast = 1.06;
}

/**
 * La signature de cette fabrique a changé entre versions de Cesium
 * (clé positionnelle puis options). On essaie les deux plutôt que d'imposer
 * une version précise.
 */
async function createGoogleTileset(key: string): Promise<Cesium.Cesium3DTileset> {
  const factory = Cesium.createGooglePhotorealistic3DTileset as unknown as (
    ...args: unknown[]
  ) => Promise<Cesium.Cesium3DTileset>;
  try {
    return await factory({ key });
  } catch {
    return await factory(key);
  }
}
