/**
 * Prise de vue et archivage.
 *
 * Une photo n'est pas qu'une image : c'est une image PLUS sa géométrie de prise
 * de vue et la liste des bâtiments cadrés. Sans ces métadonnées, on ne peut ni
 * reprojeter les détections, ni situer un dégât sur une carte, ni produire un
 * rapport exploitable. C'est exactement ce que fait une vraie mission de
 * photogrammétrie : l'image seule ne vaut rien.
 */

import { CONFIG } from '../core/config';
import { emit } from '../core/bus';
import type { Detection } from '../diagnostic/detector';
import type { NadirGeometry, NadirView } from './nadir';
import type { DroneState } from './drone';

export interface Photo {
  id: string;
  /** Image brute, encodée en PNG. */
  dataUrl: string;
  /** Horodatage de la prise de vue. */
  at: Date;
  /** Géométrie de prise de vue, pour reprojeter les détections. */
  geometry: NadirGeometry;
  /** Ce que le détecteur a relevé sur cette image. */
  detections: Detection[];
  /** Résolution au sol, en cm/pixel. */
  gsd: number;
  /** Altitude et cap au déclenchement. */
  agl: number;
  heading: number;
}

export class PhotoLog {
  readonly photos: Photo[] = [];
  private canvas: HTMLCanvasElement;
  private seq = 0;

  constructor(
    private nadir: NadirView,
    private state: DroneState,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CONFIG.nadir.photoSize;
    this.canvas.height = CONFIG.nadir.photoSize;
  }

  /**
   * Déclenche une prise de vue.
   * @param detect fonction qui analyse la géométrie et renvoie les détections.
   */
  take(detect: (g: NadirGeometry) => Detection[]): Photo {
    // Rendu dédié, à la résolution photo. On ne marque pas l'aperçu comme
    // rafraîchi : la vignette garde son propre rythme.
    const geometry = this.nadir.render(this.canvas, false);

    const photo: Photo = {
      id: `IMG_${String(++this.seq).padStart(4, '0')}`,
      dataUrl: this.canvas.toDataURL('image/png'),
      at: new Date(),
      geometry,
      detections: detect(geometry),
      // Résolution au sol : combien de centimètres couvre un pixel.
      gsd: (geometry.footprint / geometry.size) * 100,
      agl: this.state.agl,
      heading: this.state.heading,
    };

    this.photos.unshift(photo);
    // On borne l'historique : chaque PNG 1024² pèse quelques mégaoctets en
    // mémoire, et une mission longue finirait par saturer l'onglet.
    if (this.photos.length > 24) this.photos.pop();

    emit('photo:taken', photo);
    return photo;
  }
}
