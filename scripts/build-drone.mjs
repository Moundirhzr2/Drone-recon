/**
 * Modèle 3D du drone, généré par le code : `public/models/drone.glb`.
 *
 * Un quadricoptère d'inspection à la taille réelle — 0,9 m entre moteurs
 * opposés, hélices de 21 pouces, nacelle de caméra sous le nez, patins
 * d'atterrissage —, dessiné pièce par pièce, avec des matériaux physiques
 * (plastique, carbone, métal, verre) que Cesium éclaire comme le reste de la
 * scène. Le générer plutôt que le télécharger : aucune licence à suivre, et
 * chaque cote se lit et se corrige ici.
 *
 * Repère : +Y en haut, le nez vers +X, la droite vers +Z. Cesium amène l'avant
 * d'un glTF (+Z) sur son axe +X ; avec ce choix, le nez tombe sur +Y, qui est
 * l'avant du repère du drone (voir `src/drone/model.ts`).
 *
 * Les quatre hélices sont des nœuds à part, nommés, que l'application fait
 * tourner à chaque image. Toutes les pièces restent au-dessus de 0,9 m sous
 * l'origine : c'est de là que filme la caméra nadir.
 *
 * Usage : npm run model:drone
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = 'public/models/drone.glb';
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Petite algèbre
// ---------------------------------------------------------------------------

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a) => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** Matrices 3×3, rangées ligne par ligne. */
const rotY = (t) => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];
const rotZ = (t) => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
const apply = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** Rotation qui amène l'axe +Y sur la direction `d` (formule de Rodrigues). */
function alignY(d) {
  const y = [0, 1, 0];
  const c = dot(y, d);
  if (c > 0.999999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -0.999999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const [x, , z] = normalize(cross(y, d));
  const s = Math.sqrt(1 - c * c);
  const t = 1 - c;
  return [t * x * x + c, -s * z, t * x * z, s * z, c, -s * x, t * x * z, s * x, t * z * z + c];
}

// ---------------------------------------------------------------------------
// Formes de base
// ---------------------------------------------------------------------------

/** Maillage : positions et normales à plat, triangles indexés. */
const mesh = () => ({ p: [], n: [], i: [] });

function vertex(g, p, n) {
  g.p.push(p[0], p[1], p[2]);
  g.n.push(n[0], n[1], n[2]);
  return g.p.length / 3 - 1;
}

/** Déplace un maillage : rotation `m` puis translation `t`. */
function place(g, m, t = [0, 0, 0]) {
  const out = mesh();
  for (let k = 0; k < g.p.length; k += 3) {
    vertex(
      out,
      add(apply(m, [g.p[k], g.p[k + 1], g.p[k + 2]]), t),
      apply(m, [g.n[k], g.n[k + 1], g.n[k + 2]]),
    );
  }
  out.i = g.i.slice();
  return out;
}

const moved = (g, t) => place(g, [1, 0, 0, 0, 1, 0, 0, 0, 1], t);

/**
 * Boîte aux arêtes arrondies, centrée sur l'origine, de demi-côtés `h`.
 *
 * Chaque face est une grille : une seule maille sur le plat, `K` dans chaque
 * arrondi, espacées à angle constant pour que la courbure soit régulière. Les
 * points sont ensuite plaqués sur la boîte intérieure grossie d'une sphère de
 * rayon `r` — d'où des normales exactes, continues d'une face à l'autre.
 */
function roundedBox(h, r, K = 3) {
  const g = mesh();
  const inner = h.map((v) => Math.max(v - r, 0));
  const coords = (axis) => {
    const band = [];
    for (let k = 0; k <= K; k++) band.push(inner[axis] + r * Math.tan((Math.PI / 4) * (k / K)));
    return [...band.map((x) => -x).reverse(), ...band];
  };
  // Normale, puis axes u et v de la grille, tels que u × v = normale.
  const FACES = [
    [0, 1, [2, -1], [1, 1]],
    [0, -1, [2, 1], [1, 1]],
    [1, 1, [0, 1], [2, -1]],
    [1, -1, [0, 1], [2, 1]],
    [2, 1, [0, 1], [1, 1]],
    [2, -1, [0, -1], [1, 1]],
  ];
  for (const [axis, sign, [ua, us], [va, vs]] of FACES) {
    const U = coords(ua);
    const V = coords(va);
    const base = g.p.length / 3;
    for (const v of V) {
      for (const u of U) {
        const P = [0, 0, 0];
        P[axis] = sign * h[axis];
        P[ua] = us * u;
        P[va] = vs * v;
        const Q = P.map((x, k) => Math.min(Math.max(x, -inner[k]), inner[k]));
        const n = normalize(sub(P, Q));
        vertex(g, add(Q, mul(n, r)), n);
      }
    }
    const cols = U.length;
    for (let j = 0; j < V.length - 1; j++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = base + j * cols + k;
        g.i.push(a, a + 1, a + cols + 1, a, a + cols + 1, a + cols);
      }
    }
  }
  return g;
}

