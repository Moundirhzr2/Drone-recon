/**
 * Campagne de prise de vue : le jeu de données exporté par la touche J.
 *
 * Deux campagnes, au-dessus de la ville de l'IGN :
 *
 *  - en quadrillage (touche J) : chacun des quatre aléas, joué avec ses
 *    réglages par défaut jusqu'à son état final, est photographié case par
 *    case, à 60 m, nord en haut ;
 *  - variée (Maj+J) : seize scénarios (`variants.ts`), et pour chacun des
 *    images centrées sur les dégâts, à hauteur et cap tirés au hasard. C'est
 *    la réponse aux faiblesses du premier modèle, entraîné sur la grille :
 *    effondrements trop rares, une seule hauteur, un seul cap.
 *
 * Chaque image part dans un dossier choisi par l'utilisateur, avec ses
 * annotations ; les fichiers sont écrits au fil de l'eau, si bien qu'un
 * millier d'images ne tient jamais en mémoire.
 *
 * POURQUOI LA VILLE DE L'IGN, ET PAS LE RELEVÉ DE GOOGLE
 * ------------------------------------------------------
 * Les conditions de Google Maps Platform interdisent d'extraire ses images
 * hors du service : un jeu d'entraînement en serait une. Les données de l'IGN,
 * elles, sont sous Licence Ouverte. Le relevé est donc masqué pendant la
 * campagne, et rétabli ensuite.
 *
 * L'écriture passe par l'accès aux dossiers du navigateur (File System
 * Access), que proposent Chrome et Edge.
 */

import type * as Cesium from 'cesium';
import { CONFIG } from '../core/config';
import { DEG, makeRandom, metersToDegrees } from '../core/math';
import { DISASTERS, defaultScenario, type DisasterKind, type Scenario } from '../disaster/scenario';
import type { DroneState } from '../drone/drone';
import type { NadirView } from '../drone/nadir';
import type { DisasterPanel } from '../hud/disaster';
import type { Building, DamageState } from '../world/buildings';
import type { City } from '../world/city';
import { annotate } from './annotate';
import {
  cocoDocument,
  metadataCsv,
  readme,
  yoloConfig,
  yoloLabels,
  type ImageRecord,
} from './formats';
import { VARIANTS } from './variants';

/** Les aléas, dans l'ordre du panneau du simulateur (voir `pickKind`). */
const KINDS: DisasterKind[] = ['seisme', 'explosion', 'inondation', 'incendie'];

/** Quadrillage à hauteur fixe, ou campagne variée. */
export type CampaignMode = 'grille' | 'variee';

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export interface CampaignHooks {
  city: City;
  drone: DroneState;
  nadir: NadirView;
  scene: Cesium.Scene;
  panel: DisasterPanel;
  groundAt: (lon: number, lat: number) => number;
  /** Rien n'attend plus d'être construit ou repeint dans la ville dessinée. */
  renderIdle: () => boolean;
  /** Passe à la ville de l'IGN, sans effets ni vue diagnostique. */
  prepareView: () => void;
  /** Rend la vue telle que le pilote l'avait réglée. */
  restoreView: () => void;
  report: (text: string, kind?: 'info' | 'ok' | 'err') => void;
}

/** Une prise de vue : position en mètres depuis le centre-ville, hauteur, cap. */
interface Shot {
  east: number;
  north: number;
  agl: number;
  heading: number;
}

/** Un scénario joué, puis photographié. */
interface Pass {
  /** Repris dans le nom des images : l'aléa seul en grille, `seisme-2` en variée. */
  variant: string;
  label: string;
  scenario: Scenario;
}

