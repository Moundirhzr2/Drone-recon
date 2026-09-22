/**
 * Couche d'abstraction des commandes.
 *
 * C'est la pièce la plus importante de tout le module d'entrée, et elle tient
 * en quinze lignes. Le drone ne sait pas ce qu'est une main, ni une touche : il
 * reçoit quatre nombres. Conséquences concrètes :
 *
 *  - on développe assis au clavier, sans lever les bras toutes les trente
 *    secondes devant une webcam ;
 *  - si le suivi des mains lâche en pleine démonstration, le clavier reprend la
 *    main sans rien changer au reste du programme ;
 *  - ajouter une manette plus tard, c'est écrire une source de plus, pas
 *    toucher à la physique de vol.
 *
 * Les sources s'ADDITIONNENT plutôt que de se remplacer : on peut corriger une
 * trajectoire au clavier alors même qu'on pilote aux mains.
 */

import { clamp } from '../core/math';

export interface ControlVector {
  /** Avant (+1) / arrière (-1). */
  pitch: number;
  /** Droite (+1) / gauche (-1), en translation. */
  roll: number;
  /** Rotation horaire (+1) / antihoraire (-1). */
  yaw: number;
  /** Monter (+1) / descendre (-1). */
  throttle: number;
}

export const NEUTRAL: ControlVector = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };

export interface ControlSource {
  readonly name: string;
  /** Renvoie la contribution de cette source, ou null si elle est inactive. */
  read(): ControlVector | null;
}

export class ControlMixer {
  private sources: ControlSource[] = [];
  /** Nom de la source qui a réellement produit la commande courante. */
  active = '—';

  add(source: ControlSource): void {
    this.sources.push(source);
  }

  read(): ControlVector {
    const out: ControlVector = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
    let dominant = '—';
    let best = 0;

    for (const src of this.sources) {
      const v = src.read();
      if (!v) continue;
      out.pitch += v.pitch;
      out.roll += v.roll;
      out.yaw += v.yaw;
      out.throttle += v.throttle;

      // La source dominante est celle qui pousse le plus fort : c'est elle
      // qu'on annonce au pilote dans le HUD.
      const magnitude =
        Math.abs(v.pitch) + Math.abs(v.roll) + Math.abs(v.yaw) + Math.abs(v.throttle);
      if (magnitude > best) {
        best = magnitude;
        dominant = src.name;
      }
    }

    this.active = best > 0.02 ? dominant : '—';

    out.pitch = clamp(out.pitch, -1, 1);
    out.roll = clamp(out.roll, -1, 1);
    out.yaw = clamp(out.yaw, -1, 1);
    out.throttle = clamp(out.throttle, -1, 1);
    return out;
  }
}
