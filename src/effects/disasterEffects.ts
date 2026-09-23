/**
 * Effets visuels des désastres.
 *
 * Tout ici est ASSERVI au temps de la chronologie (`DisasterPlayer.time`),
 * jamais à l'horloge murale : le niveau de l'eau, les bâtiments en feu, le
 * rayon de l'onde de choc se déduisent de l'instant affiché. Déplacer le
 * curseur de lecture, revenir en arrière ou sauter à la fin donne donc
 * toujours une image cohérente avec l'état des bâtiments.
 *
 * Seuls les effets ponctuels — la boule de feu, la poussière d'un effondrement
 * — dépendent du déroulement : ils ne se déclenchent que pendant une lecture
 * vers l'avant. Un saut direct au bilan n'en fait pas jaillir des centaines.
 *
 * BUDGET
 * ------
 * Une explosion peut faire s'effondrer des centaines de bâtiments, et un
 * incendie en embraser autant. Les particules se paient au processeur, image
 * par image : on plafonne donc le nombre d'émetteurs actifs, en réservant les
 * effets aux bâtiments les plus proches de la caméra, les seuls qu'on voit en
 * détail. Au-delà, l'état des bâtiments suffit à lire le sinistre.
 *
 * Les systèmes de particules et le matériau « eau » animé sont ceux de CesiumJS,
 * tels qu'utilisés dans ses exemples officiels (Sandcastle).
 */

import * as Cesium from 'cesium';
import type { Building } from '../world/buildings';
import { standingHeight } from '../world/buildings';
import type { City } from '../world/city';
import { floodLevel, seismicIntensity, type Scenario } from '../disaster/scenario';
import { floodBottom, type DisasterPlayer, type Timeline } from '../disaster/timeline';

/** Émetteurs de feu actifs au plus. */
const MAX_FIRES = 14;
/** Nuages de poussière simultanés au plus. */
const MAX_DUST = 8;
/**
 * Systèmes de particules créés au plus par image. Chaque création coûte :
 * Cesium y bâtit une collection de billboards et son atlas de textures.
 * Quatorze foyers et sept nuages de poussière nés dans la même image faisaient
 * un pic de 70 ms ; étalés sur quelques images, ils passent inaperçus.
 */
const MAX_NEW_SYSTEMS = 4;
/** Au-delà de cette distance à la caméra, un effet ne vaut pas son coût. */
const EFFECT_RANGE = 900;
/** Durée pendant laquelle un bâtiment consumé fume encore, en secondes. */
const SMOLDER = 12;
/**
 * Durée minimale des flammes, en secondes de chronologie. Un départ de feu dû
 * à une explosion ou à un séisme passe à l'état « consumé » presque aussitôt
 * dans la simulation ; le feu, lui, continue de brûler bien après.
 */
const MIN_FLAMES = 15;
/** Instant d'arrivée de l'onde de choc au foyer, en secondes. */
const BLAST_AT = 0.4;
/** Vitesse de l'onde de choc : celle du son, qu'elle rejoint vite. */
const SOUND_SPEED = 340;
/** Pesanteur, pour les débris projetés. */
const GRAVITY = 9.81;

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------

/**
 * Tache douce, générée une fois : un dégradé radial. Aucun fichier d'image à
 * livrer, et la même tache sert à la fumée, aux flammes et à la poussière — la
 * couleur est donnée par le système de particules.
 */
function softSprite(size = 64, core = 0.15): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(
    size / 2,
    size / 2,
    size * core,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

// ---------------------------------------------------------------------------
// Forces appliquées aux particules
// ---------------------------------------------------------------------------

const scratch = new Cesium.Cartesian3();

/**
 * Poussée verticale et traînée. Les particules vivent dans le repère terrestre
 * (ECEF) : la verticale locale est la direction de leur propre position.
 *
 * Avec `ramp`, la couleur suit en plus une rampe à plusieurs paliers.
 */
function buoyancy(
  lift: number,
  drag: number,
  ramp?: ColorStop[],
): Cesium.ParticleSystem.updateCallback {
  return (p: Cesium.Particle, dt: number) => {
    Cesium.Cartesian3.normalize(p.position, scratch);
    Cesium.Cartesian3.multiplyByScalar(scratch, lift * dt, scratch);
    Cesium.Cartesian3.add(p.velocity, scratch, p.velocity);
    Cesium.Cartesian3.multiplyByScalar(p.velocity, Math.max(0, 1 - drag * dt), p.velocity);
    if (ramp) applyRamp(p, ramp);
  };
}

/** Un palier de couleur : l'âge relatif de la particule, entre 0 et 1. */
type ColorStop = readonly [age: number, color: Cesium.Color];

/**
 * Couleur d'une particule au fil de sa vie, sur plusieurs paliers.
 *
 * Cesium n'interpole qu'entre une couleur de départ et une d'arrivée, et le
 * mélange direct du jaune incandescent au gris de la fumée passe par un beige
 * terne qui ne ressemble à rien. Une flamme qui refroidit passe par l'orange
 * puis le rouge sombre avant de noircir : on fixe donc les deux couleurs à la
 * valeur de la rampe, et l'interpolation de Cesium n'a plus rien à mélanger.
 */
function applyRamp(p: Cesium.Particle, stops: ColorStop[]): void {
  // La masse, tirée au hasard à la naissance et inutilisée par ailleurs, sert
  // de rythme de refroidissement propre à chaque particule : sans cet écart,
  // toutes celles nées ensemble ont la même teinte, et le feu tourne à l'aplat.
  const age = Math.min(Math.max(p.normalizedAge * p.mass, 0), 1);
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < age) i++;
  const [a0, c0] = stops[i - 1];
  const [a1, c1] = stops[i];
  const f = a1 > a0 ? Math.min(Math.max((age - a0) / (a1 - a0), 0), 1) : 1;
  Cesium.Color.lerp(c0, c1, f, p.startColor);
  Cesium.Color.clone(p.startColor, p.endColor);
}

