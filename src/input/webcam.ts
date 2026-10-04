/**
 * Traitement de l'image de la webcam, par OpenCV.
 *
 * MediaPipe repère les mains ; OpenCV s'occupe de l'image elle-même. Trois
 * traitements, chacun pour une raison :
 *
 *  1. MESURE DE L'ÉCLAIRAGE — la luminance moyenne de l'image, plusieurs fois
 *     par seconde, sur une vignette : l'éclairage d'une pièce change lentement,
 *     inutile de la mesurer sur chaque image en pleine taille.
 *  2. CORRECTION D'ÉCLAIRAGE, quand la pièce est sombre — égalisation
 *     adaptative du contraste (CLAHE) sur la luminance seule (espace YCrCb),
 *     pour ne pas fausser les couleurs de peau. Dans la pénombre, la main
 *     redevient lisible pour le détecteur. En pleine lumière, elle n'apporterait
 *     rien et ajouterait du bruit : MediaPipe reçoit alors la vidéo telle
 *     quelle, en pleine définition.
 *  3. RETOUR VIDÉO — par-dessus la vidéo, OpenCV dessine le squelette de chaque
 *     main, la zone neutre, la commande reconnue, et signale la correction
 *     d'éclairage quand elle est active.
 *
 * OpenCV (13 Mo) n'est chargé qu'à l'activation du pilotage gestuel. Ses
 * matrices vivent hors du ramasse-miettes de JavaScript : elles sont créées
 * une fois, réutilisées à chaque image, et libérées par `dispose()`.
 */

import type { CV, Mat, MatVector } from '@techstark/opencv-js';
import { CONFIG } from '../core/config';

/** Une main à dessiner sur le retour vidéo, en coordonnées image normalisées. */
export interface HandSketch {
  points: Array<{ x: number; y: number }>;
  /** Centre de paume filtré, et centre de repos établi au calibrage. */
  cx: number;
  cy: number;
  origin: { x: number; y: number };
  /** Couleur de la main, en rouge, vert, bleu. */
  color: [number, number, number];
  pinching: boolean;
  fist: boolean;
}

/** Ce que le retour vidéo doit montrer par-dessus l'image. */
export interface Overlay {
  hands: HandSketch[];
  /** Commande reconnue, une ligne par main : `G  MONTE`, `D  AVANCE`. */
  lines: string[];
  /** Secondes restantes du calibrage, ou `null` hors calibrage. */
  countdown: number | null;
}

