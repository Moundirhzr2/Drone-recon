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
 * la mention des données affichées. La planche avant / après / diagnostic
 * n'en a qu'un, sous ses trois images (`pairSheet`). Le nom d'un fichier
 * contient la date et l'heure : `capture_2026-10-04_18-37-12_vue.png`.
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
  const line = Math.round(size * 2.1);
  const lat = `${Math.abs(info.lat).toFixed(5)}° ${info.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(info.lon).toFixed(5)}° ${info.lon >= 0 ? 'E' : 'W'}`;
  const cap = String(Math.round(((info.heading % 360) + 360) % 360)).padStart(3, '0');
  const facts = `${info.at.toLocaleString('en-GB')}   ${lat}  ${lon}   AGL ${Math.round(info.agl)} m   HDG ${cap}°`;

  ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
  const left = ctx.measureText('DRONE RECON').width + size * 2;
  // Sur une image étroite (la photo nadir, carrée), les crédits passent sur
  // une seconde ligne plutôt que de chevaucher la position.
  const twoLines =
    left + ctx.measureText(facts).width + ctx.measureText(info.credits).width + size * 3 > w;
  const band = twoLines ? line * 2 - Math.round(size * 0.6) : line;

  ctx.fillStyle = 'rgba(4, 7, 11, 0.72)';
  ctx.fillRect(0, h - band, w, band);
  ctx.textBaseline = 'middle';
  const y = h - band + line / 2;
  ctx.fillStyle = '#00e5ff';
  ctx.textAlign = 'left';
  ctx.fillText('DRONE RECON', size, y);
  ctx.fillStyle = '#e6f6ff';
  ctx.fillText(facts, left, y);
  ctx.fillStyle = 'rgba(230, 246, 255, 0.6)';
  if (twoLines) {
    ctx.fillText(info.credits, size, h - line / 2);
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(info.credits, w - size, y);
  }

  if (info.title) {
    const big = Math.round(size * 2.2);
    ctx.font = `700 ${big}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const titleWidth = ctx.measureText(info.title).width;
    ctx.fillStyle = 'rgba(4, 7, 11, 0.72)';
    ctx.fillRect(size, size, titleWidth + size * 2, big + size * (info.subtitle ? 2.6 : 1.2));
    ctx.fillStyle = info.title.startsWith('BE') ? '#00e5ff' : '#ff9100';
    ctx.fillText(info.title, size * 2, size * 1.6);
    if (info.subtitle) {
      ctx.font = `600 ${size}px ui-monospace, Consolas, monospace`;
      ctx.fillStyle = '#e6f6ff';
      ctx.fillText(info.subtitle, size * 2, size * 1.8 + big);
    }
  }
}

/** Une image de la planche avant / après, et son étiquette. */
export interface SheetImage {
  image: HTMLCanvasElement;
  label: string;
}

/** Ce que mesure le diagnostic montré sur la planche. */
export interface SheetMetrics {
  precision: number | null;
  recall: number | null;
  targets: number;
}

/**
 * La planche avant / après / diagnostic : les images nues côte à côte, une
 * petite étiquette sur chacune, et un seul bandeau dessous pour tout le reste.
 * Avec un bandeau par image, la date, la position et les crédits se
 * répétaient trois fois. Les images enregistrées seules gardent le leur :
 * elles doivent se suffire.
 */
export function pairSheet(
  images: SheetImage[],
  info: CaptureInfo,
  metrics: SheetMetrics,
): HTMLCanvasElement {
  const side = Math.max(...images.map((i) => i.image.height));
  const gap = Math.max(4, Math.round(side * 0.008));
  const size = Math.max(12, Math.round(side * 0.026));
  const small = Math.max(10, Math.round(size * 0.8));
  const pad = Math.round(size * 0.9);
  const lead = Math.round(size * 0.55);
  const band = pad + size + lead + small + pad;

  const out = document.createElement('canvas');
  out.width = images.reduce((w, i) => w + i.image.width, 0) + gap * (images.length - 1);
  out.height = side + band;
  const ctx = out.getContext('2d');
  if (!ctx) return out;
  ctx.fillStyle = '#04070b';
  ctx.fillRect(0, 0, out.width, out.height);
  const font = (weight: number, px: number) =>
    `${weight} ${px}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // Les images, et l'étiquette de chacune.
  let x = 0;
  for (const { image, label } of images) {
    ctx.drawImage(image, x, 0);
    ctx.font = font(700, size);
    ctx.letterSpacing = `${Math.round(size * 0.14)}px`;
    const inset = Math.round(size * 0.8);
    const w = ctx.measureText(label).width + size * 1.2;
    const h = Math.round(size * 1.75);
    ctx.fillStyle = 'rgba(4, 7, 11, 0.78)';
    ctx.fillRect(x + inset, inset, w, h);
    ctx.fillStyle = label.startsWith('BE') ? '#00e5ff' : '#ff9100';
    ctx.fillText(label, x + inset + size * 0.6, inset + h / 2 + 1);
    x += image.width + gap;
  }
  ctx.letterSpacing = '0px';

  // Le bandeau : ce qui est montré, d'où et quand ; ce que mesure le diagnostic.
  const ink = '#e6f6ff';
  const dim = 'rgba(230, 246, 255, 0.55)';
  const accent = '#00e5ff';
  const margin = Math.round(size * 0.6);
  const lat = `${Math.abs(info.lat).toFixed(5)}° ${info.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(info.lon).toFixed(5)}° ${info.lon >= 0 ? 'E' : 'W'}`;
  const hdg = Math.round(((info.heading % 360) + 360) % 360) % 360;
  const facing = hdg === 0 ? 'north up' : `heading ${String(hdg).padStart(3, '0')}°`;
  const when = info.at.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const left: Array<[string, string]> = [
    [info.subtitle ?? '', ink],
    [`nadir view · ${Math.round(info.agl)} m · ${facing}`, dim],
    [`${lat} ${lon} · ${when}`, dim],
  ];
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
  const right: Array<[string, string]> = [
    ['precision ', ink],
    [pct(metrics.precision), accent],
    ['   recall ', ink],
    [pct(metrics.recall), accent],
    ['   ', ink],
    [String(metrics.targets), accent],
    [` target${metrics.targets === 1 ? '' : 's'}`, ink],
  ];
  const spread = size * 1.4;
  /** Écrit des morceaux à la suite ; renvoie la largeur occupée. */
  const write = (parts: Array<[string, string]>, at: number, y: number, between = 0) => {
    let cx = at;
    for (const [text, color] of parts) {
      if (!text) continue;
      ctx.fillStyle = color;
      ctx.fillText(text, cx, y);
      cx += ctx.measureText(text).width + between;
    }
    return cx - at - between;
  };
  const measure = (parts: Array<[string, string]>, between = 0) =>
    parts.reduce((w, [t]) => (t ? w + ctx.measureText(t).width + between : w), 0) - between;

  const y1 = side + pad + size / 2;
  const y2 = side + pad + size + lead + small / 2;
  ctx.font = font(400, size);
  const leftWidth = measure(left, spread);
  const rightWidth = measure(right);
  // Sur une planche étroite, les mesures passent sur la seconde ligne.
  const oneLine = margin + leftWidth + spread + rightWidth + margin <= out.width;
  write(left, margin, y1, spread);
  if (oneLine) write(right, out.width - margin - rightWidth, y1);

  ctx.font = font(400, small);
  ctx.fillStyle = dim;
  ctx.fillText(info.credits, margin, y2);
  if (oneLine) {
    ctx.fillStyle = accent;
    ctx.textAlign = 'right';
    ctx.fillText('DRONE RECON', out.width - margin, y2);
    ctx.textAlign = 'left';
  } else {
    // Même corps que la ligne du dessus, aligné à droite.
    ctx.font = font(400, size);
    write(right, out.width - margin - measure(right), y2);
  }
  return out;
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
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('empty image'))), 'image/png'),
  );
}

/** Enregistre les captures : dans un dossier choisi une fois, sinon en téléchargement. */
export class CaptureSaver {
  private folder: FileSystemDirectoryHandle | null = null;
  /** L'utilisateur a refusé de choisir un dossier : on ne le lui redemande pas. */
  private declined = false;

  /** Où partent les captures, pour le message de confirmation. */
  get destination(): string {
    return this.folder ? `the "${this.folder.name}" folder` : 'Downloads';
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
