/**
 * Scénarios de la campagne variée (Maj+J).
 *
 * La campagne en quadrillage joue chaque aléa une fois, avec ses réglages par
 * défaut : un modèle qui n'a vu que ces quatre sinistres apprend quatre
 * dispositions de ruines. Ici, chaque aléa est rejoué quatre fois, avec un
 * autre foyer, une autre intensité et un autre tirage. Le premier de chaque
 * série reste le scénario par défaut, pour garder le lien avec la grille.
 *
 * Les foyers sont en mètres depuis le centre-ville (est, nord) et couvrent les
 * quatre quarts de la zone, pour que les dégâts ne tombent pas toujours au
 * même endroit. L'inondation n'a pas de foyer : c'est le relief qui décide où
 * l'eau monte, seule la hauteur de crue change.
 */

import { defaultScenario, type DisasterKind, type Scenario } from '../disaster/scenario';

type Override = Partial<Omit<Scenario, 'kind'>>;

const OVERRIDES: Record<DisasterKind, Override[]> = {
  // Intensité EMS-98 : VI½ à VIII, épicentres dans trois quarts différents.
  seisme: [
    {},
    { magnitude: 7.5, east: -200, north: 150, seed: 11 },
    { magnitude: 8, east: 250, north: -200, seed: 23 },
    { magnitude: 6.5, east: 0, north: 0, seed: 37 },
  ],
  // Charge en tonnes de TNT : d'un camion piégé à un entrepôt.
  explosion: [
    {},
    { magnitude: 3, east: -250, north: -150, seed: 41 },
    { magnitude: 6, east: 200, north: 250, seed: 53 },
    { magnitude: 2, east: -150, north: 280, seed: 67 },
  ],
  // Hauteur de crue, en mètres au-dessus du point le plus bas.
  inondation: [
    {},
    { magnitude: 2, seed: 71 },
    { magnitude: 4, seed: 83 },
    { magnitude: 5, seed: 97 },
  ],
  // Vigueur de propagation et vent : le feu part d'ailleurs et file autrement.
  incendie: [
    {},
    { magnitude: 1.5, east: 200, north: 100, windFrom: 270, seed: 5 },
    { magnitude: 1, east: -50, north: 250, windFrom: 180, seed: 9 },
    { magnitude: 1.8, east: 100, north: -250, windFrom: 45, seed: 13 },
  ],
};

/** Ordre des aléas, celui du panneau du simulateur. */
const KINDS: DisasterKind[] = ['seisme', 'explosion', 'inondation', 'incendie'];

export interface Variant {
  /** Identifiant court, repris dans le nom des images : `seisme-2`. */
  id: string;
  scenario: Scenario;
}

export const VARIANTS: Variant[] = KINDS.flatMap((kind) =>
  OVERRIDES[kind].map((override, i) => ({
    id: `${kind}-${i + 1}`,
    scenario: { ...defaultScenario(kind), ...override },
  })),
);
