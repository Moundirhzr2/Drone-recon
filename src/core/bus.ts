/**
 * Bus d'événements minimal.
 *
 * Il existe pour une raison précise : les gestes, le clavier et l'interface
 * déclenchent tous les mêmes actions (photo, bascule diagnostic...). Sans bus,
 * chaque source devrait connaître chaque destinataire.
 */

import type { Building } from '../world/buildings';
import type { Photo } from '../drone/photo';

/** Toutes les actions du simulateur, quelle que soit leur origine. */
export type AppEvents = {
  /** Déclencher une prise de vue nadir. */
  'photo:take': void;
  /** Une photo vient d'être enregistrée. */
  'photo:taken': Photo;
  /** Basculer entre image brute et image diagnostique. */
  'view:toggle-diagnostic': void;
  /** Changer le mode de rendu (réaliste / fil de fer / scan). */
  'view:cycle-render': void;
  /** Recentrer la caméra derrière le drone. */
  'view:reset-camera': void;
  /** Basculer entre caméra de suivi et vue à la première personne. */
  'view:toggle-fpv': void;
  /** Activer ou couper le suivi des mains. */
  'hands:toggle': void;
  /** Relancer le calibrage des mains. */
  'hands:calibrate': void;
  /** Stabilisation : le drone fige sa position. */
  'drone:hold': boolean;
  /** Remettre le drone au point de décollage. */
  'drone:reset': void;
  /** Un bâtiment a changé d'état (utile pour la partie 2). */
  'building:changed': Building;
  /** Lancer ou mettre en pause le sinistre en cours. */
  'disaster:toggle-play': void;
  /** Choisir un aléa par son rang (0 à 3). */
  'disaster:pick': number;
  /** Sauter au début (avant) ou à la fin (après) du sinistre. */
  'disaster:jump': 'start' | 'end';
  /** Annuler le sinistre et rendre la ville à son état d'origine. */
  'disaster:cancel': void;
  /** Message à afficher dans le bandeau de pilotage. */
  'ui:message': { text: string; kind?: 'info' | 'ok' | 'err' };
};

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void;

const listeners = new Map<string, Set<Handler<never>>>();

/** Écoute un événement. Renvoie la fonction de désabonnement. */
export function on<K extends keyof AppEvents>(event: K, fn: Handler<K>): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn as Handler<never>);
  return () => set!.delete(fn as Handler<never>);
}

/** Émet un événement vers tous les abonnés. */
export function emit<K extends keyof AppEvents>(
  event: K,
  ...args: AppEvents[K] extends void ? [] : [AppEvents[K]]
): void {
  const set = listeners.get(event);
  if (!set) return;
  const payload = args[0] as AppEvents[K];
  for (const fn of set) {
    try {
      (fn as Handler<K>)(payload);
    } catch (err) {
      console.error(`[bus] échec du gestionnaire de "${event}"`, err);
    }
  }
}

/** Raccourci pour afficher un message dans le HUD. */
export function say(text: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
  emit('ui:message', { text, kind });
}
