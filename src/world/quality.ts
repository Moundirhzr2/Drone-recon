/**
 * Qualité d'image, adaptée à la machine.
 *
 * DEUX ÉTAGES
 * -----------
 * 1. Au démarrage, un PROFIL est choisi d'après la carte graphique déclarée par
 *    le navigateur : on ne demande pas d'anticrénelage à un circuit intégré, et
 *    on ne bride pas une carte dédiée à la qualité d'un portable d'entrée de
 *    gamme.
 *
 * 2. En vol, un RÉGULATEUR tient la cadence. Il joue d'abord sur l'échelle de
 *    rendu, le levier le plus fin ; si la cadence manque encore à l'échelle
 *    minimale, il coupe une option coûteuse, la plus chère d'abord. Il ne les
 *    rétablit jamais : mieux vaut une image un peu moins riche qu'une qualité
 *    qui clignote.
 *
 * Le nom de la carte n'est qu'un indice — deux machines à la même carte n'ont
 * pas le même écran ni le même processeur. C'est le régulateur qui a le dernier
 * mot, sur la cadence réellement mesurée.
 */

import * as Cesium from 'cesium';
import { CONFIG } from '../core/config';
import type { GpuReport } from './viewer';

export type QualityName = 'fluide' | 'equilibre' | 'beau';

export interface QualitySettings {
  /** Échelle de rendu de départ ; le régulateur l'ajuste ensuite. */
  resolutionScale: number;
  /**
   * Rendre à la définition physique de l'écran. Sur un écran à 125 %, c'est
   * 56 % de pixels en plus pour une image plus nette.
   */
  nativeResolution: boolean;
  /**
   * Finesse du terrain ET de la photo aérienne : c'est la même erreur d'écran
   * qui décide du niveau de tuile. Plus le nombre est BAS, plus c'est net.
   */
  terrainDetail: number;
  /**
   * Tuiles gardées en mémoire. La vue principale, tournée vers l'horizon, et la
   * vue nadir, à la verticale, n'utilisent pas les mêmes : si le cache ne peut
   * pas contenir les deux, chaque passe évince les tuiles de l'autre, qui sont
   * rechargées en boucle. Mesuré en profil équilibré avec 600 places : plus de
   * 20 000 requêtes en quelques minutes, sur une vue immobile.
   */
  tileCacheSize: number;
  /** Atmosphère au sol : la brume qui éclaircit le lointain. */
  groundAtmosphere: boolean;
  /**
   * Densité du brouillard. C'est elle qui borne la distance de vue : Cesium ne
   * charge pas les tuiles entièrement noyées.
   */
  fogDensity: number;
  /** Anticrénelage par post-traitement : presque gratuit, un peu flou. */
  fxaa: boolean;
  /** Anticrénelage matériel : net, mais multiplie le coût des pixels. */
  msaa: 1 | 2 | 4;
  /**
   * Ombres portées du soleil. Désactivées dans tous les profils : la carte
   * d'ombre de Cesium est recalculée à chaque mouvement de caméra, et sur les
   * façades ses bords scintillaient pendant le vol. Le reste du mécanisme est
   * en place : passer ce réglage à `true` suffit à les rétablir.
   */
  shadows: boolean;
  /** Bords d'ombre adoucis (filtrage sur plusieurs échantillons). */
  softShadows: boolean;
  /**
   * Finesse de la ville photoréaliste, en pixels d'erreur tolérés : même
   * principe que `terrainDetail`, plus le nombre est BAS, plus c'est net.
   *
   * C'est de loin le réglage le plus coûteux. Mesuré sur une GTX 1650 devant
   * le temple Saint-Étienne, sans la vue nadir : 16 donne 265 tuiles et
   * 28 ms par image, 24 en donne 174 et 16 ms, 32 en donne 149 et 14 ms. À
   * l'altitude d'un drone, 24 et 16 se distinguent à peine.
   */
  photorealDetail: number;
  /** Mémoire allouée à ses tuiles, en Mo. */
  photorealCacheMB: number;
}

