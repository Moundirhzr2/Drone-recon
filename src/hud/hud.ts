/**
 * Panneaux du HUD.
 *
 * Règle de performance qui gouverne tout ce fichier : le HUD ne se rafraîchit
 * PAS à la cadence du rendu. Réécrire une trentaine de noeuds DOM soixante fois
 * par seconde coûte plus cher que la scène 3D elle-même, pour un résultat que
 * personne ne peut lire. Tout est cadencé à 10 Hz, et on n'écrit que si la
 * valeur a changé.
 */

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

// ------------------------------------------------------------------
// Télémétrie (haut gauche)
// ------------------------------------------------------------------
export class GpsPanel {
  private rows = $('gps-rows');
  private cells = new Map<string, HTMLElement>();
  private needle = $('compass-rose');
  private deg = $('compass-deg');
  private fix = $('gps-fix');
  private modeTag = $('gps-mode');
  private batteryBar: HTMLElement | null = null;

  constructor(private home: { lon: number; lat: number }) {
    this.build();
  }

  private build(): void {
    const defs: Array<[string, string, string]> = [
      ['lat', 'LATITUDE', ''],
      ['lon', 'LONGITUDE', ''],
      ['dms', 'DMS', ''],
      ['agl', 'ALT SOL', 'm'],
      ['msl', 'ALT MER', 'm'],
      ['spd', 'VIT SOL', 'm/s'],
      ['vsi', 'VIT VERT', 'm/s'],
      ['home', 'DIST HOME', 'm'],
      ['sat', 'SATELLITES', ''],
      ['fps', 'IMAGES/S', ''],
    ];

    for (const [key, k, u] of defs) {
      const row = document.createElement('div');
      row.className = key === 'lat' || key === 'lon' ? 'row hi' : 'row';
      row.innerHTML = `<span class="k">${k}</span><span class="v" data-v="${key}">—</span><span class="u">${u}</span>`;
      this.rows.appendChild(row);
      this.cells.set(key, row.querySelector('[data-v]') as HTMLElement);
    }

    const bat = document.createElement('div');
    bat.className = 'row';
    bat.innerHTML =
      '<span class="k">BATTERIE</span><span class="bar"><i></i></span><span class="v" data-v="bat">—</span>';
    this.rows.appendChild(bat);
    this.cells.set('bat', bat.querySelector('[data-v]') as HTMLElement);
    this.batteryBar = bat.querySelector('.bar i');
  }

  update(s: DroneState, holding: boolean, fps = 0): void {
    put(this.cells.get('lat')!, s.lat.toFixed(6) + '°');
    put(this.cells.get('lon')!, s.lon.toFixed(6) + '°');
    put(this.cells.get('dms')!, `${toDMS(s.lat, 'lat')}`);
    put(this.cells.get('agl')!, s.agl.toFixed(1));
    put(this.cells.get('msl')!, s.msl.toFixed(1));
    put(this.cells.get('spd')!, this.speed(s).toFixed(1));
    put(this.cells.get('vsi')!, (s.vUp >= 0 ? '+' : '') + s.vUp.toFixed(1));
    put(
      this.cells.get('home')!,
      groundDistance(this.home.lon, this.home.lat, s.lon, s.lat).toFixed(0),
    );
    // Nombre de satellites simulé : il varie doucement pour rester crédible.
    const sats = 11 + Math.round(2 * Math.sin(s.flightTime / 9));
    put(this.cells.get('sat')!, `${sats}  ●`);

    // Cadence : verte au-dessus de 50, orange entre 30 et 50, rouge en dessous.
    const fpsCell = this.cells.get('fps')!;
    put(fpsCell, fps ? String(Math.round(fps)) : '—');
    fpsCell.style.color = fps >= 50 ? 'var(--ok)' : fps >= 30 ? 'var(--warn)' : 'var(--bad)';

    const pct = Math.round(s.battery * 100);
    put(this.cells.get('bat')!, pct + '%');
    if (this.batteryBar) {
      this.batteryBar.style.width = pct + '%';
      this.batteryBar.style.background =
        pct > 40 ? 'var(--ok)' : pct > 15 ? 'var(--warn)' : 'var(--bad)';
    }

    const hdg = Math.round(wrap360(s.heading));
    put(this.deg, String(hdg).padStart(3, '0'));
    this.needle.setAttribute('transform', `rotate(${-hdg})`);

    this.fix.className = 'dot ' + (s.battery > 0.05 ? 'live' : 'warn');
    put(this.modeTag, holding ? 'STABLE' : 'MANUEL');
    this.modeTag.className = 'tag' + (holding ? ' on' : '');
  }

  private speed(s: DroneState): number {
    return Math.hypot(s.vEast, s.vNorth);
  }
}

// ------------------------------------------------------------------
// Vue nadir (haut droite)
// ------------------------------------------------------------------
export class NadirPanel {
  private stats = $('nadir-stats');
  private modeTag = $('nadir-mode');
  private foot = $('nadir-footprint');
  private cells = new Map<string, HTMLElement>();

  constructor() {
    for (const [key, unit] of [
      ['alt', 'ALT'],
      ['gsd', 'CM/PX'],
      ['det', 'CIBLES'],
    ] as Array<[string, string]>) {
      const st = document.createElement('div');
      st.className = 'st';
      st.innerHTML = `<b data-v>—</b><span>${unit}</span>`;
      this.stats.appendChild(st);
      this.cells.set(key, st.querySelector('[data-v]') as HTMLElement);
    }
  }

