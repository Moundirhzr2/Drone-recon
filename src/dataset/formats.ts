/**
 * Les fichiers du jeu de données : étiquettes YOLO, annotations COCO,
 * métadonnées des prises de vue et notice.
 *
 * YOLO et COCO sont les deux formats que lisent presque tous les outils
 * d'entraînement de détecteurs d'objets ; les écrire tous deux évite au
 * lecteur une conversion. Les coordonnées sont en pixels dans COCO, et
 * normalisées entre 0 et 1 dans YOLO.
 */

import { DAMAGE_INFO, DAMAGE_ORDER } from '../world/buildings';
import type { Annotation } from './annotate';

/** Une prise de vue et ce qu'elle contient. */
export interface ImageRecord {
  /** Nom du fichier image, sans dossier. */
  file: string;
  /** Identifiant de l'aléa (`seisme`, `explosion`…) et son nom affiché. */
  scenario: string;
  scenarioLabel: string;
  /** Scénario précis : l'aléa seul en quadrillage, `seisme-2` en campagne variée. */
  variant: string;
  /** Ce scénario en clair : intensité, foyer, tirage. */
  variantLabel: string;
  /** Ses réglages, pour pouvoir le rejouer. */
  params: { magnitude: number; east: number; north: number; windFrom: number; seed: number };
  lon: number;
  lat: number;
  /** Hauteur de la caméra au-dessus du sol, en mètres. */
  agl: number;
  /** Cap de l'image : la direction en haut du cadre, en degrés. */
  heading: number;
  /** Côté de l'emprise au sol, en mètres. */
  footprint: number;
  /** Résolution au sol, en centimètres par pixel. */
  gsd: number;
  /** Côté de l'image, en pixels. */
  size: number;
  annotations: Annotation[];
}

const fixed = (v: number, digits: number) => Number(v.toFixed(digits));

/** Étiquettes YOLO : une ligne par bâtiment, classe puis boîte normalisée. */
export function yoloLabels(record: ImageRecord): string {
  const s = record.size;
  return record.annotations
    .map(({ classId, bbox: [x, y, w, h] }) =>
      [classId, (x + w / 2) / s, (y + h / 2) / s, w / s, h / s]
        .map((v, i) => (i === 0 ? String(v) : v.toFixed(6)))
        .join(' '),
    )
    .join('\n');
}

/** Configuration YOLO (format Ultralytics). */
export function yoloConfig(): string {
  return [
    '# Drone Recon : images nadir annotées, format YOLO.',
    '# Aucune séparation entraînement / validation : à faire selon votre usage.',
    'path: .',
    'train: images',
    'val: images',
    'names:',
    ...DAMAGE_ORDER.map((state, i) => `  ${i}: ${state}`),
    '',
  ].join('\n');
}

/** Document COCO complet. */
export function cocoDocument(records: ImageRecord[], createdAt: Date): unknown {
  let annotationId = 0;
  return {
    info: {
      description: 'Drone Recon — images nadir annotées après sinistre, à Mulhouse',
      version: '1.0',
      year: createdAt.getFullYear(),
      contributor: 'Drone Recon',
      date_created: createdAt.toISOString(),
    },
    licenses: [
      {
        id: 1,
        name: 'Données IGN, Licence Ouverte Etalab 2.0',
        url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
      },
    ],
    categories: DAMAGE_ORDER.map((state, i) => ({
      id: i + 1,
      name: state,
      supercategory: 'batiment',
      label_fr: DAMAGE_INFO[state].label,
    })),
    images: records.map((r, i) => ({
      id: i + 1,
      file_name: r.file,
      width: r.size,
      height: r.size,
      license: 1,
      scenario: r.scenario,
      variante: r.variant,
      graine: r.params.seed,
      longitude: fixed(r.lon, 7),
      latitude: fixed(r.lat, 7),
      altitude_sol_m: fixed(r.agl, 1),
      cap_deg: fixed(r.heading, 1),
      emprise_m: fixed(r.footprint, 2),
      resolution_cm_px: fixed(r.gsd, 2),
    })),
    annotations: records.flatMap((r, i) =>
      r.annotations.map((a) => ({
        id: ++annotationId,
        image_id: i + 1,
        category_id: a.classId + 1,
        bbox: a.bbox,
        area: fixed(a.bbox[2] * a.bbox[3], 1),
        segmentation: a.polygon.length ? [a.polygon] : [],
        iscrowd: 0,
        attributes: {
          building_id: a.buildingId,
          source_id: a.sourceId ?? null,
          damage: a.damage,
          visible: a.visible,
        },
      })),
    ),
  };
}

