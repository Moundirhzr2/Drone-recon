/**
 * Panneaux du HUD.
 *
 * Règle de performance qui gouverne tout ce fichier : le HUD ne se rafraîchit
 * PAS à la cadence du rendu. Réécrire une trentaine de noeuds DOM soixante fois
 * par seconde coûte plus cher que la scène 3D elle-même, pour un résultat que
 * personne ne peut lire. Tout est cadencé à 10 Hz, et on n'écrit que si la
 * valeur a changé.
 */

import { emit } from '../core/bus';
import { CONFIG } from '../core/config';
import { toDMS, groundDistance, wrap360 } from '../core/math';
import { DAMAGE_INFO, DAMAGE_ORDER, type Building, type DamageState } from '../world/buildings';
import type { DroneState } from '../drone/drone';
import type { Metrics, Detection } from '../diagnostic/detector';
import type { Photo } from '../drone/photo';
import type { NadirGeometry } from '../drone/nadir';
import { RENDER_LABEL, type RenderMode } from '../world/render';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Pourcentage, ou tiret quand la métrique n'est pas définie.
 * Un cadre sans cible ne vaut pas 100 % : il ne vaut rien du tout.
 */
function pct(v: number | null): string {
  return v === null ? '<span style="color:var(--ink-dim)">—</span>' : `${(v * 100).toFixed(0)}%`;
}