export const QUALITY_LABEL: Record<QualityName, string> = {
  fluide: 'fluide',
  equilibre: 'équilibrée',
  beau: 'haute',
};

const PROFILES: Record<QualityName, QualitySettings> = {
  // Circuits intégrés et rendu logiciel : la cadence avant tout.
  fluide: {
    resolutionScale: 0.75,
    nativeResolution: false,
    terrainDetail: 6,
    tileCacheSize: 600,
    groundAtmosphere: false,
    fogDensity: 0.0004,
    fxaa: false,
    msaa: 1,
    shadows: false,
    softShadows: false,
    photorealDetail: 32,
    photorealCacheMB: 256,
  },
  // Cartes dédiées d'entrée de gamme (GTX 16xx, RX 5xx…) : la brume et le
  // lissage, mais pas l'anticrénelage matériel.
  equilibre: {
    resolutionScale: 1,
    nativeResolution: false,
    terrainDetail: 4,
    tileCacheSize: 1000,
    groundAtmosphere: true,
    fogDensity: 0.00022,
    fxaa: true,
    msaa: 1,
    shadows: false,
    softShadows: false,
    photorealDetail: 24,
    photorealCacheMB: 512,
  },
  // Cartes récentes : définition native, sol plus fin, arêtes nettes.
  beau: {
    resolutionScale: 1,
    nativeResolution: true,
    terrainDetail: 2,
    tileCacheSize: 1500,
    groundAtmosphere: true,
    fogDensity: 0.00016,
    fxaa: false,
    msaa: 4,
    shadows: false,
    softShadows: true,
    photorealDetail: 12,
    photorealCacheMB: 1024,
  },
};

/**
 * Profil suggéré par le nom de la carte graphique.
 *
 * Le nom arrive tel que WebGL le déclare, par exemple sous Windows :
 * « ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F91) Direct3D11 …) ».
 */
export function suggestProfile(gpu: GpuReport): QualityName {
  const r = gpu.renderer.toLowerCase();
  if (gpu.software) return 'fluide';
  if (
    /rtx\s*a?\d{3,4}|radeon rx\s*[6-9]\d{3}|radeon pro|arc\s*a7|apple m\d+ (pro|max|ultra)/.test(r)
  ) {
    return 'beau';
  }
  // Toute autre carte dédiée. « Radeon Graphics » sans « RX » est un circuit
  // intégré aux processeurs AMD, et reste donc exclu.
  if (/geforce|quadro|radeon rx|radeon r9|\barc\b|apple m\d/.test(r)) return 'equilibre';
  return 'fluide';
}

/** Profil demandé dans l'URL (`?qualite=beau`), s'il est valide. */
function requestedProfile(): QualityName | null {
  const q = new URLSearchParams(window.location.search).get('qualite');
  return q && q in PROFILES ? (q as QualityName) : null;
}

/**
 * Choisit le profil et l'applique à la scène.
 * Ordre de priorité : l'URL, puis la configuration, puis la carte graphique.
 */
export function createQuality(viewer: Cesium.Viewer, gpu: GpuReport): QualityGovernor {
  const configured = CONFIG.performance.profile;
  const name = requestedProfile() ?? (configured === 'auto' ? suggestProfile(gpu) : configured);
  const settings = { ...PROFILES[name] };
  applyQuality(viewer, settings);
  console.info(`[qualité] profil ${name} (${gpu.renderer})`);
  return new QualityGovernor(viewer, name, settings);
}

function applyQuality(viewer: Cesium.Viewer, q: QualitySettings): void {
  const scene = viewer.scene;
  viewer.useBrowserRecommendedResolution = !q.nativeResolution;
  viewer.resolutionScale = q.resolutionScale;
  scene.globe.maximumScreenSpaceError = q.terrainDetail;
  scene.globe.tileCacheSize = q.tileCacheSize;
  scene.globe.showGroundAtmosphere = q.groundAtmosphere;
  scene.fog.density = q.fogDensity;
  scene.postProcessStages.fxaa.enabled = q.fxaa;
  scene.msaaSamples = q.msaa;

  viewer.shadows = q.shadows;
  const shadowMap = scene.shadowMap;
  shadowMap.softShadows = q.softShadows;
  // Les ombres ne se calculent qu'autour de la caméra : au-delà, un drone à
  // 100 m ne les distingue plus, et la carte d'ombre garde toute sa finesse
  // pour le premier plan.
  shadowMap.maximumDistance = 1500;
  shadowMap.size = 2048;
  // Ombre claire : l'éclairage du ciel débouche les rues, une ombre noire
  // ferait un trou dans l'image.
  shadowMap.darkness = 0.45;
}