const rgba = (r: number, g: number, b: number, a: number) => new Cesium.Color(r, g, b, a);

/** Boule de feu : du blanc incandescent à la fumée, en passant par le rouge. */
const FIREBALL_RAMP: ColorStop[] = [
  [0, rgba(1, 0.97, 0.82, 1)],
  [0.12, rgba(1, 0.78, 0.32, 1)],
  [0.3, rgba(0.98, 0.45, 0.12, 0.95)],
  [0.5, rgba(0.55, 0.2, 0.08, 0.85)],
  [0.72, rgba(0.22, 0.16, 0.13, 0.6)],
  [1, rgba(0.2, 0.19, 0.18, 0)],
];

/** Flammes d'un bâtiment : jaune à la base, rouge sombre en haut. */
const FLAME_RAMP: ColorStop[] = [
  [0, rgba(1, 0.86, 0.46, 0.95)],
  [0.35, rgba(1, 0.55, 0.14, 0.9)],
  [0.7, rgba(0.78, 0.2, 0.05, 0.6)],
  [1, rgba(0.3, 0.1, 0.05, 0)],
];

/**
 * Éclat de débris : un polygone irrégulier à bords francs. Une tache douce
 * ferait un nuage ; un débris doit se lire comme un objet dur.
 */
function shardSprite(size = 32): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const corners = [
    [0.18, 0.3],
    [0.62, 0.1],
    [0.9, 0.46],
    [0.7, 0.88],
    [0.26, 0.78],
  ];
  g.fillStyle = '#fff';
  g.beginPath();
  corners.forEach(([x, y], i) => (i ? g.lineTo(x * size, y * size) : g.moveTo(x * size, y * size)));
  g.closePath();
  g.fill();
  return c;
}

/**
 * Émetteur en demi-sphère : directions réparties uniformément vers le haut,
 * départ sur une petite boule. Cesium n'en fournit pas, et son émetteur conique
 * tire les rayons uniformément sur la BASE du cône : ouvert large, il envoie la
 * plupart des particules presque à l'horizontale, et la boule de feu prend une
 * forme de V.
 */
class HemisphereEmitter {
  constructor(private radius: number) {}

  emit(p: Cesium.Particle): void {
    // cos θ uniforme sur [0, 1] donne une densité uniforme sur la demi-sphère.
    const z = Math.random();
    const phi = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    p.velocity = Cesium.Cartesian3.fromElements(
      r * Math.cos(phi),
      r * Math.sin(phi),
      z,
      p.velocity,
    );
    p.position = Cesium.Cartesian3.multiplyByScalar(
      p.velocity,
      this.radius * Math.cbrt(Math.random()),
      p.position,
    );
  }
}

// ---------------------------------------------------------------------------
// Onde de choc : une demi-sphère unité, mise à l'échelle chaque image
// ---------------------------------------------------------------------------

/**
 * Le front d'une explosion au sol est une demi-sphère qui s'élargit. Il est
 * d'ordinaire invisible ; par temps humide, la détente qui le suit condense la
 * vapeur d'eau en un voile blanc, bref — le dôme des vidéos de Beyrouth en
 * 2020. C'est ce voile qu'on dessine : presque transparent de face, plus dense
 * sur les bords, comme une bulle. Contrairement à une bande posée au sol, il
 * se voit au-dessus des toits.
 */
function shockDome(): Cesium.EllipsoidGeometry {
  return new Cesium.EllipsoidGeometry({
    radii: new Cesium.Cartesian3(1, 1, 1),
    maximumCone: Cesium.Math.PI_OVER_TWO,
    stackPartitions: 24,
    slicePartitions: 72,
    vertexFormat: Cesium.MaterialAppearance.MaterialSupport.BASIC.vertexFormat,
  });
}

// ---------------------------------------------------------------------------
// Eau de crue
// ---------------------------------------------------------------------------