/** Cylindre, ou tronc de cône, d'axe Y, de y0 (rayon r0) à y1 (rayon r1). */
function cylinder(r0, r1, y0, y1, seg = 24) {
  const g = mesh();
  const slope = (r0 - r1) / (y1 - y0);
  for (let k = 0; k <= seg; k++) {
    const t = (k / seg) * 2 * Math.PI;
    const n = normalize([Math.cos(t), slope, Math.sin(t)]);
    vertex(g, [r0 * Math.cos(t), y0, r0 * Math.sin(t)], n);
    vertex(g, [r1 * Math.cos(t), y1, r1 * Math.sin(t)], n);
  }
  for (let k = 0; k < seg; k++) {
    const b = 2 * k;
    g.i.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  // Fonds : sommets à part, pour une arête franche.
  for (const [y, r, up] of [
    [y1, r1, 1],
    [y0, r0, -1],
  ]) {
    if (r <= 0) continue;
    const c = vertex(g, [0, y, 0], [0, up, 0]);
    for (let k = 0; k <= seg; k++) {
      const t = (k / seg) * 2 * Math.PI;
      vertex(g, [r * Math.cos(t), y, r * Math.sin(t)], [0, up, 0]);
    }
    for (let k = 0; k < seg; k++) {
      if (up > 0) g.i.push(c, c + k + 2, c + k + 1);
      else g.i.push(c, c + k + 1, c + k + 2);
    }
  }
  return g;
}

/** Tube de rayon r entre deux points. */
function tube(from, to, r, seg = 16) {
  const d = sub(to, from);
  const L = Math.hypot(d[0], d[1], d[2]);
  return place(cylinder(r, r, 0, L, seg), alignY(normalize(d)), from);
}

function sphere(r, seg = 16, rings = 10) {
  const g = mesh();
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    for (let k = 0; k <= seg; k++) {
      const t = (k / seg) * 2 * Math.PI;
      const n = [Math.sin(phi) * Math.cos(t), Math.cos(phi), Math.sin(phi) * Math.sin(t)];
      vertex(g, mul(n, r), n);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let k = 0; k < seg; k++) {
      const a = j * (seg + 1) + k;
      const b = a + seg + 1;
      g.i.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return g;
}

/** Disque horizontal, face vers le haut : le flou d'une hélice qui tourne. */
function disc(r, seg = 48) {
  const g = mesh();
  const c = vertex(g, [0, 0, 0], [0, 1, 0]);
  for (let k = 0; k <= seg; k++) {
    const t = (k / seg) * 2 * Math.PI;
    vertex(g, [r * Math.cos(t), 0, r * Math.sin(t)], [0, 1, 0]);
  }
  for (let k = 0; k < seg; k++) g.i.push(c, c + k + 2, c + k + 1);
  return g;
}

/**
 * Hélice bipale : deux pales amincies et vrillées, du moyeu au saumon.
 *
 * Profil elliptique, corde et épaisseur qui décroissent vers l'extrémité,
 * vrillage de 24° au pied à 10° au bout. `sens` inverse le vrillage : une
 * hélice qui tourne dans l'autre sens est l'image de la première dans un
 * miroir. Normales lissées d'après les triangles ; le matériau des pales est
 * vu des deux côtés, l'orientation des faces n'a donc pas d'importance.
 */
function propeller(R, sens) {
  const g = mesh();
  const S = 14;
  const M = 10;
  const r0 = 0.03;
  for (const side of [0, Math.PI]) {
    const base = g.p.length / 3;
    for (let s = 0; s <= S; s++) {
      const k = s / S;
      const x = r0 + (R - r0) * k;
      const round = Math.sqrt(Math.max(0, 1 - k ** 8));
      const chord = (0.052 - 0.026 * k) * round + 0.002;
      const thick = (0.01 - 0.006 * k) * round + 0.001;
      const twist = sens * (24 - 14 * k) * DEG;
      for (let m = 0; m < M; m++) {
        const phi = (m / M) * 2 * Math.PI;
        const z = (chord / 2) * Math.cos(phi);
        const y = (thick / 2) * Math.sin(phi);
        const p = [
          x,
          y * Math.cos(twist) + z * Math.sin(twist),
          z * Math.cos(twist) - y * Math.sin(twist),
        ];
        vertex(g, apply(rotY(side), p), [0, 0, 0]);
      }
    }
    for (let s = 0; s < S; s++) {
      for (let m = 0; m < M; m++) {
        const a = base + s * M + m;
        const b = base + s * M + ((m + 1) % M);
        g.i.push(a, b, a + M, b, b + M, a + M);
      }
    }
    // Pied et saumon fermés en éventail.
    for (const [ring, flip] of [
      [0, true],
      [S, false],
    ]) {
      const center = mul(
        [0, 1, 2].map((c) => {
          let sum = 0;
          for (let m = 0; m < M; m++) sum += g.p[(base + ring * M + m) * 3 + c];
          return sum;
        }),
        1 / M,
      );
      const c = vertex(g, center, [0, 0, 0]);
      for (let m = 0; m < M; m++) {
        const a = base + ring * M + m;
        const b = base + ring * M + ((m + 1) % M);
        if (flip) g.i.push(c, b, a);
        else g.i.push(c, a, b);
      }
    }
  }
  smoothNormals(g);
  // Moyeu.
  return merge(g, cylinder(0.034, 0.03, -0.012, 0.018, 20));
}

/** Normales moyennées sur les triangles adjacents. */
function smoothNormals(g) {
  const acc = new Array(g.p.length).fill(0);
  const at = (k) => [g.p[k * 3], g.p[k * 3 + 1], g.p[k * 3 + 2]];
  for (let t = 0; t < g.i.length; t += 3) {
    const [a, b, c] = [g.i[t], g.i[t + 1], g.i[t + 2]];
    const n = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) acc[v * 3 + k] += n[k];
  }
  for (let v = 0; v < g.p.length / 3; v++) {
    const n = normalize([acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]]);
    g.n.splice(v * 3, 3, ...n);
  }
}

