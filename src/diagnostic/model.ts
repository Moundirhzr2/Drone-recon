/**
 * Détecteur entraîné : un vrai modèle de vision, branché à la place de
 * `analyse()`.
 *
 * Le modèle exporté par `ml/exporter.py` tourne dans un worker sur l'image
 * nadir, telle qu'elle est rendue. Ses boîtes sont ensuite confrontées à la
 * vérité du simulateur : chaque boîte est rapprochée du bâtiment réel qu'elle
 * recouvre le mieux, ce qui donne, comme pour le détecteur simulé, la
 * précision et le rappel en direct — mais cette fois ceux d'un vrai modèle.
 *
 * Le contrat est la fiche `public/models/detecteur.json` : taille d'entrée,
 * classes, format de sortie. Un autre détecteur se branche en remplaçant le
 * modèle et sa fiche ; seul un format de sortie différent de celui de YOLO
 * demande d'écrire son décodage (voir `yolo.ts`).
 */

import { CONFIG } from '../core/config';
import { groundDistance } from '../core/math';
import { annotate } from '../dataset/annotate';
import type { NadirGeometry } from '../drone/nadir';
import { DAMAGE_INFO, DAMAGE_ORDER, type Building, type DamageState } from '../world/buildings';
import type { Detection, DiagnosticResult } from './detector';
import type { WorkerRequest, WorkerResponse } from './model.worker';
import { iou, type RawBox } from './yolo';

/** Fiche du modèle, écrite par `ml/exporter.py`. */
export interface ModelCard {
  name: string;
  format: string;
  inputSize: number;
  /** Une classe par sortie, nommée comme un état de dommage du simulateur. */
  classes: string[];
  /** Hauteurs de vol extrêmes des images d'entraînement, en mètres. */
  trainedAltitudes: [number, number];
  epoch: number;
  validation: { mAP50: number; 'mAP50-95': number; precision: number; recall: number };
  exportedAt: string;
}

/**
 * Dégâts que le modèle a appris à voir. « Fissuré » n'en fait pas partie :
 * la ville dessinée rend un bâtiment fissuré comme un intact, et l'entraînement
 * a fusionné les deux classes (voir `ml/preparer.py`).
 */
const VISIBLE_DAMAGE: ReadonlySet<DamageState> = new Set(['partial', 'collapsed', 'burnt']);

/** Écart toléré, en mètres, avant de signaler un vol hors des hauteurs d'entraînement. */
const ALTITUDE_MARGIN = 15;

/** Recouvrement à partir duquel une boîte trop imprécise est dite viser un bâtiment. */
const LOOSE_IOU = 0.1;

/** Échecs d'inférence d'affilée au-delà desquels on considère le modèle en panne. */
const MAX_FAILURES = 3;

export type ModelState = 'off' | 'loading' | 'ready' | 'error';

export class TrainedDetector {
  state: ModelState = 'off';
  card: ModelCard | null = null;
  /** Où tourne le modèle : carte graphique ou processeur. */
  backend: 'webgpu' | 'wasm' | null = null;
  error = '';
  /** Durée d'une inférence, en millisecondes, lissée. */
  ms = 0;

  private worker: Worker | null = null;
  private classes: DamageState[] = [];
  private pending: { id: number; geometry: NadirGeometry } | null = null;
  private seq = 0;
  private failures = 0;
  private loading: Promise<void> | null = null;

  /** @param onResult appelé avec les boîtes et la géométrie de l'image analysée. */
  constructor(private onResult: (boxes: RawBox[], geometry: NadirGeometry) => void) {}

  /** Prêt à recevoir une image : modèle chargé et aucune analyse en cours. */
  get idle(): boolean {
    return this.state === 'ready' && this.pending === null;
  }

  /** Classe annoncée par une boîte, en état du simulateur. */
  classOf(box: RawBox): DamageState {
    return this.classes[box.classId] ?? 'intact';
  }