/** Un scénario en clair, pour la notice : intensité, foyer, tirage. */
function describe(id: string, s: Scenario): string {
  const meta = DISASTERS[s.kind];
  const number = id.split('-')[1];
  const parts = [`${meta.unit} ${s.magnitude.toLocaleString('fr-FR')}`];
  // La crue ne part pas d'un foyer, et seul l'incendie dépend du vent.
  const along = (v: number, ahead: string, behind: string) =>
    `${Math.abs(v)} m ${v < 0 ? behind : ahead}`;
  if (s.kind !== 'inondation') {
    parts.push(
      `foyer à ${along(s.east, 'est', 'ouest')} et ${along(s.north, 'nord', 'sud')} du centre`,
    );
  }
  if (s.kind === 'incendie') parts.push(`vent de ${s.windFrom}°`);
  parts.push(`graine ${s.seed}`);
  return `${meta.label} ${number} : ${parts.join(', ')}`;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const file = await dir.getFileHandle(name, { create: true });
  const out = await file.createWritable();
  await out.write(data);
  await out.close();
}

export class DatasetCampaign {
  private running = false;
  private stopRequested = false;
  private canvas: HTMLCanvasElement;

  constructor(private hooks: CampaignHooks) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = CONFIG.dataset.imageSize;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Lance la campagne, ou l'arrête si elle tourne. À appeler depuis un geste de
   * l'utilisateur : le navigateur n'ouvre le choix du dossier qu'à ce prix.
   */
  toggle(mode: CampaignMode = 'grille'): void {
    if (this.running) {
      this.stopRequested = true;
      this.hooks.report('Jeu de données : arrêt demandé, fin de l’image en cours…');
      return;
    }
    if (!window.showDirectoryPicker) {
      this.hooks.report(
        'Jeu de données : il faut Chrome ou Edge pour écrire dans un dossier',
        'err',
      );
      return;
    }
    // Appelé sans attendre : le choix du dossier doit s'ouvrir dans le geste.
    window
      .showDirectoryPicker({ id: 'drone-recon-jeu-de-donnees', mode: 'readwrite' })
      .then((root) => this.run(root, mode))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.hooks.report('Jeu de données : aucun dossier choisi');
          return;
        }
        console.error('[jeu de données]', err);
        this.hooks.report(`Jeu de données interrompu : ${String(err)}`, 'err');
      });
  }

  /** Les cases du quadrillage, là où il y a au moins un bâtiment. */
  private plan(side: number): Shot[] {
    const { city } = this.hooks;
    const mLon = 111320 * Math.cos(city.center.lat * DEG);
    const points = city.buildings.map((b) => ({
      east: (b.lon - city.center.lon) * mLon,
      north: (b.lat - city.center.lat) * 111320,
    }));
    const minE = Math.min(...points.map((p) => p.east));
    const maxE = Math.max(...points.map((p) => p.east));
    const minN = Math.min(...points.map((p) => p.north));
    const maxN = Math.max(...points.map((p) => p.north));

    const occupied = new Set<string>();
    for (const p of points) {
      occupied.add(`${Math.floor((p.east - minE) / side)}:${Math.floor((p.north - minN) / side)}`);
    }

    const cells: Shot[] = [];
    const columns = Math.floor((maxE - minE) / side) + 1;
    const rows = Math.floor((maxN - minN) / side) + 1;
    for (let j = rows - 1; j >= 0; j--) {
      // En lacet : chaque rangée repart du côté où la précédente s'est arrêtée.
      const reverse = (rows - 1 - j) % 2 === 1;
      for (let k = 0; k < columns; k++) {
        const i = reverse ? columns - 1 - k : k;
        if (!occupied.has(`${i}:${j}`)) continue;
        cells.push({
          east: minE + (i + 0.5) * side,
          north: minN + (j + 0.5) * side,
          agl: CONFIG.dataset.altitude,
          heading: 0,
        });
      }
    }
    return cells;
  }

  /**
   * Les prises de vue d'un scénario de la campagne variée, une fois le sinistre
   * joué : surtout centrées sur des bâtiments endommagés, tirés au hasard
   * selon leur état, et quelques-unes au-dessus du bâti pris au hasard. Le
   * tirage dépend d'une graine : deux exports donnent les mêmes images.
   */
  private scatter(seed: number): Shot[] {
    const { city } = this.hooks;
    const V = CONFIG.dataset.varied;
    const rnd = makeRandom(seed);
    const weights: Partial<Record<DamageState, number>> = V.weights;
    const weightOf = (b: Building) => weights[b.state] ?? 0;
    const mLon = 111320 * Math.cos(city.center.lat * DEG);
    const tan = Math.tan((CONFIG.nadir.fov * DEG) / 2);

    // Une image autour d'un bâtiment : hauteur, décalage et cap au hasard. Le
    // décalage reste dans l'emprise, pour que le bâtiment soit dans le cadre.
    const around = (b: Building): Shot => {
      const agl = V.minAltitude + rnd() * (V.maxAltitude - V.minAltitude);
      const reach = V.offset * 2 * agl * tan;
      return {
        east: (b.lon - city.center.lon) * mLon + (rnd() * 2 - 1) * reach,
        north: (b.lat - city.center.lat) * 111320 + (rnd() * 2 - 1) * reach,
        agl,
        heading: rnd() * 360,
      };
    };

    const damaged = city.buildings.filter((b) => weightOf(b) > 0);
    const totalWeight = damaged.reduce((sum, b) => sum + weightOf(b), 0);
    const pick = (): Building => {
      let r = rnd() * totalWeight;
      for (const b of damaged) {
        r -= weightOf(b);
        if (r <= 0) return b;
      }
      return damaged[damaged.length - 1];
    };

    const onDamage = Math.min(V.damageShots, damaged.length * V.shotsPerDamaged);
    const elsewhere = Math.max(V.minOtherShots, Math.round(onDamage * V.otherShare));
    const shots: Shot[] = [];
    for (let i = 0; i < onDamage; i++) shots.push(around(pick()));
    for (let i = 0; i < elsewhere; i++) {
      shots.push(around(city.buildings[Math.floor(rnd() * city.buildings.length)]));
    }

    // Ordre de passage en lacet, par bandes de 100 m : le drone ne traverse
    // pas la ville entre deux images, et les tuiles du sol restent en cache.
    const band = (s: Shot) => Math.floor(s.north / 100);
    return shots.sort((a, b) => {
      if (band(a) !== band(b)) return band(b) - band(a);
      return Math.abs(band(a)) % 2 === 0 ? a.east - b.east : b.east - a.east;
    });
  }

  /** Place le drone pour une prise de vue et attend que la vue soit complète. */
  private async shoot(shot: Shot) {
    const { city, drone, nadir, scene, groundAt, renderIdle } = this.hooks;
    const { dLon, dLat } = metersToDegrees(shot.east, shot.north, city.center.lat);
    const lon = city.center.lon + dLon;
    const lat = city.center.lat + dLat;
    const agl = shot.agl;
    Object.assign(drone, {
      lon,
      lat,
      agl,
      msl: groundAt(lon, lat) + agl,
      heading: shot.heading,
      vEast: 0,
      vNorth: 0,
      vUp: 0,
      pitch: 0,
      roll: 0,
    });

    // La vue verticale charge ses propres tuiles : on la rend jusqu'à ce que le
    // sol soit complet et que les ruines soient construites, trois fois de
    // suite, sans dépasser huit secondes.
    const start = performance.now();
    let calm = 0;
    while (calm < 3 && performance.now() - start < 8000) {
      await nextFrame();
      nadir.render(this.canvas, false);
      calm = scene.globe.tilesLoaded && renderIdle() ? calm + 1 : 0;
    }
    return nadir.render(this.canvas, false);
  }

  private async run(root: FileSystemDirectoryHandle, mode: CampaignMode): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    try {
      await this.capture(root, mode);
    } finally {
      this.running = false;
    }
  }

  private async capture(root: FileSystemDirectoryHandle, mode: CampaignMode): Promise<void> {
    const { city, drone, panel, report } = this.hooks;
    const createdAt = new Date();
    // Date et heure locales dans le nom du dossier : 20261003-2126.
    const pad = (v: number) => String(v).padStart(2, '0');
    const stamp =
      `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}` +
      `-${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}`;
    const prefix = mode === 'variee' ? 'drone-recon-varie' : 'drone-recon';
    const dir = await root.getDirectoryHandle(`${prefix}-${stamp}`, { create: true });
    const images = await dir.getDirectoryHandle('images', { create: true });
    const labels = await dir.getDirectoryHandle('labels', { create: true });

    const fovy = CONFIG.nadir.fov * DEG;
    const grid =
      mode === 'grille' ? this.plan(2 * CONFIG.dataset.altitude * Math.tan(fovy / 2)) : null;
    const passes: Pass[] =
      mode === 'grille'
        ? KINDS.map((kind) => ({
            variant: kind,
            label: DISASTERS[kind].label,
            scenario: defaultScenario(kind),
          }))
        : VARIANTS.map((v) => ({
            variant: v.id,
            label: describe(v.id, v.scenario),
            scenario: v.scenario,
          }));
    const saved = {
      lon: drone.lon,
      lat: drone.lat,
      agl: drone.agl,
      heading: drone.heading,
      holding: drone.holding,
    };
    const records: ImageRecord[] = [];
    let finished = false;

    // Le drone ne doit pas partir sur une touche pressée pendant la campagne.
    drone.holding = true;
    this.hooks.prepareView();
    try {
      for (const [index, pass] of passes.entries()) {
        if (this.stopRequested) break;
        const { scenario } = pass;
        panel.useScenario(scenario);
        panel.jump('end');
        const label = DISASTERS[scenario.kind].label;
        const shots = grid ?? this.scatter(scenario.seed * 7919 + index);

        for (const [n, shot] of shots.entries()) {
          if (this.stopRequested) break;
          const g = await this.shoot(shot);
          const file = `${pass.variant}_${String(n + 1).padStart(4, '0')}`;
          const blob = await new Promise<Blob>((resolve, reject) =>
            this.canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error('image vide'))),
              'image/jpeg',
              CONFIG.dataset.jpegQuality,
            ),
          );
          const record: ImageRecord = {
            file: `${file}.jpg`,
            scenario: scenario.kind,
            scenarioLabel: label,
            variant: pass.variant,
            variantLabel: pass.label,
            params: {
              magnitude: scenario.magnitude,
              east: scenario.east,
              north: scenario.north,
              windFrom: scenario.windFrom,
              seed: scenario.seed,
            },
            lon: g.lon,
            lat: g.lat,
            agl: g.agl,
            heading: g.heading,
            footprint: g.footprint,
            gsd: (g.footprint / g.size) * 100,
            size: g.size,
            annotations: annotate(city.buildings, g),
          };
          await writeFile(images, record.file, blob);
          await writeFile(labels, `${file}.txt`, yoloLabels(record));
          records.push(record);
          report(
            `Jeu de données — ${label}, scénario ${index + 1}/${passes.length} : ` +
              `${n + 1}/${shots.length} (${records.length} images) · J pour arrêter`,
          );
        }
      }
      finished = !this.stopRequested;
    } finally {
      const complete = finished;
      await writeFile(dir, 'annotations.json', JSON.stringify(cocoDocument(records, createdAt)));
      await writeFile(dir, 'data.yaml', yoloConfig());
      await writeFile(dir, 'metadonnees.csv', metadataCsv(records));
      await writeFile(
        dir,
        'LISEZMOI.md',
        readme(records, {
          createdAt,
          campaign: mode,
          altitudes:
            mode === 'grille'
              ? [CONFIG.dataset.altitude, CONFIG.dataset.altitude]
              : [CONFIG.dataset.varied.minAltitude, CONFIG.dataset.varied.maxAltitude],
          imageSize: CONFIG.dataset.imageSize,
          fov: CONFIG.nadir.fov,
          minVisible: CONFIG.dataset.minVisible,
          complete,
        }),
      );

      panel.cancel();
      Object.assign(drone, saved, { vEast: 0, vNorth: 0, vUp: 0 });
      drone.msl = this.hooks.groundAt(drone.lon, drone.lat) + drone.agl;
      this.hooks.restoreView();
      report(
        `Jeu de données ${complete ? 'terminé' : 'arrêté'} : ${records.length} images dans « ${dir.name} »`,
        'ok',
      );
    }
  }
}
