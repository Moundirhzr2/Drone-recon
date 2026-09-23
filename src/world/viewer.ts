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
    // Terrain plat par défaut : la plaine d'Alsace s'en accommode très bien et
    // cela évite toute dépendance réseau au démarrage.
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  });

  // On prend la main sur la boucle de rendu (voir l'en-tête du fichier).
  viewer.useDefaultRenderLoop = false;

  const scene = viewer.scene;
  const globe = scene.globe;

  // Un profil ne fait que surcharger les réglages fins ci-dessous : on garde
  // ainsi la possibilité de bricoler un cas particulier sans casser les préréglages.
  const PROFILES = {
    fluide: { resolutionScale: 0.75, terrainDetail: 10, atmosphere: false, viewDistance: 22000 },
    equilibre: { resolutionScale: 1, terrainDetail: 4, atmosphere: true, viewDistance: 20000 },
    beau: { resolutionScale: 1, terrainDetail: 2, atmosphere: true, viewDistance: 60000 },
  };
  const PERF = { ...CONFIG.performance, ...PROFILES[CONFIG.performance.profile] };

  globe.baseColor = Cesium.Color.fromCssColorString('#1b2a1f');
  // L'atmosphère AU SOL est un shader coûteux appliqué sur tout le terrain ;
  // celle du CIEL est une simple coupole, quasi gratuite. On ne coupe que la
  // première : sans le ciel, l'horizon devient un mur noir.
  globe.showGroundAtmosphere = PERF.atmosphere;
  // Avec un terrain ellipsoïdal (sol plat), ce test ne change rien à l'image
  // mais coûte ~8 % du temps de rendu. Il redevient nécessaire avec du relief.
  globe.depthTestAgainstTerrain = PERF.depthTestTerrain || CONFIG.backend !== 'offline';
  globe.maximumScreenSpaceError = PERF.terrainDetail;

  // Le brouillard reste actif même sans atmosphère : c'est lui qui masque la
  // limite de la distance de vue, sans quoi le terrain se couperait net.
  scene.fog.enabled = true;
  scene.fog.density = PERF.atmosphere ? 0.00012 : 0.0004;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

  // Chargement des tuiles : c'est lui qui produit les pires pics (jusqu'à 60 ms
  // sur une image), car le décodage des images se fait sur le thread principal.
  // Un cache plus grand évite de recharger ce qu'on vient de survoler, et
  // couper le préchargement des voisines étale la charge dans le temps.
  globe.tileCacheSize = 600;
  globe.preloadSiblings = false;
  globe.preloadAncestors = false;
  Cesium.RequestScheduler.throttleRequests = true;
  Cesium.RequestScheduler.maximumRequestsPerServer = 8;

  // Rendre moins de pixels : le gain le plus direct sur une machine modeste.
  // Ce n'est qu'un point de départ, la boucle principale ajuste ensuite.
  viewer.resolutionScale = PERF.resolutionScale;
  viewer.useBrowserRecommendedResolution = true;

  // Borner la distance de vue évite de charger et dessiner des dizaines de
  // kilomètres de terrain qu'aucun pilote de drone ne regarde.
  const frustum = scene.camera.frustum as Cesium.PerspectiveFrustum;
  frustum.far = PERF.viewDistance;
  scene.screenSpaceCameraController.enableCollisionDetection = true;
  // Le pilotage se fait au drone : la souris ne doit pas voler la caméra.
  scene.screenSpaceCameraController.enableInputs = false;

  // Lumière rasante : les volumes se lisent bien mieux qu'en éclairage zénithal.
  scene.light = new Cesium.DirectionalLight({
    direction: Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(0.35, -0.72, -0.6),
      new Cesium.Cartesian3(),
    ),
    intensity: 2.1,
  });

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

  let provider: Cesium.ImageryProvider;
  try {
    provider = new Cesium.UrlTemplateImageryProvider({
      // Esri World Imagery. Attention à l'ordre des axes : {z}/{y}/{x}.
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: new Cesium.Credit('Esri, Maxar, Earthstar Geographics'),
    });
  } catch {
    provider = new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      maximumLevel: 19,
    });
  }

  const layer = viewer.imageryLayers.addImageryProvider(provider);
  // Léger assombrissement : le drone survole une zone sinistrée, et cela fait
  // ressortir les volumes bâtis par-dessus le sol.
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