/**
 * Matériau de l'eau de crue.
 *
 * Il reprend les vagues animées du matériau « Water » de Cesium (même carte de
 * normales, même bruit), et y ajoute ce qui manquait pour qu'une nappe se lise
 * comme de l'EAU vue de biais : le reflet du ciel, qui croît à mesure que le
 * regard devient rasant (approximation de Schlick du facteur de Fresnel). Vue
 * d'en haut, la crue est boueuse ; vers l'horizon, elle devient un miroir
 * pâle. Sans ce reflet, une crue brune se confondait avec un terrain vague.
 */
function floodWaterMaterial(): Cesium.Material {
  return new Cesium.Material({
    translucent: true,
    fabric: {
      type: 'EauDeCrue',
      uniforms: {
        normalMap: Cesium.buildModuleUrl('Assets/Textures/waterNormals.jpg'),
        mudColor: new Cesium.Color(0.35, 0.31, 0.22, 0.9),
        skyColor: new Cesium.Color(0.6, 0.67, 0.74, 1),
        frequency: 300.0,
        animationSpeed: 0.012,
        // Vagues douces : plus fortes, les reflets tournaient en plaques
        // claires qu'on prenait pour de la neige.
        amplitude: 2.5,
        specularIntensity: 0.7,
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput)
        {
          czm_material material = czm_getDefaultMaterial(materialInput);
          float time = czm_frameNumber * animationSpeed;
          vec4 noise = czm_getWaterNoise(normalMap, materialInput.st * frequency, time, 0.0);
          vec3 normalTS = normalize(noise.xyz * vec3(1.0, 1.0, 1.0 / amplitude));
          vec3 normalEC = normalize(materialInput.tangentToEyeMatrix * normalTS);

          float cosTheta = clamp(dot(normalEC, normalize(materialInput.positionToEyeEC)), 0.0, 1.0);
          float fresnel = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);

          vec3 mud = czm_gammaCorrect(mudColor).rgb;
          vec3 sky = czm_gammaCorrect(skyColor).rgb;
          material.diffuse = mix(mud, sky, fresnel);
          // Crêtes des vagues un peu plus claires, comme dans « Water ».
          material.diffuse += 0.08 * clamp(dot(normalTS, vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
          material.alpha = mudColor.a;
          material.normal = normalEC;
          material.specular = specularIntensity;
          material.shininess = 18.0;
          return material;
        }
      `,
    },
  });
}

// ---------------------------------------------------------------------------

interface FireSlot {
  flames: Cesium.ParticleSystem;
  smoke: Cesium.ParticleSystem;
}

interface Blast {
  frame: Cesium.Matrix4;
  wave: Cesium.Primitive;
  waveMaterial: Cesium.Material;
  flash: Cesium.BillboardCollection;
  fireball: Cesium.ParticleSystem | null;
  debris: Cesium.ParticleSystem | null;
  smoke: Cesium.ParticleSystem | null;
  /** Rayon au-delà duquel l'onde n'est plus qu'un souffle, en mètres. */
  reach: number;
}

export class DisasterEffects {
  // Les sprites passent en URL `data:`, et ce n'est pas un détail. Cesium
  // range l'image de chaque billboard dans un atlas de textures, sous un
  // identifiant tiré de son URL ; un <canvas> n'en a pas, et chaque billboard
  // en reçoit alors un inédit. Chaque particule ajoutait ainsi SA copie du
  // sprite à l'atlas, qui grossissait et se recopiait sans cesse : 110 ms par
  // image pendant une explosion sur une GTX 1650, contre 10 ms sans particules.
  // Avec une URL, toutes les particules partagent une seule entrée.
  private sprite = softSprite().toDataURL();
  private shard = shardSprite().toDataURL();
  private timeline: Timeline | null = null;
  private byId = new Map<string, Building>();

  private water: Cesium.Primitive | null = null;
  private waterBottom = 0;
  private waterUp = new Cesium.Cartesian3();

  private blast: Blast | null = null;
  private baseLight = 2.1;

  private fires = new Map<string, FireSlot>();
  private lastFireScan = -Infinity;

  private dust: Array<{ ps: Cesium.ParticleSystem; until: number }> = [];

  /** Systèmes à émission unique arrivés au bout de leur vie, à retirer. */
  private finished = new Set<Cesium.ParticleSystem>();

  /** Créations de systèmes encore permises dans l'image courante. */
  private budget = MAX_NEW_SYSTEMS;

  /** Faux dans les vues techniques (scan, diagnostic) : voir `setVisible`. */
  private visible = true;

  /** Système de préchauffage, retiré après quelques images (voir `warmUp`). */
  private warm: { ps: Cesium.ParticleSystem; frames: number } | null = null;

  constructor(
    private scene: Cesium.Scene,
    private city: City,
    private groundAt: (lon: number, lat: number) => number,
  ) {
    for (const b of city.buildings) this.byId.set(b.id, b);
    const light = scene.light as Cesium.DirectionalLight;
    if (light && typeof light.intensity === 'number') this.baseLight = light.intensity;
    this.warmUp();
  }

  /**
   * Préchauffage : un système de particules invisible, rendu quelques images
   * dès le démarrage. Le premier système créé fait compiler à Cesium ses
   * shaders de billboards dimensionnés en mètres — 85 ms d'un coup, mesurés
   * au moment précis de l'explosion. Autant les payer pendant le chargement.
   */
  private warmUp(): void {
    const ps = new Cesium.ParticleSystem({
      image: this.sprite,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
        Cesium.Cartesian3.fromDegrees(this.city.center.lon, this.city.center.lat, -500),
      ),
      emissionRate: 0,
      bursts: [new Cesium.ParticleBurst({ time: 0, minimum: 2, maximum: 2 })],
      minimumImageSize: new Cesium.Cartesian2(1, 1),
      maximumImageSize: new Cesium.Cartesian2(1, 1),
      sizeInMeters: true,
    });
    this.scene.primitives.add(ps);
    this.warm = { ps, frames: 0 };
  }

  /**
   * À appeler à chaque image, après la mise à jour du lecteur.
   * @param now horodatage de l'image, en millisecondes.
   */
  update(player: DisasterPlayer, now: number): void {
    this.budget = MAX_NEW_SYSTEMS;
    if (this.warm && ++this.warm.frames > 5) {
      this.scene.primitives.remove(this.warm.ps);
      this.warm = null;
    }

    const tl = player.current;
    if (tl !== this.timeline) {
      this.reset();
      this.timeline = tl;
      if (tl) this.prepare(tl);
    }
    if (!tl) return;

    const t = player.time;
    const s = tl.scenario;
    if (s.kind === 'inondation') this.updateFlood(s, t);
    if (s.kind === 'explosion') this.updateBlast(s, t, player);

    // Les incendies ne sont pas réservés au scénario « incendie » : un séisme
    // ou une explosion en allument aussi, par les réseaux de gaz.
    // Rafraîchi toutes les 350 ms : le choix des bâtiments en flammes n'a pas
    // besoin de suivre chaque image.
    if (now - this.lastFireScan > 350) {
      this.lastFireScan = now;
      this.updateFires(tl, t);
    }

    // Poussière des effondrements, seulement pendant une lecture vers l'avant.
    if (player.recentSpan > 0 && player.recentSpan < 1.5) {
      for (const e of player.recent) {
        if (e.state !== 'collapsed' && e.state !== 'partial') continue;
        const b = this.byId.get(e.id);
        if (b) this.spawnDust(b, now);
      }
    }
    this.expireDust(now);
    this.sweep();
    if (!this.visible) this.applyVisibility();
  }

  /**
   * Masque ou rétablit les effets. Les vues « scan » et diagnostique ne
   * montrent que la classification des dommages : fumée, flammes et eau y
   * brouilleraient la lecture. Le sinistre continue de se dérouler, simplement
   * sans être dessiné.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    for (const ps of this.systems()) ps.show = this.visible;
    if (this.blast) this.blast.flash.show = this.visible;
    // L'eau et l'onde de choc sont réaffichées par leur propre mise à jour.
    if (!this.visible) {
      if (this.water) this.water.show = false;
      if (this.blast) this.blast.wave.show = false;
    }
  }

  /** Tous les systèmes de particules en cours. */
  private *systems(): Generator<Cesium.ParticleSystem> {
    const b = this.blast;
    if (b?.fireball) yield b.fireball;
    if (b?.debris) yield b.debris;
    if (b?.smoke) yield b.smoke;
    for (const slot of this.fires.values()) yield* [slot.flames, slot.smoke];
    for (const d of this.dust) yield d.ps;
  }

  /**
   * Neutralise les particules mortes, et retire les systèmes terminés.
   *
   * Quand une particule meurt, Cesium masque son billboard sans le détruire,
   * pour le réutiliser. Or un billboard masqué dont la taille est en mètres
   * n'est PAS gratuit : son shader le ramène sur l'œil de la caméra, où sa
   * taille déborde l'écran, et la carte graphique le traite quand même.
   * Mesuré sur une GTX 1650 : les 275 particules éteintes d'une boule de feu
   * coûtaient 10 ms par image, invisibles. Une échelle nulle les rend
   * inoffensives, et Cesium la rétablit lorsqu'il réutilise la particule.
   */
  private sweep(): void {
    for (const ps of this.finished) {
      this.scene.primitives.remove(ps);
      const b = this.blast;
      if (b?.fireball === ps) b.fireball = null;
      if (b?.debris === ps) b.debris = null;
    }
    this.finished.clear();

    for (const ps of this.systems()) {
      const bc = (ps as unknown as { _billboardCollection?: Cesium.BillboardCollection })
        ._billboardCollection;
      if (!bc) continue;
      for (let i = 0; i < bc.length; i++) {
        const bb = bc.get(i);
        if (!bb.show && bb.scale !== 0) bb.scale = 0;
      }
    }
  }

  /**
   * Secousse de la caméra pendant un séisme. À appeler juste après que la
   * caméra a été placée derrière le drone, et avant le rendu.
   *
   * C'est une CONVENTION visuelle, empruntée au cinéma : un drone en vol ne
   * ressent pas un séisme. Mais sans elle, rien à l'écran ne dirait que le sol
   * tremble pendant la dizaine de secondes où les bâtiments se fissurent.
   */
  shake(camera: Cesium.Camera, player: DisasterPlayer): void {
    const tl = player.current;
    if (!tl || tl.scenario.kind !== 'seisme' || !player.playing) return;
    const s = tl.scenario;
    const t = player.time;
    const strong = s.duration * 0.34;
    const envelope =
      t < 0.8 ? 0 : t < 1.8 ? t - 0.8 : t < strong + 1 ? 1 : Math.max(0, 1 - (t - strong - 1) / 3);
    if (envelope <= 0) return;

    // Amplitude proportionnelle à l'intensité ressentie sous la caméra.
    const carto = camera.positionCartographic;
    const mLon = 111320 * Math.cos((this.city.center.lat * Math.PI) / 180);
    const east = ((carto.longitude * 180) / Math.PI - this.city.center.lon) * mLon;
    const north = ((carto.latitude * 180) / Math.PI - this.city.center.lat) * 111320;
    const intensity = seismicIntensity(Math.hypot(east - s.east, north - s.north), s.magnitude);
    const amp = (0.08 + 0.7 * intensity) * envelope;

    // Somme de sinusoïdes de fréquences premières entre elles : un tremblement
    // qui ne se répète pas, sans le grésillement d'un bruit tiré au hasard.
    const w = t * Math.PI * 2;
    const dx = amp * (Math.sin(w * 7.1) + 0.6 * Math.sin(w * 11.3 + 1.7));
    const dy = amp * (Math.sin(w * 5.3 + 0.4) + 0.5 * Math.sin(w * 13.7 + 2.9));
    const offset = Cesium.Cartesian3.multiplyByScalar(camera.rightWC, dx, new Cesium.Cartesian3());
    Cesium.Cartesian3.add(
      offset,
      Cesium.Cartesian3.multiplyByScalar(camera.upWC, dy, new Cesium.Cartesian3()),
      offset,
    );
    camera.position = Cesium.Cartesian3.add(camera.position, offset, new Cesium.Cartesian3());
    camera.twistRight(0.004 * amp * Math.sin(w * 9.1));
  }

  destroy(): void {
    this.reset();
  }

  // ------------------------------------------------------------------------
  // Préparation et nettoyage
  // ------------------------------------------------------------------------

  private prepare(tl: Timeline): void {
    if (tl.scenario.kind === 'inondation') this.prepareFlood();
    if (tl.scenario.kind === 'explosion') this.prepareBlast(tl.scenario);
  }

  private reset(): void {
    const prims = this.scene.primitives;
    if (this.water) prims.remove(this.water);
    this.water = null;

    if (this.blast) {
      prims.remove(this.blast.wave);
      prims.remove(this.blast.flash);
      this.extinguishBlast(this.blast);
      this.blast = null;
    }
    this.setLight(1);

    for (const id of [...this.fires.keys()]) this.dropFire(id);
    for (const d of this.dust) prims.remove(d.ps);
    this.dust = [];
    this.finished.clear();
    this.lastFireScan = -Infinity;
  }

  // ------------------------------------------------------------------------
  // Inondation
  // ------------------------------------------------------------------------

  /**
   * Une nappe d'eau plane couvrant la zone, posée au point le plus bas puis
   * relevée par sa `modelMatrix` à mesure que l'eau monte : on ne reconstruit
   * rien pendant la crue. C'est le relief qui la découpe — le test de
   * profondeur contre le terrain la cache là où le sol est plus haut que l'eau.
   *
   * Couleur boueuse, pas bleue : une crue charrie la terre qu'elle arrache.
   */
  private prepareFlood(): void {
    this.waterBottom = floodBottom(this.city);
    const { lon, lat } = this.city.center;
    const half = 700;
    const dLat = half / 111320;
    const dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));

    const material = floodWaterMaterial();

    this.water = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(lon - dLon, lat - dLat, lon + dLon, lat + dLat),
          height: this.waterBottom,
          vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
        }),
      }),
      appearance: new Cesium.EllipsoidSurfaceAppearance({ material, aboveGround: true }),
      asynchronous: false,
      show: false,
    });
    Cesium.Cartesian3.normalize(Cesium.Cartesian3.fromDegrees(lon, lat, 0), this.waterUp);
    this.scene.primitives.add(this.water);
  }

  private updateFlood(s: Scenario, t: number): void {
    if (!this.water) return;
    const rise = floodLevel(s, t, this.waterBottom) - this.waterBottom;
    this.water.show = rise > 0.02;
    this.water.modelMatrix = Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.multiplyByScalar(this.waterUp, rise, new Cesium.Cartesian3()),
    );
  }

  // ------------------------------------------------------------------------
  // Explosion
  // ------------------------------------------------------------------------

  private prepareBlast(s: Scenario): void {
    const { lon: lon0, lat: lat0 } = this.city.center;
    const lon = lon0 + s.east / (111320 * Math.cos((lat0 * Math.PI) / 180));
    const lat = lat0 + s.north / 111320;
    const ground = this.groundAt(lon, lat);
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(lon, lat, ground),
    );

    const waveMaterial = Cesium.Material.fromType('RimLighting', {
      color: new Cesium.Color(0.96, 0.95, 0.92, 0),
      rimColor: new Cesium.Color(1, 1, 0.97, 0),
      width: 0.5,
    });
    const wave = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry: shockDome() }),
      appearance: new Cesium.MaterialAppearance({
        material: waveMaterial,
        materialSupport: Cesium.MaterialAppearance.MaterialSupport.BASIC,
        translucent: true,
        // Visible de l'intérieur aussi : l'onde finit par dépasser le drone.
        closed: false,
        faceForward: true,
      }),
      asynchronous: false,
      show: false,
    });

    const flash = new Cesium.BillboardCollection({ scene: this.scene });
    flash.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, ground + 30),
      image: this.sprite,
      color: new Cesium.Color(1, 0.93, 0.75, 0),
      width: 170,
      height: 170,
      sizeInMeters: true,
    });

    // La surpression retombe sous 0,03 bar : au-delà, l'onde ne casse plus
    // rien et on cesse de la dessiner. Même loi que la simulation.
    const reach = Math.cbrt(Math.max(s.magnitude, 0.01) * 1000) * 45;

    this.scene.primitives.add(wave);
    this.scene.primitives.add(flash);
    this.blast = {
      frame,
      wave,
      waveMaterial,
      flash,
      fireball: null,
      debris: null,
      smoke: null,
      reach,
    };
  }

  private updateBlast(s: Scenario, t: number, player: DisasterPlayer): void {
    const b = this.blast;
    if (!b) return;
    const since = t - BLAST_AT;

    // Flash : une lueur et un éclat de la lumière de la scène, pendant moins
    // d'une seconde.
    const glow = since >= 0 ? Math.exp(-since / 0.18) : 0;
    this.setLight(1 + 3 * glow);
    const billboard = b.flash.get(0);
    billboard.color = new Cesium.Color(1, 0.9, 0.7, Math.min(1, glow * 1.4));
    billboard.scale = 0.6 + 1.6 * (1 - glow);

    // Onde de choc : le dôme s'élargit à la vitesse du son et s'efface en
    // s'éloignant, d'autant plus vite que la surpression chute.
    const r = since * SOUND_SPEED;
    const alive = since > 0 && r < b.reach;
    b.wave.show = alive;
    if (alive) {
      const fade = (1 - r / b.reach) ** 1.6;
      b.wave.modelMatrix = Cesium.Matrix4.multiply(
        b.frame,
        Cesium.Matrix4.fromUniformScale(Math.max(r, 0.5)),
        b.wave.modelMatrix,
      );
      const u = b.waveMaterial.uniforms as { color: Cesium.Color; rimColor: Cesium.Color };
      u.color.alpha = 0.07 * fade;
      u.rimColor.alpha = 0.75 * fade;
    }

    // Boule de feu, débris et colonne de fumée : on ne les fait naître que si
    // l'on assiste au passage de l'instant, pas après un saut dans la
    // chronologie.
    const crossing =
      player.recentSpan > 0 &&
      player.recentSpan < 1.5 &&
      since >= 0 &&
      since - player.recentSpan <= 0;
    if (crossing && !b.fireball) this.igniteBlast(b, s);
    if (since < 0) this.extinguishBlast(b);
    if (b.smoke) {
      // La colonne s'épuise en une quinzaine de secondes.
      b.smoke.emissionRate = since < 12 ? 30 * (1 - since / 14) : 0;
    }
  }

  /**
   * Les trois temps d'une explosion vue de loin : la boule de feu, qui
   * s'étale en une fraction de seconde puis monte en s'assombrissant ; les
   * débris, projetés en cloche ; la colonne de fumée, qui dure.
   *
   * Tout part vers le haut. Une explosion au sol ne s'enfonce pas dans le
   * sol : une sphère d'émission y perdrait la moitié de ses particules,
   * cachées sous le terrain.
   */
  private igniteBlast(b: Blast, s: Scenario): void {
    // Les dimensions d'une explosion suivent la racine cubique de la charge,
    // comme la portée de son onde de choc.
    const size = Math.cbrt(Math.max(s.magnitude, 0.2));
    // Les particules partent de 2 m au-dessus du sol, pour ne pas naître à
    // moitié enterrées dans le relief.
    const raised = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(0, 0, 2));

    b.fireball = new Cesium.ParticleSystem({
      image: this.sprite,
      modelMatrix: b.frame,
      emitterModelMatrix: raised,
      emitter: new HemisphereEmitter(4 * size),
      emissionRate: 0,
      bursts: [new Cesium.ParticleBurst({ time: 0, minimum: 240, maximum: 300 })],
      lifetime: 3,
      loop: false,
      // Des vitesses faibles aussi, sinon la boule est creuse : toutes les
      // particules s'arrêtent à la même distance du centre.
      minimumSpeed: 5 * size,
      maximumSpeed: 55 * size,
      minimumParticleLife: 1.2,
      maximumParticleLife: 3,
      // Rythme de refroidissement propre à chaque particule (voir `applyRamp`).
      minimumMass: 0.6,
      maximumMass: 1.4,
      startScale: 1,
      endScale: 3.2,
      minimumImageSize: new Cesium.Cartesian2(11 * size, 11 * size),
      maximumImageSize: new Cesium.Cartesian2(22 * size, 22 * size),
      sizeInMeters: true,
      // Une traînée forte arrête l'expansion en une fraction de seconde ; la
      // poussée d'Archimède prend ensuite le relais et fait monter la boule.
      updateCallback: buoyancy(16, 2.6, FIREBALL_RAMP),
    });
    b.debris = new Cesium.ParticleSystem({
      image: this.shard,
      modelMatrix: b.frame,
      emitterModelMatrix: raised,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(62)),
      emissionRate: 0,
      bursts: [new Cesium.ParticleBurst({ time: 0, minimum: 110, maximum: 150 })],
      lifetime: 6,
      loop: false,
      minimumSpeed: 22 * size,
      maximumSpeed: 60 * size,
      minimumParticleLife: 2.5,
      maximumParticleLife: 5,
      startColor: new Cesium.Color(0.16, 0.14, 0.12, 1),
      endColor: new Cesium.Color(0.22, 0.2, 0.18, 0.85),
      startScale: 1,
      endScale: 1,
      minimumImageSize: new Cesium.Cartesian2(1.2, 1.2),
      maximumImageSize: new Cesium.Cartesian2(3.2, 3.2),
      sizeInMeters: true,
      // Balistique : la pesanteur, et un peu de résistance de l'air.
      updateCallback: buoyancy(-GRAVITY, 0.06),
    });
    b.smoke = new Cesium.ParticleSystem({
      image: this.sprite,
      modelMatrix: b.frame,
      emitterModelMatrix: raised,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(22)),
      emissionRate: 30,
      lifetime: 30,
      loop: false,
      minimumSpeed: 8,
      maximumSpeed: 16,
      minimumParticleLife: 7,
      maximumParticleLife: 12,
      startColor: new Cesium.Color(0.22, 0.19, 0.17, 0.85),
      endColor: new Cesium.Color(0.36, 0.34, 0.32, 0),
      startScale: 1,
      endScale: 6,
      minimumImageSize: new Cesium.Cartesian2(12 * size, 12 * size),
      maximumImageSize: new Cesium.Cartesian2(22 * size, 22 * size),
      sizeInMeters: true,
      updateCallback: buoyancy(2.5, 0.35),
    });
    this.scene.primitives.add(b.smoke);
    this.scene.primitives.add(b.debris);
    this.scene.primitives.add(b.fireball);
    // Une fois toutes leurs particules éteintes, boule de feu et débris n'ont
    // plus rien à montrer : on les retire (voir `sweep`).
    for (const ps of [b.fireball, b.debris]) {
      ps.complete.addEventListener(() => this.finished.add(ps));
    }
  }

  private extinguishBlast(b: Blast): void {
    for (const ps of [b.fireball, b.debris, b.smoke]) if (ps) this.scene.primitives.remove(ps);
    b.fireball = b.debris = b.smoke = null;
  }

  private setLight(factor: number): void {
    const light = this.scene.light as Cesium.DirectionalLight;
    if (light && typeof light.intensity === 'number') light.intensity = this.baseLight * factor;
  }

  // ------------------------------------------------------------------------
  // Incendies
  // ------------------------------------------------------------------------

  /**
   * Choisit les bâtiments qui portent des flammes : ceux en feu ou qui fument
   * encore à l'instant affiché, les plus proches de la caméra d'abord.
   */
  private updateFires(tl: Timeline, t: number): void {
    const eye = this.scene.camera.positionWC;
    const active: Array<{ id: string; burning: boolean; d: number }> = [];
    for (const f of tl.fires) {
      const flamesUntil = Math.max(f.to, f.from + MIN_FLAMES);
      if (t < f.from || t > flamesUntil + SMOLDER) continue;
      const b = this.byId.get(f.id);
      if (!b) continue;
      const d = Cesium.Cartesian3.distance(
        eye,
        Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.baseHeight),
      );
      if (d > EFFECT_RANGE) continue;
      active.push({ id: f.id, burning: t <= flamesUntil, d });
    }
    active.sort((a, b) => a.d - b.d);
    const chosen = new Map(active.slice(0, MAX_FIRES).map((a) => [a.id, a.burning]));

    for (const id of [...this.fires.keys()]) if (!chosen.has(id)) this.dropFire(id);
    for (const [id, burning] of chosen) {
      let slot = this.fires.get(id);
      if (!slot) {
        // Les plus proches d'abord ; les suivants s'allumeront aux passages
        // suivants, 350 ms plus tard.
        const b = this.byId.get(id);
        if (!b || this.budget < 2) continue;
        this.budget -= 2;
        slot = this.lightFire(b);
        this.fires.set(id, slot);
      }
      // Une fois le bâtiment consumé, plus de flammes, mais une fumée plus
      // claire qui retombe peu à peu.
      slot.flames.emissionRate = burning ? this.flameRate(id) : 0;
      slot.smoke.emissionRate = burning ? 5 : 2;
    }
  }

  private flameRate(id: string): number {
    const b = this.byId.get(id);
    const area = b ? (b.area ?? b.width * b.depth) : 100;
    return Math.min(70, Math.max(18, area / 10));
  }

  private lightFire(b: Building): FireSlot {
    const top = b.baseHeight + standingHeight(b);
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(b.lon, b.lat, top),
    );
    // Les flammes naissent sur toute l'emprise du toit, orientée comme le
    // bâtiment.
    const rot = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromRotationZ((b.heading * Math.PI) / 180),
    );
    const flames = new Cesium.ParticleSystem({
      image: this.sprite,
      modelMatrix: frame,
      emitterModelMatrix: rot,
      emitter: new Cesium.BoxEmitter(
        new Cesium.Cartesian3(Math.max(b.width * 0.8, 3), Math.max(b.depth * 0.8, 3), 1.5),
      ),
      emissionRate: this.flameRate(b.id),
      minimumSpeed: 1.5,
      maximumSpeed: 4.5,
      minimumParticleLife: 0.6,
      maximumParticleLife: 1.4,
      minimumMass: 0.7,
      maximumMass: 1.3,
      startScale: 1,
      endScale: 0.4,
      minimumImageSize: new Cesium.Cartesian2(3.5, 3.5),
      maximumImageSize: new Cesium.Cartesian2(8, 8),
      sizeInMeters: true,
      updateCallback: buoyancy(13, 1.2, FLAME_RAMP),
    });
    const smoke = new Cesium.ParticleSystem({
      image: this.sprite,
      modelMatrix: frame,
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14)),
      emissionRate: 5,
      minimumSpeed: 4,
      maximumSpeed: 8,
      minimumParticleLife: 6,
      maximumParticleLife: 10,
      // Une colonne par foyer, qui s'élargit en montant sans devenir un mur :
      // quatorze foyers voisins finissaient par masquer tout le quartier.
      startColor: new Cesium.Color(0.16, 0.15, 0.14, 0.7),
      endColor: new Cesium.Color(0.35, 0.34, 0.33, 0),
      startScale: 1,
      endScale: 4,
      minimumImageSize: new Cesium.Cartesian2(7, 7),
      maximumImageSize: new Cesium.Cartesian2(12, 12),
      sizeInMeters: true,
      updateCallback: buoyancy(1.8, 0.25),
    });
    this.scene.primitives.add(flames);
    this.scene.primitives.add(smoke);
    return { flames, smoke };
  }

  private dropFire(id: string): void {
    const slot = this.fires.get(id);
    if (!slot) return;
    this.scene.primitives.remove(slot.flames);
    this.scene.primitives.remove(slot.smoke);
    this.fires.delete(id);
  }

  // ------------------------------------------------------------------------
  // Poussière d'effondrement
  // ------------------------------------------------------------------------

  private spawnDust(b: Building, now: number): void {
    if (this.dust.length >= MAX_DUST || this.budget < 1) return;
    const base = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.baseHeight);
    if (Cesium.Cartesian3.distance(base, this.scene.camera.positionWC) > EFFECT_RANGE) return;

    const size = Math.max(b.width, b.depth);
    const ps = new Cesium.ParticleSystem({
      image: this.sprite,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(base),
      emitter: new Cesium.CircleEmitter(Math.max(size * 0.5, 4)),
      emissionRate: 0,
      // Peu de particules, mais larges : c'est leur surface cumulée à l'écran
      // qui coûte, pas leur nombre.
      bursts: [new Cesium.ParticleBurst({ time: 0, minimum: 30, maximum: 45 })],
      lifetime: 6,
      loop: false,
      minimumSpeed: 3,
      maximumSpeed: 9,
      minimumParticleLife: 2.5,
      maximumParticleLife: 5.5,
      startColor: new Cesium.Color(0.64, 0.6, 0.52, 0.8),
      endColor: new Cesium.Color(0.64, 0.6, 0.52, 0),
      startScale: 1,
      endScale: 2.6,
      minimumImageSize: new Cesium.Cartesian2(7, 7),
      maximumImageSize: new Cesium.Cartesian2(12, 12),
      sizeInMeters: true,
      updateCallback: buoyancy(1.2, 0.9),
    });
    this.scene.primitives.add(ps);
    this.budget -= 1;
    this.dust.push({ ps, until: now + 7000 });
  }

  private expireDust(now: number): void {
    this.dust = this.dust.filter((d) => {
      if (now < d.until) return true;
      this.scene.primitives.remove(d.ps);
      return false;
    });
  }
}
