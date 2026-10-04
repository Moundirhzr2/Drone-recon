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
import { PhotorealCity, wantsPhotoreal } from './world/photoreal';
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
import { compareToTruth, describe, rescale, TrainedDetector } from './diagnostic/model';
import { drawMainOverlay, drawNadirOverlay } from './diagnostic/overlay';
import { runTour } from './demo/tour';
import { DatasetCampaign } from './dataset/campaign';
import { BuildingEditor } from './hud/editor';
import {
  annotateCapture,
  CaptureSaver,
  grabView,
  sideBySide,
  timestamp,
  toPng,
  type CaptureInfo,
} from './drone/capture';
import { downloadScenario, pickScenarioFile, scenarioFileName } from './disaster/scenarioFile';
import {
  boot,
  buildKeymap,
  flashShutter,
  Gallery,
  GpsPanel,
  HandsPanel,
  HudToggle,
  NadirPanel,
  QualityButton,
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

  // La ville photoréaliste : le relevé 3D de Google posé sur le relief de
  // l'IGN, quand un jeton est fourni. La simulation, elle, reste sur les
  // bâtiments de l'IGN (voir `world/photoreal.ts`).
  let photoreal: PhotorealCity | null = null;
  if (relief && wantsPhotoreal()) {
    boot.set('Chargement de la ville photoréaliste…', 0.85);
    photoreal = await PhotorealCity.load(
      scene,
      city,
      (lon, lat) => relief.heightAt(lon, lat),
      quality.settings,
    );
    if (photoreal) {
      renderer.setPhotoreal(true);
      document.body.classList.add('photoreal');
    }
  }
  const worldLabel = photoreal
    ? 'ville réelle photoréaliste'
    : wantsPhotoreal()
      ? 'ville dessinée (relevé photoréaliste indisponible)'
      : backendLabel;

  // --- Drone ---------------------------------------------------------------
  // Sa hauteur au-dessus du sol se mesure sur le relief réel quand on l'a.
  const groundAt = relief
    ? (lon: number, lat: number) => relief.heightAt(lon, lat)
    : () => city.ground;
  const drone = new Drone(groundAt);
  // Le châssis 3D est optionnel : voir CONFIG.drone.showModel.
  const model = CONFIG.drone.showModel ? DroneModel.create(viewer, drone.state) : null;
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
  const hudToggle = new HudToggle();
  const qualityButton = new QualityButton();

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
    onRebuild: () => {
      renderer.sync();
      photoreal?.sync();
    },
    // Scénario annulé ou remplacé : la sélection de bâtiments ne vaut plus.
    onCleared: () => editor.clear(),
  });

  // --- Dégâts posés à la main (touche E) : voir `hud/editor.ts` --------------
  const editor = new BuildingEditor({
    scene,
    city,
    panel: disasterPanel,
    report: (text, kind) => handsPanel.setMessage(text, kind ?? 'info'),
  });
  on('editor:toggle', () => editor.toggle());

  // --- Scénarios en JSON : voir `disaster/scenarioFile.ts` -------------------
  const scenarioName = document.getElementById('dis-file-name') as HTMLInputElement;
  document.getElementById('dis-save')?.addEventListener('click', () => {
    const s = drone.state;
    const name = scenarioName.value.trim() || `Scénario du ${new Date().toLocaleString('fr-FR')}`;
    // Le point de vue part avec le scénario : on retrouvera la même
    // comparaison avant / après.
    downloadScenario(
      disasterPanel.exportScenario(name, {
        lon: s.lon,
        lat: s.lat,
        agl: s.agl,
        heading: s.heading,
      }),
    );
    handsPanel.setMessage(`Scénario enregistré : ${scenarioFileName(name)}`, 'ok');
  });
  document.getElementById('dis-load')?.addEventListener('click', () => {
    void pickScenarioFile().then((text) => {
      if (!text) return;
      try {
        const { file, missing } = disasterPanel.importScenario(text);
        scenarioName.value = file.name;
        const v = file.viewpoint;
        if (v) {
          Object.assign(drone.state, { ...v, vEast: 0, vNorth: 0, vUp: 0 });
          drone.state.msl = groundAt(v.lon, v.lat) + v.agl;
          camera.snap();
        }
        const skipped = missing ? ` (${missing} bâtiment(s) inconnu(s) ignoré(s))` : '';
        handsPanel.setMessage(
          `Scénario « ${file.name} » chargé${skipped} — B / N pour comparer`,
          'ok',
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        handsPanel.setMessage(`Scénario illisible : ${reason}`, 'err');
      }
    });
  });
  const noResult = (): DiagnosticResult => ({
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
  });
  let lastResult = noResult();

  // --- Détecteur entraîné (touche O) : voir `diagnostic/model.ts` ------------
  // Il remplace `analyse()` : ses résultats arrivent du worker, une analyse à
  // la fois, et sont aussitôt confrontés à la vérité du simulateur.
  let modelOn = false;
  const modelCanvas = document.createElement('canvas');
  const trained = new TrainedDetector((boxes, g) => {
    if (!modelOn) return;
    lastResult = compareToTruth(
      boxes,
      (b) => trained.classOf(b),
      city.buildings,
      g,
      nadirCanvas.width,
    );
    drawNadirOverlay(nadirOverlay, lastResult.detections, g, true);
  });

  // --- Actions ------------------------------------------------------------------
  // --- Captures : voir `drone/capture.ts` -------------------------------------
  const saver = new CaptureSaver();
  /** Le bandeau d'une capture : où, quand, et la source des données à l'image. */
  const captureInfo = (extra: Partial<CaptureInfo> = {}): CaptureInfo => ({
    at: new Date(),
    lon: drone.state.lon,
    lat: drone.state.lat,
    agl: drone.state.agl,
    heading: drone.state.heading,
    credits: photoreal?.shown
      ? 'Relevé 3D : Google · Cesium ion'
      : city.attribution?.includes('IGN')
        ? 'Données : IGN — BD TOPO®, BD ORTHO®, RGE ALTI®'
        : 'Données : © OpenStreetMap (ODbL) · imagerie Esri, Maxar · relief Mapzen',
    ...extra,
  });
  const captureFailed = (err: unknown) =>
    handsPanel.setMessage(
      `Capture non enregistrée : ${err instanceof Error ? err.message : String(err)}`,
      'err',
    );

  // Espace, ou pincement de la main droite : la vue du pilote, et la photo
  // verticale de la caméra nadir, avec ses détections.
  on('photo:take', () => {
    // Le choix du dossier doit s'ouvrir dans la foulée de la touche.
    const folder = saver.ensureFolder();
    const stamp = timestamp();
    const view = grabView(viewer);
    annotateCapture(view, captureInfo());
    // Avec le modèle, la photo reprend ses dernières détections : une analyse
    // prend du temps, et elle date d'une fraction de seconde au plus.
    const photo = photos.take((g) =>
      modelOn
        ? rescale(lastResult.detections, nadirCanvas.width, g.size)
        : analyse(city.buildings, g).detections,
    );
    flashShutter();
    gallery.add(photo);
    void (async () => {
      await folder;
      await saver.save(`capture_${stamp}_vue.png`, await toPng(view));
      await saver.save(`capture_${stamp}_nadir.png`, await (await fetch(photo.dataUrl)).blob());
      handsPanel.setMessage(
        `Capture enregistrée dans ${saver.destination} : capture_${stamp}_vue.png et _nadir.png`,
        'ok',
      );
    })().catch(captureFailed);
  });

  // Maj + Espace : la paire avant / après, depuis le même point de vue.
  let pairBusy = false;
  /** Attend que la vue soit complète : ruines construites, tuiles chargées. */
  const settle = async () => {
    const start = performance.now();
    let calm = 0;
    while (calm < 3 && performance.now() - start < 8000) {
      await new Promise((r) => requestAnimationFrame(r));
      const ready =
        renderer.idle &&
        (!scene.globe.show || scene.globe.tilesLoaded) &&
        (photoreal?.tilesLoaded ?? true);
      calm = ready ? calm + 1 : 0;
    }
  };
  const capturePair = async () => {
    if (pairBusy) return;
    if (!player.current) {
      handsPanel.setMessage(
        'Paire avant / après : lancer d’abord un sinistre, ou poser des dégâts (E)',
        'err',
      );
      return;
    }
    pairBusy = true;
    const folder = saver.ensureFolder();
    const stamp = timestamp();
    const time = player.time;
    const playing = player.playing;
    // Le drone ne bouge pas entre les deux images : c'est le même point de vue.
    drone.state.holding = true;
    const subtitle = disasterPanel.describe();
    handsPanel.setMessage('Paire avant / après : prise de vue…');
    try {
      disasterPanel.jump('start');
      await settle();
      const before = grabView(viewer);
      annotateCapture(before, captureInfo({ title: 'AVANT', subtitle }));
      disasterPanel.jump('end');
      await settle();
      const after = grabView(viewer);
      annotateCapture(after, captureInfo({ title: 'APRÈS', subtitle }));
      flashShutter();
      await folder;
      await saver.save(`capture_${stamp}_avant.png`, await toPng(before));
      await saver.save(`capture_${stamp}_apres.png`, await toPng(after));
      await saver.save(`capture_${stamp}_avant-apres.png`, await toPng(sideBySide(before, after)));
      handsPanel.setMessage(
        `Paire avant / après enregistrée dans ${saver.destination} : capture_${stamp}_avant, _apres, _avant-apres`,
        'ok',
      );
    } catch (err) {
      captureFailed(err);
    } finally {
      disasterPanel.seek(time);
      player.playing = playing;
      pairBusy = false;
      drone.state.holding = holdRequested;
    }
  };
  on('photo:pair', () => void capturePair());
  document.getElementById('dis-pair')?.addEventListener('click', () => void capturePair());

  // Fumée, flammes et eau brouilleraient la lecture des vues techniques, qui
  // ne montrent que la classification des dommages. Pour la même raison, ces
  // vues reviennent à la ville dessinée.
  //
  // Le modèle entraîné voit la scène comme à l'entraînement : la ville dessinée
  // d'après l'IGN, sans le relevé de Google, sans effets, et sans les couleurs
  // du diagnostic, qui lui souffleraient la réponse.
  const syncViews = () => {
    const plain = diagnostic || modelOn;
    effects.setVisible(renderMode !== 'scan' && !plain);
    photoreal?.setVisible(renderMode === 'realiste' && !plain);
    if (photoreal) renderer.setPhotoreal(!modelOn);
    renderer.setDiagnostic(diagnostic && !modelOn);
  };

  const setModel = (on: boolean) => {
    modelOn = on;
    lastResult = noResult();
    if (on && renderMode !== 'realiste') {
      renderMode = 'realiste';
      renderer.setRenderMode(renderMode);
    }
    syncViews();
    report.setOpen(diagnostic || modelOn);
  };

  on('view:toggle-diagnostic', () => {
    diagnostic = !diagnostic;
    syncViews();
    report.setOpen(diagnostic || modelOn);
    handsPanel.setMessage(diagnostic ? 'Vue diagnostique' : 'Vue brute', 'ok');
  });

  on('model:toggle', () => {
    if (modelOn) {
      setModel(false);
      handsPanel.setMessage('Détecteur simulé', 'ok');
      return;
    }
    setModel(true);
    handsPanel.setMessage('Chargement du modèle entraîné…');
    trained.load().then(
      () => {
        if (!modelOn) return;
        const where = trained.backend === 'webgpu' ? 'carte graphique' : 'processeur';
        handsPanel.setMessage(`Modèle entraîné actif, sur le ${where} — O pour revenir`, 'ok');
      },
      () => {
        setModel(false);
        handsPanel.setMessage(`Modèle indisponible : ${trained.error}`, 'err');
      },
    );
  });

  on('view:cycle-render', () => {
    renderMode = RENDER_CYCLE[(RENDER_CYCLE.indexOf(renderMode) + 1) % RENDER_CYCLE.length];
    renderer.setRenderMode(renderMode);
    syncViews();
    handsPanel.setMessage(`Rendu : ${RENDER_LABEL[renderMode]}`, 'ok');
  });

  on('view:toggle-fpv', () => {
    const mode = camera.toggle();
    // Le châssis se masque en vue embarquée, sinon il occupe tout l'écran.
    model?.setVisible(mode === 'suivi');
    handsPanel.setMessage(mode === 'fpv' ? 'Caméra embarquée' : 'Caméra de suivi', 'ok');
  });

  on('view:toggle-hud', () => hudToggle.toggle());

  on('view:toggle-quality', () => {
    const fixed = quality.toggleFixed(performance.now());
    qualityButton.update(fixed, quality.degraded);
    handsPanel.setMessage(
      fixed
        ? 'Qualité fixée : pleine définition, même si la cadence baisse'
        : 'Qualité automatique : elle baisse au besoin pour rester fluide',
      'ok',
    );
  });

  // --- Jeu de données (touche J) : voir `dataset/campaign.ts` ----------------
  const dataset = new DatasetCampaign({
    city,
    drone: drone.state,
    nadir,
    scene,
    panel: disasterPanel,
    groundAt,
    renderIdle: () => renderer.idle,
    prepareView: () => {
      if (modelOn) setModel(false);
      if (diagnostic) {
        diagnostic = false;
        renderer.setDiagnostic(false);
        report.setOpen(false);
      }
      if (renderMode !== 'realiste') {
        renderMode = 'realiste';
        renderer.setRenderMode(renderMode);
      }
      // La ville dessinée d'après l'IGN : sans le relevé de Google, dont les
      // images ne peuvent pas être extraites, et sans fumée ni flammes.
      renderer.setPhotoreal(false);
      photoreal?.setVisible(false);
      effects.setVisible(false);
    },
    restoreView: syncViews,
    report: (text, kind) => handsPanel.setMessage(text, kind ?? 'info'),
  });
  on('dataset:toggle', (mode) => dataset.toggle(mode));

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

  // Dernière stabilisation demandée (Maj, deux poings) : une paire avant /
  // après fige aussi le drone, et doit lui rendre cette demande-là à la fin.
  let holdRequested = false;
  on('drone:hold', (v) => {
    holdRequested = v;
    drone.state.holding = v || pairBusy;
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
  boot.set(`Prêt — ${worldLabel} — qualité ${QUALITY_LABEL[quality.profile]}`, 1);
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
      // Le modèle ne reçoit une image que s'il a fini la précédente : on ne
      // recopie l'image à sa taille d'entrée que dans ce cas.
      const feed = modelOn && trained.idle ? modelCanvas : undefined;
      const inputSize = trained.card?.inputSize ?? 0;
      if (feed && feed.width !== inputSize) feed.width = feed.height = inputSize;
      const shoot = () => nadir.render(nadirCanvas, true, feed);
      const g = photoreal ? photoreal.coarser(shoot) : shoot();
      if (feed) trained.submit(feed, { ...g, size: inputSize });
      if (!modelOn) lastResult = analyse(city.buildings, g);
      drawNadirOverlay(nadirOverlay, lastResult.detections, g, diagnostic || modelOn);
      nadirPanel.update(
        g,
        lastResult.detections,
        modelOn ? 'modele' : diagnostic ? 'diagnostic' : 'brut',
      );
    }

    // Rendu de la vue principale.
    viewer.render();
    // Les couleurs en attente ne peuvent s'appliquer qu'une fois la géométrie
    // compilée, donc après au moins une passe de rendu.
    renderer.tick();

    // Une sélection de bâtiments suit la caméra : redessinée à chaque image.
    if (now - lastMainOverlay > 125 || editor.selection.size > 0) {
      lastMainOverlay = now;
      drawMainOverlay(
        mainOverlay,
        scene,
        city.buildings,
        drone.state.lon,
        drone.state.lat,
        diagnostic,
      );
      editor.draw(mainOverlay);
    }

    // --- Qualité adaptative -------------------------------------------------
    // Résolution d'abord, puis options coûteuses : voir `world/quality.ts`.
    const dropped = quality.update(now, fps);
    if (dropped) {
      handsPanel.setMessage(`Qualité réduite pour rester fluide : ${dropped} — F pour la rétablir`);
    }

    if (now - lastHud > 100) {
      lastHud = now;
      qualityButton.update(quality.isFixed, quality.degraded);
      gps.update(drone.state, drone.state.holding, fps);
      handsPanel.update(ctl, mixer.active, hands.isRunning ? hands.status() : null);
      if (diagnostic || modelOn) {
        const note = modelOn ? describe(trained, drone.state.agl) : '';
        report.update(lastResult.detections, lastResult.metrics, city.buildings, note);
      }
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

  // Visite guidée : `?demo` dans l'adresse.
  if (new URLSearchParams(window.location.search).has('demo')) {
    void runTour({
      city,
      drone: drone.state,
      panel: disasterPanel,
      player,
      diagnostic: () => diagnostic,
      tilesLoaded: () =>
        (!scene.globe.show || scene.globe.tilesLoaded) && (photoreal?.tilesLoaded ?? true),
      photoreal: photoreal !== null,
    });
  }

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
      photoreal,
      dataset,
      editor,
      saver,
      trained,
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
