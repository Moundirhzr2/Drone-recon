/**
 * Pilotage gestuel — MediaPipe Hands, deux mains, disposition Mode 2.
 *
 * POURQUOI DEUX MAINS
 * -------------------
 * Un multirotor a quatre axes continus. Une seule main n'en pilote proprement
 * que deux : pour aller chercher les deux autres il faudrait exploiter la
 * profondeur estimée (bruitée) et l'angle du poignet (qui déplace aussi la
 * paume, donc contamine les axes déjà pris). S'y ajoute un conflit de fond :
 * les gestes ponctuels — prendre une photo — se déclenchent avec les mêmes
 * doigts que ceux qui tiennent le vol.
 *
 * Deux mains reproduisent une radiocommande réelle, en « Mode 2 » :
 *
 *      MAIN GAUCHE                    MAIN DROITE
 *      haut/bas  -> altitude          haut/bas  -> avancer / reculer
 *      gauche/droite -> rotation      gauche/droite -> translation latérale
 *
 * Chaque main porte deux axes indépendants, la charge se répartit, et les
 * doigts redeviennent disponibles pour les gestes ponctuels. Une main qui sort
 * du champ annule seulement SES axes : le drone se stabilise au lieu de partir.
 *
 * TROIS DÉTAILS SANS LESQUELS RIEN NE MARCHE
 * ------------------------------------------
 *  1. Filtrage One Euro. MediaPipe tremble en permanence, même main immobile.
 *  2. Zone morte. Sans elle, le drone dérive dès qu'on ne bouge plus.
 *  3. Pincement normalisé par la taille de la paume, sinon le seuil dépend de
 *     la distance à la caméra et le geste devient impossible à régler.
 */

import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import { CONFIG, MEDIAPIPE } from '../core/config';
import { emit, say } from '../core/bus';
import { clamp, OneEuroFilter } from '../core/math';
import type { ControlSource, ControlVector } from './control';

type Point = { x: number; y: number; z: number };
type Side = 'gauche' | 'droite';

/** Squelette de la main, pour le retour visuel. */
const BONES: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // pouce
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8], // index
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12], // majeur
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16], // annulaire
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20], // auriculaire
  [0, 17],
];

const PALM = [0, 5, 9, 13, 17];
const TIPS = [8, 12, 16, 20];
const KNUCKLES = [6, 10, 14, 18];

interface HandFrame {
  side: Side;
  points: Point[];
  /** Centre de paume filtré, en coordonnées image normalisées. */
  cx: number;
  cy: number;
  pinching: boolean;
  fist: boolean;
}

/** Filtre de lissage neuf, accorde sur CONFIG.hands.smoothing. */
function newFilter(): OneEuroFilter {
  const { minCutoff, beta } = CONFIG.hands.smoothing;
  return new OneEuroFilter(minCutoff, beta);
}

export class HandControl implements ControlSource {
  readonly name = 'mains';

  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;

  private running = false;
  private lastVideoTime = -1;
  private lastTimestamp = 0;

  /** Filtres de lissage, un par main et par axe. */
  private filters: Record<Side, { x: OneEuroFilter; y: OneEuroFilter }> = {
    gauche: { x: newFilter(), y: newFilter() },
    droite: { x: newFilter(), y: newFilter() },
  };

  /** Centres de repos, établis au calibrage. */
  private origin: Record<Side, { x: number; y: number }> = {
    gauche: { x: 0.72, y: 0.5 },
    droite: { x: 0.28, y: 0.5 },
  };

  private calibrating = false;
  private calibSamples: Record<Side, Array<{ x: number; y: number }>> = { gauche: [], droite: [] };
  private calibUntil = 0;

  /** État des gestes, avec anti-rebond. */
  private pinchState: Record<Side, boolean> = { gauche: false, droite: false };
  private lastFire: Record<Side, number> = { gauche: 0, droite: 0 };
  private holdActive = false;

