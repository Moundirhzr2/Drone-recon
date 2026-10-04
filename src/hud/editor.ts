/**
 * Éditeur de dégâts : choisir des bâtiments à la souris et leur donner un état.
 *
 * La touche E (ou le bouton du panneau) passe en sélection. Un clic sur la vue
 * principale prend le bâtiment visé ; Maj + clic en ajoute ou en retire un ;
 * un clic dans le vide vide la sélection. Les boutons du panneau posent ensuite
 * un état sur toute la sélection, de « fissuré » à « effondré », ou
 * « incendié », ou la remettent intacte. Les dégâts rejoignent le scénario du
 * simulateur (`disaster/manual.ts`) : avant / après, lecture et sauvegarde
 * s'appliquent à eux comme à un aléa.
 *
 * QUEL BÂTIMENT EST SOUS LE CURSEUR
 * ---------------------------------
 * On ne demande pas à Cesium quel objet a été cliqué : selon la vue, ce serait
 * un morceau du relevé de Google, un carreau de façades, ou une ruine, et
 * aucun ne porte l'identifiant du bâtiment. On lit plutôt la PROFONDEUR sous
 * le curseur (`pickPosition`), qui donne le point 3D touché quelle que soit la
 * vue, puis on cherche le bâtiment de l'IGN dont le contour contient ce point.
 */

import * as Cesium from 'cesium';
import {
  DAMAGE_INFO,
  DAMAGE_ORDER,
  standingHeight,
  type Building,
  type DamageState,
} from '../world/buildings';
import type { City } from '../world/city';
import { outline } from '../dataset/annotate';
import { toWindow } from '../diagnostic/overlay';
import type { DisasterPanel } from './disaster';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Libellé de chaque bouton : un verbe d'action pour « intact ». */
const ACTION: Record<DamageState, string> = {
  intact: 'Réparer',
  cracked: 'Fissuré',
  partial: 'Partiel',
  collapsed: 'Effondré',
  burnt: 'Incendié',
};

/** Au-delà, un clic à côté de tout contour ne prend aucun bâtiment, en mètres. */
const NEAR = 12;

type Point = [number, number];

interface Footprint {
  b: Building;
  /** Contour en mètres depuis le centre-ville (est, nord). */
  ring: Point[];
  cx: number;
  cy: number;
  /** Rayon du cercle qui contient le contour : un tri rapide avant le calcul exact. */
  radius: number;
}

export interface EditorHooks {
  scene: Cesium.Scene;
  city: City;
  panel: DisasterPanel;
  report: (text: string, kind?: 'info' | 'ok' | 'err') => void;
}

export class BuildingEditor {
  active = false;
  readonly selection = new Set<string>();

  private footprints: Footprint[];
  private byId: Map<string, Building>;
  private mLon: number;
  private toggleBtn = $<HTMLButtonElement>('dis-edit-toggle');
  private selLabel = $('dis-edit-sel');
  private statesBox = $('dis-edit-states');
  private buttons = new Map<DamageState, HTMLButtonElement>();

  constructor(private hooks: EditorHooks) {
    const { city } = hooks;
    this.byId = new Map(city.buildings.map((b) => [b.id, b]));
    this.mLon = 111320 * Math.cos((city.center.lat * Math.PI) / 180);
    this.footprints = city.buildings.map((b) => this.footprintOf(b));
    this.buildButtons();
    this.toggleBtn.addEventListener('click', () => this.toggle());
    hooks.scene.canvas.addEventListener('click', (e) => this.onClick(e));
    this.refresh();
  }

