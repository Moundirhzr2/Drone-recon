/**
 * Captures d'écran : la vue du drone, enregistrée en PNG.
 *
 * Deux commandes :
 *  - une capture (Espace, ou pincement de la main droite) : la vue principale,
 *    celle du pilote, et la photo verticale de la caméra nadir ;
 *  - une paire avant / après (Maj + Espace) : la même vue, depuis le même
 *    point, avant puis après le sinistre en cours, et les deux côte à côte.
 *
 * Chaque image porte un bandeau : date et heure, position, hauteur, cap, et
 * la mention des données affichées. Son nom contient la date et l'heure :
 * `capture_2026-10-04_18-37-12_vue.png`.
 *
 * OÙ VONT LES FICHIERS
 * --------------------
 * À la première capture faite au clavier, le navigateur demande un dossier
 * (Chrome et Edge) ; les suivantes s'y écrivent sans question. Ailleurs, ou si
 * l'on refuse, elles partent dans les téléchargements. Un pincement de la main
 * ne peut pas ouvrir ce choix : le navigateur exige une action au clavier ou à
 * la souris ; il télécharge donc, tant qu'aucun dossier n'est choisi.
 */

import type * as Cesium from 'cesium';

/** Horodatage pour un nom de fichier, en heure locale : `2026-10-04_18-37-12`. */
export function timestamp(date = new Date()): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/** Ce que dit le bandeau d'une capture. */
export interface CaptureInfo {
  at: Date;
  lon: number;
  lat: number;
  /** Hauteur au-dessus du sol, en mètres. */
  agl: number;
  heading: number;
  /** Source des données à l'image, à citer : Google ou l'IGN. */
  credits: string;
  /** Grand titre en haut à gauche, pour une paire : « AVANT », « APRÈS ». */
  title?: string;
  /** Sous-titre : le sinistre montré. */
  subtitle?: string;
}

/**
 * Rend la vue principale et la recopie. La recopie doit suivre le rendu dans
 * la même tâche : le canvas de Cesium ne garde pas son image ensuite.
 */
export function grabView(viewer: Cesium.Viewer): HTMLCanvasElement {
  viewer.render();
  const src = viewer.scene.canvas;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  out.getContext('2d')?.drawImage(src, 0, 0);
  return out;
}

/** Ajoute à une image le bandeau d'informations, et son titre s'il y en a un. */
export function annotateCapture(canvas: HTMLCanvasElement, info: CaptureInfo): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const size = Math.max(12, Math.round(h * 0.02));
  const band = Math.round(size * 2.1);

  ctx.fillStyle = 'rgba(4, 7, 11, 0.72)';
  ctx.fillRect(0, h - band, w, band);
  ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  const y = h - band / 2;
  const lat = `${Math.abs(info.lat).toFixed(5)}° ${info.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(info.lon).toFixed(5)}° ${info.lon >= 0 ? 'E' : 'O'}`;
  const cap = String(Math.round(((info.heading % 360) + 360) % 360)).padStart(3, '0');
  ctx.fillStyle = '#00e5ff';
  ctx.textAlign = 'left';
  ctx.fillText('DRONE RECON', size, y);
  ctx.fillStyle = '#e6f6ff';
  const left = ctx.measureText('DRONE RECON').width + size * 2;
  ctx.fillText(
    `${info.at.toLocaleString('fr-FR')}   ${lat}  ${lon}   SOL ${Math.round(info.agl)} m   CAP ${cap}°`,
    left,
    y,
  );
  ctx.fillStyle = 'rgba(230, 246, 255, 0.6)';
  ctx.textAlign = 'right';
  ctx.fillText(info.credits, w - size, y);

  if (info.title) {
    const big = Math.round(size * 2.2);
    ctx.font = `700 ${big}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const titleWidth = ctx.measureText(info.title).width;
    ctx.fillStyle = 'rgba(4, 7, 11, 0.72)';
    ctx.fillRect(size, size, titleWidth + size * 2, big + size * (info.subtitle ? 2.6 : 1.2));
    ctx.fillStyle = info.title.startsWith('AV') ? '#00e5ff' : '#ff9100';
    ctx.fillText(info.title, size * 2, size * 1.6);
    if (info.subtitle) {
      ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
      ctx.fillStyle = '#e6f6ff';
      ctx.fillText(info.subtitle, size * 2, size * 1.8 + big);
    }
  }
}

/** Deux images côte à côte, à la même hauteur : la paire avant / après. */
export function sideBySide(left: HTMLCanvasElement, right: HTMLCanvasElement): HTMLCanvasElement {
  const gap = Math.round(left.height * 0.01);
  const out = document.createElement('canvas');
  out.width = left.width + right.width + gap;
  out.height = Math.max(left.height, right.height);
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#04070b';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(left, 0, 0);
    ctx.drawImage(right, left.width + gap, 0);
  }
  return out;
}

export function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('image vide'))), 'image/png'),
  );
}

/** Enregistre les captures : dans un dossier choisi une fois, sinon en téléchargement. */
export class CaptureSaver {
  private folder: FileSystemDirectoryHandle | null = null;
  /** L'utilisateur a refusé de choisir un dossier : on ne le lui redemande pas. */
  private declined = false;

  /** Où partent les captures, pour le message de confirmation. */
  get destination(): string {
    return this.folder ? `le dossier « ${this.folder.name} »` : 'les téléchargements';
  }

  /**
   * Demande le dossier des captures, une fois. À appeler AVANT toute attente
   * dans la commande de capture : le navigateur n'ouvre ce choix que dans la
   * foulée d'une action au clavier ou à la souris.
   */
  async ensureFolder(): Promise<void> {
    if (this.folder || this.declined || !window.showDirectoryPicker) return;
    if (!navigator.userActivation?.isActive) return;
    try {
      this.folder = await window.showDirectoryPicker({
        id: 'drone-recon-captures',
        mode: 'readwrite',
      });
    } catch {
      this.declined = true;
    }
  }

  /** Utilise un dossier déjà ouvert, par exemple pour les tests. */
  useFolder(folder: FileSystemDirectoryHandle): void {
    this.folder = folder;
  }

  async save(name: string, blob: Blob): Promise<void> {
    if (this.folder) {
      try {
        const file = await this.folder.getFileHandle(name, { create: true });
        const out = await file.createWritable();
        await out.write(blob);
        await out.close();
        return;
      } catch (err) {
        // Dossier retiré ou permission révoquée : on retombe sur les téléchargements.
        console.warn('[captures] dossier inaccessible, téléchargement', err);
        this.folder = null;
      }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