/** Une ligne par image : où et comment elle a été prise, et ce qu'elle contient. */
export function metadataCsv(records: ImageRecord[]): string {
  const header = [
    'image',
    'scenario',
    'variante',
    'grandeur',
    'foyer_est_m',
    'foyer_nord_m',
    'vent_deg',
    'graine',
    'longitude',
    'latitude',
    'altitude_sol_m',
    'cap_deg',
    'emprise_m',
    'resolution_cm_px',
    'batiments',
    'endommages',
  ];
  const rows = records.map((r) =>
    [
      r.file,
      r.scenario,
      r.variant,
      r.params.magnitude,
      r.params.east,
      r.params.north,
      r.params.windFrom,
      r.params.seed,
      r.lon.toFixed(7),
      r.lat.toFixed(7),
      r.agl.toFixed(1),
      r.heading.toFixed(1),
      r.footprint.toFixed(2),
      r.gsd.toFixed(2),
      r.annotations.length,
      r.annotations.filter((a) => a.state !== 'intact').length,
    ].join(','),
  );
  return [header.join(','), ...rows, ''].join('\n');
}

export interface ReadmeSettings {
  createdAt: Date;
  /** Quadrillage à hauteur fixe, ou campagne variée. */
  campaign: 'grille' | 'variee';
  /** Hauteurs de vol extrêmes, en mètres : deux fois la même pour le quadrillage. */
  altitudes: [number, number];
  imageSize: number;
  fov: number;
  minVisible: number;
  complete: boolean;
}

