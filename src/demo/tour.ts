/**
 * Visite guidée, lancée par `?demo` dans l'adresse.
 *
 * Le drone vole seul : le centre-ville réel, le tour du temple Saint-Étienne,
 * puis les quatre aléas l'un après l'autre, chaque étape annoncée par un
 * sous-titre. Trois minutes environ, pour présenter le simulateur sans tenir
 * les commandes. N'importe quelle touche l'interrompt et rend la main, là où
 * se trouve le drone.
 *
 * Chaque aléa est cadré d'après son scénario par défaut (`defaultScenario`),
 * et les sous-titres décrivent ces mêmes réglages.
 */

import { emit } from '../core/bus';
import { DEG, metersToDegrees, wrap360 } from '../core/math';
import { defaultScenario, localOffset } from '../disaster/scenario';
import type { DisasterPlayer } from '../disaster/timeline';
import type { DroneState } from '../drone/drone';
import type { DisasterPanel } from '../hud/disaster';
import type { City } from '../world/city';

export interface TourContext {
  city: City;
  drone: DroneState;
  panel: DisasterPanel;
  player: DisasterPlayer;
  /** La vue diagnostique est-elle affichée ? */
  diagnostic: () => boolean;
  /** Vrai quand les tuiles de la vue courante sont chargées. */
  tilesLoaded: () => boolean;
  /** La ville est-elle le relevé photoréaliste, ou la ville dessinée ? */
  photoreal: boolean;
}

/** Rang de chaque aléa dans le panneau du simulateur. */
const SEISME = 0;
const EXPLOSION = 1;
const INONDATION = 2;
const INCENDIE = 3;

/** Départ et arrivée en douceur. */
const ease = (k: number) => k * k * (3 - 2 * k);

/**
 * Images réellement présentées par seconde, comptées sur une demi-seconde.
 *
 * Un onglet en arrière-plan n'en présente aucune : la visite s'y déroulerait
 * sans témoin. Le compteur de la boucle ne suffit pas à le voir, il garde sa
 * dernière valeur quand la boucle est gelée.
 */
function presentedFps(): Promise<number> {
  return new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 < 500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(frames * 2), 520);
  });
}