  /** Charge la fiche, puis le modèle dans le worker. Sans effet s'il est déjà prêt. */
  load(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    this.loading ??= this.start().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async start(): Promise<void> {
    this.state = 'loading';
    this.error = '';
    try {
      const base = new URL(import.meta.env.BASE_URL + CONFIG.model.path, window.location.href).href;
      const response = await fetch(`${base}.json`);
      if (!response.ok) {
        throw new Error(`model card not found (${response.status}), see ml/README.md`);
      }
      const card = (await response.json()) as ModelCard;
      if (card.format !== 'yolo') throw new Error(`unsupported output format: ${card.format}`);
      const unknown = card.classes.filter((c) => !DAMAGE_ORDER.includes(c as DamageState));
      if (unknown.length)
        throw new Error(`classes unknown to the simulator: ${unknown.join(', ')}`);

      const worker = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      this.backend = await new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          if (e.data.type === 'ready') resolve(e.data.backend);
          else if (e.data.type === 'error') reject(new Error(e.data.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || 'the model worker failed'));
        const init: WorkerRequest = {
          type: 'init',
          url: `${base}.onnx`,
          inputSize: card.inputSize,
          classes: card.classes.length,
        };
        worker.postMessage(init);
      });
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);

      this.card = card;
      this.classes = card.classes as DamageState[];
      this.failures = 0;
      this.state = 'ready';
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Envoie une image au modèle, si aucune analyse n'est en cours : on n'empile
   * pas les images, on analyse toujours la plus récente.
   * @param geometry géométrie de l'image, à la taille d'entrée du modèle.
   */
  submit(image: HTMLCanvasElement, geometry: NadirGeometry): void {
    const worker = this.worker;
    if (!this.idle || !worker) return;
    const id = ++this.seq;
    this.pending = { id, geometry };
    // L'image est figée à l'appel ; le transfert évite d'en faire une copie.
    createImageBitmap(image)
      .then((bitmap) => {
        const run: WorkerRequest = {
          type: 'run',
          id,
          image: bitmap,
          confidence: CONFIG.model.confidence,
          nmsIoU: CONFIG.model.nmsIoU,
        };
        worker.postMessage(run, [bitmap]);
      })
      .catch(() => {
        if (this.pending?.id === id) this.pending = null;
      });
  }

  private receive(msg: WorkerResponse): void {
    if (msg.type === 'ready') return;
    const pending = this.pending;
    if (!pending || msg.id !== pending.id) return;
    this.pending = null;

    if (msg.type === 'error') {
      console.warn('[modèle] analyse en échec', msg.message);
      if (++this.failures >= MAX_FAILURES) this.fail(msg.message);
      return;
    }
    this.failures = 0;
    this.ms = this.ms ? this.ms * 0.8 + msg.ms * 0.2 : msg.ms;
    this.onResult(msg.boxes, pending.geometry);
  }

