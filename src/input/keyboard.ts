/**
 * Pilotage au clavier — la source de référence.
 *
 * Elle existe autant pour le développement que pour la démonstration : c'est
 * elle qui permet de savoir si un comportement bizarre vient de la physique ou
 * du suivi des mains. Sans elle, on déboguerait deux inconnues à la fois.
 *
 * Disposition pensée pour un clavier AZERTY, avec les équivalents QWERTY
 * acceptés en parallèle : on lit les CODES de touche, donc la position
 * physique, ce qui rend les deux dispositions équivalentes.
 */

import { emit } from '../core/bus';
import type { ControlSource, ControlVector } from './control';

/** Touches de pilotage : code physique -> effet. */
const AXES: Record<string, Partial<ControlVector>> = {
  // Manche droit : déplacement dans le plan (Z Q S D sur AZERTY).
  KeyW: { pitch: 1 },
  KeyS: { pitch: -1 },
  KeyA: { roll: -1 },
  KeyD: { roll: 1 },
  // Manche gauche : altitude et rotation (flèches).
  ArrowUp: { throttle: 1 },
  ArrowDown: { throttle: -1 },
  ArrowLeft: { yaw: -1 },
  ArrowRight: { yaw: 1 },
};

export class KeyboardControl implements ControlSource {
  readonly name = 'clavier';
  private down = new Set<string>();

  constructor() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    // Relâcher toutes les touches si la fenêtre perd le focus : sinon le drone
    // part tout seul pendant qu'on regarde ailleurs.
    window.addEventListener('blur', () => this.down.clear());
  }

  private onDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (AXES[e.code]) {
      this.down.add(e.code);
      e.preventDefault();
      return;
    }
    this.handleAction(e);
  };

  private onUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  /** Commandes ponctuelles : tout ce qui n'est pas un axe. */
  private handleAction(e: KeyboardEvent): void {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        emit('photo:take');
        break;
      case 'KeyV':
        emit('view:toggle-diagnostic');
        break;
      case 'KeyM':
        emit('view:cycle-render');
        break;
      case 'KeyC':
        emit('view:toggle-fpv');
        break;
      case 'KeyI':
        emit('view:toggle-hud');
        break;
      case 'KeyR':
        emit('drone:reset');
        break;
      case 'KeyH':
        emit('hands:toggle');
        break;
      case 'KeyK':
        emit('hands:calibrate');
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        emit('drone:hold', true);
        break;

      // --- Simulateur de désastres (partie 2) ---------------------------
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
        emit('disaster:pick', Number(e.code.slice(5)) - 1);
        break;
      case 'KeyP':
        emit('disaster:toggle-play');
        break;
      case 'KeyB':
        emit('disaster:jump', 'start');
        break;
      case 'KeyN':
        emit('disaster:jump', 'end');
        break;
      case 'Backspace':
        e.preventDefault();
        emit('disaster:cancel');
        break;
    }
  }

  read(): ControlVector | null {
    if (this.down.size === 0) return null;
    const v: ControlVector = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
    for (const code of this.down) {
      const axis = AXES[code];
      if (!axis) continue;
      v.pitch += axis.pitch ?? 0;
      v.roll += axis.roll ?? 0;
      v.yaw += axis.yaw ?? 0;
      v.throttle += axis.throttle ?? 0;
    }
    return v;
  }
}

/** La stabilisation se relâche au relevé de Maj. */
window.addEventListener('keyup', (e) => {
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') emit('drone:hold', false);
});
