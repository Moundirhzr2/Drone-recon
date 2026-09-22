/**
 * Génération procédurale du tissu urbain.
 *
 * On ne modélise pas Mulhouse au bâtiment près : on en reproduit la STRUCTURE
 * (centre dense et mitoyen, faubourgs plus lâches, quelques équipements publics
 * dégagés), ce qui suffit largement à une mission de reconnaissance et garde
 * chaque bâtiment manipulable individuellement — l'inverse exact d'un maillage
 * photogrammétrique, où rien n'est sélectionnable.
 */

import { CONFIG } from '../core/config';
import { makeRandom, metersToDegrees } from '../core/math';
import { severityFromStress, stateFromStress, stressOf } from './fragility';
import {
  computeVulnerability,
  type Building,
  type BuildingKind,
  type DamageState,
} from './buildings';

const STREETS = [
  'rue du Sauvage',
  'rue des Maréchaux',
  'rue de la Sinne',
  'rue Henriette',
  'avenue de Colmar',
  'rue des Boulangers',
  'rue du Mittelbach',
  'quai des Pêcheurs',
  'rue Lambert',
  'rue des Tanneurs',
  'passage Central',
  'rue de la Moselle',
];

/** Équipements publics placés à la main, pour donner des repères au pilote. */
const LANDMARKS: Array<{
  name: string;
  kind: BuildingKind;
  east: number;
  north: number;
  w: number;
  d: number;
  h: number;
  year: number;
}> = [
  {
    name: 'Temple Saint-Étienne',
    kind: 'civique',
    east: 10,
    north: 18,
    w: 34,
    d: 58,
    h: 78,
    year: 1866,
  },
  {
    name: 'Hôtel de Ville',
    kind: 'civique',
    east: -46,
    north: 30,
    w: 44,
    d: 26,
    h: 24,
    year: 1552,
  },
  { name: 'Halle au Blé', kind: 'commerce', east: 62, north: -22, w: 48, d: 34, h: 18, year: 1899 },
  {
    name: 'Gare Centrale',
    kind: 'civique',
    east: -180,
    north: -240,
    w: 120,
    d: 38,
    h: 22,
    year: 1932,
  },
  {
    name: 'Filature Nord',
    kind: 'industriel',
    east: 250,
    north: 210,
    w: 86,
    d: 52,
    h: 26,
    year: 1911,
  },
  { name: 'Tour Europe', kind: 'bureau', east: -140, north: 160, w: 30, d: 30, h: 96, year: 1972 },
  {
    name: 'Centre Hospitalier',
    kind: 'civique',
    east: 300,
    north: -180,
    w: 74,
    d: 46,
    h: 34,
    year: 1988,
  },
  {
    name: 'Entrepôt Dornach',
    kind: 'industriel',
    east: -300,
    north: -60,
    w: 96,
    d: 44,
    h: 14,
    year: 1964,
  },
];

/** État du monde : la liste des bâtiments, plus les repères de la ville. */
export interface City {
  buildings: Building[];
  center: { lon: number; lat: number };
  ground: number;
}

/** Convertit une position locale en mètres (est, nord) en coordonnées géographiques. */
function place(east: number, north: number) {
  const { dLon, dLat } = metersToDegrees(east, north, CONFIG.city.lat);
  return { lon: CONFIG.city.lon + dLon, lat: CONFIG.city.lat + dLat };
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

/** Génère les gravats projetés autour d'un bâtiment qui s'est effondré. */
function makeDebris(rnd: () => number, b: Building, intensity: number) {
  const spread = Math.max(b.width, b.depth) * (0.45 + 0.3 * intensity);
  const count = Math.round(4 + intensity * 11);
  const debris: Building['debris'] = [];
  for (let i = 0; i < count; i++) {
    const angle = rnd() * Math.PI * 2;
    const dist = spread * (0.35 + 0.65 * rnd());
    debris.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      size: 2.2 + rnd() * 5.5,
      height: 0.8 + rnd() * 3.4,
      rot: rnd() * 360,
    });
  }
  return debris;
}

/**
 * Applique un état de dommage à un bâtiment, débris compris.
 * Sert aussi bien à la génération initiale qu'au simulateur de désastres.
 */
export function setDamage(
  b: Building,
  state: DamageState,
  damage: number,
  rnd: () => number,
): void {
  b.state = state;
  b.damage = Math.min(Math.max(damage, 0), 1);
  b.debris =
    state === 'partial' || state === 'collapsed'
      ? makeDebris(rnd, b, state === 'collapsed' ? 1 : 0.5)
      : [];
}

