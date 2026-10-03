/**
 * Campagne de prise de vue : le jeu de données exporté par la touche J.
 *
 * Le drone balaie la zone en quadrillage, au-dessus de la ville de l'IGN, pour
 * chacun des quatre aléas joués jusqu'à leur état final, et prend une image
 * verticale par case. Chaque image part dans un dossier choisi par
 * l'utilisateur, avec ses annotations ; les fichiers sont écrits au fil de
 * l'eau, si bien qu'un millier d'images ne tient jamais en mémoire.
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
import { DEG, metersToDegrees } from '../core/math';
import { DISASTERS, type DisasterKind } from '../disaster/scenario';
import type { DroneState } from '../drone/drone';
import type { NadirView } from '../drone/nadir';
import type { DisasterPanel } from '../hud/disaster';
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

/** Les aléas, dans l'ordre du panneau du simulateur (voir `pickKind`). */
const KINDS: DisasterKind[] = ['seisme', 'explosion', 'inondation', 'incendie'];

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

interface Cell {
  east: number;
  north: number;
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
  toggle(): void {
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
      .then((root) => this.run(root))
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
  private plan(side: number): Cell[] {
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

    const cells: Cell[] = [];
    const columns = Math.floor((maxE - minE) / side) + 1;
    const rows = Math.floor((maxN - minN) / side) + 1;
    for (let j = rows - 1; j >= 0; j--) {
      // En lacet : chaque rangée repart du côté où la précédente s'est arrêtée.
      const reverse = (rows - 1 - j) % 2 === 1;
      for (let k = 0; k < columns; k++) {
        const i = reverse ? columns - 1 - k : k;
        if (!occupied.has(`${i}:${j}`)) continue;
        cells.push({ east: minE + (i + 0.5) * side, north: minN + (j + 0.5) * side });
      }
    }
    return cells;
  }

  /** Place le drone au-dessus d'une case et attend que la vue soit complète. */
  private async shoot(cell: Cell) {
    const { city, drone, nadir, scene, groundAt, renderIdle } = this.hooks;
    const { dLon, dLat } = metersToDegrees(cell.east, cell.north, city.center.lat);
    const lon = city.center.lon + dLon;
    const lat = city.center.lat + dLat;
    const agl = CONFIG.dataset.altitude;
    Object.assign(drone, {
      lon,
      lat,
      agl,
      msl: groundAt(lon, lat) + agl,
      heading: 0,
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

  private async run(root: FileSystemDirectoryHandle): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    try {
      await this.capture(root);
    } finally {
      this.running = false;
    }
  }

  private async capture(root: FileSystemDirectoryHandle): Promise<void> {
    const { city, drone, panel, report } = this.hooks;
    const createdAt = new Date();
    // Date et heure locales dans le nom du dossier : 20261003-2126.
    const pad = (v: number) => String(v).padStart(2, '0');
    const stamp =
      `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}` +
      `-${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}`;
    const dir = await root.getDirectoryHandle(`drone-recon-${stamp}`, { create: true });
    const images = await dir.getDirectoryHandle('images', { create: true });
    const labels = await dir.getDirectoryHandle('labels', { create: true });

    const fovy = CONFIG.nadir.fov * DEG;
    const side = 2 * CONFIG.dataset.altitude * Math.tan(fovy / 2);
    const cells = this.plan(side);
    const total = cells.length * KINDS.length;
    const saved = {
      lon: drone.lon,
      lat: drone.lat,
      agl: drone.agl,
      heading: drone.heading,
      holding: drone.holding,
    };
    const records: ImageRecord[] = [];

    // Le drone ne doit pas partir sur une touche pressée pendant la campagne.
    drone.holding = true;
    this.hooks.prepareView();
    try {
      for (const [index, kind] of KINDS.entries()) {
        if (this.stopRequested) break;
        panel.pickKind(index);
        panel.jump('end');
        const label = DISASTERS[kind].label;

        for (const [n, cell] of cells.entries()) {
          if (this.stopRequested) break;
          const g = await this.shoot(cell);
          const file = `${kind}_${String(n + 1).padStart(4, '0')}`;
          const blob = await new Promise<Blob>((resolve, reject) =>
            this.canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error('image vide'))),
              'image/jpeg',
              CONFIG.dataset.jpegQuality,
            ),
          );
          const record: ImageRecord = {
            file: `${file}.jpg`,
            scenario: kind,
            scenarioLabel: label,
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
            `Jeu de données — ${label} : ${n + 1}/${cells.length} (${records.length}/${total}) · J pour arrêter`,
          );
        }
      }
    } finally {
      const complete = records.length === total;
      await writeFile(dir, 'annotations.json', JSON.stringify(cocoDocument(records, createdAt)));
      await writeFile(dir, 'data.yaml', yoloConfig());
      await writeFile(dir, 'metadonnees.csv', metadataCsv(records));
      await writeFile(
        dir,
        'LISEZMOI.md',
        readme(records, {
          createdAt,
          altitude: CONFIG.dataset.altitude,
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