/** Réunit des maillages en un seul : un matériau, un appel de dessin. */
function merge(...parts) {
  const g = mesh();
  for (const part of parts) {
    const offset = g.p.length / 3;
    g.p.push(...part.p);
    g.n.push(...part.n);
    for (const i of part.i) g.i.push(i + offset);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Matériaux
// ---------------------------------------------------------------------------

/** Couleur sRGB « #rrggbb » vers les composantes linéaires qu'attend glTF. */
function linear(hex, alpha = 1) {
  const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
  return [...c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)), alpha];
}

const MATERIALS = {
  coque: { color: linear('#3b4148'), metallic: 0.15, roughness: 0.5 },
  capot: { color: linear('#6e767f'), metallic: 0.1, roughness: 0.42 },
  carbone: { color: linear('#1d2023'), metallic: 0.35, roughness: 0.32 },
  moteur: { color: linear('#b9bfc5'), metallic: 0.9, roughness: 0.28 },
  helice: { color: linear('#1a1c1f'), metallic: 0.05, roughness: 0.45, doubleSided: true },
  flou: {
    color: linear('#cfd6dc', 0.13),
    metallic: 0,
    roughness: 0.7,
    blend: true,
    doubleSided: true,
  },
  verre: { color: linear('#0b1118'), metallic: 0.6, roughness: 0.08 },
  // Feux de navigation, comme en aviation : rouge à gauche, vert à droite,
  // blanc à l'arrière. Ils disent d'un coup d'œil dans quel sens vole le drone.
  feu_rouge: { color: linear('#ff2a1a'), metallic: 0, roughness: 0.3, emissive: [1, 0.07, 0.04] },
  feu_vert: { color: linear('#20ff60'), metallic: 0, roughness: 0.3, emissive: [0.08, 1, 0.22] },
  feu_blanc: { color: linear('#ffffff'), metallic: 0, roughness: 0.3, emissive: [1, 1, 1] },
  // Le cyan de l'interface, en liseré discret.
  accent: { color: linear('#00e5ff'), metallic: 0.2, roughness: 0.35, emissive: [0, 0.35, 0.42] },
};

