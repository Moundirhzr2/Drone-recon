/**
 * Détecteur de dommages.
 *
 * CE QUE C'EST, HONNÊTEMENT
 * -------------------------
 * Ce module ne fait PAS de vision par ordinateur. Il lit la vérité terrain de
 * la simulation et la restitue sous la forme exacte qu'aurait produite un
 * détecteur d'objets : une boîte, une classe, un score de confiance.
 *
 * Ce n'est pas un raccourci, c'est un choix, et il a trois avantages concrets :
 *
 *  1. La sortie a le format d'un vrai détecteur. Brancher un YOLO exporté en
 *     ONNX sur l'image nadir revient à remplacer `analyse()` — rien en aval ne
 *     bouge.
 *  2. On peut BRUITER la sortie de façon réaliste : confiance qui baisse avec
 *     la distance, classes voisines confondues, faux positifs occasionnels. Le
 *     comportement observé est celui d'un détecteur, pas d'un oracle.
 *  3. Comme on possède la vérité terrain, on peut afficher la précision et le
 *     rappel EN DIRECT — ce qu'aucun vrai détecteur ne peut faire sur le
 *     terrain, faute de connaître la réponse.
 *
 * Le bruit est déterministe par bâtiment : sans cela les boîtes clignoteraient
 * à chaque image et l'affichage serait illisible.
 */

import { CONFIG } from '../core/config';
import { gaussian, groundDistance, makeRandom } from '../core/math';
import {
  DAMAGE_INFO,
  isDamaged,
  standingHeight,
  type Building,
  type DamageState,
} from '../world/buildings';
import { projectNadir, type NadirGeometry } from '../drone/nadir';

export interface Detection {
  buildingId: string;
  name: string;
  /** Classe annoncée par le détecteur. */
  predicted: DamageState;
  /** Classe réelle — connue seulement parce qu'on est en simulation. */
  truth: DamageState;
  /** Confiance, entre 0 et 1. */
  score: number;
  /** Boîte englobante dans l'image nadir, en pixels. */
  box: { x: number; y: number; w: number; h: number };
  /** Distance du drone au bâtiment, en mètres. */
  distance: number;
  /** Vrai si le détecteur signale un bâtiment en réalité intact. */
  falsePositive: boolean;
}

/**
 * Qualité du diagnostic sur une prise de vue.
 *
 * Chaque taux vaut `null` quand son dénominateur est nul — aucune alerte à
 * juger, aucun dégât à retrouver. C'est une distinction qui compte : afficher
 * « 100 % » sur un cadre vide laisse croire à une performance parfaite alors
 * qu'il n'y a rien à évaluer.
 */
export interface Metrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Part des alertes qui sont justifiées. `null` si rien n'a été signalé. */
  precision: number | null;
  /** Part des dégâts réels repérés. `null` si le cadre n'en contient aucun. */
  recall: number | null;
  /** Part des détections dont la CLASSE exacte est correcte. `null` si aucune. */
  classAccuracy: number | null;
}

export interface DiagnosticResult {
  detections: Detection[];
  metrics: Metrics;
  /** Nombre de bâtiments réellement endommagés dans le cadre. */
  damagedInFrame: number;
}

/** Confiance de base qu'un détecteur atteindrait sur une classe donnée. */
const BASE_SCORE: Record<DamageState, number> = {
  intact: 0.0,
  cracked: 0.56, // une fissure vue du ciel, c'est difficile
  partial: 0.84,
  collapsed: 0.95,
  burnt: 0.88,
};

