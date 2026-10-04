/**
 * Physique de vol du drone.
 *
 * Modèle volontairement simple — masse ponctuelle, traînée linéaire — mais avec
 * la propriété qui compte : de l'INERTIE. Un drone qui se téléporte sur commande
 * est facile à coder et pénible à piloter ; celui-ci accélère, dérive et freine,
 * ce qui rend le cadrage d'une photo réellement intéressant.
 *
 * Les commandes arrivent dans le repère du drone (avant / droite), pas du monde :
 * c'est le lacet qui décide où est « l'avant ».
 *
 * COLLISIONS ET ATTERRISSAGE
 * --------------------------
 * Les bâtiments et les ruines sont solides (`world/obstacles.ts`). Un mur
 * arrête le drone, qui glisse le long de la façade s'il l'aborde de biais.
 * Une marche basse — le bord d'un tas de gravats, un éclat au sol — se
 * franchit : le drone s'élève au-dessus. Descendre jusqu'au contact le pose,
 * sur le sol, un toit ou des gravats : moteurs au ralenti, il ne bouge plus
 * jusqu'à ce qu'on remette les gaz.
 */

import { CONFIG } from '../core/config';
import { clamp, DEG, metersToDegrees, wrap360 } from '../core/math';
import type { ControlVector } from '../input/control';
import type { Solid } from '../world/obstacles';

export interface DroneState {
  lon: number;
  lat: number;
  /** Altitude au-dessus du sol, en mètres. */
  agl: number;
  /** Altitude au-dessus du niveau de la mer, en mètres. */
  msl: number;
  /** Cap en degrés, 0 = nord. */
  heading: number;

  /** Vitesses dans le repère monde, en m/s. */
  vEast: number;
  vNorth: number;
  vUp: number;

  /** Inclinaisons visuelles du châssis, en degrés. */
  pitch: number;
  roll: number;

  /** Charge restante, entre 0 et 1. */
  battery: number;
  /** Durée de vol écoulée, en secondes. */
  flightTime: number;
  /** Stabilisation active : le drone refuse les commandes et freine. */
  holding: boolean;
  /** Posé : moteurs au ralenti, jusqu'à ce qu'on remette les gaz. */
  landed: boolean;
  /** Altitude de ce qui est sous le drone — sol, toit ou gravats —, comme `msl`. */
  floor: number;
  /** Ce qui est sous le drone, `null` au-dessus du sol nu. */
  below: Solid | null;
}

/** Le plancher en un point : le sol, la hauteur du drone posé là, et ce qui le porte. */
interface Floor {
  ground: number;
  agl: number;
  solid: Solid | null;
}

/** Ce que le drone signale : un contact, un atterrissage, un décollage. */
export type DroneEvent =
  | { type: 'contact'; solid: Solid }
  | { type: 'landed'; on: Solid | null; speed: number }
  | { type: 'takeoff' };

export class Drone {
  readonly state: DroneState;
  readonly home: { lon: number; lat: number };
  /** Appelé à chaque contact, atterrissage ou décollage. */
  onEvent: ((e: DroneEvent) => void) | null = null;

  /**
   * @param groundAt altitude du sol en un point. Avec le relief réel, la
   *   hauteur au-dessus du sol reste juste quand le drone passe d'un quartier bas
   *   à un quartier haut.
   * @param solidAt le plus haut solide sous un disque : voir `world/obstacles.ts`.
   *   Sans lui, le drone traverse les bâtiments.
   */
  constructor(
    private groundAt: (lon: number, lat: number) => number,
    private solidAt: (lon: number, lat: number, radius: number) => Solid | null = () => null,
  ) {
    this.home = { lon: CONFIG.city.lon, lat: CONFIG.city.lat };
    this.state = {
      lon: CONFIG.city.lon,
      lat: CONFIG.city.lat,
      agl: CONFIG.drone.startAltitude,
      msl: groundAt(CONFIG.city.lon, CONFIG.city.lat) + CONFIG.drone.startAltitude,
      heading: CONFIG.drone.startHeading,
      vEast: 0,
      vNorth: 0,
      vUp: 0,
      pitch: 0,
      roll: 0,
      battery: 1,
      flightTime: 0,
      holding: false,
      landed: false,
      floor: groundAt(CONFIG.city.lon, CONFIG.city.lat),
      below: null,
    };
  }