// ---------------------------------------------------------------------------
// Le drone
// ---------------------------------------------------------------------------

/** Distance du centre à chaque moteur : 0,9 m entre moteurs opposés. */
const REACH = 0.45;
/** Rayon d'hélice : 21 pouces de diamètre. */
const PROP = 0.265;
/** Hauteur des moyeux d'hélice. */
const HUB_Y = 0.098;

/**
 * Bras en X, repérés par leur angle depuis le nez, vers la droite. Sens de
 * rotation vu de dessus (+1 anti-horaire) : les hélices diagonales tournent
 * dans le même sens, ce qui annule le couple de lacet en vol stationnaire.
 */
const ARMS = [
  { name: 'helice_avant_droite', angle: 45, sens: 1, light: 'feu_vert' },
  { name: 'helice_arriere_droite', angle: 135, sens: -1, light: 'feu_blanc' },
  { name: 'helice_arriere_gauche', angle: 225, sens: 1, light: 'feu_blanc' },
  { name: 'helice_avant_gauche', angle: 315, sens: -1, light: 'feu_rouge' },
];

const parts = Object.fromEntries(Object.keys(MATERIALS).map((k) => [k, []]));

// Fuselage : corps, capot supérieur, barre de capteurs à l'avant.
parts.coque.push(roundedBox([0.22, 0.075, 0.14], 0.035, 4));
parts.capot.push(moved(roundedBox([0.16, 0.028, 0.11], 0.02, 3), [-0.025, 0.085, 0]));
parts.verre.push(moved(roundedBox([0.012, 0.024, 0.085], 0.008, 2), [0.222, 0.012, 0]));
parts.accent.push(moved(roundedBox([0.045, 0.004, 0.01], 0.003, 1), [0.16, 0.077, 0]));
// Récepteur GNSS et antennes de liaison.
parts.capot.push(moved(cylinder(0.034, 0.03, 0, 0.018, 24), [-0.05, 0.112, 0]));
for (const z of [-0.085, 0.085]) {
  const tip = [-0.19, 0.19, z * 1.35];
  parts.carbone.push(tube([-0.17, 0.07, z], tip, 0.006, 10));
  parts.carbone.push(moved(sphere(0.009, 10, 6), tip));
}