  update(g: NadirGeometry | null, detections: Detection[], diagnostic: boolean): void {
    put(this.modeTag, diagnostic ? 'DIAGNOSTIC' : 'BRUT');
    this.modeTag.className = 'tag' + (diagnostic ? ' hot' : '');

    if (!g) return;
    put(this.foot, `${g.footprint.toFixed(0)} m × ${g.footprint.toFixed(0)} m`);
    put(this.cells.get('alt')!, g.agl.toFixed(0));
    put(this.cells.get('gsd')!, ((g.footprint / g.size) * 100).toFixed(1));
    put(this.cells.get('det')!, String(detections.length));
  }
}

// ------------------------------------------------------------------
// Pilotage (bas gauche)
// ------------------------------------------------------------------
export class HandsPanel {
  private dot = $('hands-dot');
  private source = $('hands-source');
  private msg = $('hands-msg');
  private stickL = $('stick-l');
  private stickR = $('stick-r');
  private msgUntil = 0;

  setMessage(text: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
    this.msg.textContent = text;
    this.msg.className = 'hands-msg' + (kind === 'info' ? '' : ' ' + kind);
    this.msgUntil = performance.now() + 4000;
  }

  update(
    ctl: { pitch: number; roll: number; yaw: number; throttle: number },
    sourceName: string,
    hands: { left: boolean; right: boolean; calibrating: boolean; hold: boolean } | null,
  ): void {
    // Manche gauche : rotation en X, altitude en Y. Manche droit : translation.
    this.place(this.stickL, ctl.yaw, ctl.throttle);
    this.place(this.stickR, ctl.roll, ctl.pitch);

    const active = hands && (hands.left || hands.right);
    put(this.source, active ? 'MAINS' : sourceName === 'clavier' ? 'CLAVIER' : 'INACTIF');
    this.source.className = 'tag' + (active ? ' on' : '');
    this.dot.className = 'dot ' + (active ? 'live' : 'off');

    if (performance.now() < this.msgUntil) return;
    if (!hands) {
      this.msg.className = 'hands-msg';
      put(this.msg, 'Mains inactives — touche H pour activer');
    } else if (hands.calibrating) {
      this.msg.className = 'hands-msg';
      put(this.msg, 'Calibrage en cours — mains au centre');
    } else if (hands.left && hands.right) {
      this.msg.className = 'hands-msg ok';
      put(this.msg, 'Deux mains — pincer à droite : photo · à gauche : diagnostic');
    } else if (hands.left || hands.right) {
      this.msg.className = 'hands-msg';
      put(this.msg, `Main ${hands.left ? 'gauche' : 'droite'} seule — axes partiels`);
    } else {
      this.msg.className = 'hands-msg err';
      put(this.msg, 'Aucune main vue — stationnaire automatique');
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

  setOpen(open: boolean): void {
    this.panel.classList.toggle('collapsed', !open);
  }

  update(detections: Detection[], metrics: Metrics, buildings: Building[]): void {
    put(this.count, String(detections.length));

    // On ne reconstruit la liste que si son contenu a réellement changé.
    const signature =
      detections.map((d) => `${d.buildingId}:${d.predicted}:${d.score.toFixed(2)}`).join('|') +
      `#${metrics.precision ?? -1}`;
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
      : '<div class="dl"><span class="nm" style="color:var(--ink-dim)">Aucune cible dans le cadre</span></div>';

    this.body.innerHTML = `
      <div class="dmg-legend">${legend}</div>
      ${list}
      <div class="metrics">
        <div class="m"><span>PRÉCISION</span><b>${pct(metrics.precision)}</b></div>
        <div class="m"><span>RAPPEL</span><b>${pct(metrics.recall)}</b></div>
        <div class="m"><span>CLASSE OK</span><b>${pct(metrics.classAccuracy)}</b></div>
        <div class="m"><span>MANQUÉS</span><b>${metrics.falseNegatives}</b></div>
      </div>`;
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
    el.title = `${photo.id} — ${photo.agl.toFixed(0)} m — ${photo.detections.length} cible(s)`;
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
        <dt>HORODATAGE</dt><dd>${photo.at.toLocaleString('fr-FR')}</dd>
        <dt>POSITION</dt><dd>${photo.geometry.lat.toFixed(6)}, ${photo.geometry.lon.toFixed(6)}</dd>
        <dt>ALTITUDE SOL</dt><dd>${photo.agl.toFixed(1)} m</dd>
        <dt>CAP</dt><dd>${photo.heading.toFixed(0)}°</dd>
        <dt>EMPRISE AU SOL</dt><dd>${photo.geometry.footprint.toFixed(1)} m × ${photo.geometry.footprint.toFixed(1)} m</dd>
        <dt>RÉSOLUTION</dt><dd>${photo.gsd.toFixed(1)} cm/pixel</dd>
      </dl>
      <table><tr><th>ID</th><th>ADRESSE</th><th>CLASSE</th><th>SCORE</th><th>DIST</th></tr>${rows}</table>
    </div>`);
  w.document.close();
}

// ------------------------------------------------------------------
// Bandeau de commandes et écran de chargement
// ------------------------------------------------------------------
export function buildKeymap(): void {
  const keys: Array<[string, string]> = [
    ['Z Q S D', 'déplacer'],
    ['↑ ↓', 'altitude'],
    ['← →', 'rotation'],
    ['ESPACE', 'photo'],
    ['V', 'diagnostic'],
    ['M', 'rendu'],
    ['C', 'caméra'],
    ['H', 'mains'],
    ['K', 'calibrer'],
    ['MAJ', 'stabiliser'],
    ['R', 'retour base'],
    ['1-4', 'aléa'],
    ['P', 'lancer'],
    ['B / N', 'avant / après'],
  ];
  $('keymap').innerHTML = keys
    .map(([k, v]) => `<div class="km"><kbd>${k}</kbd>${v}</div>`)
    .join('');
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
