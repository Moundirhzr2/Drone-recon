/**
 * Point d'entrée : assemblage des modules et boucle principale.
 *
 * LA BOUCLE
 * ---------
 * On a pris la main sur la boucle de rendu de Cesium (`useDefaultRenderLoop =
 * false`) pour une raison précise : quand la vue nadir doit se rafraîchir, il
 * faut rendre la scène DEUX fois dans la même image — une fois caméra à la
 * verticale, une fois caméra normale. La boucle interne de Cesium ne laisse
 * aucun point d'accroche entre les deux.
 *
 * Trois cadences cohabitent, et c'est volontaire :
 *   - 60 Hz : physique, caméra, rendu principal ;
 *   - 10 Hz : vue nadir + analyse de l'image (une seconde passe de rendu) ;
 *   - 10 Hz : HUD (réécrire le DOM à 60 Hz coûte plus cher que la 3D).
 */

import * as Cesium from 'cesium';
import { CONFIG } from './core/config';
import { on, emit } from './core/bus';
import { createWorld } from './world/viewer';
import { createQuality, QUALITY_LABEL } from './world/quality';
import { generateCity } from './world/city';
import { loadRealCity } from './world/realCity';
import { loadRelief } from './world/terrain';
import { BuildingRenderer, RENDER_LABEL, type RenderMode } from './world/render';
import { Drone } from './drone/drone';
import { DroneModel } from './drone/model';
import { DroneCamera } from './drone/camera';
import { NadirView } from './drone/nadir';
import { PhotoLog } from './drone/photo';
import { ControlMixer } from './input/control';
import { KeyboardControl } from './input/keyboard';
import { HandControl } from './input/hands';
import { DisasterPlayer } from './disaster/timeline';
import { DisasterPanel } from './hud/disaster';
import { DisasterEffects } from './effects/disasterEffects';
import { analyse, type DiagnosticResult } from './diagnostic/detector';
import { drawMainOverlay, drawNadirOverlay } from './diagnostic/overlay';
import {
  boot,
  buildKeymap,
  flashShutter,
  Gallery,
  GpsPanel,
  HandsPanel,
  NadirPanel,
  ReportPanel,
  showSoftwareRenderingWarning,
} from './hud/hud';

const RENDER_CYCLE: RenderMode[] = ['realiste', 'wireframe', 'scan'];