  private fail(message: string): void {
    this.state = 'error';
    this.error = message;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Confronte les boîtes du modèle à la vérité du simulateur.
 *
 * La vérité, ce sont les annotations exactes de l'image (`annotate()`), celles
 * qui ont servi à l'entraînement. Chaque boîte prend le bâtiment qu'elle
 * recouvre le mieux, au-delà de `CONFIG.model.matchIoU`, et un bâtiment ne
 * sert qu'une fois : les boîtes arrivent de la plus sûre à la moins sûre.
 *
 * Seules les boîtes d'une classe de dégâts sont des alertes. Une alerte sur
 * un bâtiment réellement endommagé est un vrai positif ; sur un bâtiment
 * intact ou sur rien, un faux positif. Un dégât sans alerte est un manqué.
 *
 * Une boîte posée sur un bâtiment mais qui le recouvre trop peu reste un faux
 * positif, comme dans le calcul du mAP50 ; on nomme quand même ce bâtiment,
 * pour qu'on voie que l'erreur est de cadrage et non de cible.
 *
 * @param geometry    géométrie de l'image analysée, à la taille d'entrée du modèle
 * @param displaySize côté de la vignette où les boîtes seront dessinées
 */
export function compareToTruth(
  boxes: RawBox[],
  classOf: (box: RawBox) => DamageState,
  buildings: Building[],
  geometry: NadirGeometry,
  displaySize: number,
): DiagnosticResult {
  const truth = annotate(buildings, geometry);
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const taken = new Set<number>();
  const scale = displaySize / geometry.size;

  const detections: Detection[] = [];
  let tp = 0;
  let fp = 0;
  let classOk = 0;

  for (const box of boxes) {
    // Le bâtiment le plus recouvert, même trop peu pour compter.
    let nearest = -1;
    let best = 0;
    truth.forEach((a, k) => {
      if (taken.has(k)) return;
      const [x, y, w, h] = a.bbox;
      const overlap = iou(box, { x, y, w, h });
      if (overlap > best) {
        best = overlap;
        nearest = k;
      }
    });
    const match = best >= CONFIG.model.matchIoU ? nearest : -1;
    if (match >= 0) taken.add(match);

    const predicted = classOf(box);
    if (predicted === 'intact') continue;

    const annotation = match >= 0 ? truth[match] : null;
    const building = annotation ? byId.get(annotation.buildingId) : undefined;
    const real = annotation?.state ?? 'intact';
    const damaged = VISIBLE_DAMAGE.has(real);
    if (damaged) {
      tp++;
      if (predicted === real) classOk++;
    } else {
      fp++;
    }

    const aimed =
      nearest >= 0 && best >= LOOSE_IOU ? byId.get(truth[nearest].buildingId) : undefined;
    detections.push({
      buildingId: annotation?.buildingId ?? '—',
      name: building?.name ?? (aimed ? `${aimed.name}, loose box` : 'No building'),
      predicted,
      truth: real,
      score: box.score,
      box: { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale },
      distance: building
        ? Math.hypot(
            groundDistance(geometry.lon, geometry.lat, building.lon, building.lat),
            geometry.agl,
          )
        : geometry.agl,
      falsePositive: !damaged,
    });
  }

  const damagedInFrame = truth.filter((a) => VISIBLE_DAMAGE.has(a.state)).length;
  detections.sort((a, b) => DAMAGE_INFO[b.predicted].severity - DAMAGE_INFO[a.predicted].severity);

  return {
    detections,
    metrics: {
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: Math.max(0, damagedInFrame - tp),
      precision: tp + fp > 0 ? tp / (tp + fp) : null,
      recall: damagedInFrame > 0 ? tp / damagedInFrame : null,
      classAccuracy: tp > 0 ? classOk / tp : null,
    },
    damagedInFrame,
  };
}

/** Recopie des détections d'une image vers une autre de taille différente. */
export function rescale(detections: Detection[], from: number, to: number): Detection[] {
  const k = to / from;
  return detections.map((d) => ({
    ...d,
    box: { x: d.box.x * k, y: d.box.y * k, w: d.box.w * k, h: d.box.h * k },
  }));
}

/** Résumé pour le rapport : quel modèle, où il tourne, et dans quelles limites. */
export function describe(detector: TrainedDetector, agl: number): string {
  const card = detector.card;
  if (detector.state === 'loading') return 'Loading the model…';
  if (detector.state === 'error') return `Model unavailable: ${detector.error}`;
  if (!card) return '';
  const fr = (v: number, digits: number) =>
    v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const where = detector.backend === 'webgpu' ? 'On the graphics card' : 'On the CPU';
  const lines = [
    `${card.name}, epoch ${card.epoch}: mAP50 ${fr(card.validation.mAP50, 2)} on validation.`,
    `${where}, ${fr(detector.ms, 0)} ms per image.`,
    '"Cracked" counts as intact: the model was not trained on it.',
  ];
  // Une marge, car un détecteur tolère un peu d'écart de taille apparente.
  const [lowest, highest] = card.trainedAltitudes;
  if (agl < lowest - ALTITUDE_MARGIN || agl > highest + ALTITUDE_MARGIN) {
    const trained = lowest === highest ? `at ${lowest} m` : `between ${lowest} and ${highest} m`;
    lines.push(`Trained ${trained}: at ${fr(agl, 0)} m, buildings do not have the size it knows.`);
  }
  return lines.join(' ');
}
