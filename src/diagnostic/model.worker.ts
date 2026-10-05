/**
 * Worker du détecteur entraîné.
 *
 * Le modèle tourne ici, hors de la boucle de rendu : sur la carte graphique
 * (WebGPU), une image prend quelques dizaines de millisecondes ; sur le
 * processeur (WebAssembly), plusieurs centaines. Dans le fil principal, ce
 * serait autant d'images figées.
 *
 * Messages reçus : `init` (adresse du modèle et taille d'entrée), puis `run`
 * (une image carrée). Réponses : `ready`, `result` ou `error`.
 */

import * as ort from 'onnxruntime-web/webgpu';
import { decodeYolo, type RawBox } from './yolo';

export type WorkerRequest =
  | { type: 'init'; url: string; inputSize: number; classes: number }
  | {
      type: 'run';
      id: number;
      image: ImageBitmap;
      confidence: number;
      nmsIoU: number;
    };

export type WorkerResponse =
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; boxes: RawBox[]; ms: number }
  | { type: 'error'; id?: number; message: string };

let session: ort.InferenceSession | null = null;
let size = 640;
let classes = 0;
let pixels: OffscreenCanvasRenderingContext2D | null = null;

// Sans isolation d'origine, le navigateur interdit les fils WebAssembly
// partagés : on le dit d'emblée plutôt que de laisser onnxruntime essayer.
ort.env.wasm.numThreads = 1;
// Sur un portable à deux cartes graphiques, la dédiée plutôt que l'intégrée.
ort.env.webgpu.powerPreference = 'high-performance';

// Le projet est typé pour la page (lib DOM), où `postMessage` exige une
// origine ; dans un worker, il n'en prend pas.
const scope = self as unknown as { postMessage(message: WorkerResponse): void };
const reply = (message: WorkerResponse) => scope.postMessage(message);

async function init(url: string): Promise<'webgpu' | 'wasm'> {
  // La carte graphique d'abord ; le processeur si WebGPU manque ou échoue.
  if ('gpu' in navigator) {
    try {
      session = await ort.InferenceSession.create(url, { executionProviders: ['webgpu'] });
      return 'webgpu';
    } catch (err) {
      console.warn('[modèle] WebGPU indisponible, repli sur le processeur', err);
    }
  }
  session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
  return 'wasm';
}

/** Image RGBA -> tenseur [1, 3, taille, taille], canaux séparés, entre 0 et 1. */
function toTensor(image: ImageBitmap): ort.Tensor {
  if (!pixels) {
    pixels = new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
    if (!pixels) throw new Error('offscreen canvas unavailable');
  }
  pixels.drawImage(image, 0, 0, size, size);
  image.close();
  const { data } = pixels.getImageData(0, 0, size, size);
  const plane = size * size;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = data[i * 4] / 255;
    input[plane + i] = data[i * 4 + 1] / 255;
    input[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', input, [1, 3, size, size]);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    size = msg.inputSize;
    classes = msg.classes;
    try {
      reply({ type: 'ready', backend: await init(msg.url) });
    } catch (err) {
      reply({ type: 'error', message: String(err) });
    }
    return;
  }

  if (!session) {
    msg.image.close();
    reply({ type: 'error', id: msg.id, message: 'model not loaded' });
    return;
  }
  try {
    const start = performance.now();
    const feeds = { [session.inputNames[0]]: toTensor(msg.image) };
    const results = await session.run(feeds);
    const output = results[session.outputNames[0]];
    const anchors = output.dims[2];
    const boxes = decodeYolo(
      output.data as Float32Array,
      anchors,
      classes,
      msg.confidence,
      msg.nmsIoU,
    );
    reply({ type: 'result', id: msg.id, boxes, ms: performance.now() - start });
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: String(err) });
  }
};
