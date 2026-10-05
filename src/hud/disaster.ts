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
 *
 * Un scénario, c'est un aléa — ou aucun — plus des dégâts posés à la main sur
 * des bâtiments choisis (`editor.ts`, `disaster/manual.ts`). Le panneau en
 * construit une seule chronologie, et sait l'enregistrer en JSON et la
 * recharger (`disaster/scenarioFile.ts`).
 */

import { DAMAGE_INFO, DAMAGE_ORDER, type DamageState } from '../world/buildings';
import type { City } from '../world/city';
import { DISASTERS, defaultScenario, type DisasterKind, type Scenario } from '../disaster/scenario';
import { buildTimeline, type Timeline } from '../disaster/timeline';
import type { DisasterPlayer } from '../disaster/timeline';
import { withManualEdits, type ManualEdits } from '../disaster/manual';
import {
  parseScenarioFile,
  toScenarioFile,
  type ParsedScenario,
  type ScenarioFile,
  type Viewpoint,
} from '../disaster/scenarioFile';

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
  /** Appelé quand le scénario est annulé ou remplacé : la sélection n'a plus de sens. */
  onCleared?: () => void;
}

export class DisasterPanel {
  private panel = $('hud-disaster');
  private title = $('disaster-title');
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

  /** L'aléa choisi ; `null` : aucun, seulement des dégâts posés à la main. */
  private kind: DisasterKind | null = 'seisme';
  private scenario: Scenario = defaultScenario('seisme');
  /** Dégâts posés à la main, ajoutés à l'aléa. */
  private edits: ManualEdits = new Map();
  private magField = this.mag.closest('.dis-field') as HTMLElement;
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
    const none = document.createElement('button');
    none.className = 'dis-kind';
    none.dataset.kind = '';
    none.textContent = 'No hazard';
    none.title = 'Only damage set by hand (E key)';
    none.addEventListener('click', () => this.selectKind(null));
    this.kindsBox.appendChild(none);
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

  /**
   * Choisit l'aléa, ou aucun. Les dégâts posés à la main sont gardés : on peut
   * changer d'aléa sous eux.
   */
  selectKind(kind: DisasterKind | null): void {
    this.disarm();
    this.kind = kind;
    for (const b of Array.from(this.kindsBox.children) as HTMLElement[]) {
      b.classList.toggle('on', b.dataset.kind === (kind ?? ''));
    }
    if (!kind) {
      this.magField.style.display = 'none';
      this.windField.style.display = 'none';
      this.blurb.textContent = 'No hazard: only damage set by hand. Press E, then click buildings.';
      this.refresh();
      return;
    }
    this.magField.style.display = '';
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
    this.refresh();
  }

  /**
   * Prépare un scénario précis — foyer, intensité, vent, tirage — au lieu des
   * réglages par défaut de son aléa. Sert aux campagnes de prise de vue.
   */
  useScenario(scenario: Scenario): void {
    this.selectKind(scenario.kind);
    this.scenario = { ...scenario };
    this.mag.value = String(scenario.magnitude);
    this.magValue.textContent = this.formatMagnitude();
    this.wind.value = String(scenario.windFrom);
    this.windValue.textContent = `${scenario.windFrom}°`;
    this.refresh();
  }

  /**
   * Construit la chronologie — l'aléa, puis les dégâts posés à la main — et
   * l'arme, sans la jouer. `null` s'il n'y a ni aléa ni dégât.
   */
  private arm(): Timeline | null {
    const baseline = Object.fromEntries(DAMAGE_ORDER.map((s) => [s, 0])) as Record<
      DamageState,
      number
    >;
    for (const b of this.city.buildings) baseline[b.state]++;
    this.baseline = baseline;

    const base = this.kind ? buildTimeline(this.city, this.scenario) : null;
    const timeline = withManualEdits(this.city, base, this.edits);
    if (!timeline) {
      this.baseline = null;
      return null;
    }
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
    const tl = this.player.current ?? this.arm();
    if (!tl) return;

    if (this.player.finished) {
      // Relancer depuis la fin : on repart du début plutôt que de ne rien faire.
      if (this.player.jumpToStart()) this.hooks.onRebuild();
    }
    this.player.playing = !this.player.playing;
    this.refresh();
  }

  jump(where: 'start' | 'end'): void {
    if (!this.player.current && !this.arm()) return;
    this.player.playing = false;
    const changed = where === 'end' ? this.player.jumpToEnd() : this.player.jumpToStart();
    if (changed) this.hooks.onRebuild();
    this.refresh();
  }

  /** Annule tout : l'aléa et les dégâts posés à la main. La ville redevient intacte. */
  cancel(): void {
    this.edits.clear();
    this.disarm();
    this.hooks.onCleared?.();
  }

  cycleKind(delta: number): void {
    const from = this.kind ? KINDS.indexOf(this.kind) : -1;
    const i = (from + delta + KINDS.length) % KINDS.length;
    this.selectKind(KINDS[i]);
  }

  // ----------------------------------------------------------------------
  // Dégâts posés à la main, et fichiers de scénario
  // ----------------------------------------------------------------------

  /** Nombre de bâtiments touchés à la main. */
  get editCount(): number {
    return this.edits.size;
  }