  private footprintOf(b: Building): Footprint {
    const { center } = this.hooks.city;
    const cx = (b.lon - center.lon) * this.mLon;
    const cy = (b.lat - center.lat) * 111320;
    const ring = outline(b).map(([e, n]): Point => [cx + e, cy + n]);
    const radius = Math.max(...ring.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    return { b, ring, cx, cy, radius };
  }

  private buildButtons(): void {
    this.statesBox.innerHTML = '';
    // Du plus grave au moins grave serait illogique à l'œil : on suit l'échelle
    // de gravité, et « Réparer » vient en dernier.
    for (const state of [
      ...DAMAGE_ORDER.filter((s) => s !== 'intact'),
      'intact',
    ] as DamageState[]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dis-btn dis-state';
      b.textContent = ACTION[state];
      b.style.borderColor = `${DAMAGE_INFO[state].color}88`;
      b.style.color = DAMAGE_INFO[state].color;
      b.addEventListener('click', () => this.apply(state));
      this.statesBox.appendChild(b);
      this.buttons.set(state, b);
    }
  }

  /** Entre en sélection ou en sort. */
  toggle(): void {
    this.active = !this.active;
    // Un réticule rappelle qu'un clic sur la vue choisit un bâtiment.
    this.hooks.scene.canvas.style.cursor = this.active ? 'crosshair' : '';
    if (this.active) {
      this.hooks.panel.open();
      this.hooks.report(
        'Sélection : clic sur un bâtiment, Maj + clic pour en ajouter — E pour finir',
        'ok',
      );
    } else {
      this.hooks.report('Sélection terminée', 'ok');
    }
    this.refresh();
  }

  private onClick(e: MouseEvent): void {
    if (!this.active) return;
    const rect = this.hooks.scene.canvas.getBoundingClientRect();
    const b = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    if (!e.shiftKey) this.selection.clear();
    if (b) {
      if (e.shiftKey && this.selection.has(b.id)) this.selection.delete(b.id);
      else this.selection.add(b.id);
    }
    this.refresh();
  }

  /** Le bâtiment sous un point de l'écran, en pixels CSS du canvas. */
  private pick(x: number, y: number): Building | null {
    const { scene, city } = this.hooks;
    const at = new Cesium.Cartesian2(x, y);
    let world = scene.pickPositionSupported ? scene.pickPosition(at) : undefined;
    if (!world) {
      const ray = scene.camera.getPickRay(at);
      world = ray ? scene.globe.pick(ray, scene) : undefined;
    }
    if (!world) return null;

    const c = Cesium.Cartographic.fromCartesian(world);
    const px = (Cesium.Math.toDegrees(c.longitude) - city.center.lon) * this.mLon;
    const py = (Cesium.Math.toDegrees(c.latitude) - city.center.lat) * 111320;

    let nearest: Footprint | null = null;
    let best = NEAR;
    for (const f of this.footprints) {
      const d = Math.hypot(px - f.cx, py - f.cy);
      if (d > f.radius + NEAR) continue;
      if (inside(px, py, f.ring)) return f.b;
      // Un clic sur une façade tombe juste à côté du contour : on retient le
      // bâtiment le plus proche, s'il l'est assez.
      const edge = distanceToRing(px, py, f.ring);
      if (edge < best) {
        best = edge;
        nearest = f;
      }
    }
    return nearest?.b ?? null;
  }

  /** Pose un état sur toute la sélection. */
  private apply(state: DamageState): void {
    if (!this.selection.size) return;
    this.hooks.panel.applyEdits([...this.selection], state);
    const n = this.selection.size;
    this.hooks.report(
      `${ACTION[state]} : ${n} bâtiment${n > 1 ? 's' : ''} — B / N pour comparer avant / après`,
      'ok',
    );
  }

  /** Vide la sélection, par exemple quand le scénario est annulé ou remplacé. */
  clear(): void {
    this.selection.clear();
    this.refresh();
  }

  private refresh(): void {
    this.toggleBtn.textContent = this.active ? 'Terminer (E)' : 'Sélectionner (E)';
    this.toggleBtn.classList.toggle('playing', this.active);
    for (const b of this.buttons.values()) b.disabled = this.selection.size === 0;

    const n = this.selection.size;
    const first = this.byId.get([...this.selection][0]);
    let text: string;
    if (n === 0) {
      text = this.active
        ? 'Clic sur un bâtiment ; Maj + clic pour en ajouter.'
        : 'E, puis clic sur un ou plusieurs bâtiments.';
    } else if (n === 1 && first) {
      text = `${first.name} (${DAMAGE_INFO[first.state].label.toLowerCase()})`;
    } else {
      text = `${n} bâtiments sélectionnés`;
    }
    // Appelé à chaque image tant qu'un bâtiment est choisi : on n'écrit que
    // si le texte change.
    if (this.selLabel.textContent !== text) this.selLabel.textContent = text;
  }

  /**
   * Dessine le contour des bâtiments choisis sur la surcouche de la vue
   * principale, au niveau de leur toit.
   */
  draw(canvas: HTMLCanvasElement): void {
    if (!this.selection.size) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { scene } = this.hooks;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#00e5ff';
    ctx.fillStyle = 'rgba(0, 229, 255, 0.14)';
    for (const id of this.selection) {
      const b = this.byId.get(id);
      if (!b) continue;
      const top = b.baseHeight + standingHeight(b);
      const bLon = 111320 * Math.cos((b.lat * Math.PI) / 180);
      ctx.beginPath();
      let drawn = 0;
      for (const [e, n] of outline(b)) {
        const p = toWindow(
          scene,
          Cesium.Cartesian3.fromDegrees(b.lon + e / bLon, b.lat + n / 111320, top),
        );
        if (!p) continue;
        if (drawn++ === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      if (drawn < 3) continue;
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    // Le nom d'un bâtiment peut changer d'état sous l'effet d'un aléa : on
    // garde l'étiquette du panneau à jour.
    if (this.selection.size === 1) this.refresh();
  }
}

/** Le point est-il dans le polygone ? (règle du nombre de croisements) */
function inside(x: number, y: number, ring: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Distance d'un point au contour d'un polygone, en mètres. */
function distanceToRing(x: number, y: number, ring: Point[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}