async function main(): Promise<void> {
  buildKeymap();
  boot.set('Initialisation…', 0.05);

  // --- Monde -------------------------------------------------------------
  // Le relief d'abord : la scène en a besoin pour construire son terrain.
  boot.set('Chargement du relief…', 0.08);
  const relief = await loadRelief();
  const { viewer, scene, backendLabel, gpu } = await createWorld('cesium', boot.set, relief);
  // Qualité d'image choisie d'après la carte graphique, puis tenue en vol.
  const quality = createQuality(viewer, gpu);

  // Les vrais bâtiments de l'IGN ; la ville générée ne sert plus que de secours
  // si les données ne sont pas là.
  boot.set('Chargement des bâtiments réels…', 0.6);
  const city = (await loadRealCity(relief)) ?? generateCity();

  const renderer = new BuildingRenderer(scene, city);
  renderer.build();
  boot.set(`${city.buildings.length} bâtiments construits`, 0.8);

  // --- Drone ---------------------------------------------------------------
  // Sa hauteur au-dessus du sol se mesure sur le relief réel quand on l'a.
  const groundAt = relief
    ? (lon: number, lat: number) => relief.heightAt(lon, lat)
    : () => city.ground;
  const drone = new Drone(groundAt);
  // Le châssis 3D est optionnel : voir CONFIG.drone.showModel.
  const model = CONFIG.drone.showModel ? new DroneModel(viewer, drone.state) : null;
  const camera = new DroneCamera(scene.camera, drone.state);
  const nadir = new NadirView(scene, drone.state);
  const photos = new PhotoLog(nadir, drone.state);

  // --- Entrées --------------------------------------------------------------
  const mixer = new ControlMixer();
  mixer.add(new KeyboardControl());
  const hands = new HandControl(
    document.getElementById('webcam') as HTMLVideoElement,
    document.getElementById('hands-canvas') as HTMLCanvasElement,
  );
  mixer.add(hands);

  // --- Simulateur de désastres (partie 2) -----------------------------------
  const player = new DisasterPlayer(city);
  const effects = new DisasterEffects(scene, city, groundAt);

  // --- Interface -------------------------------------------------------------
  const gps = new GpsPanel(drone.home);
  const nadirPanel = new NadirPanel();
  const handsPanel = new HandsPanel();
  const report = new ReportPanel();
  const gallery = new Gallery();

  const nadirCanvas = document.getElementById('nadir-canvas') as HTMLCanvasElement;
  const nadirOverlay = document.getElementById('nadir-overlay') as HTMLCanvasElement;
  const mainOverlay = document.getElementById('overlay-main') as HTMLCanvasElement;

  // La vignette est dessinée à sa taille CSS : inutile de rendre plus grand.
  nadirCanvas.width = nadirOverlay.width = nadirCanvas.clientWidth || CONFIG.nadir.previewSize;
  nadirCanvas.height = nadirOverlay.height = nadirCanvas.width;

  // --- État de l'affichage -----------------------------------------------------
  let diagnostic = false;
  let renderMode: RenderMode = 'realiste';
  // --- Reconstruction du bâti après un dommage -------------------------------
  //
  // Un effondrement change la GÉOMÉTRIE — hauteur écrêtée, gravats — et pas
  // seulement la couleur. Le renderer repère lui-même les carreaux touchés et
  // étale leur reconstruction sur les images suivantes (voir `world/render.ts`) :
  // il suffit de lui signaler qu'un état a changé.
  const disasterPanel = new DisasterPanel(city, player, {
    onRebuild: () => renderer.sync(),
  });
  let lastResult: DiagnosticResult = {
    detections: [],
    metrics: {
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      // Rien n'a encore été analysé : les taux ne sont pas définis.
      precision: null,
      recall: null,
      classAccuracy: null,
    },
    damagedInFrame: 0,
  };

  // --- Actions ------------------------------------------------------------------
  on('photo:take', () => {
    const photo = photos.take((g) => analyse(city.buildings, g).detections);
    flashShutter();
    gallery.add(photo);
    handsPanel.setMessage(
      `${photo.id} — ${photo.detections.length} cible(s), ${photo.gsd.toFixed(1)} cm/px`,
      'ok',
    );
  });

  // Fumée, flammes et eau brouilleraient la lecture des vues techniques, qui
  // ne montrent que la classification des dommages.
  const syncEffectsVisibility = () => effects.setVisible(renderMode !== 'scan' && !diagnostic);

  on('view:toggle-diagnostic', () => {
    diagnostic = !diagnostic;
    renderer.setDiagnostic(diagnostic);
    syncEffectsVisibility();
    report.setOpen(diagnostic);
    handsPanel.setMessage(diagnostic ? 'Vue diagnostique' : 'Vue brute', 'ok');
  });

  on('view:cycle-render', () => {
    renderMode = RENDER_CYCLE[(RENDER_CYCLE.indexOf(renderMode) + 1) % RENDER_CYCLE.length];
    renderer.setRenderMode(renderMode);
    syncEffectsVisibility();
    handsPanel.setMessage(`Rendu : ${RENDER_LABEL[renderMode]}`, 'ok');
  });

  on('view:toggle-fpv', () => {
    const mode = camera.toggle();
    // Le châssis se masque en vue embarquée, sinon il occupe tout l'écran.
    model?.setVisible(mode === 'suivi');
    handsPanel.setMessage(mode === 'fpv' ? 'Caméra embarquée' : 'Caméra de suivi', 'ok');
  });

  on('disaster:toggle-play', () => {
    disasterPanel.open();
    disasterPanel.togglePlay();
  });
  on('disaster:pick', (i) => {
    disasterPanel.open();
    disasterPanel.pickKind(i);
  });
  on('disaster:jump', (where) => {
    disasterPanel.open();
    disasterPanel.jump(where);
  });
  on('disaster:cancel', () => disasterPanel.cancel());

  on('drone:reset', () => {
    drone.reset();
    camera.snap();
    handsPanel.setMessage('Retour au point de décollage', 'ok');
  });

  on('drone:hold', (v) => {
    drone.state.holding = v;
  });

  on('hands:toggle', () => void hands.toggle());
  on('hands:calibrate', () => hands.calibrate());
  on('ui:message', ({ text, kind }) => handsPanel.setMessage(text, kind ?? 'info'));

  // Molette : recul de la caméra de suivi.
  viewer.canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      camera.zoom(Math.sign(e.deltaY) * 4);
    },
    { passive: false },
  );

  // --- Boucle ----------------------------------------------------------------------
  // La vue par défaut est embarquée : le châssis doit être masqué dès le départ,
  // sinon la caméra démarre à l'intérieur de sa propre carlingue.
  model?.setVisible(camera.mode === 'suivi');
  camera.snap();
  viewer.resize();
  viewer.render();
  boot.set(`Prêt — ${backendLabel} — qualité ${QUALITY_LABEL[quality.profile]}`, 1);
  setTimeout(() => boot.hide(), 450);
  handsPanel.setMessage('Prêt au décollage — H pour piloter aux mains', 'ok');
  // Affiché ici et pas pendant la création de la scène : c'est seulement
  // maintenant que l'interface existe pour le montrer.
  if (gpu.software) showSoftwareRenderingWarning(gpu.renderer);

  let last = performance.now();
  let lastHud = 0;
  let lastMainOverlay = 0;
  let fps = 0;

  /** Durée d'un pas de simulation, en secondes. */
  const FIXED_STEP = 1 / 120;
  /** Temps écoulé pas encore simulé. */
  let accumulator = 0;
  let lastResize = 0;

  /**
   * Un pas de simulation complet, séparé de la boucle.
   *
   * L'isoler permet de l'appeler à la main depuis la console — indispensable
   * quand `requestAnimationFrame` est gelé, ce que fait le navigateur dès que
   * la fenêtre passe en arrière-plan.
   */
  function step(now: number): void {
    // `viewer.render()` ne redimensionne PAS le canvas : c'est la boucle de
    // rendu par défaut de Cesium qui appelait `resize()` avant chaque image.
    // L'ayant désactivée, la charge nous revient — sans cela le canvas reste
    // à 0x0 et toute lecture (vue nadir, photo) échoue.
    //
    // Deux fois par seconde suffit : `resize()` interroge la mise en page du
    // document, et la fenêtre ne change pas de taille soixante fois par seconde.
    if (now - lastResize > 500) {
      lastResize = now;
      viewer.resize();
    }

    // Cadence réelle, mesurée AVANT plafonnement : sinon le compteur ne
    // descendrait jamais sous 20 et masquerait précisément ce qu'on veut voir.
    const raw = (now - last) / 1000;
    if (raw > 0) fps = fps ? fps * 0.9 + (1 / raw) * 0.1 : 1 / raw;
    last = now;

    const ctl = mixer.read();

    // --- Pas de temps fixe -------------------------------------------------
    // La physique avance TOUJOURS par pas de 1/120 s, quel que soit le temps
    // réellement écoulé. C'est ce qui rend le déplacement régulier : sans cela,
    // une image qui met 40 ms fait bondir le drone de quatre fois la distance
    // d'une image à 10 ms, et le mouvement paraît saccadé même à bonne cadence.
    //
    // L'accumulateur est plafonné pour éviter la « spirale de la mort » : après
    // une longue pause, on ne rattrape pas deux secondes de simulation d'un
    // coup, on repart simplement du présent.
    accumulator = Math.min(accumulator + raw, 0.25);
    while (accumulator >= FIXED_STEP) {
      drone.update(FIXED_STEP, ctl);
      accumulator -= FIXED_STEP;
    }

    const dt = Math.min(raw, 0.05);
    model?.sync(dt);
    camera.update(dt);

    // Le simulateur avance en temps simulé, indépendamment du drone : on peut
    // survoler un sinistre pendant qu'il se produit. Les effets visuels suivent
    // le même temps, et la secousse d'un séisme s'applique à la caméra déjà
    // placée, juste avant le rendu.
    disasterPanel.update(dt);
    effects.update(player, now);
    effects.shake(scene.camera, player);

    // Vue nadir : seconde passe de rendu, cadencée à part.
    if (nadir.due(now)) {
      const g = nadir.render(nadirCanvas);
      lastResult = analyse(city.buildings, g);
      drawNadirOverlay(nadirOverlay, lastResult.detections, g, diagnostic);
      nadirPanel.update(g, lastResult.detections, diagnostic);
    }

    // Rendu de la vue principale.
    viewer.render();
    // Les couleurs en attente ne peuvent s'appliquer qu'une fois la géométrie
    // compilée, donc après au moins une passe de rendu.
    renderer.tick();

    if (now - lastMainOverlay > 125) {
      lastMainOverlay = now;
      drawMainOverlay(
        mainOverlay,
        scene,
        city.buildings,
        drone.state.lon,
        drone.state.lat,
        diagnostic,
      );
    }

    // --- Qualité adaptative -------------------------------------------------
    // Résolution d'abord, puis options coûteuses : voir `world/quality.ts`.
    const dropped = quality.update(now, fps);
    if (dropped) handsPanel.setMessage(`Qualité réduite pour rester fluide : ${dropped}`, 'info');

    if (now - lastHud > 100) {
      lastHud = now;
      gps.update(drone.state, drone.state.holding, fps);
      handsPanel.update(ctl, mixer.active, hands.isRunning ? hands.status() : null);
      if (diagnostic) report.update(lastResult.detections, lastResult.metrics, city.buildings);
    }
  }

  /**
   * Boucle de rendu.
   *
   * Le `try` n'est pas décoratif : sans lui, une seule exception transitoire
   * interrompt la chaîne de `requestAnimationFrame` et l'application se fige
   * définitivement, sans que rien à l'écran n'indique pourquoi. On journalise
   * et on continue — au pire l'image est sautée.
   */
  let faults = 0;
  function frame(now: number): void {
    try {
      step(now);
    } catch (err) {
      if (faults++ < 5) console.error('[boucle] image ignorée', err);
      else if (faults === 6) console.error('[boucle] erreurs répétées, journal coupé');
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Raccourcis de débogage, accessibles depuis la console du navigateur.
  // `step()` fait avancer la simulation d'une image même quand la boucle est
  // gelée (fenêtre en arrière-plan), ce qui rend la scène inspectable.
  Object.assign(window, {
    __sim: {
      // Exposé pour pouvoir expérimenter depuis la console sans recompiler.
      Cesium,
      viewer,
      scene,
      city,
      drone,
      renderer,
      photos,
      hands,
      nadir,
      analyse,
      get fps() {
        return Math.round(fps);
      },
      /** Échelle de rendu courante, ajustée automatiquement. */
      get scale() {
        return viewer.resolutionScale;
      },
      /** Moteur de rendu réellement utilisé par le navigateur. */
      get gpu() {
        const ctx = scene.canvas.getContext('webgl2') as WebGLRenderingContext | null;
        if (!ctx) return 'inconnu';
        const info = ctx.getExtension('WEBGL_debug_renderer_info');
        return info
          ? String(ctx.getParameter(info.UNMASKED_RENDERER_WEBGL))
          : String(ctx.getParameter(ctx.RENDERER));
      },
      player,
      disasterPanel,
      effects,
      quality,
      step: (n?: number) => step(n ?? performance.now()),
      get diagnostic() {
        return diagnostic;
      },
    },
  });
}

main().catch((err) => {
  console.error(err);
  boot.set('Échec du démarrage — voir la console', 1);
  emit('ui:message', { text: String(err), kind: 'err' });
});
