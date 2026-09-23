/**
 * Configuration centrale du simulateur.
 * Tout ce qui se règle sans toucher à la logique est ici.
 */

import type { QualityName } from '../world/quality';

/** Modes de fond de scène, par ordre de coût d'accès. */
export type WorldBackend = 'offline' | 'ion' | 'google';

export const CONFIG = {
  /**
   * Fond de scène.
   *  - 'offline' : photo aérienne IGN et relief IGN livré avec l'application. Aucune clé.
   *  - 'ion'     : terrain mondial Cesium + bâtiments OSM 3D. Demande un token Cesium ion (gratuit).
   *  - 'google'  : 3D Tiles photoréalistes. Demande une clé Google Map Tiles API (facturée).
   *
   * Les clés se mettent dans un fichier .env à la racine (voir .env.example).
   */
  backend: (import.meta.env.VITE_WORLD_BACKEND ?? 'offline') as WorldBackend,
  ionToken: import.meta.env.VITE_CESIUM_ION_TOKEN ?? '',
  googleKey: import.meta.env.VITE_GOOGLE_MAPS_KEY ?? '',

  /**
   * Terrain de jeu : Mulhouse, place de la Réunion.
   *
   * Ce centre doit coïncider avec celui des données de `public/data/`, produites
   * par les scripts de `scripts/` : c'est l'origine de leurs coordonnées locales.
   */
  city: {
    name: 'Mulhouse',
    lon: 7.3389,
    lat: 47.7466,
    /**
     * Altitude du sol en mètres, utilisée seulement si le relief réel n'a pas pu
     * être chargé. Le relief IGN va de 235 à 244 m sur la zone.
     */
    groundHeight: 239,
    /** Demi-étendue de la zone bâtie, en mètres. */
    extent: 360,
    /** Graine du générateur : changer ce nombre regénère une ville différente. */
    seed: 20260921,
  },

  /** Caractéristiques de vol du drone. */
  drone: {
    /**
     * Altitude de décollage au-dessus du sol, en mètres.
     * Doit dominer le plus haut bâtiment (Tour Europe, 96 m) : en dessous, le
     * drone décolle le nez dans une façade et la vue de suivi est bouchée.
     */
    startAltitude: 125,
    /** Cap au décollage : orienté vers le foyer principal de dégâts. */
    startHeading: 53,
    /**
     * Afficher le châssis 3D du drone, visible en vue de suivi (touche C).
     *
     * Activé : depuis sa réécriture en primitive, il coûte **+0,1 ms par
     * image**, contre +9,2 ms pour la version en entités. Le détail de la
     * mesure — et la vraie raison pour laquelle on l'a longtemps cru
     * indessinable — sont en tête de `drone/model.ts`.
     */
    showModel: true,
    maxSpeed: 16, // m/s horizontal
    maxClimb: 6, // m/s vertical
    yawRate: 95, // degrés/s
    /** Accélération à pleine commande, en m/s². */
    accel: 14,
    /** Coefficient de traînée : plus il est haut, plus le drone freine vite. */
    drag: 1.9,
    /** Inclinaison visuelle maximale du châssis, en degrés. */
    maxTilt: 22,
    /** Plafond et plancher de vol au-dessus du sol, en mètres. */
    minAGL: 3,
    maxAGL: 400,
    /** Autonomie simulée, en secondes. */
    batteryLife: 900,
  },

  /**
   * Compromis qualité / fluidité.
   *
   * Les réglages de chaque profil (résolution, ombres, anticrénelage, finesse
   * du sol, brouillard) sont dans `world/quality.ts`, avec la façon dont le
   * profil est choisi.
   */
  performance: {
    /**
     * Profil de qualité. 'auto' le choisit d'après la carte graphique : une
     * carte dédiée a droit aux ombres, un circuit intégré passe en 'fluide'.
     * On peut aussi le forcer depuis l'URL : `?qualite=beau`.
     */
    profile: 'auto' as 'auto' | QualityName,

    /**
     * Résolution adaptative.
     *
     * La bonne échelle de rendu ne dépend pas du code mais de la machine : un
     * GPU intégré sur un écran 1920×1080 en mise à l'échelle 125 % doit couvrir
     * 2,5 fois plus de pixels qu'un petit panneau de test. Plutôt que d'imposer
     * une valeur, on vise une cadence et on ajuste la finesse pour la tenir ; à
     * l'échelle minimale, on coupe ensuite les options les plus coûteuses.
     */
    adaptiveResolution: true,
    /** Cadence visée, en images par seconde. */
    targetFps: 50,
    /** Bornes de l'échelle de rendu. En dessous de 0,4 l'image devient molle. */
    minScale: 0.4,
    maxScale: 1.0,

    /**
     * Test de profondeur contre le terrain. Inutile tant que le sol est plat ;
     * forcé dès que le relief réel est chargé.
     */
    depthTestTerrain: false,
  },

  /** Caméra embarquée pointée à la verticale. */
  nadir: {
    /** Champ de vision vertical, en degrés. */
    fov: 50,
    /** Résolution du rendu temps réel (le carré en haut à droite). */
    previewSize: 340,
    /** Résolution des photos enregistrées. */
    photoSize: 1024,
    /**
     * Cadence de rafraîchissement de l'aperçu, en images/s.
     *
     * Chaque rafraîchissement est une passe de rendu COMPLÈTE de la scène,
     * mesurée à ~6 ms : l'image où elle tombe coûte trois fois une image
     * normale. C'est la principale source de saccade, d'où une cadence basse.
     */
    fps: 4,
  },

  /** Détecteur de dommages (simulé, mais bruité comme un vrai). */
  detector: {
    /** Seuil de confiance en-dessous duquel une détection est rejetée. */
    threshold: 0.45,
    /** Écart-type du bruit ajouté au score. Monter = détecteur moins fiable. */
    noise: 0.11,
    /** Probabilité qu'un bâtiment intact soit signalé à tort. */
    falsePositiveRate: 0.05,
    /** Portée de détection depuis le drone, en mètres. */
    range: 260,
  },

  /** Reconnaissance des mains. */
  hands: {
    /** Zone morte centrale, en fraction du cadre. Sans elle, le drone dérive en permanence. */
    deadzone: 0.12,
    /** Amplitude utile autour du centre, en fraction du cadre. */
    gain: 0.3,
    /** Durée de calibrage au démarrage, en secondes. */
    calibrationTime: 3,
    /** Seuils de pincement (normalisés par la taille de la paume), avec hystérésis. */
    pinchOn: 0.32,
    pinchOff: 0.45,
    /** Anti-rebond des gestes, en ms. */
    debounce: 600,
    /** Inverse l'attribution gauche/droite si le mapping semble à l'envers. */
    swapHands: false,
    /**
     * Lissage One Euro du centre de paume.
     *
     * `beta` est le reglage qui compte. Le principe du One Euro est d'ouvrir
     * le filtre quand la main accelere : coupure = minCutoff + beta x vitesse.
     * Les coordonnees de MediaPipe sont normalisees (0 a 1), donc une vitesse
     * de geste vaut 1 a 3 unites/s. Avec un beta trop faible le terme est
     * negligeable, le filtre ne s'ouvre jamais et se comporte comme un simple
     * passe-bas : la main repond en retard quoi qu'on fasse.
     *
     * Mesure sur un geste de 0,30 unite en 0,30 s, echantillonne a 30 Hz,
     * latence pour atteindre 90 pour cent de la consigne :
     *
     *     minCutoff 1,2  beta 0,01 .... 200 ms   (ancien reglage)
     *     minCutoff 1,6  beta 0,70 ....  67 ms   (actuel)
     *     minCutoff 3,2  beta 1,50 ....  33 ms   (nerveux, tremblement visible)
     *
     * Monter `minCutoff` reduit la latence au repos mais laisse passer le
     * tremblement ; monter `beta` ne coute rien au repos et accelere les
     * gestes francs. C'est donc `beta` qu'il faut toucher en premier.
     */
    smoothing: { minCutoff: 1.6, beta: 0.7 },
  },
};

/** URLs des ressources MediaPipe (CDN, pas de clé requise). */
export const MEDIAPIPE = {
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
  model:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
