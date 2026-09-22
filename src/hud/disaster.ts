/**
 * Panneau du simulateur de désastres.
 *
 * Il ne contient aucune physique : il choisit un scénario, le fait construire,
 * pilote la lecture et affiche le bilan. Toute la modélisation est dans
 * `disaster/` et la courbe de fragilité dans `world/fragility.ts`.
 *
 * Un point d'ergonomie qui a dicté la disposition : le bilan affiche l'ÉCART
 * par rapport à l'état d'avant, pas seulement le décompte final. « 14 effondrés »
 * ne dit rien si on ignore qu'il y en avait déjà 6. C'est le « +8 » qui porte
 * l'information, et c'est lui qu'on veut lire pendant que le sinistre se
 * déroule.
 */

import { DAMAGE_INFO, DAMAGE_ORDER, type DamageState } from '../world/buildings';
import type { City } from '../world/city';
import { DISASTERS, defaultScenario, type DisasterKind, type Scenario } from '../disaster/scenario';
import { buildTimeline, type Timeline } from '../disaster/timeline';
import type { DisasterPlayer } from '../disaster/timeline';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const KINDS: DisasterKind[] = ['seisme', 'explosion', 'inondation', 'incendie'];

/** Écrit dans un noeud seulement si le texte a changé. */
function put(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

export interface DisasterPanelHooks {
  /** Appelé quand la géométrie de la ville doit être reconstruite. */
  onRebuild: () => void;
  /** Appelé quand un scénario est armé ou annulé. */
  onArmed?: (armed: boolean) => void;
}

export class DisasterPanel {
  private panel = $('hud-disaster');
  private tag = $('disaster-tag');
  private dot = $('disaster-dot');
  private kindsBox = $('dis-kinds');
  private blurb = $('dis-blurb');
  private magLabel = $('dis-mag-label');
  private mag = $<HTMLInputElement>('dis-mag');
  private magValue = $('dis-mag-value');
  private windField = $('dis-wind-field');
  private wind = $<HTMLInputElement>('dis-wind');
  private windValue = $('dis-wind-value');
  private playBtn = $<HTMLButtonElement>('dis-play');
  private startBtn = $<HTMLButtonElement>('dis-start');
  private endBtn = $<HTMLButtonElement>('dis-end');
  private resetBtn = $<HTMLButtonElement>('dis-reset');
  private scrub = $<HTMLInputElement>('dis-scrub');
  private timeLabel = $('dis-time');
  private ofLabel = $('dis-of');
  private tally = $('dis-tally');
  private note = $('dis-note');

  private kind: DisasterKind = 'seisme';
  private scenario: Scenario = defaultScenario('seisme');
  /** Décompte des états avant le sinistre, pour afficher l'écart. */
  private baseline: Record<DamageState, number> | null = null;
  /** L'utilisateur déplace le curseur : on ne le réécrit pas sous ses doigts. */
  private scrubbing = false;
  private cells = new Map<DamageState, { n: HTMLElement; d: HTMLElement }>();

  constructor(
    private city: City,
    private player: DisasterPlayer,
    private hooks: DisasterPanelHooks,
  ) {
    this.buildKindButtons();
    this.buildTally();
    this.wireControls();
    this.selectKind('seisme');
    this.refresh();
  }

  // ----------------------------------------------------------------------
  // Construction de l'interface
  // ----------------------------------------------------------------------

  private buildKindButtons(): void {
    this.kindsBox.innerHTML = '';
    KINDS.forEach((k, i) => {
      const b = document.createElement('button');
      b.className = 'dis-kind';
      b.dataset.kind = k;
      b.textContent = `${i + 1}. ${DISASTERS[k].label}`;
      b.addEventListener('click', () => this.selectKind(k));
      this.kindsBox.appendChild(b);
    });
  }

  private buildTally(): void {
    this.tally.innerHTML = '';
    for (const state of DAMAGE_ORDER) {
      const info = DAMAGE_INFO[state];
      const cell = document.createElement('div');
      cell.className = 'dis-cell';
      cell.style.borderColor = `${info.color}55`;

      const n = document.createElement('span');
      n.className = 'n';
      n.style.color = info.color;
      n.textContent = '0';

      const l = document.createElement('span');
      l.className = 'l';
      l.textContent = info.short;

      const d = document.createElement('span');
      d.className = 'd';
      d.style.color = info.color;
      d.textContent = '';

      cell.append(n, l, d);
      this.tally.appendChild(cell);
      this.cells.set(state, { n, d });
    }
  }

  private wireControls(): void {
    $('disaster-header').addEventListener('click', () => {
      this.panel.classList.toggle('collapsed');
    });

    this.mag.addEventListener('input', () => {
      this.scenario.magnitude = Number(this.mag.value);
      this.magValue.textContent = this.formatMagnitude();
      // Changer la magnitude invalide la chronologie en cours.
      this.disarm();
    });

    this.wind.addEventListener('input', () => {
      this.scenario.windFrom = Number(this.wind.value);
      this.windValue.textContent = `${this.wind.value}°`;
      this.disarm();
    });

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.startBtn.addEventListener('click', () => this.jump('start'));
    this.endBtn.addEventListener('click', () => this.jump('end'));
    this.resetBtn.addEventListener('click', () => this.cancel());

    // Le curseur ne doit pas se battre avec la lecture automatique.
    this.scrub.addEventListener('pointerdown', () => {
      this.scrubbing = true;
      this.player.playing = false;
    });
    const release = () => {
      this.scrubbing = false;
    };
    this.scrub.addEventListener('pointerup', release);
    this.scrub.addEventListener('pointercancel', release);

    this.scrub.addEventListener('input', () => {
      const tl = this.player.current;
      if (!tl) return;
      const t = (Number(this.scrub.value) / 1000) * tl.duration;
      if (this.player.seek(t)) this.hooks.onRebuild();
      this.refresh();
    });
  }

  // ----------------------------------------------------------------------
  // Scénario
  // ----------------------------------------------------------------------

  private formatMagnitude(): string {
    const m = this.scenario.magnitude;
    return this.kind === 'seisme' ? m.toFixed(1) : `${m}`;
  }

  selectKind(kind: DisasterKind): void {
    this.cancel();
    this.kind = kind;
    this.scenario = defaultScenario(kind);

    const meta = DISASTERS[kind];
    this.mag.min = String(meta.min);
    this.mag.max = String(meta.max);
    this.mag.step = String(meta.step);
    this.mag.value = String(this.scenario.magnitude);
    this.magLabel.textContent = meta.unit;
    this.magValue.textContent = this.formatMagnitude();
    this.blurb.textContent = meta.blurb;

    // Le vent ne sert qu'à l'incendie : l'afficher ailleurs laisserait croire
    // qu'il influe sur une explosion ou une crue.
    this.windField.style.display = kind === 'incendie' ? '' : 'none';
    this.wind.value = String(this.scenario.windFrom);
    this.windValue.textContent = `${this.scenario.windFrom}°`;

    for (const b of Array.from(this.kindsBox.children) as HTMLElement[]) {
      b.classList.toggle('on', b.dataset.kind === kind);
    }
    this.refresh();
  }

  /** Construit la chronologie et l'arme, sans la jouer. */
  private arm(): Timeline {
    const baseline = Object.fromEntries(DAMAGE_ORDER.map((s) => [s, 0])) as Record<
      DamageState,
      number
    >;
    for (const b of this.city.buildings) baseline[b.state]++;
    this.baseline = baseline;

    const timeline = buildTimeline(this.city, this.scenario);
    this.player.load(timeline);
    this.hooks.onArmed?.(true);
    return timeline;
  }

  /** Oublie la chronologie en cours et rend la ville à son état d'avant. */
  private disarm(): void {
    if (this.player.clear()) this.hooks.onRebuild();
    this.baseline = null;
    this.hooks.onArmed?.(false);
    this.refresh();
  }

  // ----------------------------------------------------------------------
  // Commandes
  // ----------------------------------------------------------------------

  togglePlay(): void {
    let tl = this.player.current;
    if (!tl) tl = this.arm();

    if (this.player.finished) {
      // Relancer depuis la fin : on repart du début plutôt que de ne rien faire.
      if (this.player.jumpToStart()) this.hooks.onRebuild();
    }
    this.player.playing = !this.player.playing;
    this.refresh();
  }

  jump(where: 'start' | 'end'): void {
    if (!this.player.current) this.arm();
    this.player.playing = false;
    const changed = where === 'end' ? this.player.jumpToEnd() : this.player.jumpToStart();
    if (changed) this.hooks.onRebuild();
    this.refresh();
  }

  cancel(): void {
    this.disarm();
  }

  cycleKind(delta: number): void {
    const i = (KINDS.indexOf(this.kind) + delta + KINDS.length) % KINDS.length;
    this.selectKind(KINDS[i]);
  }

  pickKind(index: number): void {
    if (index >= 0 && index < KINDS.length) this.selectKind(KINDS[index]);
  }

  /** Déplie le panneau s'il est replié. */
  open(): void {
    this.panel.classList.remove('collapsed');
  }

  // ----------------------------------------------------------------------
  // Boucle
  // ----------------------------------------------------------------------

  /** À appeler une fois par image. */
  update(dt: number): void {
    if (this.player.update(dt)) this.hooks.onRebuild();
    this.refresh();
  }

  private refresh(): void {
    const tl = this.player.current;
    const playing = this.player.playing;

    put(this.tag, !tl ? 'INACTIF' : playing ? 'EN COURS' : this.player.finished ? 'BILAN' : 'ARMÉ');
    this.tag.classList.toggle('on', !!tl && !playing);
    this.tag.classList.toggle('hot', playing);
    this.dot.className = playing ? 'dot live' : tl ? 'dot warn' : 'dot off';

    this.playBtn.textContent = playing ? 'Pause' : this.player.finished ? 'Rejouer' : 'Lancer';
    this.playBtn.classList.toggle('playing', playing);
    this.startBtn.disabled = !tl;
    this.endBtn.disabled = !tl;
    this.resetBtn.disabled = !tl;
    this.scrub.disabled = !tl;

    if (!tl) {
      this.scrub.value = '0';
      put(this.timeLabel, '0.0 s');
      put(this.ofLabel, '/ 0 s');
      this.writeTally(null);
      put(this.note, 'Choisir un aléa, puis Lancer.');
      this.note.className = 'dis-note';
      return;
    }

    const t = this.player.time;
    if (!this.scrubbing) this.scrub.value = String(Math.round((t / tl.duration) * 1000));
    put(this.timeLabel, `${t.toFixed(1)} s`);
    put(this.ofLabel, `/ ${tl.duration} s`);

    this.writeTally(this.liveCounts());

    if (playing) {
      this.note.className = 'dis-note hot';
      put(this.note, `${DISASTERS[this.kind].label} en cours…`);
    } else if (this.player.finished) {
      this.note.className = 'dis-note ok';
      put(
        this.note,
        `Bilan : ${tl.affected} bâtiment${tl.affected > 1 ? 's' : ''} touché${
          tl.affected > 1 ? 's' : ''
        } sur ${this.city.buildings.length}.`,
      );
    } else {
      this.note.className = 'dis-note';
      put(this.note, `${tl.events.length} événements prévus. Avant / Après pour comparer.`);
    }
  }

  /** Décompte des états à l'instant courant. */
  private liveCounts(): Record<DamageState, number> {
    const counts = Object.fromEntries(DAMAGE_ORDER.map((s) => [s, 0])) as Record<
      DamageState,
      number
    >;
    for (const b of this.city.buildings) counts[b.state]++;
    return counts;
  }

  private writeTally(counts: Record<DamageState, number> | null): void {
    for (const state of DAMAGE_ORDER) {
      const cell = this.cells.get(state);
      if (!cell) continue;
      if (!counts) {
        put(cell.n, '—');
        put(cell.d, '');
        continue;
      }
      put(cell.n, String(counts[state]));
      const base = this.baseline?.[state];
      const delta = base === undefined ? 0 : counts[state] - base;
      put(cell.d, delta === 0 ? '·' : delta > 0 ? `+${delta}` : `${delta}`);
    }
  }
}
