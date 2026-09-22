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
 */

import { CONFIG } from '../core/config';
import { clamp, DEG, metersToDegrees, wrap360 } from '../core/math';
import type { ControlVector } from '../input/control';

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
}

export class Drone {
  readonly state: DroneState;
  readonly home: { lon: number; lat: number };

  constructor(private ground: number) {
    this.home = { lon: CONFIG.city.lon, lat: CONFIG.city.lat };
    this.state = {
      lon: CONFIG.city.lon,
      lat: CONFIG.city.lat,
      agl: CONFIG.drone.startAltitude,
      msl: ground + CONFIG.drone.startAltitude,
      heading: CONFIG.drone.startHeading,
      vEast: 0,
      vNorth: 0,
      vUp: 0,
      pitch: 0,
      roll: 0,
      battery: 1,
      flightTime: 0,
      holding: false,
    };
  }

  reset(): void {
    const s = this.state;
    s.lon = this.home.lon;
    s.lat = this.home.lat;
    s.agl = CONFIG.drone.startAltitude;
    s.msl = this.ground + s.agl;
    s.heading = CONFIG.drone.startHeading;
    s.vEast = s.vNorth = s.vUp = 0;
    s.pitch = s.roll = 0;
    s.holding = false;
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

    // --- Intégration ------------------------------------------------------
    const { dLon, dLat } = metersToDegrees(s.vEast * dt, s.vNorth * dt, s.lat);
    s.lon += dLon;
    s.lat += dLat;
    s.agl += s.vUp * dt;

    // Butées de vol : au sol on ne s'enfonce pas, au plafond on ne monte plus.
    if (s.agl < C.minAGL) {
      s.agl = C.minAGL;
      if (s.vUp < 0) s.vUp = 0;
    }
    if (s.agl > C.maxAGL) {
      s.agl = C.maxAGL;
      if (s.vUp > 0) s.vUp = 0;
    }
    s.msl = this.ground + s.agl;

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