  /**
   * Pose un état sur des bâtiments, puis montre le résultat (vue « après »).
   * Sans aléa armé, ce sont des dégâts à la main seuls : on ne déclenche pas
   * l'aléa resté sélectionné dans le panneau.
   */
  applyEdits(ids: string[], state: DamageState): void {
    if (!ids.length) return;
    if (!this.player.current && this.kind) this.selectKind(null);
    for (const id of ids) {
      // Sans aléa, « intact » revient à retirer le dégât posé ; avec un aléa,
      // c'est une réparation qui l'emporte sur lui.
      if (state === 'intact' && !this.kind) this.edits.delete(id);
      else this.edits.set(id, state);
    }
    this.disarm();
    if (this.kind || this.edits.size) this.jump('end');
  }

  /** Le scénario en cours, prêt à être enregistré. */
  exportScenario(name: string, viewpoint?: Viewpoint, description?: string): ScenarioFile {
    const hazard = this.kind ? this.scenario : null;
    return toScenarioFile(this.city, name, hazard, this.edits, viewpoint, description);
  }

  /**
   * Charge un scénario lu dans un fichier et montre son état final.
   * @throws Error avec un message lisible si le fichier n'est pas valide.
   */
  importScenario(text: string): ParsedScenario {
    const parsed = parseScenarioFile(text, this.city);
    this.cancel();
    if (parsed.file.hazard) this.useScenario(parsed.file.hazard);
    else this.selectKind(null);
    this.edits = new Map(parsed.edits);
    this.open();
    this.jump('end');
    return parsed;
  }

  pickKind(index: number): void {
    if (index >= 0 && index < KINDS.length) this.selectKind(KINDS[index]);
  }

  /** Place la lecture à un instant donné, sans la lancer. */
  seek(t: number): void {
    if (this.player.seek(t)) this.hooks.onRebuild();
    this.refresh();
  }

  /** Le sinistre en cours, en une ligne : le sous-titre d'une capture avant / après. */
  /** Le sinistre en une ligne, pour l'en-tête : « EARTHQUAKE · EMS-98 7 ». */
  private headline(scenario: Scenario | null): string {
    const n = this.edits.size;
    if (!scenario) return n ? `MANUAL DAMAGE · ${n}` : 'SIMULATOR';
    const m = scenario.magnitude.toLocaleString('en-GB');
    const amount: Record<DisasterKind, string> = {
      seisme: `EMS-98 ${m}`,
      explosion: `${m} t TNT`,
      inondation: `${m} m`,
      incendie: `STRENGTH ${m}`,
    };
    const hazard = `${DISASTERS[scenario.kind].label.toUpperCase()} · ${amount[scenario.kind]}`;
    return n ? `${hazard} + ${n} BY HAND` : hazard;
  }

  describe(): string {
    const parts: string[] = [];
    if (this.kind) {
      const meta = DISASTERS[this.kind];
      parts.push(
        `${meta.label} · ${meta.unit}: ${this.scenario.magnitude.toLocaleString('en-GB')}`,
      );
    }
    const n = this.edits.size;
    if (n) parts.push(`${n} building${n > 1 ? 's' : ''} damaged by hand`);
    return parts.join(' + ') || 'Disaster';
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

    // Dès qu'un sinistre est armé, l'en-tête dit lequel, plutôt que SIMULATOR.
    put(this.title, tl ? this.headline(tl.scenario) : 'SIMULATOR');
    this.title.classList.toggle('armed', !!tl);
    put(this.tag, !tl ? 'IDLE' : playing ? 'RUNNING' : this.player.finished ? 'RESULT' : 'ARMED');
    this.tag.classList.toggle('on', !!tl && !playing);
    this.tag.classList.toggle('hot', playing);
    this.dot.className = playing ? 'dot live' : tl ? 'dot warn' : 'dot off';

    this.playBtn.textContent = playing ? 'Pause' : this.player.finished ? 'Replay' : 'Start';
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
      const n = this.edits.size;
      put(
        this.note,
        n
          ? `${n} building${n > 1 ? 's' : ''} damaged by hand. Start, or After to see.`
          : this.kind
            ? 'Choose a hazard, then Start.'
            : 'Press E, then click the buildings to damage.',
      );
      this.note.className = 'dis-note';
      return;
    }

    const t = this.player.time;
    if (!this.scrubbing) this.scrub.value = String(Math.round((t / tl.duration) * 1000));
    put(this.timeLabel, `${t.toFixed(1)} s`);
    // Une durée posée à la main n’est pas ronde (3,75 s) : même arrondi que le temps.
    put(
      this.ofLabel,
      `/ ${Number.isInteger(tl.duration) ? tl.duration : tl.duration.toFixed(1)} s`,
    );

    this.writeTally(this.liveCounts());

    if (playing) {
      this.note.className = 'dis-note hot';
      put(this.note, `${this.kind ? DISASTERS[this.kind].label : 'Disaster'} in progress…`);
    } else if (this.player.finished) {
      this.note.className = 'dis-note ok';
      const byHand = this.edits.size ? `, ${this.edits.size} of them by hand` : '';
      put(
        this.note,
        `Result: ${tl.affected} building${tl.affected > 1 ? 's' : ''} hit out of ${
          this.city.buildings.length
        }${byHand}.`,
      );
    } else {
      this.note.className = 'dis-note';
      put(this.note, `${tl.events.length} events planned. Before / After to compare.`);
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
