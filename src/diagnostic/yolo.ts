/**
 * Lecture de la sortie brute d'un détecteur au format YOLO.
 *
 * Le modèle exporté sans post-traitement (`nms=False`) rend un tenseur
 * [1, 4 + classes, ancres] : pour chaque ancre, le centre et la taille d'une
 * boîte en pixels d'entrée, puis un score par classe. Il reste à garder la
 * meilleure classe de chaque ancre, à écarter les scores faibles, et à
 * fusionner les boîtes qui désignent le même objet.
 *
 * Fonctions pures, sans dépendance au navigateur : elles tournent dans le
 * worker du modèle et se vérifient à part.
 */

export interface RawBox {
  /** Coin haut gauche, largeur et hauteur, en pixels d'entrée du modèle. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rang de la classe dans la fiche du modèle. */
  classId: number;
  score: number;
}

/** Recouvrement de deux boîtes : intersection sur union, entre 0 et 1. */
export function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Décode la sortie et applique la suppression des non-maxima.
 *
 * La suppression ignore la classe : un bâtiment n'a qu'un état, et deux boîtes
 * presque superposées de classes différentes sont une hésitation du modèle sur
 * le même objet, pas deux objets. On garde la plus sûre.
 *
 * @param output  tenseur à plat, ligne par ligne : [cx…, cy…, w…, h…, score classe 0…, …]
 * @param anchors nombre d'ancres (dernière dimension du tenseur)
 */
export function decodeYolo(
  output: Float32Array,
  anchors: number,
  classes: number,
  confidence: number,
  nmsIoU: number,
  maxBoxes = 300,
): RawBox[] {
  const candidates: RawBox[] = [];
  for (let i = 0; i < anchors; i++) {
    let best = 0;
    let classId = 0;
    for (let c = 0; c < classes; c++) {
      const s = output[(4 + c) * anchors + i];
      if (s > best) {
        best = s;
        classId = c;
      }
    }
    if (best < confidence) continue;
    const cx = output[i];
    const cy = output[anchors + i];
    const w = output[2 * anchors + i];
    const h = output[3 * anchors + i];
    candidates.push({ x: cx - w / 2, y: cy - h / 2, w, h, classId, score: best });
  }

  candidates.sort((a, b) => b.score - a.score);
  const kept: RawBox[] = [];
  for (const box of candidates) {
    if (kept.length >= maxBoxes) break;
    if (kept.every((k) => iou(k, box) < nmsIoU)) kept.push(box);
  }
  return kept;
}