export async function runTour(ctx: TourContext): Promise<void> {
  const { city, drone, panel, player } = ctx;

  const stop = new AbortController();
  const alive = () => !stop.signal.aborted;
  const onKey = () => stop.abort();
  window.addEventListener('keydown', onKey, { once: true });

  const caption = document.createElement('div');
  caption.id = 'demo-caption';
  document.body.appendChild(caption);
  const say = (text: string) => {
    caption.textContent = text;
  };

  /** Attente écourtée dès que la visite est interrompue. */
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stop.signal.addEventListener('abort', done, { once: true });
    });

  const tilesLoaded = async () => {
    const t0 = performance.now();
    while (alive() && !ctx.tilesLoaded() && performance.now() - t0 < 8000) await wait(200);
  };

  /** Appelle `fn` à chaque image, avec un avancement qui va de 0 à 1 en `ms`. */
  const animate = async (ms: number, fn: (k: number) => void) => {
    const t0 = performance.now();
    let k = 0;
    while (alive() && k < 1) {
      k = Math.min(1, (performance.now() - t0) / ms);
      fn(ease(k));
      await new Promise(requestAnimationFrame);
    }
  };

  /** Place le drone immobile, en mètres depuis le centre-ville. */
  const place = (east: number, north: number, agl: number, heading: number) => {
    const { dLon, dLat } = metersToDegrees(east, north, city.center.lat);
    Object.assign(drone, {
      lon: city.center.lon + dLon,
      lat: city.center.lat + dLat,
      agl,
      heading: wrap360(heading),
      vEast: 0,
      vNorth: 0,
      vUp: 0,
    });
  };

  /** Place le drone à `distance` mètres d'un point, cap sur lui. */
  const face = (east: number, north: number, distance: number, agl: number, heading: number) => {
    place(
      east - distance * Math.sin(heading * DEG),
      north - distance * Math.cos(heading * DEG),
      agl,
      heading,
    );
  };

  /** Joue un aléa jusqu'au bout, depuis la ville intacte. */
  const play = async (kind: number, speed: number) => {
    panel.pickKind(kind);
    panel.open();
    player.speed = speed;
    panel.togglePlay();
    while (alive() && !player.finished) await wait(250);
    await wait(2500);
  };

  const temple = city.buildings.find((b) => b.name === 'Temple Saint-Étienne');
  const count = city.buildings.length.toLocaleString('fr-FR');

  const steps: Array<() => Promise<void>> = [
    async () => {
      place(-199, -123, 95, 30);
      say(
        `1/6 — Le centre réel de Mulhouse : ${count} bâtiments de l'IGN autour de la place de la Réunion`,
      );
      await tilesLoaded();
      await animate(9000, (k) => {
        drone.heading = 30 + 30 * k;
      });
    },
    async () => {
      // À 40 m, le drone passe au-dessus du temple (27 m) comme de ses voisins.
      const center = temple
        ? localOffset(temple, city.center.lon, city.center.lat)
        : { east: 0, north: 0 };
      const orbit = (bearing: number) => {
        place(
          center.east + 110 * Math.sin(bearing * DEG),
          center.north + 110 * Math.cos(bearing * DEG),
          40,
          bearing + 180,
        );
      };
      orbit(200);
      const where = temple ? 'Tour du temple Saint-Étienne' : 'Tour du centre-ville';
      say(
        ctx.photoreal
          ? `2/6 — ${where} : la ville telle qu'elle est, relevée en 3D, posée sur le relief de l'IGN`
          : `2/6 — ${where} : façades et toitures dessinées d'après l'époque, l'usage et la couverture que déclare l'IGN`,
      );
      await tilesLoaded();
      await wait(800);
      await animate(22000, (k) => orbit(200 + 160 * k));
    },
    async () => {
      const { east, north } = defaultScenario('explosion');
      face(east, north, 325, 90, 45);
      say("3/6 — Explosion d'une tonne de TNT : éclair, boule de feu, onde de choc, débris, fumée");
      await tilesLoaded();
      await wait(1500);
      await play(EXPLOSION, 1);
    },
    async () => {
      panel.cancel();
      // La crue n'a pas de foyer : c'est le relief qui décide où l'eau monte.
      place(-40, -60, 110, 40);
      say(
        "4/6 — Crue de 3 m : l'eau monte à niveau plat et remplit d'abord le point bas du relief (×3)",
      );
      await tilesLoaded();
      await wait(1000);
      await play(INONDATION, 3);
    },
    async () => {
      panel.cancel();
      const { east, north } = defaultScenario('incendie');
      face(east, north, 225, 75, 45);
      say(
        '5/6 — Incendie poussé par le vent de sud-ouest : flammes, fumée, façades calcinées (×3)',
      );
      await tilesLoaded();
      await wait(1000);
      await play(INCENDIE, 3);
    },
    async () => {
      panel.cancel();
      const { east, north } = defaultScenario('seisme');
      face(east, north, 283, 80, 45);
      say(
        "6/6 — Séisme d'intensité VII, celle estimée à Mulhouse en 1356 : secousse, fissures, effondrements",
      );
      await tilesLoaded();
      await wait(1000);
      await play(SEISME, 1);
    },
    async () => {
      if (!ctx.diagnostic()) emit('view:toggle-diagnostic');
      say(
        "Bilan en vue diagnostique : chaque bâtiment classé. À vous de piloter — les touches sont en bas de l'écran.",
      );
      await wait(12000);
    },
  ];

  try {
    say("Visite guidée — elle démarre dès que la page s'affiche");
    while (alive() && (await presentedFps()) < 25) {
      // Page masquée : rien n'est présenté à l'écran, on attend.
    }
    panel.cancel();
    for (const step of steps) {
      if (!alive()) break;
      await step();
    }
  } finally {
    window.removeEventListener('keydown', onKey);
    player.speed = 1;
    caption.remove();
  }
}