/** Os de la main, entre les 21 points de repère de MediaPipe. */
export const BONES: Array<[number, number]> = [
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

/** Vignette de mesure de l'éclairage, en pixels. */
const PROBE_WIDTH = 160;
const PROBE_HEIGHT = 120;

/** Charge OpenCV et attend que son moteur WebAssembly soit prêt. */
async function loadOpenCv(): Promise<CV> {
  const module = await import('@techstark/opencv-js');
  const candidate = ((module as { default?: unknown }).default ?? module) as unknown;
  if (candidate instanceof Promise) return (await candidate) as CV;
  const cv = candidate as CV & { onRuntimeInitialized?: () => void };
  if (cv.Mat) return cv;
  await new Promise<void>((resolve) => {
    cv.onRuntimeInitialized = () => resolve();
  });
  return cv;
}

/** Un canvas dont on relit les pixels, et la matrice qui les reçoit. */
interface Grab {
  ctx: CanvasRenderingContext2D;
  rgba: Mat;
  width: number;
  height: number;
}

export class WebcamVision {
  /** Luminance moyenne de la dernière mesure, de 0 à 255. */
  brightness = 128;
  /** Vrai quand la pièce est assez sombre pour que l'image soit corrigée. */
  correcting = false;
  /** Durée du dernier traitement (mesure ou correction), en millisecondes. */
  ms = 0;

  private probe: Grab;
  private gray: Mat;
  /** Image à corriger, créée au premier besoin. */
  private full: Grab | null = null;
  private rgb: Mat;
  private ycrcb: Mat;
  private equalized: Mat;
  private planes: MatVector;
  private corrected: ImageData | null = null;
  private clahe: InstanceType<CV['CLAHE']>;
  /** Calque transparent du retour vidéo. */
  private layer: Mat;

  private constructor(private cv: CV) {
    this.probe = this.grab(PROBE_WIDTH, PROBE_HEIGHT);
    this.gray = new cv.Mat();
    this.rgb = new cv.Mat();
    this.ycrcb = new cv.Mat();
    this.equalized = new cv.Mat();
    this.planes = new cv.MatVector();
    this.layer = new cv.Mat();
    const { claheClip, claheGrid } = CONFIG.hands.vision;
    this.clahe = new cv.CLAHE(claheClip, new cv.Size(claheGrid, claheGrid));
  }

  static async create(): Promise<WebcamVision> {
    return new WebcamVision(await loadOpenCv());
  }

  private grab(width: number, height: number): Grab {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D indisponible');
    return { ctx, rgba: new this.cv.Mat(height, width, this.cv.CV_8UC4), width, height };
  }

  /** Copie l'image courante de la vidéo dans la matrice de `target`. */
  private read(video: HTMLVideoElement, target: Grab): void {
    target.ctx.drawImage(video, 0, 0, target.width, target.height);
    target.rgba.data.set(target.ctx.getImageData(0, 0, target.width, target.height).data);
  }

  /**
   * Mesure l'éclairage sur une vignette et décide s'il faut corriger. Deux
   * seuils distincts, sinon la correction clignoterait autour d'un seul.
   */
  measure(video: HTMLVideoElement): void {
    const cv = this.cv;
    const start = performance.now();
    this.read(video, this.probe);
    cv.cvtColor(this.probe.rgba, this.gray, cv.COLOR_RGBA2GRAY);
    this.brightness = cv.mean(this.gray)[0];
    const { darkThreshold, brightMargin } = CONFIG.hands.vision;
    if (this.correcting) this.correcting = this.brightness < darkThreshold + brightMargin;
    else this.correcting = this.brightness < darkThreshold;
    this.ms = performance.now() - start;
  }

  /**
   * Corrige l'éclairage de l'image courante (CLAHE sur la luminance) et la rend
   * en pixels bruts, prêts pour le détecteur de main.
   */
  correct(video: HTMLVideoElement): ImageData {
    const cv = this.cv;
    const start = performance.now();
    const width = CONFIG.hands.vision.width;
    const height = Math.round((width * (video.videoHeight || 480)) / (video.videoWidth || 640));
    if (!this.full || this.full.width !== width || this.full.height !== height) {
      this.full?.rgba.delete();
      this.full = this.grab(width, height);
      this.corrected = new ImageData(width, height);
    }
    const full = this.full;
    this.read(video, full);

    cv.cvtColor(full.rgba, this.rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(this.rgb, this.ycrcb, cv.COLOR_RGB2YCrCb);
    cv.split(this.ycrcb, this.planes);
    const luma = this.planes.get(0);
    this.clahe.apply(luma, this.equalized);
    luma.delete();
    this.planes.set(0, this.equalized);
    cv.merge(this.planes, this.ycrcb);
    cv.cvtColor(this.ycrcb, this.rgb, cv.COLOR_YCrCb2RGB);
    cv.cvtColor(this.rgb, full.rgba, cv.COLOR_RGB2RGBA);
    const image = this.corrected!;
    image.data.set(full.rgba.data);

    this.ms = performance.now() - start;
    return image;
  }

  /**
   * Dessine le retour vidéo sur un calque transparent, posé sur la vidéo
   * affichée en miroir : un point en x se dessine donc en 1 - x. Le texte
   * d'OpenCV ne connaît pas les accents : capitales sans accent.
   */
  overlay(target: HTMLCanvasElement, overlay: Overlay): void {
    const cv = this.cv;
    const w = target.width;
    const h = target.height;
    if (this.layer.rows !== h || this.layer.cols !== w) {
      this.layer.delete();
      this.layer = new cv.Mat(h, w, cv.CV_8UC4);
    }
    this.layer.setTo(new cv.Scalar(0, 0, 0, 0));

    const at = (p: { x: number; y: number }) =>
      new cv.Point(Math.round((1 - p.x) * w), Math.round(p.y * h));
    const scale = w / 240;
    const rgba = (r: number, g: number, b: number, a = 255) => new cv.Scalar(r, g, b, a);
    const white = rgba(255, 255, 255, 140);

    for (const hand of overlay.hands) {
      const color = hand.pinching ? rgba(0, 230, 118) : rgba(...hand.color);
      const thick = Math.max(1, Math.round((hand.pinching ? 2.5 : 1.5) * scale));
      for (const [a, b] of BONES) {
        cv.line(this.layer, at(hand.points[a]), at(hand.points[b]), color, thick, cv.LINE_AA);
      }
      // Zone neutre autour du centre de repos, et l'écart qui fait la commande.
      const radius = Math.round(CONFIG.hands.deadzone * CONFIG.hands.gain * w * 2);
      const center = at({ x: hand.cx, y: hand.cy });
      cv.circle(this.layer, at(hand.origin), radius, white, 1, cv.LINE_AA);
      cv.line(this.layer, at(hand.origin), center, white, 1, cv.LINE_AA);
      cv.circle(this.layer, center, Math.round(4 * scale), color, -1, cv.LINE_AA);
      if (hand.fist) {
        cv.circle(this.layer, center, Math.round(10 * scale), rgba(255, 23, 68), 2, cv.LINE_AA);
      }
    }

    const font = cv.FONT_HERSHEY_SIMPLEX;
    // Texte cerné de noir : lisible sur n'importe quel fond de webcam. Le
    // contour est fait de copies fines décalées, pas d'un trait épais : chez
    // OpenCV, l'épaisseur élargit chaque lettre, et le contour glisserait.
    const shift = Math.max(1, Math.round(scale));
    const text = (
      value: string,
      x: number,
      y: number,
      size: number,
      color = rgba(255, 255, 255),
    ) => {
      const put = (dx: number, dy: number, c: ReturnType<typeof rgba>) =>
        cv.putText(
          this.layer,
          value,
          new cv.Point(Math.round(x) + dx, Math.round(y) + dy),
          font,
          size * scale,
          c,
          1,
          cv.LINE_AA,
        );
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        put(dx * shift, dy * shift, rgba(0, 0, 0, 220));
      }
      put(0, 0, color);
    };
    overlay.lines.forEach((line, i) => {
      text(line, 6 * scale, h - (8 + (overlay.lines.length - 1 - i) * 16) * scale, 0.42);
    });
    if (this.correcting) text('LUMIERE CORRIGEE', 6 * scale, 14 * scale, 0.38, rgba(255, 196, 0));
    if (overlay.countdown !== null) {
      text(
        overlay.countdown.toFixed(1),
        w / 2 - 24 * scale,
        h / 2 + 10 * scale,
        1.1,
        rgba(0, 229, 255),
      );
    }

    cv.imshow(target, this.layer);
  }

  /** Libère les matrices d'OpenCV, qui échappent au ramasse-miettes. */
  dispose(): void {
    this.probe.rgba.delete();
    this.full?.rgba.delete();
    for (const mat of [this.gray, this.rgb, this.ycrcb, this.equalized, this.layer]) mat.delete();
    this.planes.delete();
    this.clahe.delete();
  }
}
