/**
 * Choix du lieu : un bouton en haut de l'écran, qui ouvre une recherche.
 *
 * Choisir un résultat recharge le simulateur sur ce lieu (`world/place.ts`).
 * Avec le géocodeur de l'IGN, la recherche part pendant la frappe ; avec
 * celui de Google, seulement sur Entrée : chaque requête est décomptée du
 * quota du compte Cesium ion.
 */

import {
  goToPlace,
  isMulhouse,
  MULHOUSE,
  searchesWithGoogle,
  searchPlaces,
  type Found,
  type Place,
} from '../world/place';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class PlacePicker {
  private button = $<HTMLButtonElement>('place-toggle');
  private panel = $('place-panel');
  private input = $<HTMLInputElement>('place-query');
  private results = $('place-results');
  private note = $('place-note');
  private home = $<HTMLButtonElement>('place-home');
  private timer = 0;
  /** Numéro de la dernière recherche : une réponse plus ancienne est ignorée. */
  private seq = 0;
  private google = searchesWithGoogle();

  constructor(current: Place) {
    this.button.textContent = current.name;
    this.button.title = 'Changer de lieu';
    this.home.hidden = isMulhouse(current);
    this.note.textContent = this.google
      ? 'Recherche : Google (Entrée pour chercher). Données : IGN en France, OpenStreetMap ailleurs.'
      : 'Recherche : IGN et Photon. Données : IGN en France, OpenStreetMap ailleurs.';

    this.button.addEventListener('click', () => this.toggle());
    this.home.addEventListener('click', () => goToPlace(MULHOUSE));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggle(false);
      if (e.key === 'Enter') void this.search();
    });
    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      if (!this.google) this.timer = window.setTimeout(() => void this.search(), 350);
    });
  }

  toggle(open = this.panel.hidden): void {
    this.panel.hidden = !open;
    this.button.classList.toggle('on', open);
    if (open) {
      this.input.value = '';
      this.results.innerHTML = '';
      this.input.focus();
    }
  }

  /** Dit pourquoi le lieu demandé n'a pas pu être chargé : le panneau reste ouvert. */
  showError(text: string): void {
    this.toggle(true);
    this.show([], text, true);
  }

  private async search(): Promise<void> {
    const query = this.input.value;
    const seq = ++this.seq;
    let found: Found[];
    try {
      found = await searchPlaces(query);
    } catch (err) {
      if (seq === this.seq) this.show([], err instanceof Error ? err.message : String(err));
      return;
    }
    if (seq !== this.seq) return;
    this.show(found, query.trim().length >= 2 && !found.length ? 'Aucun lieu trouvé.' : '');
  }

  private show(found: Found[], message: string, error = false): void {
    this.results.innerHTML = '';
    for (const place of found) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'place-result';
      b.textContent = place.label;
      b.addEventListener('click', () => {
        this.results.innerHTML = '';
        this.note.textContent = `Chargement de ${place.name}…`;
        goToPlace(place);
      });
      this.results.appendChild(b);
    }
    if (message) {
      const p = document.createElement('p');
      p.className = error ? 'place-empty err' : 'place-empty';
      p.textContent = message;
      this.results.appendChild(p);
    }
  }
}