/** Graine stable dérivée de l'identifiant : le bruit ne scintille pas. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Les quatre coins du toit, projetés dans l'image. */
function roofBox(b: Building, g: NadirGeometry) {
  const h = standingHeight(b);
  const rad = (b.heading * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = b.width / 2;
  const hd = b.depth / 2;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as Array<[number, number]>) {
    const east = sx * hw * cos - sy * hd * sin;
    const north = sx * hw * sin + sy * hd * cos;
    const lon = b.lon + east / (111320 * Math.cos((b.lat * Math.PI) / 180));
    const lat = b.lat + north / 111320;
    const p = projectNadir(g, lon, lat, b.baseHeight + h);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Analyse une prise de vue.
 * @param buildings le bâti complet ; le cadrage filtre lui-même ce qui compte.
 */
export function analyse(buildings: Building[], g: NadirGeometry): DiagnosticResult {
  const detections: Detection[] = [];
  let damagedInFrame = 0;
  let tp = 0;
  let fp = 0;
  let classOk = 0;

  for (const b of buildings) {
    const box = roofBox(b, g);

    // Hors cadre : on tolère un léger débord pour ne pas couper les boîtes au ras.
    const margin = 8;
    if (
      box.x + box.w < -margin ||
      box.y + box.h < -margin ||
      box.x > g.size + margin ||
      box.y > g.size + margin
    ) {
      continue;
    }

    const distance = Math.hypot(groundDistance(g.lon, g.lat, b.lon, b.lat), g.agl);
    if (distance > CONFIG.detector.range) continue;

    const damaged = isDamaged(b);
    if (damaged) damagedInFrame++;

    const rnd = makeRandom(seedOf(b.id));
    const noise = gaussian(rnd) * CONFIG.detector.noise;

    // --- Faux positifs ---------------------------------------------------
    if (!damaged) {
      // Un bâtiment intact n'est signalé que rarement — ombre portée, toiture
      // sombre, bâche... C'est ce qui empêche la précision d'être à 100 %.
      if (rnd() > CONFIG.detector.falsePositiveRate) continue;
      const score = 0.48 + Math.abs(noise);
      if (score < CONFIG.detector.threshold) continue;
      detections.push({
        buildingId: b.id,
        name: b.name,
        predicted: 'cracked',
        truth: b.state,
        score: Math.min(score, 0.99),
        box,
        distance,
        falsePositive: true,
      });
      fp++;
      continue;
    }

    // --- Confiance sur un bâtiment réellement endommagé --------------------
    // Elle baisse avec la distance et quand la cible est petite à l'image :
    // c'est ce qui donne au pilote une raison de descendre pour confirmer.
    const distFactor = 1 - 0.45 * Math.min(distance / CONFIG.detector.range, 1);
    const area = Math.abs(box.w * box.h);
    const sizeFactor = Math.min(1, 0.45 + area / 2600);

    const score = Math.max(
      0,
      Math.min(BASE_SCORE[b.state] * distFactor * sizeFactor + noise, 0.99),
    );

    // Sous le seuil : le détecteur passe à côté. C'est un faux négatif.
    if (score < CONFIG.detector.threshold) continue;

    // --- Confusion de classe -----------------------------------------------
    // Quand la confiance est moyenne, le détecteur hésite avec la classe
    // voisine — exactement le comportement d'un modèle mal assuré.
    let predicted = b.state;
    if (score < 0.72 && rnd() < 0.3) {
      predicted = confuse(b.state, rnd());
    }

    detections.push({
      buildingId: b.id,
      name: b.name,
      predicted,
      truth: b.state,
      score,
      box,
      distance,
      falsePositive: false,
    });
    tp++;
    if (predicted === b.state) classOk++;
  }

  const fn = damagedInFrame - tp;
  const metrics: Metrics = {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: Math.max(0, fn),
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: damagedInFrame > 0 ? tp / damagedInFrame : null,
    classAccuracy: tp > 0 ? classOk / tp : null,
  };

  // Les boîtes les plus graves passent devant.
  detections.sort((a, b) => DAMAGE_INFO[b.predicted].severity - DAMAGE_INFO[a.predicted].severity);

  return { detections, metrics, damagedInFrame };
}

/** Remplace une classe par une classe voisine en gravité. */
function confuse(truth: DamageState, roll: number): DamageState {
  const neighbours: Record<DamageState, DamageState[]> = {
    intact: ['cracked'],
    cracked: ['intact', 'partial'],
    partial: ['cracked', 'collapsed'],
    collapsed: ['partial', 'burnt'],
    burnt: ['collapsed', 'partial'],
  };
  const options = neighbours[truth];
  return options[Math.floor(roll * options.length) % options.length];
}