  private current: Record<Side, HandFrame | null> = { gauche: null, droite: null };
  private vector: ControlVector | null = null;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Démarre la webcam et charge le modèle. */
  async start(): Promise<void> {
    if (this.running) return;
    say('Ouverture de la caméra…');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
    } catch {
      say('Caméra refusée ou indisponible — pilotage clavier maintenu', 'err');
      return;
    }

    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);

    if (!this.landmarker) {
      try {
        say('Chargement du modèle de détection…');
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE.wasm);
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MEDIAPIPE.model, delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
      } catch (err) {
        console.error(err);
        say('Modèle indisponible — vérifier la connexion réseau', 'err');
        this.stop();
        return;
      }
    }

    this.running = true;
    this.calibrate();
    requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    this.vector = null;
    this.current = { gauche: null, droite: null };
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.holdActive) {
      this.holdActive = false;
      emit('drone:hold', false);
    }
  }

  async toggle(): Promise<void> {
    if (this.running) {
      this.stop();
      say('Pilotage gestuel coupé');
    } else {
      await this.start();
    }
  }

  /** Relance le calibrage : mains au centre, immobiles. */
  calibrate(): void {
    if (!this.running) return;
    this.calibrating = true;
    this.calibSamples = { gauche: [], droite: [] };
    this.calibUntil = performance.now() + CONFIG.hands.calibrationTime * 1000;
    for (const side of ['gauche', 'droite'] as Side[]) {
      this.filters[side].x.reset();
      this.filters[side].y.reset();
    }
    say('Calibrage : mains ouvertes, au centre, immobiles…');
  }

  // ------------------------------------------------------------------
  // Boucle de détection
  // ------------------------------------------------------------------
  private loop = (): void => {
    if (!this.running || !this.landmarker) return;

    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      // MediaPipe exige un horodatage strictement croissant.
      const ts = Math.max(performance.now(), this.lastTimestamp + 1);
      this.lastTimestamp = ts;
      try {
        const result = this.landmarker.detectForVideo(this.video, ts);
        this.consume(result, ts);
      } catch (err) {
        console.warn('[mains] détection échouée', err);
      }
    }

    requestAnimationFrame(this.loop);
  };

  private consume(result: HandLandmarkerResult, ts: number): void {
    const found: Record<Side, HandFrame | null> = { gauche: null, droite: null };

    for (let i = 0; i < result.landmarks.length; i++) {
      const points = result.landmarks[i] as Point[];
      const label = result.handednesses?.[i]?.[0]?.categoryName ?? 'Right';

      // MediaPipe raisonne du point de vue de la personne filmée.
      let side: Side = label === 'Left' ? 'gauche' : 'droite';
      if (CONFIG.hands.swapHands) side = side === 'gauche' ? 'droite' : 'gauche';

      // Centre de paume : moyenne de cinq points, bien plus stable qu'un doigt.
      let sx = 0;
      let sy = 0;
      for (const idx of PALM) {
        sx += points[idx].x;
        sy += points[idx].y;
      }
      sx /= PALM.length;
      sy /= PALM.length;

      const cx = this.filters[side].x.filter(sx, ts);
      const cy = this.filters[side].y.filter(sy, ts);

      found[side] = {
        side,
        points,
        cx,
        cy,
        pinching: this.detectPinch(side, points),
        fist: detectFist(points),
      };
    }

    this.current = found;

    if (this.calibrating) {
      this.collectCalibration(found, ts);
      this.vector = null;
      this.draw();
      return;
    }

    this.vector = this.toControl(found);
    this.handleGestures(found, ts);
    this.draw();
  }

  private collectCalibration(found: Record<Side, HandFrame | null>, ts: number): void {
    for (const side of ['gauche', 'droite'] as Side[]) {
      const h = found[side];
      if (h) this.calibSamples[side].push({ x: h.cx, y: h.cy });
    }

    if (ts < this.calibUntil) return;

    this.calibrating = false;
    let ok = 0;
    for (const side of ['gauche', 'droite'] as Side[]) {
      const s = this.calibSamples[side];
      // On ne retient que la seconde moitié : le temps que la main se stabilise.
      const stable = s.slice(Math.floor(s.length / 2));
      if (stable.length < 6) continue;
      this.origin[side] = {
        x: stable.reduce((a, p) => a + p.x, 0) / stable.length,
        y: stable.reduce((a, p) => a + p.y, 0) / stable.length,
      };
      ok++;
    }

    if (ok === 2) say('Calibrage terminé — deux mains actives', 'ok');
    else if (ok === 1) say('Une seule main calibrée — axes partiels', 'err');
    else say('Aucune main vue — recommencer avec K', 'err');
  }

  /**
   * Conversion d'une position de main en commande.
   * Zone morte d'abord, puis renormalisation : sans cette seconde étape, la
   * commande saute brutalement de 0 à la valeur du seuil en sortie de zone.
   */
  private axis(value: number, center: number, invert = false): number {
    const raw = (value - center) / CONFIG.hands.gain;
    const dz = CONFIG.hands.deadzone;
    const mag = Math.abs(raw);
    if (mag < dz) return 0;
    const norm = ((mag - dz) / (1 - dz)) * Math.sign(raw);
    return clamp(invert ? -norm : norm, -1, 1);
  }

  private toControl(found: Record<Side, HandFrame | null>): ControlVector | null {
    const left = found.gauche;
    const right = found.droite;
    if (!left && !right) return null;

    const v: ControlVector = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };

    if (left) {
      // Haut de l'image = y faible : monter demande donc une inversion.
      v.throttle = this.axis(left.cy, this.origin.gauche.y, true);
      // L'image n'est pas retournée : déplacer la main vers SA droite fait
      // DIMINUER x. On inverse pour que le sens perçu soit le bon.
      v.yaw = this.axis(left.cx, this.origin.gauche.x, true);
    }
    if (right) {
      v.pitch = this.axis(right.cy, this.origin.droite.y, true);
      v.roll = this.axis(right.cx, this.origin.droite.x, true);
    }
    return v;
  }

  // ------------------------------------------------------------------
  // Gestes ponctuels
  // ------------------------------------------------------------------
  private detectPinch(side: Side, p: Point[]): boolean {
    // Normalisation par la largeur de paume : le seuil devient indépendant de
    // la distance entre la main et la caméra.
    const palm = Math.hypot(p[9].x - p[0].x, p[9].y - p[0].y) || 1e-6;
    const gap = Math.hypot(p[4].x - p[8].x, p[4].y - p[8].y) / palm;

    const was = this.pinchState[side];
    // Hystérésis : deux seuils distincts, sinon le geste papillonne au bord.
    const now = was ? gap < CONFIG.hands.pinchOff : gap < CONFIG.hands.pinchOn;
    this.pinchState[side] = now;
    return now;
  }

  private handleGestures(found: Record<Side, HandFrame | null>, ts: number): void {
    // Front montant du pincement, avec anti-rebond.
    for (const side of ['gauche', 'droite'] as Side[]) {
      const h = found[side];
      if (!h || !h.pinching) continue;
      if (ts - this.lastFire[side] < CONFIG.hands.debounce) continue;
      this.lastFire[side] = ts;

      if (side === 'droite') emit('photo:take');
      else emit('view:toggle-diagnostic');
    }

    // Deux poings fermés : stabilisation. C'est un geste franc, impossible à
    // déclencher par accident pendant un pilotage normal.
    const bothFists = !!found.gauche?.fist && !!found.droite?.fist;
    if (bothFists !== this.holdActive) {
      this.holdActive = bothFists;
      emit('drone:hold', bothFists);
      if (bothFists) say('Stabilisation — poings fermés', 'ok');
    }
  }

  // ------------------------------------------------------------------
  // Retour visuel
  // ------------------------------------------------------------------
  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);

    if (this.calibrating) {
      const left = Math.max(0, (this.calibUntil - performance.now()) / 1000);
      ctx.fillStyle = 'rgba(0, 229, 255, 0.85)';
      ctx.font = '600 22px ui-monospace, monospace';
      ctx.textAlign = 'center';
      // Le canvas est retourné par CSS : on compense pour garder le texte lisible.
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.fillText(left.toFixed(1), w / 2, h / 2 + 8);
      ctx.restore();
    }

    for (const side of ['gauche', 'droite'] as Side[]) {
      const hand = this.current[side];
      if (!hand) continue;

      const tint = side === 'gauche' ? '#ffc400' : '#00e5ff';
      const px = (p: Point) => p.x * w;
      const py = (p: Point) => p.y * h;

      ctx.strokeStyle = hand.pinching ? '#00e676' : tint;
      ctx.lineWidth = hand.pinching ? 2.5 : 1.5;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(px(hand.points[a]), py(hand.points[a]));
        ctx.lineTo(px(hand.points[b]), py(hand.points[b]));
      }
      ctx.stroke();

      // Centre de paume et origine calibrée : on voit d'un coup d'oeil
      // l'amplitude de commande envoyée.
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(hand.cx * w, hand.cy * h, 4, 0, Math.PI * 2);
      ctx.fill();

      const o = this.origin[side];
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(o.x * w, o.y * h, CONFIG.hands.deadzone * CONFIG.hands.gain * w * 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(o.x * w, o.y * h);
      ctx.lineTo(hand.cx * w, hand.cy * h);
      ctx.stroke();

      if (hand.fist) {
        ctx.fillStyle = 'rgba(255,23,68,.9)';
        ctx.beginPath();
        ctx.arc(hand.cx * w, hand.cy * h, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /** Résumé pour le HUD. */
  status(): { left: boolean; right: boolean; calibrating: boolean; hold: boolean } {
    return {
      left: !!this.current.gauche,
      right: !!this.current.droite,
      calibrating: this.calibrating,
      hold: this.holdActive,
    };
  }

  read(): ControlVector | null {
    return this.running ? this.vector : null;
  }
}

/** Poing fermé : chaque bout de doigt est plus près du poignet que sa jointure. */
function detectFist(p: Point[]): boolean {
  let curled = 0;
  for (let i = 0; i < TIPS.length; i++) {
    const tip = p[TIPS[i]];
    const knuckle = p[KNUCKLES[i]];
    const dTip = Math.hypot(tip.x - p[0].x, tip.y - p[0].y);
    const dKnuckle = Math.hypot(knuckle.x - p[0].x, knuckle.y - p[0].y);
    if (dTip < dKnuckle) curled++;
  }
  return curled >= 3;
}
