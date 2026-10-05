/**
 * Scénarios enregistrés : un fichier JSON pour sauvegarder, recharger et
 * partager un sinistre.
 *
 * Un scénario, c'est un aléa (facultatif), avec ses réglages et sa graine,
 * plus les dégâts posés à la main. L'aléa est déterministe : sa graine suffit
 * à rejouer exactement le même sinistre, inutile d'enregistrer l'état de deux
 * mille bâtiments. S'y ajoutent le point de vue du drone, pour retrouver la
 * même comparaison avant / après, et la ville, pour refuser un scénario fait
 * ailleurs.
 *
 * Exemple : `scenarios/exemple-explosion.json`.
 */

import { DAMAGE_ORDER, type DamageState } from '../world/buildings';
import type { City } from '../world/city';
import { DISASTERS, type DisasterKind, type Scenario } from './scenario';
import type { ManualEdits } from './manual';

export const SCENARIO_FORMAT = 'drone-recon/scenario';
export const SCENARIO_VERSION = 1;

/** Le point de vue du drone : où il était, à quelle hauteur, dans quelle direction. */
export interface Viewpoint {
  lon: number;
  lat: number;
  /** Hauteur au-dessus du sol, en mètres. */
  agl: number;
  /** Cap, en degrés depuis le nord. */
  heading: number;
}

export interface ScenarioFile {
  format: typeof SCENARIO_FORMAT;
  version: number;
  name: string;
  description?: string;
  createdAt: string;
  /** La ville du scénario : les bâtiments sont désignés par leur identifiant IGN. */
  city: { name: string; lon: number; lat: number };
  /** L'aléa et ses réglages ; `null` pour des dégâts posés à la main seulement. */
  hazard: Scenario | null;
  /**
   * Les dégâts posés à la main. L'identifiant est celui de la BD TOPO® quand
   * le bâtiment en a un : il ne change pas si l'on retélécharge les données.
   * Le nom n'est là que pour la lecture humaine.
   */
  buildings: Array<{ id: string; state: DamageState; name?: string }>;
  viewpoint?: Viewpoint;
}

const KINDS = Object.keys(DISASTERS) as DisasterKind[];

/** Fabrique le fichier d'un scénario. */
export function toScenarioFile(
  city: City,
  name: string,
  hazard: Scenario | null,
  edits: ManualEdits,
  viewpoint?: Viewpoint,
  description?: string,
): ScenarioFile {
  const byId = new Map(city.buildings.map((b) => [b.id, b]));
  const round = (v: number, digits: number) => Number(v.toFixed(digits));
  return {
    format: SCENARIO_FORMAT,
    version: SCENARIO_VERSION,
    name,
    description: description || undefined,
    createdAt: new Date().toISOString(),
    city: { name: city.name, lon: round(city.center.lon, 6), lat: round(city.center.lat, 6) },
    // Champs dans un ordre fixe, la grandeur juste après l'aléa : le fichier se lit.
    hazard: hazard && {
      kind: hazard.kind,
      magnitude: hazard.magnitude,
      east: hazard.east,
      north: hazard.north,
      windFrom: hazard.windFrom,
      seed: hazard.seed,
      duration: hazard.duration,
    },
    buildings: [...edits].map(([id, state]) => {
      const b = byId.get(id);
      return { id: b?.sourceId ?? id, state, name: b?.name };
    }),
    viewpoint: viewpoint && {
      lon: round(viewpoint.lon, 7),
      lat: round(viewpoint.lat, 7),
      agl: round(viewpoint.agl, 1),
      heading: round(viewpoint.heading, 1),
    },
  };
}

/** Lecture d'un fichier : le scénario, et les bâtiments qui n'existent pas ici. */
export interface ParsedScenario {
  file: ScenarioFile;
  edits: ManualEdits;
  /** Bâtiments du fichier introuvables dans cette ville, ignorés. */
  missing: number;
}

