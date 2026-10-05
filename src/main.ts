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
import { fetchCityData, type CityData } from './world/ignData';
import { isMulhouse, MULHOUSE, placeFromUrl, searchPlaces, type Place } from './world/place';
import { PlacePicker } from './hud/placePicker';
import { BuildingRenderer, RENDER_LABEL, type RenderMode } from './world/render';
import { PhotorealCity, wantsPhotoreal } from './world/photoreal';
import { Obstacles, type Solid } from './world/obstacles';
import { Drone } from './drone/drone';
import { DroneModel } from './drone/model';
import { DroneCamera, type CameraMode } from './drone/camera';
import { NadirView, type NadirGeometry } from './drone/nadir';
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
  pairSheet,
  sideBySide,
  timestamp,
  toPng,
  type CaptureInfo,
} from './drone/capture';
import { downloadScenario, pickScenarioFile, scenarioFileName } from './disaster/scenarioFile';
import {
  boot,
  flashShutter,
  Gallery,
  GpsPanel,
  HandsPanel,
  HudToggle,
  KeyHelp,
  NadirPanel,
  QualityButton,
  ReportPanel,
  showSoftwareRenderingWarning,
} from './hud/hud';

const RENDER_CYCLE: RenderMode[] = ['realiste', 'wireframe', 'scan'];

/**
 * Le lieu du vol (`world/place.ts`) : Mulhouse, livrée toute prête, ou le lieu
 * demandé dans l'adresse, téléchargé depuis l'IGN. Si le lieu est introuvable
 * ou hors de France, on retombe sur Mulhouse, et on garde la raison pour la
 * dire au pilote.
 */