/**
 * Tient la cadence visée, sur la cadence mesurée.
 *
 * Seuils décalés à la baisse et à la hausse — la marge évite de faire osciller
 * l'échelle d'une valeur à l'autre, et chaque changement d'échelle reconstruit
 * les tampons de rendu. Le seuil de remontée reste sous 60 : sur un écran à
 * 60 Hz, le navigateur ne dépasse jamais 60 images par seconde, et un seuil
 * au-delà empêcherait la résolution de jamais remonter.
 */
export class QualityGovernor {
  private lastCheck = 0;
  private scale: number;

  constructor(
    private viewer: Cesium.Viewer,
    readonly profile: QualityName,
    readonly settings: QualitySettings,
  ) {
    this.scale = settings.resolutionScale;
  }

  /**
   * À appeler à chaque image.
   * @returns une description de l'option coupée, s'il a fallu en couper une.
   */
  update(now: number, fps: number): string | null {
    const perf = CONFIG.performance;
    if (!perf.adaptiveResolution || now - this.lastCheck < 2000 || fps <= 0) return null;
    this.lastCheck = now;

    // Sous 5 images par seconde, ce n'est pas la charge : c'est le navigateur
    // qui a mis la page en veille — onglet en arrière-plan, fenêtre couverte,
    // panneau replié. Il ralentit alors volontairement ses images, et régler la
    // qualité sur cette cadence la dégraderait pour rien ; pour de bon, même,
    // puisque les options coupées ne reviennent pas. Mesuré dans un panneau
    // masqué : 4 images par seconde, sur une machine qui en tient soixante.
    if (document.hidden || fps < 5) return null;
    const target = perf.targetFps;

    if (fps < target * 0.8) {
      if (this.scale > perf.minScale) {
        this.setScale(Math.max(perf.minScale, this.scale - 0.1), fps);
        return null;
      }
      return this.dropFeature(fps);
    }
    if (fps > target * 1.1 && this.scale < perf.maxScale) {
      this.setScale(Math.min(perf.maxScale, this.scale + 0.05), fps);
    }
    return null;
  }

  private setScale(scale: number, fps: number): void {
    console.info(
      `[perf] ${Math.round(fps)} img/s — échelle de rendu ${this.scale.toFixed(2)} -> ${scale.toFixed(2)}`,
    );
    this.scale = scale;
    this.viewer.resolutionScale = scale;
  }

  /**
   * Coupe l'option la plus coûteuse encore active. Les ombres d'abord : leur
   * coût tient au nombre d'objets à redessiner depuis le soleil, pas au nombre
   * de pixels, et baisser la résolution n'y change donc rien.
   */
  private dropFeature(fps: number): string | null {
    const q = this.settings;
    const scene = this.viewer.scene;
    let dropped: string | null = null;
    if (q.shadows) {
      q.shadows = false;
      this.viewer.shadows = false;
      dropped = 'ombres coupées';
    } else if (q.msaa > 1) {
      q.msaa = 1;
      scene.msaaSamples = 1;
      dropped = 'anticrénelage matériel coupé';
    } else if (q.groundAtmosphere) {
      q.groundAtmosphere = false;
      scene.globe.showGroundAtmosphere = false;
      dropped = 'brume au sol coupée';
    } else if (q.fxaa) {
      q.fxaa = false;
      scene.postProcessStages.fxaa.enabled = false;
      dropped = 'lissage coupé';
    }
    if (dropped) console.info(`[perf] ${Math.round(fps)} img/s à l'échelle minimale — ${dropped}`);
    return dropped;
  }
}