for (const arm of ARMS) {
  const a = arm.angle * DEG;
  const dir = [Math.cos(a), 0, Math.sin(a)];
  const motor = [REACH * dir[0], 0, REACH * dir[2]];
  // Bras en tube de carbone, avec sa rotule de repliage près du corps.
  parts.carbone.push(tube(add(mul(dir, 0.13), [0, 0.02, 0]), add(motor, [0, 0.02, 0]), 0.019, 18));
  parts.coque.push(
    place(roundedBox([0.04, 0.03, 0.032], 0.01, 2), rotY(-a), add(mul(dir, 0.17), [0, 0.02, 0])),
  );
  // Liseré près du moteur.
  parts.accent.push(
    place(
      cylinder(0.0205, 0.0205, 0, 0.016, 18),
      alignY(dir),
      add(mul(dir, REACH - 0.09), [0, 0.02, 0]),
    ),
  );
  // Moteur : support, cloche métallique, capuchon.
  parts.carbone.push(moved(cylinder(0.04, 0.04, -0.012, 0.035, 24), motor));
  parts.moteur.push(moved(cylinder(0.046, 0.044, 0.035, 0.078, 28), motor));
  parts.carbone.push(moved(cylinder(0.022, 0.018, 0.078, 0.088, 20), motor));
  // Flou de l'hélice en rotation, fixe : c'est lui qui donne la vitesse.
  parts.flou.push(moved(disc(PROP - 0.004), add(motor, [0, HUB_Y + 0.002, 0])));
  // Feu de navigation sous le moteur.
  parts[arm.light].push(moved(sphere(0.013, 12, 8), add(motor, [0, -0.02, 0])));
}

// Train d'atterrissage : deux patins, chacun porté par deux jambes.
for (const z of [-1, 1]) {
  const skid = 0.19 * z;
  parts.carbone.push(tube([-0.2, -0.3, skid], [0.2, -0.3, skid], 0.011, 14));
  for (const x of [-0.2, 0.2]) parts.carbone.push(moved(sphere(0.011, 10, 6), [x, -0.3, skid]));
  for (const x of [-0.09, 0.09]) {
    parts.carbone.push(tube([x, -0.06, 0.1 * z], [x * 1.25, -0.3, skid], 0.01, 12));
  }
}

// Nacelle de caméra sous le nez, pointée vers l'avant et le bas.
parts.carbone.push(tube([0.15, -0.07, 0], [0.15, -0.105, 0], 0.012, 14));
parts.coque.push(moved(roundedBox([0.02, 0.032, 0.065], 0.008, 2), [0.15, -0.125, 0]));
{
  const tilt = rotZ(-20 * DEG);
  const at = [0.165, -0.15, 0];
  parts.capot.push(place(roundedBox([0.055, 0.045, 0.05], 0.016, 3), tilt, at));
  const lensAxis = apply(tilt, [1, 0, 0]);
  const lensFrom = add(at, mul(lensAxis, 0.05));
  parts.moteur.push(place(cylinder(0.031, 0.031, 0, 0.012, 24), alignY(lensAxis), lensFrom));
  parts.verre.push(place(cylinder(0.025, 0.022, 0.012, 0.022, 24), alignY(lensAxis), lensFrom));
}

// ---------------------------------------------------------------------------
// Contrôle : chaque face doit regarder vers l'extérieur
// ---------------------------------------------------------------------------

/**
 * Compare l'orientation de chaque triangle à la normale de ses sommets. Un
 * triangle retourné serait invisible (faces arrière éliminées) ou éclairé à
 * l'envers : mieux vaut échouer ici que le découvrir à l'écran.
 */
function checkWinding(name, g) {
  let wrong = 0;
  const at = (k) => [g.p[k * 3], g.p[k * 3 + 1], g.p[k * 3 + 2]];
  const nrm = (k) => [g.n[k * 3], g.n[k * 3 + 1], g.n[k * 3 + 2]];
  for (let t = 0; t < g.i.length; t += 3) {
    const [a, b, c] = [g.i[t], g.i[t + 1], g.i[t + 2]];
    const face = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    if (Math.hypot(...face) < 1e-12) continue;
    if (dot(face, add(add(nrm(a), nrm(b)), nrm(c))) < 0) wrong++;
  }
  if (wrong) throw new Error(`${name} : ${wrong} triangle(s) retourné(s)`);
}