async function resolvePlace(): Promise<{
  place: Place;
  data: CityData | null;
  failure: string | null;
}> {
  const wanted = placeFromUrl();
  if (!wanted) return { place: MULHOUSE, data: null, failure: null };
  try {
    let place: Place;
    if ('query' in wanted) {
      boot.set(`Searching for "${wanted.query}"…`, 0.04);
      const [first] = await searchPlaces(wanted.query);
      if (!first) throw new Error(`place not found: "${wanted.query}"`);
      place = first;
    } else {
      place = wanted;
    }
    if (isMulhouse(place)) return { place: MULHOUSE, data: null, failure: null };
    const data = await fetchCityData(place, (text) => boot.set(text, 0.06));
    return { place, data, failure: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const asked = 'query' in wanted ? wanted.query : wanted.name;
    console.warn(`[lieu] ${asked} : ${reason} ; retour à Mulhouse`);
    return { place: MULHOUSE, data: null, failure: `${asked} : ${reason}` };
  }
}

async function main(): Promise<void> {
  const keyHelp = new KeyHelp();
  on('help:toggle', () => keyHelp.toggle());
  boot.set('Initialisation…', 0.05);

  // --- Lieu du vol ----------------------------------------------------------
  const { place, data: placeData, failure: placeFailure } = await resolvePlace();
  // Le départ du drone et la ville de secours se règlent sur CONFIG.city.
  Object.assign(CONFIG.city, { name: place.name, lon: place.lon, lat: place.lat });

  // --- Monde -------------------------------------------------------------
  // Le relief d'abord : la scène en a besoin pour construire son terrain.
  boot.set('Loading the relief…', 0.08);
  const relief = await loadRelief(placeData?.relief);
  const { viewer, scene, backendLabel, gpu } = await createWorld('cesium', boot.set, relief);
  // Qualité d'image choisie d'après la carte graphique, puis tenue en vol.
  const quality = createQuality(viewer, gpu);

  // Les vrais bâtiments de l'IGN ; la ville générée ne sert plus que de secours
  // si les données ne sont pas là.
  boot.set('Loading the real buildings…', 0.6);
  const city = (await loadRealCity(relief, placeData?.city)) ?? generateCity();

  const renderer = new BuildingRenderer(scene, city);
  renderer.build();
  boot.set(`${city.buildings.length} buildings built`, 0.8);

  // La ville photoréaliste : le relevé 3D de Google posé sur le relief de
  // l'IGN, quand un jeton est fourni. La simulation, elle, reste sur les
  // bâtiments de l'IGN (voir `world/photoreal.ts`).
  let photoreal: PhotorealCity | null = null;
  if (relief && wantsPhotoreal()) {
    boot.set('Loading the photorealistic city…', 0.85);
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
    ? 'photorealistic real city'
    : wantsPhotoreal()
      ? 'drawn city (photorealistic tiles unavailable)'
      : backendLabel;

  // --- Drone ---------------------------------------------------------------
  // Sa hauteur au-dessus du sol se mesure sur le relief réel quand on l'a.
  const groundAt = relief
    ? (lon: number, lat: number) => relief.heightAt(lon, lat)
    : () => city.ground;
  // Bâtiments et ruines sont solides : le drone s'y heurte et s'y pose.
  const obstacles = new Obstacles(city, () => photoreal?.shown ?? false);
  const drone = new Drone(groundAt, (lon, lat, r) => obstacles.under(lon, lat, r));
  // Le châssis 3D est optionnel : voir CONFIG.drone.showModel.
  const model = CONFIG.drone.showModel ? DroneModel.create(viewer, drone.state) : null;
  const camera = new DroneCamera(scene.camera, drone.state);
  const nadir = new NadirView(scene, drone.state);
  if (model) nadir.around = (draw) => model.hidden(draw);
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
  const effects = new DisasterEffects(scene, city, groundAt, () => photoreal?.shown ?? false);

  // --- Interface -------------------------------------------------------------
  const gps = new GpsPanel(drone.home);
  const nadirPanel = new NadirPanel();
  const handsPanel = new HandsPanel();
  // Contacts, atterrissages et décollages : un message, sans en noyer le pilote
  // quand il reste appuyé contre un mur.
  const onWhat = (solid: Solid | null) => {
    if (!solid) return 'the ground';
    const name = solid.building.name;
    if (solid.kind === 'toit') return `the roof (${name})`;
    if (solid.kind === 'mur') return `a standing wall (${name})`;
    return `the rubble (${name})`;
  };
  let lastContact = 0;
  drone.onEvent = (e) => {
    if (e.type === 'contact') {
      const now = performance.now();
      if (now - lastContact < 1500) return;
      lastContact = now;
      const what = e.solid.kind === 'toit' ? 'façade' : e.solid.kind === 'mur' ? 'wall' : 'rubble';
      handsPanel.setMessage(`Contact: ${what} (${e.solid.building.name}) — the drone stops`, 'err');
    } else if (e.type === 'landed') {
      const hard = e.speed > 2.5 ? ` — hard landing, ${e.speed.toFixed(1)} m/s` : '';
      handsPanel.setMessage(
        `Landed on ${onWhat(e.on)}${hard}. Throttle up to take off`,
        hard ? 'err' : 'ok',
      );
    } else {
      handsPanel.setMessage('Take-off', 'ok');
    }
  };
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
      const hazard = player.current?.scenario?.kind ?? null;
      renderer.setHazard(hazard);
      renderer.sync();
      photoreal?.setHazard(hazard);
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
    const name = scenarioName.value.trim() || `Scenario of ${new Date().toLocaleString('en-GB')}`;
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
    handsPanel.setMessage(`Scenario saved: ${scenarioFileName(name)}`, 'ok');
  });
  document.getElementById('dis-load')?.addEventListener('click', () => {
    void pickScenarioFile().then((text) => {
      if (!text) return;
      try {
        const { file, missing } = disasterPanel.importScenario(text);
        scenarioName.value = file.name;
        const v = file.viewpoint;
        if (v) {
          Object.assign(drone.state, { ...v, vEast: 0, vNorth: 0, vUp: 0, landed: false });
          drone.state.msl = groundAt(v.lon, v.lat) + v.agl;
          camera.snap();
        }
        const skipped = missing ? ` (${missing} unknown building(s) skipped)` : '';
        handsPanel.setMessage(`Scenario "${file.name}" loaded${skipped} — B / N to compare`, 'ok');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        handsPanel.setMessage(`Unreadable scenario: ${reason}`, 'err');
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
      ? '3D tiles: Google · Cesium ion'
      : city.attribution?.includes('IGN')
        ? 'Data: IGN — BD TOPO®, BD ORTHO®, RGE ALTI®'
        : 'Data: © OpenStreetMap (ODbL) · imagery Esri, Maxar · relief Mapzen',
    ...extra,
  });
  const captureFailed = (err: unknown) =>
    handsPanel.setMessage(
      `Capture not saved: ${err instanceof Error ? err.message : String(err)}`,
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
      await saver.save(`capture_${stamp}_view.png`, await toPng(view));
      await saver.save(`capture_${stamp}_nadir.png`, await (await fetch(photo.dataUrl)).blob());
      handsPanel.setMessage(
        `Capture saved in ${saver.destination}: capture_${stamp}_view.png and _nadir.png`,
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
  /**
   * La photo nadir du moment, à la définition des photos : la vue verticale
   * charge ses propres tuiles, on la rend donc jusqu'à ce qu'elle soit complète.
   */
  const grabNadir = async () => {
    const out = document.createElement('canvas');
    out.width = out.height = CONFIG.nadir.photoSize;
    const start = performance.now();
    let calm = 0;
    while (calm < 3 && performance.now() - start < 8000) {
      await new Promise((r) => requestAnimationFrame(r));
      nadir.render(out, false);
      const ready =
        renderer.idle &&
        (!scene.globe.show || scene.globe.tilesLoaded) &&
        (photoreal?.tilesLoaded ?? true);
      calm = ready ? calm + 1 : 0;
    }
    const g = nadir.render(out, false);
    return { image: out, g };
  };

  /**
   * La photo nadir avec le diagnostic du détecteur : un cadre par bâtiment
   * signalé, à la couleur de sa classe, en pointillés pour une fausse alerte,
   * et la précision et le rappel mesurés contre la vérité du simulateur.
   */
  const diagnosticOf = (image: HTMLCanvasElement, g: NadirGeometry) => {
    const result = analyse(city.buildings, g);
    const out = document.createElement('canvas');
    out.width = image.width;
    out.height = image.height;
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.drawImage(image, 0, 0);
      // Les cadres sont dessinés à demi-définition puis agrandis : traits et
      // étiquettes restent lisibles sur une photo de 1024 px.
      const half = Math.round(g.size / 2);
      const overlay = document.createElement('canvas');
      overlay.width = overlay.height = half;
      drawNadirOverlay(
        overlay,
        rescale(result.detections, g.size, half),
        { ...g, size: half },
        true,
      );
      ctx.drawImage(overlay, 0, 0, out.width, out.height);
    }
    const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)} %`);
    const m = result.metrics;
    const targets = result.detections.length;
    const summary = `precision ${pct(m.precision)} · recall ${pct(m.recall)} · ${targets} target(s)`;
    return { image: out, summary, metrics: { precision: m.precision, recall: m.recall, targets } };
  };

  // Aperçu de la paire nadir, à l'écran : un clic ou Échap le ferme.
  const preview = document.getElementById('pair-preview');
  const closePreview = () => {
    if (preview) preview.hidden = true;
  };
  preview?.addEventListener('click', closePreview);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && preview && !preview.hidden) closePreview();
  });
  const pairCaption = document.getElementById('pair-preview-caption');
  const showPair = (pair: HTMLCanvasElement, caption: string) => {
    const box = document.getElementById('pair-preview-images');
    if (!preview || !box || !pairCaption) return;
    box.replaceChildren(pair);
    pairCaption.textContent = caption;
    preview.hidden = false;
  };

  const capturePair = async () => {
    if (pairBusy) return;
    if (!player.current) {
      handsPanel.setMessage(
        'Before / after pair: start a disaster first, or set damage by hand (E)',
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
    handsPanel.setMessage('Before / after pair: capturing…');
    try {
      // Chaque état est pris deux fois : la vue du pilote, puis la verticale.
      disasterPanel.jump('start');
      await settle();
      const before = grabView(viewer);
      annotateCapture(before, captureInfo({ title: 'BEFORE', subtitle }));
      const { image: beforeNadir } = await grabNadir();
      disasterPanel.jump('end');
      await settle();
      const after = grabView(viewer);
      annotateCapture(after, captureInfo({ title: 'AFTER', subtitle }));
      const { image: afterNadir, g: afterGeometry } = await grabNadir();
      // Le diagnostic part de la photo « après » nue, avant son bandeau.
      const diag = diagnosticOf(afterNadir, afterGeometry);
      // La planche part des images nues : une étiquette sur chacune, un seul
      // bandeau dessous. Les images seules reçoivent ensuite le leur.
      const sheet = pairSheet(
        [
          { image: beforeNadir, label: 'BEFORE' },
          { image: afterNadir, label: 'AFTER' },
          { image: diag.image, label: 'DIAGNOSTIC' },
        ],
        captureInfo({ subtitle }),
        diag.metrics,
      );
      annotateCapture(beforeNadir, captureInfo({ title: 'BEFORE', subtitle: 'nadir view' }));
      annotateCapture(afterNadir, captureInfo({ title: 'AFTER', subtitle: 'nadir view' }));
      annotateCapture(diag.image, captureInfo({ title: 'DIAGNOSTIC', subtitle: diag.summary }));
      flashShutter();
      const files = `capture_${stamp}_*.png`;
      showPair(sheet, `Saving 7 images: ${files}…`);
      await folder;
      await saver.save(`capture_${stamp}_before.png`, await toPng(before));
      await saver.save(`capture_${stamp}_after.png`, await toPng(after));
      await saver.save(`capture_${stamp}_before-after.png`, await toPng(sideBySide(before, after)));
      await saver.save(`capture_${stamp}_before_nadir.png`, await toPng(beforeNadir));
      await saver.save(`capture_${stamp}_after_nadir.png`, await toPng(afterNadir));
      await saver.save(`capture_${stamp}_diagnostic_nadir.png`, await toPng(diag.image));
      await saver.save(`capture_${stamp}_before-after_nadir.png`, await toPng(sheet));
      if (pairCaption) pairCaption.textContent = `7 images saved in ${saver.destination}: ${files}`;
      handsPanel.setMessage(
        `Before / after pair saved in ${saver.destination}: pilot view, nadir view and diagnostic (7 images)`,
        'ok',
      );
    } catch (err) {
      if (pairCaption) {
        pairCaption.textContent = `Not saved: ${err instanceof Error ? err.message : String(err)}`;
      }
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
    handsPanel.setMessage(diagnostic ? 'Diagnostic view' : 'Raw view', 'ok');
  });

  on('model:toggle', () => {
    if (modelOn) {
      setModel(false);
      handsPanel.setMessage('Simulated detector', 'ok');
      return;
    }
    setModel(true);
    handsPanel.setMessage('Loading the trained model…');
    trained.load().then(
      () => {
        if (!modelOn) return;
        const where = trained.backend === 'webgpu' ? 'graphics card' : 'processeur';
        handsPanel.setMessage(`Trained model active, on the ${where} — O to go back`, 'ok');
      },
      () => {
        setModel(false);
        handsPanel.setMessage(`Model unavailable: ${trained.error}`, 'err');
      },
    );
  });

  on('view:cycle-render', () => {
    renderMode = RENDER_CYCLE[(RENDER_CYCLE.indexOf(renderMode) + 1) % RENDER_CYCLE.length];
    renderer.setRenderMode(renderMode);
    syncViews();
    handsPanel.setMessage(`Render: ${RENDER_LABEL[renderMode]}`, 'ok');
  });

  const CAMERA_LABEL: Record<CameraMode, string> = {
    suivi: 'Follow camera',
    fpv: 'Onboard camera',
    nadir: 'Nadir view: straight down from the drone, heading up (T to go back)',
  };
  const nadirButton = document.getElementById('nadir-pov');
  const showCamera = (mode: CameraMode) => {
    // Le châssis se masque à bord, sinon il occupe tout l'écran.
    model?.setVisible(mode === 'suivi');
    nadirButton?.classList.toggle('on', mode === 'nadir');
    handsPanel.setMessage(CAMERA_LABEL[mode], 'ok');
  };
  on('view:toggle-fpv', () => showCamera(camera.toggle()));
  on('view:toggle-nadir', () => showCamera(camera.toggleNadir()));
  nadirButton?.addEventListener('click', () => showCamera(camera.toggleNadir()));

  on('view:toggle-hud', () => hudToggle.toggle());

  on('view:toggle-quality', () => {
    const fixed = quality.toggleFixed(performance.now());
    qualityButton.update(fixed, quality.degraded);
    handsPanel.setMessage(
      fixed
        ? 'Quality locked: full resolution, even if the frame rate drops'
        : 'Automatic quality: lowered when needed to stay smooth',
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
    handsPanel.setMessage('Back to the take-off point', 'ok');
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
  boot.set(`Ready — ${place.name} — ${worldLabel} — ${QUALITY_LABEL[quality.profile]} quality`, 1);
  setTimeout(() => boot.hide(), 450);
  handsPanel.setMessage('Ready for take-off — H to fly with your hands', 'ok');

  // --- Choix du lieu : voir `hud/placePicker.ts` ----------------------------
  const picker = new PlacePicker(place);
  if (placeFailure) {
    picker.showError(`${placeFailure}. Back to Mulhouse.`);
    handsPanel.setMessage('Place unavailable: back to Mulhouse', 'err');
    // Recharger la page ne doit pas retenter le même lieu.
    const params = new URLSearchParams(window.location.search);
    for (const key of ['lieu', 'lat', 'lon']) params.delete(key);
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}`,
    );
  }
  // Hors de Mulhouse, l'écart d'altitude entre Google et l'IGN se mesure.
  if (photoreal && !isMulhouse(place)) {
    void photoreal.calibrate().then(
      (gap) => {
        if (gap === null) return;
        const m = gap.toLocaleString('en-GB', { maximumFractionDigits: 1 });
        handsPanel.setMessage(`Google tiles aligned with the relief: ${m} m offset`, 'ok');
      },
      (err) => console.warn('[relevé] calage impossible', err),
    );
  }
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
      // La campagne du jeu de données place le drone elle-même, à l'altitude
      // de chaque prise de vue : les collisions ne doivent pas l'en déloger.
      if (!dataset.isRunning) drone.update(FIXED_STEP, ctl);
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
      nadirPanel.update(g, modelOn ? 'modele' : diagnostic ? 'diagnostic' : 'brut');
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
      handsPanel.setMessage(`Quality lowered to stay smooth: ${dropped} — F to restore it`);
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
      obstacles,
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
  boot.set('Start-up failed — see the console', 1);
  emit('ui:message', { text: String(err), kind: 'err' });
});