/** Écrit dans un noeud seulement si le texte a changé. */
function put(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Texte libre inséré dans du HTML : un message d'erreur peut contenir des chevrons. */
function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  };
  return text.replace(/[&<>"]/g, (c) => entities[c]);
}

// ------------------------------------------------------------------
// Télémétrie (haut gauche)
// ------------------------------------------------------------------
/**
 * Quatre valeurs à l'écran — altitude, vitesse, cap, batterie — et la
 * position sur une ligne. Le reste se déplie d'un clic sur l'en-tête : en vol,
 * on ne lit que celles-là, et douze lignes ensemble se lisaient mal.
 */
export class GpsPanel {
  private panel = $('hud-gps');
  private rows = $('gps-rows');
  private cells = new Map<string, HTMLElement>();
  private needle = $('compass-rose');
  private deg = $('compass-deg');
  private fix = $('gps-fix');
  private modeTag = $('gps-mode');
  private alert = $('gps-alert');
  private batteryBar = $('gps-battery');

  constructor(private home: { lon: number; lat: number }) {
    this.build();
    $('gps-header').addEventListener('click', () => {
      this.rows.hidden = !this.panel.classList.toggle('open');
    });
  }

  private build(): void {
    // Les valeurs principales sont dans la page ; le détail se construit ici.
    for (const el of this.panel.querySelectorAll<HTMLElement>('[data-v]')) {
      this.cells.set(el.dataset.v ?? '', el);
    }
    const defs: Array<[string, string, string]> = [
      ['msl', 'ALT MSL', 'm'],
      ['clr', 'CLEARANCE', 'm'],
      ['vsi', 'VERT SPEED', 'm/s'],
      ['dms', 'DMS', ''],
      ['sat', 'SATELLITES', ''],
      ['fps', 'FRAMES/S', ''],
    ];
    for (const [key, k, u] of defs) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="k">${k}</span><span class="v" data-v="${key}">—</span><span class="u">${u}</span>`;
      this.rows.appendChild(row);
      this.cells.set(key, row.querySelector('[data-v]') as HTMLElement);
    }
  }

  update(s: DroneState, holding: boolean, fps = 0): void {
    put(this.cells.get('agl')!, s.agl.toFixed(1));
    put(this.cells.get('spd')!, this.speed(s).toFixed(1));
    const lat = `${Math.abs(s.lat).toFixed(6)}° ${s.lat >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(s.lon).toFixed(6)}° ${s.lon >= 0 ? 'E' : 'W'}`;
    put(this.cells.get('pos')!, `${lat} · ${lon}`);
    put(
      this.cells.get('home')!,
      groundDistance(this.home.lon, this.home.lat, s.lon, s.lat).toFixed(0),
    );

    // Hauteur des pieds au-dessus de ce qui est dessous : sol, toit ou gravats.
    const clearance = Math.max(0, s.msl - CONFIG.drone.minAGL - s.floor);
    const low = !s.landed && clearance < 2;
    const clrCell = this.cells.get('clr')!;
    put(clrCell, clearance.toFixed(1));
    clrCell.style.color = low ? 'var(--warn)' : '';
    // Trop près d'un obstacle : la seule valeur du détail qui s'affiche seule.
    if (this.alert.hidden === low) this.alert.hidden = !low;
    if (low) put(this.alert, `CLEARANCE ${clearance.toFixed(1)} m`);

    put(this.cells.get('msl')!, s.msl.toFixed(1));
    put(this.cells.get('vsi')!, (s.vUp >= 0 ? '+' : '') + s.vUp.toFixed(1));
    put(this.cells.get('dms')!, `${toDMS(s.lat, 'lat')}`);
    // Nombre de satellites simulé : il varie doucement pour rester crédible.
    const sats = 11 + Math.round(2 * Math.sin(s.flightTime / 9));
    put(this.cells.get('sat')!, `${sats}  ●`);

    // Cadence : verte au-dessus de 50, orange entre 30 et 50, rouge en dessous.
    const fpsCell = this.cells.get('fps')!;
    put(fpsCell, fps ? String(Math.round(fps)) : '—');
    fpsCell.style.color = fps >= 50 ? 'var(--ok)' : fps >= 30 ? 'var(--warn)' : 'var(--bad)';

    const pct = Math.round(s.battery * 100);
    put(this.cells.get('bat')!, pct + '%');
    this.batteryBar.style.width = pct + '%';
    this.batteryBar.style.background =
      pct > 40 ? 'var(--ok)' : pct > 15 ? 'var(--warn)' : 'var(--bad)';

    const hdg = Math.round(wrap360(s.heading));
    put(this.deg, String(hdg).padStart(3, '0'));
    this.needle.setAttribute('transform', `rotate(${-hdg})`);

    this.fix.className = 'dot ' + (s.battery > 0.05 ? 'live' : 'warn');
    put(this.modeTag, s.landed ? 'LANDED' : holding ? 'HOLD' : 'MANUAL');
    this.modeTag.className = 'tag' + (s.landed || holding ? ' on' : '');
  }

  private speed(s: DroneState): number {
    return Math.hypot(s.vEast, s.vNorth);
  }
}

// ------------------------------------------------------------------
// Vue nadir (haut droite)
// ------------------------------------------------------------------
export type NadirViewMode = 'brut' | 'diagnostic' | 'modele';

const NADIR_TAG: Record<NadirViewMode, string> = {
  brut: 'RAW',
  diagnostic: 'DIAGNOSTIC',
  modele: 'MODEL',
};

export class NadirPanel {
  private modeTag = $('nadir-mode');
  private foot = $('nadir-footprint');

  /**
   * L'emprise et la résolution s'écrivent dans l'image : la hauteur est déjà
   * dans la télémétrie, et le nombre de cibles dans le rapport de diagnostic.
   *
   * @param view ce que montre la vignette : l'image seule, le diagnostic simulé ou le modèle.
   */
  update(g: NadirGeometry | null, view: NadirViewMode): void {
    put(this.modeTag, NADIR_TAG[view]);
    this.modeTag.className =
      'tag' + (view === 'diagnostic' ? ' hot' : view === 'modele' ? ' on' : '');

    if (!g) return;
    const side = g.footprint.toFixed(0);
    const gsd = ((g.footprint / g.size) * 100).toFixed(1);
    put(this.foot, `${side} m × ${side} m · ${gsd} cm/px`);
  }
}

// ------------------------------------------------------------------
// Pilotage (bas gauche)
// ------------------------------------------------------------------
/**
 * Sans suivi des mains, le panneau se replie en une pastille : le cadre noir
 * de la webcam et les deux manches vides n'avaient rien à montrer. Il se
 * déplie dès que les mains prennent la main (touche H, ou clic sur la pastille).
 *
 * Les messages passagers — prise de vue, changement de vue, erreurs — ont
 * quitté ce panneau pour un bandeau au-dessus des raccourcis : sa ligne ne dit
 * plus que l'état des mains.
 */
export class HandsPanel {
  private panel = $('hud-hands');
  private dot = $('hands-dot');
  private source = $('hands-source');
  private msg = $('hands-msg');
  private toast = $('toast');
  private stickL = $('stick-l');
  private stickR = $('stick-r');
  private toastTimer = 0;

  constructor() {
    const pill = $<HTMLButtonElement>('hands-pill');
    pill.addEventListener('click', () => {
      // Comme pour l'œil : ESPACE, qui prend les photos, ne doit pas le redéclencher.
      pill.blur();
      emit('hands:toggle');
    });
  }

  /** Message passager, quatre secondes au-dessus des raccourcis. */
  setMessage(text: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
    this.toast.textContent = text;
    this.toast.className = 'panel show' + (kind === 'info' ? '' : ' ' + kind);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 4000);
  }

  update(
    ctl: { pitch: number; roll: number; yaw: number; throttle: number },
    sourceName: string,
    hands: { left: boolean; right: boolean; calibrating: boolean; hold: boolean } | null,
  ): void {
    const off = !hands;
    if (this.panel.classList.contains('off') !== off) this.panel.classList.toggle('off', off);

    // Manche gauche : rotation en X, altitude en Y. Manche droit : translation.
    this.place(this.stickL, ctl.yaw, ctl.throttle);
    this.place(this.stickR, ctl.roll, ctl.pitch);

    const active = hands && (hands.left || hands.right);
    put(this.source, active ? 'HANDS' : sourceName === 'clavier' ? 'KEYBOARD' : 'IDLE');
    this.source.className = 'tag' + (active ? ' on' : '');
    this.dot.className = 'dot ' + (active ? 'live' : 'off');

    // Repliée, la pastille dit tout : « Hand control off ».
    if (!hands) {
      put(this.msg, '');
    } else if (hands.calibrating) {
      this.msg.className = 'hands-msg';
      put(this.msg, 'Calibrating — hands in the centre');
    } else if (hands.left && hands.right) {
      this.msg.className = 'hands-msg ok';
      put(this.msg, 'Both hands — right pinch: photo · left pinch: diagnostic');
    } else if (hands.left || hands.right) {
      this.msg.className = 'hands-msg';
      put(this.msg, `${hands.left ? 'Left' : 'Right'} hand only — partial axes`);
    } else {
      this.msg.className = 'hands-msg err';
      put(this.msg, 'No hand seen — automatic hover');
    }
  }

  private place(knob: HTMLElement, x: number, y: number): void {
    // Le manche se déplace dans un carré de ±38 % autour du centre.
    knob.style.left = `${50 + x * 38}%`;
    knob.style.top = `${50 - y * 38}%`;
    knob.style.background = Math.hypot(x, y) > 0.05 ? 'var(--accent)' : 'var(--ink-dim)';
  }
}

// ------------------------------------------------------------------
// Rapport de diagnostic (bas droite)
// ------------------------------------------------------------------
export class ReportPanel {
  private panel = $('hud-report');
  private body = $('report-body');
  private count = $('report-count');
  private lastSignature = '';

  constructor() {
    $('report-header').addEventListener('click', () => {
      this.panel.classList.toggle('collapsed');
    });
  }

  /** Sans diagnostic (V) ni modèle (O), le panneau n'a rien à dire : il disparaît. */
  setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.panel.classList.toggle('collapsed', !open);
  }

  /** @param note texte affiché sous les mesures : d'où viennent les détections, et leurs limites. */
  update(detections: Detection[], metrics: Metrics, buildings: Building[], note = ''): void {
    put(this.count, String(detections.length));

    // On ne reconstruit la liste que si son contenu a réellement changé.
    const signature =
      detections.map((d) => `${d.buildingId}:${d.predicted}:${d.score.toFixed(2)}`).join('|') +
      `#${metrics.precision ?? -1}#${note}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    // Répartition globale du bâti par état réel.
    const tally: Record<DamageState, number> = {
      intact: 0,
      cracked: 0,
      partial: 0,
      collapsed: 0,
      burnt: 0,
    };
    for (const b of buildings) tally[b.state]++;

    const legend = DAMAGE_ORDER.map((s) => {
      const info = DAMAGE_INFO[s];
      return `<div class="lg" style="background:${info.color}22;color:${info.color}">
        <b>${tally[s]}</b>${info.short}</div>`;
    }).join('');

    const list = detections.length
      ? detections
          .map((d) => {
            const info = DAMAGE_INFO[d.predicted];
            const flag = d.falsePositive ? ' <span style="color:var(--bad)">FP</span>' : '';
            return `<div class="dl">
              <span class="sw" style="background:${info.color}"></span>
              <span class="nm">${d.name}${flag}</span>
              <span class="sc">${d.distance.toFixed(0)}m</span>
              <span class="sc" style="color:${info.color}">${(d.score * 100).toFixed(0)}%</span>
            </div>`;
          })
          .join('')
      : '<div class="dl"><span class="nm" style="color:var(--ink-dim)">No target in frame</span></div>';

    this.body.innerHTML = `
      <div class="dmg-legend">${legend}</div>
      ${list}
      <div class="metrics">
        <div class="m"><span>PRECISION</span><b>${pct(metrics.precision)}</b></div>
        <div class="m"><span>RECALL</span><b>${pct(metrics.recall)}</b></div>
        <div class="m"><span>CLASS OK</span><b>${pct(metrics.classAccuracy)}</b></div>
        <div class="m"><span>MISSED</span><b>${metrics.falseNegatives}</b></div>
      </div>
      ${note ? `<p class="report-note">${escapeHtml(note)}</p>` : ''}`;
  }
}

// ------------------------------------------------------------------
// Galerie de prises de vue
// ------------------------------------------------------------------
export class Gallery {
  private strip = $('gallery-strip');

  add(photo: Photo): void {
    const el = document.createElement('div');
    el.className = 'shot';
    el.title = `${photo.id} — ${photo.agl.toFixed(0)} m — ${photo.detections.length} target(s)`;
    el.innerHTML = `<img src="${photo.dataUrl}" alt="${photo.id}"><b>${photo.detections.length}</b>`;
    el.addEventListener('click', () => openPhoto(photo));
    this.strip.prepend(el);
    while (this.strip.children.length > 24) this.strip.lastChild?.remove();
  }
}

/** Ouvre une prise de vue en grand, dans un nouvel onglet. */
function openPhoto(photo: Photo): void {
  const w = window.open('', '_blank');
  if (!w) return;
  const rows = photo.detections
    .map(
      (d) =>
        `<tr><td>${d.buildingId}</td><td>${d.name}</td><td style="color:${DAMAGE_INFO[d.predicted].color}">${DAMAGE_INFO[d.predicted].label}</td><td>${(d.score * 100).toFixed(0)}%</td><td>${d.distance.toFixed(0)} m</td></tr>`,
    )
    .join('');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${photo.id}</title>
    <style>
      body{background:#04070b;color:#cdefff;font-family:ui-monospace,monospace;padding:24px;display:flex;gap:24px;flex-wrap:wrap}
      img{max-width:620px;border:1px solid #00e5ff44}
      table{border-collapse:collapse;font-size:12px}
      td,th{padding:4px 10px;border-bottom:1px solid #ffffff18;text-align:left}
      h1{font-size:16px;letter-spacing:.2em;color:#00e5ff;font-weight:400}
      dt{color:#6d8b9c;font-size:11px}dd{margin:0 0 8px;font-size:13px}
    </style>
    <div><h1>${photo.id}</h1><img src="${photo.dataUrl}"></div>
    <div>
      <dl>
        <dt>TIMESTAMP</dt><dd>${photo.at.toLocaleString('en-GB')}</dd>
        <dt>POSITION</dt><dd>${photo.geometry.lat.toFixed(6)}, ${photo.geometry.lon.toFixed(6)}</dd>
        <dt>ALTITUDE AGL</dt><dd>${photo.agl.toFixed(1)} m</dd>
        <dt>HEADING</dt><dd>${photo.heading.toFixed(0)}°</dd>
        <dt>GROUND FOOTPRINT</dt><dd>${photo.geometry.footprint.toFixed(1)} m × ${photo.geometry.footprint.toFixed(1)} m</dd>
        <dt>RESOLUTION</dt><dd>${photo.gsd.toFixed(1)} cm/pixel</dd>
      </dl>
      <table><tr><th>ID</th><th>ADDRESS</th><th>CLASS</th><th>SCORE</th><th>DIST</th></tr>${rows}</table>
    </div>`);
  w.document.close();
}

// ------------------------------------------------------------------
// Interface masquée
// ------------------------------------------------------------------
/**
 * Masque toute l'interface pour ne garder que la vue 3D : une capture d'écran,
 * une présentation, ou simplement la ville en entier. Seul le bouton reste
 * affiché, à la même place, pour la faire revenir.
 *
 * `visibility: hidden` plutôt que `display: none` : les panneaux gardent leur
 * mise en page, donc leurs dimensions, mais ne reçoivent plus ni clic ni focus.
 */
export class HudToggle {
  private readonly button = $<HTMLButtonElement>('hud-toggle');
  private hidden = false;

  constructor() {
    this.button.addEventListener('click', () => {
      // Le bouton ne garde pas le focus : ESPACE, qui prend les photos, le
      // déclencherait de nouveau.
      this.button.blur();
      emit('view:toggle-hud');
    });
    this.render();
  }

  toggle(): void {
    this.hidden = !this.hidden;
    this.render();
  }

  private render(): void {
    document.body.classList.toggle('hud-hidden', this.hidden);
    const label = this.hidden ? 'Show the interface (I)' : 'Hide the interface (I)';
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-pressed', String(this.hidden));
  }
}

// ------------------------------------------------------------------
// Qualité d'image
// ------------------------------------------------------------------
/**
 * Bouton HD, à droite de l'œil. Il passe à l'orange quand le régulateur a
 * baissé la qualité pour garder la cadence ; un appui la rétablit et la fixe,
 * un second rend la main au régulateur.
 */
export class QualityButton {
  private readonly button = $<HTMLButtonElement>('quality-toggle');
  private state = '';

  constructor() {
    this.button.addEventListener('click', () => {
      // Même raison que pour l'œil : ESPACE ne doit pas le redéclencher.
      this.button.blur();
      emit('view:toggle-quality');
    });
    this.update(false, false);
  }

  /** Reflète l'état du régulateur ; n'écrit dans la page qu'au changement. */
  update(fixed: boolean, degraded: boolean): void {
    const state = fixed ? 'fixed' : degraded ? 'degraded' : 'auto';
    if (state === this.state) return;
    this.state = state;
    this.button.dataset.state = state;
    const label = fixed
      ? 'Quality locked — hand back to the governor (F)'
      : degraded
        ? 'Quality lowered to stay smooth — restore it (F)'
        : 'Lock full quality (F)';
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-pressed', String(fixed));
  }
}

// ------------------------------------------------------------------
// Raccourcis, aide du clavier et écran de chargement
// ------------------------------------------------------------------
/**
 * Les gestes du vol et de la capture : les seuls toujours affichés. Les
 * optionnels disparaissent sur un écran étroit ; tout reste dans l'aide.
 */
const HINTS: Array<{ keys: string[]; label: string; optional?: boolean }> = [
  { keys: ['Z Q S D'], label: 'move' },
  { keys: ['↑ ↓'], label: 'altitude', optional: true },
  { keys: ['← →'], label: 'yaw', optional: true },
  { keys: ['SPACE'], label: 'capture' },
  { keys: ['SHIFT', 'SPACE'], label: 'before / after' },
];

/** Toutes les touches, rangées par usage, pour l'aide (touche ?). */
const KEY_GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    'FLIGHT',
    [
      ['Z Q S D', 'move'],
      ['↑ ↓', 'altitude'],
      ['← →', 'yaw'],
      ['SHIFT', 'hold position'],
      ['R', 'return home'],
    ],
  ],
  [
    'CAMERA & CAPTURE',
    [
      ['C', 'follow / onboard'],
      ['T', 'nadir view'],
      ['SPACE', 'capture'],
      ['SHIFT SPACE', 'before / after'],
      ['V', 'diagnostic'],
      ['O', 'trained model'],
    ],
  ],
  [
    'DISASTER',
    [
      ['1 – 4', 'hazard'],
      ['P', 'start / pause'],
      ['B', 'before'],
      ['N', 'after'],
      ['E', 'manual damage'],
      ['BACKSPACE', 'cancel'],
    ],
  ],
  [
    'DISPLAY & DATA',
    [
      ['M', 'render'],
      ['F', 'quality'],
      ['I', 'interface'],
      ['H', 'hands'],
      ['K', 'calibrate'],
      ['J', 'dataset'],
      ['SHIFT J', 'varied dataset'],
    ],
  ],
];

/**
 * Raccourcis et aide du clavier. Vingt-deux touches affichées en permanence
 * faisaient un mur de texte au bas de l'écran ; la ligne n'en garde que cinq,
 * et « ? » ouvre les autres, rangées en quatre groupes.
 */
export class KeyHelp {
  private box = $('keys-help');
  private more = document.createElement('button');

  constructor() {
    const bar = $('keymap');
    bar.innerHTML = HINTS.map(
      (h) =>
        `<div class="km${h.optional ? ' opt' : ''}">${h.keys.map((k) => `<kbd>${k}</kbd>`).join(' ')}${h.label}</div>`,
    ).join('');
    this.more.type = 'button';
    this.more.className = 'km km-more';
    this.more.title = 'All keys (?)';
    this.more.innerHTML = '<kbd>?</kbd>all keys';
    this.more.addEventListener('click', () => {
      // ESPACE, qui prend les photos, ne doit pas le redéclencher.
      this.more.blur();
      this.toggle();
    });
    bar.appendChild(this.more);

    const columns = KEY_GROUPS.map(
      ([title, keys]) =>
        `<div class="keys-col"><h3>${escapeHtml(title)}</h3><ul>${keys
          .map(([k, v]) => `<li><kbd>${k}</kbd><span>${v}</span></li>`)
          .join('')}</ul></div>`,
    ).join('');
    this.box.innerHTML = `<section class="panel" role="dialog" aria-label="Keyboard">
      <header><span class="dot live"></span> KEYBOARD<span class="spacer"></span>
        <span class="close-hint"><kbd>?</kbd>or<kbd>ESC</kbd>to close</span></header>
      <div class="keys-cols">${columns}</div>
    </section>`;
    // Un clic à côté du panneau le ferme, comme Échap.
    this.box.addEventListener('click', (e) => {
      if (e.target === this.box) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.box.hidden) this.close();
    });
  }

  toggle(): void {
    this.show(this.box.hidden);
  }

  close(): void {
    this.show(false);
  }

  private show(open: boolean): void {
    this.box.hidden = !open;
    this.more.classList.toggle('on', open);
  }
}

export const boot = {
  set(msg: string, pct: number): void {
    put($('boot-msg'), msg);
    $('boot-bar').style.width = `${Math.round(pct * 100)}%`;
  },
  hide(): void {
    $('boot').classList.add('gone');
  },
};

/** Flash d'obturateur. */
/**
 * Bandeau d'alerte : le navigateur calcule la 3D sans carte graphique.
 *
 * C'est un bandeau persistant et non un message du panneau de pilotage, pour
 * deux raisons. Ce panneau est réécrit dès le démarrage (« Prêt au décollage »)
 * et l'alerte y durerait moins d'une seconde. Et en rendu logiciel, le
 * simulateur est inutilisable quoi qu'on fasse : c'est la première chose que
 * l'utilisateur doit savoir, pas un détail à repérer au passage.
 */
export function showSoftwareRenderingWarning(renderer: string): void {
  let el = document.getElementById('gpu-warning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gpu-warning';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }

  el.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = 'Software rendering: the 3D is computed by the CPU, not the graphics card.';

  const fix = document.createElement('p');
  fix.textContent =
    'The simulator will be very slow. Turn on "Use graphics acceleration" in ' +
    'chrome://settings/system, then restart the browser. On a laptop with two ' +
    'graphics cards, also assign the browser to the dedicated one: Windows ' +
    'Settings → System → Display → Graphics.';

  const detail = document.createElement('small');
  detail.textContent = `Detected renderer: ${renderer}`;

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Hide';
  close.setAttribute('aria-label', 'Hide the alert');
  close.addEventListener('click', () => el?.remove());

  el.append(close, title, fix, detail);
}

export function flashShutter(): void {
  const el = $('shutter');
  el.classList.remove('fire');
  // Forcer un reflow relance l'animation même sur deux photos rapprochées.
  void el.offsetWidth;
  el.classList.add('fire');
}

/** Étiquette du mode de rendu, affichée dans le bandeau nadir. */
export function renderModeLabel(mode: RenderMode): string {
  return RENDER_LABEL[mode];
}
