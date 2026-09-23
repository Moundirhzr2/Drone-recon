#!/usr/bin/env node
/**
 * Échantillonne le relief réel de la zone depuis le RGE ALTI® de l'IGN.
 *
 *     npm run data:relief
 *
 * POURQUOI UN RELIEF, SUR UNE VILLE AUSSI PLATE
 * ---------------------------------------------
 * Le centre de Mulhouse ne varie que de six mètres. C'est peu à l'œil, mais
 * c'est tout pour une inondation : l'eau remplit d'abord les creux, et six
 * mètres séparent un quartier sous l'eau d'un quartier au sec. Sans relief,
 * une crue ne pourrait être qu'un disque autour d'un point, ce qu'aucune crue
 * n'est.
 *
 * GRILLE
 * ------
 * Un point tous les 10 m, sur un carré plus large de 150 m de chaque côté que
 * la zone bâtie : le relief ne s'arrête pas net au bord de la ville. Les
 * altitudes sont stockées en centimètres entiers, ligne par ligne du sud vers
 * le nord, chaque ligne d'ouest en est.
 *
 * Le service accepte au plus une centaine de points par requête (au-delà,
 * l'URL est refusée) ; on les envoie donc par lots, avec une courte pause pour
 * ne pas surcharger un service public gratuit.
 *
 * Source : IGN, RGE ALTI®, Licence Ouverte Etalab 2.0.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Même centre que `fetch-buildings.mjs`, zone élargie de 150 m.
const ZONE = { name: 'Mulhouse — centre', lat: 47.7466, lon: 7.3389, halfSize: 600 };
const SPACING = 10; // mètres
const METERS_PER_DEG = 111320;
const BATCH = 100;
const PAUSE_MS = 120;

const URL_ALTI = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const cosLat = Math.cos((ZONE.lat * Math.PI) / 180);

const n = Math.round((ZONE.halfSize * 2) / SPACING) + 1;
const points = [];
for (let row = 0; row < n; row++) {
  const north = -ZONE.halfSize + row * SPACING;
  for (let col = 0; col < n; col++) {
    const east = -ZONE.halfSize + col * SPACING;
    points.push({
      lon: ZONE.lon + east / (METERS_PER_DEG * cosLat),
      lat: ZONE.lat + north / METERS_PER_DEG,
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBatch(batch, attempt = 1) {
  const params = new URLSearchParams({
    lon: batch.map((p) => p.lon.toFixed(6)).join('|'),
    lat: batch.map((p) => p.lat.toFixed(6)).join('|'),
    resource: 'ign_rge_alti_wld',
    zonly: 'true',
  });
  try {
    const res = await fetch(`${URL_ALTI}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.elevations) || json.elevations.length !== batch.length) {
      throw new Error('réponse incomplète');
    }
    return json.elevations;
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(1000 * attempt);
    return fetchBatch(batch, attempt + 1);
  }
}

async function main() {
  console.log(`Relief : ${n} × ${n} points, tous les ${SPACING} m`);
  const heights = [];
  for (let i = 0; i < points.length; i += BATCH) {
    const z = await fetchBatch(points.slice(i, i + BATCH));
    heights.push(...z);
    if ((i / BATCH) % 20 === 0) console.log(`  ${heights.length} / ${points.length}`);
    await sleep(PAUSE_MS);
  }

  // Une valeur aberrante (le service renvoie -99999 hors couverture) ruinerait
  // tout le maillage : on la remplace par la médiane, et on le signale.
  const valid = heights.filter((h) => h > -1000).sort((a, b) => a - b);
  const median = valid[Math.floor(valid.length / 2)];
  const bad = heights.filter((h) => !(h > -1000)).length;
  const cm = heights.map((h) => Math.round((h > -1000 ? h : median) * 100));

  const out = {
    source: 'IGN — RGE ALTI®',
    license: 'Licence Ouverte Etalab 2.0',
    attribution: '© IGN — RGE ALTI®',
    fetched: new Date().toISOString().slice(0, 10),
    zone: ZONE,
    spacing: SPACING,
    size: n,
    order: 'lignes du sud vers le nord, chaque ligne d’ouest en est',
    unit: 'cm',
    heights: cm,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, '../public/data/mulhouse-relief.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(out));

  console.log(
    `\n${heights.length} altitudes, de ${valid[0].toFixed(2)} à ${valid[valid.length - 1].toFixed(2)} m` +
      (bad ? `, ${bad} valeurs hors couverture remplacées` : ''),
  );
  console.log(`→ ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