/**
 * Lit et vérifie un fichier de scénario. Un fichier partagé peut venir de
 * n'importe où : chaque champ est contrôlé, et l'erreur dit lequel ne va pas.
 * @throws Error avec un message lisible si le fichier n'est pas un scénario valide.
 */
export function parseScenarioFile(text: string, city: City): ParsedScenario {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('this is not a JSON file');
  }
  const f = data as Partial<ScenarioFile>;
  if (!f || typeof f !== 'object' || f.format !== SCENARIO_FORMAT) {
    throw new Error('this is not a Drone Recon scenario');
  }
  if (typeof f.version !== 'number' || f.version > SCENARIO_VERSION) {
    throw new Error('scenario version too recent for this simulator');
  }
  if (!Array.isArray(f.buildings)) throw new Error('building list missing');

  if (
    f.city &&
    Math.abs(f.city.lat - city.center.lat) + Math.abs(f.city.lon - city.center.lon) > 0.01
  ) {
    throw new Error(`scenario made for another city (${f.city.name ?? 'unknown'})`);
  }

  let hazard: Scenario | null = null;
  if (f.hazard) {
    const h = f.hazard;
    if (!KINDS.includes(h.kind)) throw new Error(`unknown hazard: ${String(h.kind)}`);
    const meta = DISASTERS[h.kind];
    const numbers = [h.magnitude, h.east, h.north, h.windFrom, h.seed, h.duration];
    if (numbers.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('incomplete hazard settings');
    }
    if (h.magnitude < meta.min || h.magnitude > meta.max) {
      const fr = (v: number) => v.toLocaleString('en-GB');
      throw new Error(
        `${meta.unit} out of range: ${fr(h.magnitude)} (from ${fr(meta.min)} to ${fr(meta.max)})`,
      );
    }
    hazard = {
      kind: h.kind,
      magnitude: h.magnitude,
      east: h.east,
      north: h.north,
      windFrom: h.windFrom,
      seed: h.seed,
      duration: h.duration,
    };
  }

  // Un bâtiment se retrouve par son identifiant IGN, ou à défaut par son
  // numéro dans le simulateur.
  const lookup = new Map<string, string>();
  for (const b of city.buildings) {
    lookup.set(b.id, b.id);
    if (b.sourceId) lookup.set(b.sourceId, b.id);
  }
  const edits: ManualEdits = new Map();
  let missing = 0;
  for (const entry of f.buildings) {
    if (!entry || typeof entry.id !== 'string' || !DAMAGE_ORDER.includes(entry.state)) {
      throw new Error('badly described building in the list');
    }
    const id = lookup.get(entry.id);
    if (id) edits.set(id, entry.state);
    else missing++;
  }

  const v = f.viewpoint;
  const viewpoint =
    v && [v.lon, v.lat, v.agl, v.heading].every((x) => typeof x === 'number' && Number.isFinite(x))
      ? v
      : undefined;

  return {
    file: {
      format: SCENARIO_FORMAT,
      version: f.version,
      name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : 'Untitled scenario',
      description: typeof f.description === 'string' ? f.description : undefined,
      createdAt: typeof f.createdAt === 'string' ? f.createdAt : '',
      city: f.city ?? { name: city.name, lon: city.center.lon, lat: city.center.lat },
      hazard,
      buildings: f.buildings,
      viewpoint,
    },
    edits,
    missing,
  };
}

/** Nom de fichier sûr, tiré du nom du scénario : `scenario-explosion-gare.json`. */
export function scenarioFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `scenario-${slug || 'untitled'}.json`;
}

/** Propose le fichier au téléchargement. */
export function downloadScenario(file: ScenarioFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = scenarioFileName(file.name);
  link.click();
  // Le navigateur a lancé le téléchargement : l'adresse peut être libérée.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Ouvre le sélecteur de fichier et rend le texte du fichier choisi, ou `null`. */
export function pickScenarioFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then(resolve, () => resolve(null));
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
