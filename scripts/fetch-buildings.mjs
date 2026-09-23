#!/usr/bin/env node
/**
 * Télécharge les bâtiments réels d'une zone depuis la BD TOPO® de l'IGN.
 *
 *     npm run data:buildings
 *
 * POURQUOI UN FICHIER FIGÉ ET PAS UN APPEL AU DÉMARRAGE
 * -----------------------------------------------------
 * Le simulateur doit démarrer sans réseau, et surtout donner le même résultat
 * à chaque lancement : une simulation de désastre n'est comparable d'une fois
 * sur l'autre que si la ville ne change pas sous nos pieds. On télécharge donc
 * une fois, on fige le résultat dans `public/data/`, et on le versionne.
 *
 * FORMAT
 * ------
 * Les contours sont convertis en mètres locaux (est, nord) autour du centre de
 * la zone, arrondis au décimètre. Trois raisons : le fichier est deux fois plus
 * léger qu'en degrés, tous les calculs du simulateur (distances, emprises,
 * propagation du feu) se font de toute façon en mètres, et un décimètre reste
 * bien en deçà de la précision planimétrique annoncée par l'IGN.
 *
 * Les attributs sont gardés bruts, tels que l'IGN les publie. Toute
 * interprétation (hauteur de rendu, vulnérabilité) se fait dans le simulateur,
 * où elle est documentée et peut évoluer sans retélécharger.
 *
 * Source : IGN, BD TOPO®, Licence Ouverte Etalab 2.0.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Zone -------------------------------------------------------------------
// Mulhouse, centrée sur la place de la Réunion. 900 m de côté : assez pour
// inclure la tour de l'Europe, au nord-ouest, et le cœur de la vieille ville.
const ZONE = {
  name: 'Mulhouse — centre',
  lat: 47.7466,
  lon: 7.3389,
  halfSize: 450,
};

// Même constante que `src/core/math.ts` : les conversions aller et retour
// doivent être rigoureusement symétriques.
const METERS_PER_DEG = 111320;

const WFS = 'https://data.geopf.fr/wfs/ows';
const LAYER = 'BDTOPO_V3:batiment';
const PAGE = 1000;

const FIELDS = [
  'cleabs',
  'hauteur',
  'nombre_d_etages',
  'usage_1',
  'usage_2',
  'nature',
  'date_d_apparition',
  'materiaux_des_murs',
  'materiaux_de_la_toiture',
  'altitude_minimale_sol',
  'altitude_maximale_toit',
  'construction_legere',
  'nombre_de_logements',
];

const cosLat = Math.cos((ZONE.lat * Math.PI) / 180);
const dLat = ZONE.halfSize / METERS_PER_DEG;
const dLon = ZONE.halfSize / (METERS_PER_DEG * cosLat);
const bbox = [ZONE.lat - dLat, ZONE.lon - dLon, ZONE.lat + dLat, ZONE.lon + dLon];

/** Degrés vers mètres locaux, arrondis au décimètre. */
function toLocal([lon, lat]) {
  return [
    Math.round((lon - ZONE.lon) * METERS_PER_DEG * cosLat * 10) / 10,
    Math.round((lat - ZONE.lat) * METERS_PER_DEG * 10) / 10,
  ];
}

/** Aire signée d'un anneau, en m². Positive dans le sens trigonométrique. */
function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Retire le point de fermeture et les doublons consécutifs créés par l'arrondi. */
function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}

async function fetchPage(startIndex) {
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: LAYER,
    OUTPUTFORMAT: 'application/json',
    SRSNAME: 'EPSG:4326',
    BBOX: `${bbox.join(',')},urn:ogc:def:crs:EPSG::4326`,
    PROPERTYNAME: [...FIELDS, 'geometrie'].join(','),
    SORTBY: 'cleabs',
    COUNT: String(PAGE),
    STARTINDEX: String(startIndex),
  });
  const res = await fetch(`${WFS}?${params}`);
  if (!res.ok) throw new Error(`WFS ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log(`Zone : ${ZONE.name}, ${ZONE.halfSize * 2} m de côté`);

  const features = [];
  for (let start = 0; ; start += PAGE) {
    const page = await fetchPage(start);
    features.push(...page.features);
    console.log(`  ${features.length} / ${page.numberMatched} bâtiments`);
    if (page.features.length < PAGE) break;
  }

  const buildings = [];
  let skipped = 0;

  for (const f of features) {
    const p = f.properties;
    const polygons =
      f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];

    for (const [pi, polygon] of polygons.entries()) {
      const rings = polygon.map((ring) => cleanRing(ring.map(toLocal)));
      const outer = rings[0];
      // Un contour de moins de 3 points ou de moins de 4 m² est un artefact de
      // numérisation, pas un bâtiment : l'extruder produirait une géométrie
      // dégénérée.
      if (!outer || outer.length < 3 || Math.abs(signedArea(outer)) < 4) {
        skipped++;
        continue;
      }
      // Sens de parcours normalisé : extérieur trigonométrique, trous horaires.
      // Les faces des murs sont orientées d'après ce sens.
      if (signedArea(outer) < 0) outer.reverse();
      const holes = rings.slice(1).filter((r) => r.length >= 3 && Math.abs(signedArea(r)) >= 1);
      for (const h of holes) if (signedArea(h) > 0) h.reverse();

      const ground = p.altitude_minimale_sol;
      const roofTop = p.altitude_maximale_toit;
      buildings.push({
        id: polygons.length > 1 ? `${p.cleabs}#${pi}` : p.cleabs,
        eaves: p.hauteur ?? null,
        ridge: ground != null && roofTop != null ? Math.round((roofTop - ground) * 10) / 10 : null,
        floors: p.nombre_d_etages ?? null,
        use: p.usage_1 ?? null,
        use2: p.usage_2 ?? null,
        nature: p.nature ?? null,
        year: p.date_d_apparition ? Number(String(p.date_d_apparition).slice(0, 4)) : null,
        walls: p.materiaux_des_murs || null,
        roof: p.materiaux_de_la_toiture || null,
        ground: ground ?? null,
        light: p.construction_legere === true,
        homes: p.nombre_de_logements ?? null,
        rings: [outer, ...holes],
      });
    }
  }

  const out = {
    source: 'IGN — BD TOPO®',
    license: 'Licence Ouverte Etalab 2.0',
    attribution: '© IGN — BD TOPO®',
    fetched: new Date().toISOString().slice(0, 10),
    zone: ZONE,
    units: 'Contours en mètres locaux (est, nord) autour de zone.lat / zone.lon',
    count: buildings.length,
    buildings,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, '../public/data/mulhouse-centre.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(out));

  const kb = Math.round(JSON.stringify(out).length / 1024);
  console.log(`\n${buildings.length} bâtiments écrits (${skipped} contours écartés), ${kb} Ko`);
  console.log(`→ ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