// ---------------------------------------------------------------------------
// Écriture du glTF binaire
// ---------------------------------------------------------------------------

const json = {
  asset: { version: '2.0', generator: 'drone-recon scripts/build-drone.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [],
  meshes: [],
  materials: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
};
const chunks = [];
let byteLength = 0;

function view(typed, target) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
  chunks.push(bytes, Buffer.alloc(pad));
  byteLength += bytes.length + pad;
  return json.bufferViews.length - 1;
}

function accessor(typed, type, target, extra = {}) {
  const componentType =
    typed instanceof Float32Array ? 5126 : typed instanceof Uint32Array ? 5125 : 5123;
  const size = type === 'VEC3' ? 3 : 1;
  json.accessors.push({
    bufferView: view(typed, target),
    componentType,
    count: typed.length / size,
    type,
    ...extra,
  });
  return json.accessors.length - 1;
}

function primitive(g, material) {
  const positions = new Float32Array(g.p);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < positions.length; k++) {
    min[k % 3] = Math.min(min[k % 3], positions[k]);
    max[k % 3] = Math.max(max[k % 3], positions[k]);
  }
  const Index = g.p.length / 3 > 65535 ? Uint32Array : Uint16Array;
  return {
    attributes: {
      POSITION: accessor(positions, 'VEC3', 34962, { min, max }),
      NORMAL: accessor(new Float32Array(g.n), 'VEC3', 34962),
    },
    indices: accessor(new Index(g.i), 'SCALAR', 34963),
    material,
  };
}

const materialIndex = {};
for (const [name, m] of Object.entries(MATERIALS)) {
  materialIndex[name] = json.materials.length;
  json.materials.push({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: m.color,
      metallicFactor: m.metallic,
      roughnessFactor: m.roughness,
    },
    ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
    ...(m.blend ? { alphaMode: 'BLEND' } : {}),
    ...(m.doubleSided ? { doubleSided: true } : {}),
  });
}

// Châssis : un maillage, une primitive par matériau.
const frame = { name: 'chassis', primitives: [] };
let triangles = 0;
for (const [name, list] of Object.entries(parts)) {
  if (!list.length || name === 'helice') continue;
  const g = merge(...list);
  if (!MATERIALS[name].doubleSided) checkWinding(name, g);
  frame.primitives.push(primitive(g, materialIndex[name]));
  triangles += g.i.length / 3;
}
json.meshes.push(frame);

// Deux hélices : une par sens de rotation.
const propMesh = {};
for (const sens of [1, -1]) {
  const g = propeller(PROP, sens);
  propMesh[sens] = json.meshes.length;
  json.meshes.push({
    name: sens > 0 ? 'helice_anti_horaire' : 'helice_horaire',
    primitives: [primitive(g, materialIndex.helice)],
  });
  triangles += (g.i.length / 3) * 2;
}

json.nodes.push({ name: 'drone', children: [1, 2, 3, 4, 5] });
json.nodes.push({ name: 'chassis', mesh: 0 });
for (const arm of ARMS) {
  const a = arm.angle * DEG;
  json.nodes.push({
    name: arm.name,
    mesh: propMesh[arm.sens],
    translation: [REACH * Math.cos(a), HUB_Y, REACH * Math.sin(a)],
  });
}

json.buffers.push({ byteLength });
const bin = Buffer.concat(chunks);
let text = Buffer.from(JSON.stringify(json));
text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // « glTF »
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
const chunk = (type, data) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]));
console.log(
  `${OUT} : ${triangles} triangles, ${Math.round((12 + 16 + text.length + bin.length) / 1024)} Ko`,
);