/** Notice du jeu de données, en Markdown. */
export function readme(records: ImageRecord[], settings: ReadmeSettings): string {
  const counts = new Map(DAMAGE_ORDER.map((s) => [s, 0]));
  for (const r of records)
    for (const a of r.annotations) counts.set(a.state, counts.get(a.state)! + 1);
  const byVariant = new Map<string, { label: string; images: number }>();
  for (const r of records) {
    const entry = byVariant.get(r.variant) ?? { label: r.variantLabel, images: 0 };
    entry.images++;
    byVariant.set(r.variant, entry);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const fr = (v: number, digits = 0) =>
    v.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  /** Une valeur, ou son étendue quand elle varie d'une image à l'autre. */
  const span = (values: number[], digits: number) => {
    const low = fr(Math.min(...values), digits);
    const high = fr(Math.max(...values), digits);
    return low === high ? low : `de ${low} à ${high}`;
  };

  const varied = settings.campaign === 'variee';
  const [lowest, highest] = settings.altitudes;
  const view = varied
    ? `verticale, cap tiré au hasard, entre ${lowest} et ${highest} m du sol, champ de ${settings.fov}°`
    : `verticale, nord en haut, à ${lowest} m du sol, champ de ${settings.fov}°`;
  const footprints = records.length ? records.map((r) => r.footprint) : [0];
  const gsds = records.length ? records.map((r) => r.gsd) : [0];
  const method = varied
    ? `Chaque aléa est joué quatre fois — d'autres foyers, intensités et tirages —,
depuis la ville intacte, puis photographié à son état final. La plupart des
images sont centrées sur un bâtiment endommagé tiré au hasard, les effondrés
plus souvent que les autres, avec un décalage, un cap et une hauteur eux aussi
tirés au hasard ; les autres survolent le bâti, pris au hasard.

Les images se recouvrent. Pour séparer entraînement et validation, il faut les
regrouper par zone géographique (\`metadonnees.csv\` donne la position de
chacune), jamais au hasard : sinon le modèle serait validé sur des rues qu'il a
déjà vues.`
    : `Chaque aléa est joué avec ses réglages par défaut, depuis la ville intacte, puis
photographié à son état final. La zone est balayée en quadrillage, sans
recouvrement ; une case sans bâtiment n'est pas photographiée.`;

  return `# Drone Recon — jeu de données

Images verticales (nadir) du centre de Mulhouse après un sinistre simulé, avec
l'état de chaque bâtiment. Produit par le simulateur Drone Recon le
${settings.createdAt.toLocaleString('fr-FR')}.${settings.complete ? '' : '\n\n**Export interrompu avant la fin** : le jeu ne contient que les images prises jusque-là.'}

## Contenu

| | |
| --- | --- |
| Images | ${fr(records.length)}, ${settings.imageSize} × ${settings.imageSize} px, JPEG |
| Bâtiments annotés | ${fr(total)} |
| Prise de vue | ${view} |
| Emprise d'une image | ${span(footprints, 1)} m de côté, soit ${span(gsds, 1)} cm par pixel |

| ${varied ? 'Scénario' : 'Aléa'} | Images |
| --- | --- |
${[...byVariant.values()].map((s) => `| ${s.label} | ${fr(s.images)} |`).join('\n')}

${method}

## Fichiers

- \`images/\` : les images.
- \`labels/\` : les étiquettes au format YOLO, une par image (classe, centre et
  taille de la boîte, normalisés entre 0 et 1).
- \`data.yaml\` : la configuration YOLO. Aucune séparation entraînement /
  validation n'est faite.
- \`annotations.json\` : les mêmes annotations au format COCO, avec le contour
  du toit (\`segmentation\`) et, pour chaque bâtiment, son identifiant, sa
  sévérité de 0 à 1 et la part restée dans le cadre.
- \`metadonnees.csv\` : scénario, position, hauteur, cap et résolution de chaque
  image.

## Classes

| Rang YOLO | Classe | État | Annotations |
| --- | --- | --- | --- |
${DAMAGE_ORDER.map((s, i) => `| ${i} | \`${s}\` | ${DAMAGE_INFO[s].label} | ${fr(counts.get(s)!)} |`).join('\n')}

## Comment les annotations sont calculées

Elles viennent de la vérité du simulateur, sans bruit. Le contour du toit est
projeté à la hauteur qui reste au bâtiment ; la boîte englobe le toit et le
pied, car loin du centre de l'image la perspective montre une façade. Un
bâtiment coupé par le bord n'est annoté que s'il en reste au moins
${Math.round(settings.minVisible * 100)} % dans le cadre. Les occultations
entre bâtiments sont ignorées.

## Limites à connaître

- **Images de synthèse.** La ville est dessinée d'après les données de l'IGN :
  bâtiments extrudés de la BD TOPO®, façades et toits procéduraux, posés sur la
  photographie aérienne BD ORTHO®. Un modèle entraîné ici devra être validé
  sur de vraies images de drone.
- **La classe \`cracked\` n'a pas de signature visuelle** dans ce rendu : un
  bâtiment fissuré est dessiné comme un bâtiment intact. Il peut être utile de
  la fusionner avec \`intact\`, ou de l'écarter.
- **Sous les ruines, la photographie aérienne** montre parfois le toit intact
  d'origine, dans la marge que les gravats ne couvrent pas.
- **Fumée, flammes et eau sont masquées** pendant la prise de vue : les images
  montrent l'état des bâtiments sans ces effets.

## Sources et licence

Données : © IGN — BD TOPO®, RGE ALTI®, BD ORTHO® — Licence Ouverte Etalab 2.0.
Toute réutilisation doit mentionner cette source. Les images ne contiennent
aucun élément du relevé photoréaliste de Google.
`;
}