  reset(): void {
    const s = this.state;
    s.lon = this.home.lon;
    s.lat = this.home.lat;
    s.agl = CONFIG.drone.startAltitude;
    s.msl = this.groundAt(s.lon, s.lat) + s.agl;
    s.heading = CONFIG.drone.startHeading;
    s.vEast = s.vNorth = s.vUp = 0;
    s.pitch = s.roll = 0;
    s.holding = false;
    s.landed = false;
  }

  /**
   * Le plancher du drone en un point : la hauteur au-dessus du sol où son
   * centre se trouve quand il est posé là, sur le sol ou sur ce qui le couvre.
   */
  private floorAt(lon: number, lat: number): Floor {
    const C = CONFIG.drone;
    const ground = this.groundAt(lon, lat);
    const solid = this.solidAt(lon, lat, C.radius);
    const agl = Math.max(C.minAGL, solid ? solid.top - ground + C.minAGL : C.minAGL);
    return { ground, agl, solid };
  }

  /**
   * Avance de (east, north) mètres, sauf à travers un mur : le drone glisse
   * alors le long de la façade, ou s'arrête net s'il l'aborde de face.
   * @returns le plancher là où il arrive, ou `null` s'il n'a pas bougé.
   */
  private move(east: number, north: number): Floor | null {
    const s = this.state;
    const C = CONFIG.drone;
    // Le passage est libre si le plancher, là-bas, ne dépasse pas de plus
    // d'une marche la hauteur où vole le drone.
    const probe = (dEast: number, dNorth: number) => {
      const { dLon, dLat } = metersToDegrees(dEast, dNorth, s.lat);
      const lon = s.lon + dLon;
      const lat = s.lat + dLat;
      const floor = this.floorAt(lon, lat);
      const wall = floor.solid && floor.agl > s.agl + C.stepUp ? floor.solid : null;
      return { lon, lat, floor, wall };
    };
    const go = (to: ReturnType<typeof probe>) => {
      s.lon = to.lon;
      s.lat = to.lat;
      return to.floor;
    };

    const ahead = probe(east, north);
    if (!ahead.wall) return go(ahead);
    this.onEvent?.({ type: 'contact', solid: ahead.wall });
    // De biais : on garde la composante qui longe le mur.
    const alongEast = probe(east, 0);
    if (!alongEast.wall) {
      s.vNorth *= -C.bounce;
      return go(alongEast);
    }
    const alongNorth = probe(0, north);
    if (!alongNorth.wall) {
      s.vEast *= -C.bounce;
      return go(alongNorth);
    }
    s.vEast *= -C.bounce;
    s.vNorth *= -C.bounce;
    return null;
  }

  /** Vitesse sol, en m/s. */
  get groundSpeed(): number {
    return Math.hypot(this.state.vEast, this.state.vNorth);
  }