export function generateCity(): City {
  const rnd = makeRandom(CONFIG.city.seed);
  const buildings: Building[] = [];
  const ground = CONFIG.city.groundHeight;
  let seq = 0;

  const add = (
    east: number,
    north: number,
    w: number,
    d: number,
    h: number,
    kind: BuildingKind,
    year: number,
    name: string,
    heading: number,
  ): Building => {
    const { lon, lat } = place(east, north);
    const floors = Math.max(1, Math.round(h / 3.2));
    const b: Building = {
      id: `B${String(++seq).padStart(3, '0')}`,
      name,
      kind,
      lon,
      lat,
      baseHeight: ground,
      width: w,
      depth: d,
      height: h,
      floors,
      heading,
      year,
      vulnerability: computeVulnerability(year, kind, h, w * d),
      state: 'intact',
      damage: 0,
      debris: [],
    };
    buildings.push(b);
    return b;
  };

  // --- Équipements publics ---------------------------------------------
  for (const l of LANDMARKS) {
    add(l.east, l.north, l.w, l.d, l.h, l.kind, l.year, l.name, 0);
  }

  // --- Tissu ordinaire : grille de blocs séparés par des rues ------------
  const BLOCK = 74; // côté d'un îlot, en mètres
  const STREET = 22; // largeur de rue
  const STEP = BLOCK + STREET;
  const span = Math.floor(CONFIG.city.extent / STEP);

  for (let gx = -span; gx <= span; gx++) {
    for (let gy = -span; gy <= span; gy++) {
      const blockEast = gx * STEP;
      const blockNorth = gy * STEP;

      // Distance au centre : pilote la densité et la hauteur.
      const distFromCenter = Math.hypot(blockEast, blockNorth);
      const centrality = Math.max(0, 1 - distFromCenter / (CONFIG.city.extent * 1.15));

      // On évite de bâtir sur les équipements déjà posés.
      const clash = LANDMARKS.some(
        (l) => Math.abs(l.east - blockEast) < 70 && Math.abs(l.north - blockNorth) < 70,
      );
      if (clash) continue;

      // Quelques îlots restent vides : places, parcs, terrains vagues.
      if (rnd() < 0.12 + 0.18 * (1 - centrality)) continue;

      // Subdivision de l'îlot en parcelles. Plus on est au centre, plus c'est découpé.
      const cols = centrality > 0.55 ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 2);
      const rows = centrality > 0.55 ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 2);
      const cellW = BLOCK / cols;
      const cellD = BLOCK / rows;
      const street = pick(rnd, STREETS);

      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          if (rnd() < 0.14) continue; // dent creuse

          // Marge intérieure : au centre les bâtiments sont mitoyens (marge faible).
          const margin = 1.5 + (1 - centrality) * 5;
          const w = Math.max(7, cellW - margin * 2);
          const d = Math.max(7, cellD - margin * 2);

          const east = blockEast - BLOCK / 2 + cellW * (cx + 0.5);
          const north = blockNorth - BLOCK / 2 + cellD * (cy + 0.5);

          // Hauteur : élevée au centre, basse en périphérie, avec de la variance.
          const baseFloors = 2 + centrality * 4;
          const floors = Math.max(1, Math.round(baseFloors + (rnd() - 0.4) * 3));
          const h = floors * (3.0 + rnd() * 0.6);

          // Usage selon la position et le gabarit.
          let kind: BuildingKind;
          const roll = rnd();
          if (centrality > 0.6 && roll < 0.35) kind = 'commerce';
          else if (centrality > 0.45 && roll < 0.5) kind = 'bureau';
          else if (centrality < 0.3 && roll < 0.22) kind = 'industriel';
          else kind = 'residentiel';

          // Année : le centre est ancien, la périphérie plus récente.
          const year = Math.round(
            1870 + (1 - centrality) * 90 + rnd() * 55 - (rnd() < 0.15 ? 40 : 0),
          );

          const num = 1 + Math.floor(rnd() * 88);
          add(east, north, w, d, h, kind, Math.min(year, 2019), `${num} ${street}`, 0);
        }
      }
    }
  }

  // --- Dommages initiaux ------------------------------------------------
  seedInitialDamage(buildings, rnd);

  return {
    buildings,
    center: { lon: CONFIG.city.lon, lat: CONFIG.city.lat },
    ground,
  };
}

/**
 * Pré-endommage une partie du bâti.
 *
 * Les dégâts ne sont pas saupoudrés au hasard sur toute la carte : ils sont
 * groupés autour de deux foyers, parce que c'est ainsi qu'un sinistre réel se
 * présente. Cela donne aussi au pilote quelque chose à chercher — une zone à
 * retrouver plutôt qu'un semis uniforme.
 */
function seedInitialDamage(buildings: Building[], rnd: () => number): void {
  // Intensités calibrées sur la courbe de fragilité : au centre d'un foyer,
  // `intensité × vulnérabilité` doit franchir le seuil d'effondrement (0.52),
  // et retomber sous le seuil de fissuration (0.18) aux trois quarts du rayon.
  // Avec une vulnérabilité moyenne autour de 0,55, il faut viser ~1,4.
  const foyers = [
    { east: 120, north: 90, radius: 185, intensity: 1.45, fire: false },
    { east: -210, north: -150, radius: 150, intensity: 1.55, fire: true },
  ];

  for (const b of buildings) {
    const { dLon, dLat } = metersToDegrees(1, 1, CONFIG.city.lat);
    const east = (b.lon - CONFIG.city.lon) / dLon;
    const north = (b.lat - CONFIG.city.lat) / dLat;

    let worst = 0;
    let fromFire = false;
    for (const f of foyers) {
      const dist = Math.hypot(east - f.east, north - f.north);
      if (dist > f.radius) continue;
      // Atténuation quadratique avec la distance au foyer.
      const local = f.intensity * Math.pow(1 - dist / f.radius, 1.6);
      if (local > worst) {
        worst = local;
        fromFire = f.fire;
      }
    }
    if (worst <= 0) continue;

    // Courbe de fragilité : l'intensité subie croise la vulnérabilité propre.
    // C'est exactement la même courbe que celle du simulateur de désastres —
    // voir `world/fragility.ts`. Les dégâts d'origine et ceux d'un scénario
    // rejoué obéissent ainsi aux mêmes seuils.
    const stress = stressOf(worst, b.vulnerability, rnd);
    const state = stateFromStress(stress, rnd, { fire: fromFire ? 0.75 : 0 });

    if (state) setDamage(b, state, severityFromStress(stress), rnd);
  }
}