  update(dt: number, ctl: ControlVector): void {
    const s = this.state;
    const C = CONFIG.drone;

    // En stabilisation, on ignore les manches et on freine énergiquement.
    const cmd = s.holding ? { pitch: 0, roll: 0, yaw: 0, throttle: 0 } : ctl;
    const brake = s.holding ? 4.5 : 1;

    // --- Posé -----------------------------------------------------------------
    // Les gaz seuls le font repartir. Sinon il reste où il est, et suit ce qui
    // le porte : un toit qui s'effondre le dépose sur les gravats.
    if (s.landed && cmd.throttle > C.takeoffThrottle) {
      s.landed = false;
      this.onEvent?.({ type: 'takeoff' });
    }
    if (s.landed) {
      s.vEast = s.vNorth = s.vUp = 0;
      // Figé pour une paire avant / après : le point de vue ne doit pas bouger.
      if (!s.holding) {
        const { ground, agl, solid } = this.floorAt(s.lon, s.lat);
        s.agl = agl;
        s.msl = ground + agl;
        s.floor = s.msl - C.minAGL;
        s.below = solid;
      }
      const k = Math.min(1, dt * 5);
      s.pitch -= s.pitch * k;
      s.roll -= s.roll * k;
      s.flightTime += dt;
      // Au ralenti, l'électronique seule consomme.
      s.battery = Math.max(0, s.battery - (dt / C.batteryLife) * 0.15);
      return;
    }

    // --- Lacet ---------------------------------------------------------
    s.heading = wrap360(s.heading + cmd.yaw * C.yawRate * dt);

    // --- Translation horizontale ----------------------------------------
    // Le repère de commande tourne avec le drone.
    const h = s.heading * DEG;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const fwd = cmd.pitch; //  +1 = avancer
    const rgt = cmd.roll; //  +1 = translater à droite

    const accEast = (fwd * sin + rgt * cos) * C.accel;
    const accNorth = (fwd * cos - rgt * sin) * C.accel;

    s.vEast += (accEast - C.drag * brake * s.vEast) * dt;
    s.vNorth += (accNorth - C.drag * brake * s.vNorth) * dt;

    // Plafonnement de la vitesse horizontale, direction conservée.
    const speed = Math.hypot(s.vEast, s.vNorth);
    if (speed > C.maxSpeed) {
      const k = C.maxSpeed / speed;
      s.vEast *= k;
      s.vNorth *= k;
    }

    // --- Altitude --------------------------------------------------------
    const accUp = cmd.throttle * C.accel * 0.8;
    s.vUp += (accUp - C.drag * brake * 1.3 * s.vUp) * dt;
    s.vUp = clamp(s.vUp, -C.maxClimb, C.maxClimb);
    // Atterrissage assisté, comme sur un vrai drone : dans les derniers mètres,
    // la descente ralentit, et il touche à un demi-mètre par seconde environ.
    const clearance = s.msl - C.minAGL - s.floor;
    if (s.vUp < 0 && clearance < 4) s.vUp = Math.max(s.vUp, -(0.4 + clearance));

    // --- Intégration ------------------------------------------------------
    // Le plancher d'arrivée sert aussi aux butées : une seule interrogation
    // des obstacles par pas quand rien ne gêne.
    const moved = this.move(s.vEast * dt, s.vNorth * dt);
    s.agl += s.vUp * dt;

    // Butées de vol : on ne s'enfonce ni dans le sol ni dans ce qui le couvre,
    // au plafond on ne monte plus.
    const floor = moved ?? this.floorAt(s.lon, s.lat);
    const { ground } = floor;
    if (s.agl <= floor.agl) {
      const impact = Math.max(0, -s.vUp);
      s.agl = floor.agl;
      if (s.vUp < 0) s.vUp = 0;
      // Au contact en descendant : il se pose.
      if (cmd.throttle < -C.takeoffThrottle) {
        s.landed = true;
        s.vEast = s.vNorth = 0;
        this.onEvent?.({ type: 'landed', on: floor.solid, speed: impact });
      }
    }
    if (s.agl > C.maxAGL) {
      s.agl = C.maxAGL;
      if (s.vUp > 0) s.vUp = 0;
    }
    s.msl = ground + s.agl;
    s.floor = ground + floor.agl - C.minAGL;
    s.below = floor.solid;

    // --- Assiette visuelle -------------------------------------------------
    // Un vrai multirotor s'incline dans le sens de son accélération. On reproduit
    // l'effet à partir de la vitesse exprimée dans le repère du drone.
    const vFwd = s.vEast * sin + s.vNorth * cos;
    const vRgt = s.vEast * cos - s.vNorth * sin;
    const targetPitch = clamp((vFwd / C.maxSpeed) * C.maxTilt, -C.maxTilt, C.maxTilt);
    const targetRoll = clamp((vRgt / C.maxSpeed) * C.maxTilt, -C.maxTilt, C.maxTilt);
    const k = Math.min(1, dt * 5);
    s.pitch += (targetPitch - s.pitch) * k;
    s.roll += (targetRoll - s.roll) * k;

    // --- Énergie ------------------------------------------------------------
    s.flightTime += dt;
    // Consommation de base, majorée par l'effort demandé aux moteurs.
    const effort = 1 + 0.6 * (Math.abs(cmd.throttle) + Math.hypot(cmd.pitch, cmd.roll) * 0.5);
    s.battery = Math.max(0, s.battery - (dt / C.batteryLife) * effort);
  }
}
