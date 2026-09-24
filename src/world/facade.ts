/**
 * Texture des bâtiments.
 *
 * POURQUOI UN SHADER ET PAS UNE IMAGE
 * -----------------------------------
 * Une texture photographique posée sur une boîte s'étire : les coordonnées `st`
 * d'un cube vont de 0 à 1 par face, quelle que soit sa taille réelle. Un pavillon
 * de 8 m et une tour de 96 m recevraient donc le MÊME nombre de rangées de
 * fenêtres — l'échelle du quartier deviendrait illisible, et c'est précisément
 * l'échelle qu'un pilote de reconnaissance doit lire.
 *
 * On génère donc le motif dans le fragment shader, à partir des dimensions
 * réelles de chaque mur : un étage fait 3 à 3,4 m selon l'époque, une travée
 * 3,1 à 3,6 m. Un immeuble de 30 m montre neuf étages parce qu'il en a neuf.
 *
 * CE QUE DESSINE LE SHADER
 * ------------------------
 * Chaque façade suit l'époque de construction et l'usage que déclare l'IGN :
 *   - avant 1914 : enduits pastel, encadrements de pierre, volets battants,
 *     bandeaux d'étage, chaînages d'angle — la vieille ville de Mulhouse ;
 *   - de 1914 à 1974 : volets roulants plus ou moins baissés, balcons ;
 *   - après 1974 : bandeaux vitrés, murs-rideaux pour les bureaux ;
 *   - vitrines et enseignes au pied des immeubles commerçants ;
 *   - édifices religieux en grès, baies en plein cintre ; annexes aveugles.
 * Chaque toiture suit sa couverture et sa forme, déclarées elles aussi par
 * l'IGN : tuiles, ardoises, zinc, terrasse gravillonnée et ses édicules,
 * verrière.
 *
 * Tous les motifs sont filtrés : de loin, ils se fondent vers leur teinte
 * moyenne au lieu de scintiller (voir `detail`).
 *
 * POURQUOI UNE APPARENCE MAISON
 * -----------------------------
 * `MaterialAppearance` porterait bien une texture, mais il ignore la couleur par
 * instance — or c'est elle qui porte tout le reste du projet : teintes par usage,
 * états de dommage, et surtout la vue diagnostique qui recolore les bâtiments un
 * par un. On garde donc l'attribut `color` et on le MULTIPLIE par le motif.
 *
 * Deux attributs de géométrie transportent le reste :
 *   surf.x = style de surface (voir SURFACE)
 *   surf.y = longueur de référence, en mètres
 *   surf.z = hauteur, en mètres
 *   facade = pour un mur, son style (époque, usage, graine, commerces) ; pour un
 *            toit réel, la position du sommet en mètres le long de l'égout et
 *            dans la pente, le code de couverture et la graine.
 *
 * Ils sont figés à la construction (voir `texturedBox` pour la raison). Seule la
 * couleur par instance reste modifiable à chaud : c'est donc son canal alpha
 * qui porte la bascule vers l'aplat de la vue diagnostique, sans reconstruire
 * la géométrie.
 */

import * as Cesium from 'cesium';
import earcut from 'earcut';

/** Styles de surface reconnus par le shader. */
export const SURFACE = {
  /** Façade : grille de fenêtres à l'échelle réelle. */
  facade: 0,
  /** Toiture : bandes de couverture. */
  roof: 1,
  /** Gravats et ruines : bruit sec, aucun motif régulier. */
  rubble: 2,
  /** Aplat pur : la couleur d'instance et rien d'autre (vue diagnostique). */
  flat: 3,
  /** Façade incendiée : baies vides et traînées de suie au-dessus. */
  charred: 4,
  /**
   * Toiture d'un bâtiment réel : sa couverture — tuiles, ardoises, métal,
   * terrasse, verrière — et sa forme viennent de la BD TOPO®.
   */
  roofReal: 5,
} as const;

/**
 * Style de façade d'un bâtiment, transmis au shader :
 * époque (0 : avant 1914, 1 : 1914-1974, 2 : après 1974), usage (voir
 * `FACADE_KIND`), graine propre au bâtiment entre 0 et 1, et 1 s'il a des
 * commerces au rez-de-chaussée.
 */
export type FacadeVariant = readonly [era: number, kind: number, seed: number, shop: number];

/** Codes d'usage lus par le shader. */
export const FACADE_KIND = {
  residentiel: 0,
  commerce: 1,
  bureau: 2,
  industriel: 3,
  civique: 4,
  religieux: 5,
  annexe: 6,
  sportif: 7,
} as const;

/** Style neutre : immeuble d'après-guerre, sans commerce. */
export const DEFAULT_VARIANT: FacadeVariant = [1, 0, 0.5, 0];

/**
 * Couverture d'un toit réel, transmise au shader : code du matériau (1 tuiles,
 * 2 ardoises, 3 métal, 4 béton, 5 verre), augmenté de 10 si le toit est en
 * pente, et graine propre au bâtiment.
 */
export type RoofVariant = readonly [code: number, seed: number];

/** Codes de couverture lus par le shader. */
export const ROOF_CODE = { tuiles: 1, ardoises: 2, metal: 3, beton: 4, verre: 5 } as const;

/** Format de sommet exigé par ce shader. */
export const FACADE_VERTEX_FORMAT = Cesium.VertexFormat.POSITION_NORMAL_AND_ST;

/**
 * Les shaders sont écrits en GLSL ES 3.00, comme ceux de Cesium : `in` / `out`
 * et `out_FragColor`. Écrire `attribute` / `varying` fait échouer la
 * compilation sur « Illegal use of reserved word ».
 *
 * Les entrées par instance sont déclarées comme des entrées ordinaires, mais
 * Cesium les réécrit en lectures de sa table de lots, indexées par `batchId` —
 * qu'il faut donc déclarer, sans quoi la réécriture produit un shader invalide.
 */
const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;
in vec4 color;
in vec3 surf;
in vec4 facade;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;
out vec4 v_color;
out vec3 v_surf;
out vec4 v_facade;

void main()
{
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_normalEC = czm_normal * normal;
  v_st = st;
  v_color = color;
  v_surf = surf;
  v_facade = facade;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
in vec4 v_color;
in vec3 v_surf;
in vec4 v_facade;

// Bruit deterministe : deux facades voisines ne doivent pas etre identiques,
// mais une meme facade ne doit pas scintiller d'une image a l'autre.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Bruit lisse : les valeurs tirees aux coins d'une grille, fondues entre elles.
// Pour les salissures et les variations d'enduit : tire case par case, le
// meme bruit dessinait un damier de carres a bords nets.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Filtrage des motifs. Chaque motif est calcule au pixel pres : quand ses
// cellules ne couvrent plus qu'un ou deux pixels a l'ecran - une fenetre a
// 400 m, une rangee de tuiles a 150 m -, il saute d'un pixel a l'autre au
// moindre mouvement de camera, et la ville scintille. Une texture image y
// echapperait grace a ses mipmaps ; un motif calcule doit etre filtre a la
// main. detail() vaut 1 tant qu'une cellule couvre au moins 4 pixels, puis
// tombe a 0 vers 1,7 pixel : on fond alors le motif vers sa teinte moyenne.
float detail(vec2 cells) {
  vec2 w = fwidth(cells);
  return 1.0 - smoothstep(0.25, 0.6, max(w.x, w.y));
}

// --- Facades -----------------------------------------------------------------
//
// Tout y est exprime en metres sur le mur. Les largeurs de filtrage sont
// calculees une fois, avant tout embranchement : une derivee prise dans une
// branche que deux pixels voisins ne suivent pas tous deux n'est pas definie.

float fx; // metres de mur couverts par un pixel, en largeur
float fy; // idem, en hauteur

// Marche filtree : un bord s'etale sur un pixel au lieu de basculer d'un coup,
// ce qui supprime l'escalier des contours et leur scintillement.
float stepX(float edge, float v) { return smoothstep(edge - fx, edge + fx, v); }
float stepY(float edge, float v) { return smoothstep(edge - fy, edge + fy, v); }
// 1 entre a et b, 0 ailleurs.
float bandY(float v, float a, float b) { return stepY(a, v) * (1.0 - stepY(b, v)); }
float insideX(float halfWidth, float v) { return 1.0 - stepX(halfWidth, abs(v)); }
// Motif de periode (px, py) metres : 1 tant qu'il couvre 4 pixels, 0 vers 1,7.
float detailP(float px, float py) {
  return 1.0 - smoothstep(0.25, 0.6, max(fx / px, fy / py));
}

// Volets : les teintes qu'on voit en Alsace, du vert au rouge sang-de-boeuf.
vec3 shutterColor(float s) {
  if (s < 0.28) return vec3(0.25, 0.36, 0.27);
  if (s < 0.46) return vec3(0.33, 0.40, 0.46);
  if (s < 0.64) return vec3(0.38, 0.28, 0.20);
  if (s < 0.86) return vec3(0.70, 0.68, 0.63);
  return vec3(0.47, 0.20, 0.16);
}

// Un vitrage reflete le ciel, d'autant plus qu'on le regarde de biais (facteur
// de Fresnel) ; de face, on devine la penombre de la piece.
vec3 glassColor(float v) {
  vec3 toEye = normalize(-v_positionEC);
  float cosT = clamp(abs(dot(toEye, normalize(v_normalEC))), 0.0, 1.0);
  float fresnel = 0.08 + 0.92 * pow(1.0 - cosT, 4.0);
  vec3 interior = vec3(0.045, 0.05, 0.058) + 0.04 * v;
  vec3 sky = mix(vec3(0.30, 0.36, 0.43), vec3(0.46, 0.51, 0.56), v);
  return mix(interior, sky, clamp(fresnel + 0.25 * v, 0.0, 0.85));
}

vec3 facade(vec3 wall) {
  float era = v_facade.x;  // 0 : avant 1914, 1 : 1914-1974, 2 : apres 1974
  float kind = v_facade.y; // 0 logement, 1 commerce, 2 bureau, 3 industrie,
                           // 4 equipement, 5 culte, 6 annexe, 7 sport
  float seed = v_facade.z; // propre au batiment, entre 0 et 1
  float shop = v_facade.w; // 1 : commerces au rez-de-chaussee
  float len = v_surf.y;
  float H = v_surf.z;
  vec2 m = vec2(v_st.s * len, v_st.t * H);
  fx = max(fwidth(m.x), 1e-4) * 0.75;
  fy = max(fwidth(m.y), 1e-4) * 0.75;

  // Valeurs arrondies avant tout tirage au sort. Une valeur constante sur le
  // mur arrive au pixel avec d'infimes ecarts d'interpolation, que le hachage
  // amplifie : chaque pixel tirait autre chose, et les vitrages se couvraient
  // d'un moucheture qui scintillait au moindre mouvement.
  float sq = floor(seed * 997.0 + 0.5);
  float lq = floor(len * 8.0 + 0.5);
  vec2 salt = vec2(sq * 0.1731, sq * 0.0719);

  // Variations de l'enduit, en grandes taches fondues : un bruit fin
  // scintillerait, et des cases nettes feraient un damier.
  wall *= 0.95 + 0.07 * mix(0.5, vnoise(m * 0.45 + salt), detailP(2.2, 2.2));

  // --- Edifice religieux : gres en assises, baies en plein cintre -----------
  if (kind > 4.5 && kind < 5.5) {
    float course = step(0.5, fract(m.y / 0.42));
    wall *= 0.93 + 0.08 * mix(0.5, course, detailP(1e6, 0.42));
    float n = floor(len / 5.0);
    if (n < 1.0) return wall;
    float bayR = len / n;
    float xr = (fract(m.x / bayR) - 0.5) * bayR;
    float hw = min(0.8, bayR * 0.2);
    float bottom = min(3.0, H * 0.2);
    float spring = H * 0.7;
    float rect = insideX(hw, xr) * bandY(m.y, bottom, spring);
    float r = length(vec2(xr, (m.y - spring)));
    float arch = stepY(spring, m.y) * (1.0 - smoothstep(hw - fx, hw + fx, r));
    float win = max(rect, arch);
    vec3 glass = mix(vec3(0.10, 0.12, 0.17), vec3(0.24, 0.14, 0.16), hash21(floor(m * 1.5)));
    vec3 detailed = mix(wall, glass, win);
    float frac = (2.0 * hw * (spring - bottom) + 1.5708 * hw * hw) / (bayR * H);
    vec3 averaged = mix(wall, vec3(0.14, 0.13, 0.17), frac);
    return mix(averaged, detailed, detailP(bayR, H * 0.25));
  }

  // --- Annexes : murs aveugles, portes de garage ----------------------------
  if (kind > 5.5 && kind < 6.5) {
    float n = floor(len / 3.0);
    if (n < 1.0 || H < 2.4) return wall;
    float bw = len / n;
    float x = (fract(m.x / bw) - 0.5) * bw;
    float open = step(0.45, hash21(vec2(floor(m.x / bw), 0.0) + salt));
    float door = insideX(1.15, x) * (1.0 - stepY(2.15, m.y)) * open;
    float ribs = mix(0.5, step(0.5, fract(m.y / 0.22)), detailP(1e6, 0.22));
    vec3 metal = vec3(0.47, 0.48, 0.49) * (0.9 + 0.12 * ribs);
    vec3 detailed = mix(wall, metal, door);
    return mix(mix(wall, metal, 0.35 * 0.5), detailed, detailP(bw, 2.2));
  }

  // --- Trame des etages -----------------------------------------------------
  bool old = era < 0.5;
  bool office = kind > 1.5 && kind < 2.5 && era > 0.5;
  bool modern = era > 1.5 || office;
  bool industry = kind > 2.5 && kind < 3.5;
  float floorH = old ? 3.4 : 3.05;
  float groundH = shop > 0.5 ? 4.2 : floorH;
  float bayW = old ? 3.1 : (modern ? 3.6 : 3.3);
  float nb = floor(len / bayW);
  if (nb < 1.0) return wall; // pan de mur trop court pour une fenetre
  float bay = len / nb;

  float above = m.y - groundH;
  bool ground = above < 0.0;
  float yIn = ground ? m.y : mod(above, floorH);
  float level = ground ? -1.0 : floor(above / floorH);
  float storeyBase = m.y - yIn;
  float col = floor(m.x / bay);
  float x = m.x - (col + 0.5) * bay; // ecart au milieu de la travee
  vec2 cid = vec2(col, level);
  float h1 = hash21(cid + salt);
  float h2 = hash21(cid * 1.37 + salt * 1.9 + 5.0);
  float wallHash = hash21(vec2(lq * 0.37, 1.0) + salt);

  float corniceH = old ? 0.45 : 0.25;
  float topLimit = H - corniceH - 0.25;

  // Fenetres, selon l'epoque et l'usage.
  float winW = old ? 1.05 : (modern ? bay - 0.4 : 1.35);
  float winH = old ? 1.8 : (modern ? 1.6 : 1.45);
  float sill = old ? 0.95 : 0.9;
  if (office) { winW = bay - 0.1; winH = floorH - 0.9; sill = 0.45; }
  if (kind > 3.5 && kind < 4.5) { winW *= 1.25; winH *= 1.1; }
  if (industry) { winW = bay - 0.5; winH = 1.1; sill = max(floorH - 1.5, 0.9); }
  if (ground) sill += 0.15;

  float fits = step(storeyBase + sill + winH, topLimit);
  float wx = insideX(winW * 0.5, x);
  float wy = bandY(yIn, sill, sill + winH);
  float win = wx * wy * fits;

  vec3 glass = glassColor(h2);
  glass = mix(glass, vec3(0.58, 0.53, 0.45), step(0.84, h1) * 0.8); // rideaux tires
  vec3 stone = mix(wall, vec3(0.80, 0.77, 0.70), 0.55);
  vec3 detailed = wall;
  float winFrac = winW * winH / (bay * floorH);
  vec3 winMean = vec3(0.16, 0.18, 0.2);

  if (ground && shop > 0.5) {
    // --- Rez-de-chaussee commercial : vitrines et enseignes -----------------
    float vitrine = insideX(bay * 0.5 - 0.3, x) * bandY(m.y, 0.35, 3.0);
    float sign = insideX(bay * 0.5 - 0.15, x) * bandY(m.y, 3.2, 3.85);
    float hs = hash21(vec2(col, 7.0) + salt);
    vec3 signColor = mix(vec3(0.14, 0.19, 0.28), vec3(0.50, 0.12, 0.10), step(0.5, hs));
    signColor = mix(signColor, vec3(0.09, 0.09, 0.09), step(0.72, fract(hs * 7.3)));
    detailed = mix(detailed, vec3(0.2, 0.19, 0.17), bandY(m.y, 0.0, 0.35));
    detailed = mix(detailed, signColor, sign);
    detailed = mix(detailed, glassColor(h2) * 0.85, vitrine);
  } else {
    // --- Etages ----------------------------------------------------------------
    // Porte d'entree : une sur un mur sur deux, dans une travee tiree au sort.
    float doorBay = floor(wallHash * nb);
    float isDoor = (ground && col == doorBay && wallHash > 0.35 && !industry) ? 1.0 : 0.0;
    float door = isDoor * insideX(0.6, x) * (1.0 - stepY(2.35, m.y));

    if (old) {
      // Encadrement de pierre, appui saillant, volets battants.
      float frameW = 0.14;
      float frame = insideX(winW * 0.5 + frameW, x) * bandY(yIn, sill - 0.12, sill + winH + frameW) * fits;
      detailed = mix(detailed, stone, frame * (1.0 - isDoor));
      float withShutters = step(0.25, seed);
      float closed = step(0.9, h2) * withShutters;
      float sx = abs(x) - winW * 0.5 - frameW;
      float shutter = (stepX(0.03, sx) * (1.0 - stepX(winW * 0.5, sx))) * wy * fits * withShutters * (1.0 - closed) * (1.0 - isDoor);
      float slats = mix(0.5, step(0.5, fract(yIn / 0.09)), detailP(1e6, 0.09));
      vec3 sc = shutterColor(fract(seed * 3.7)) * (0.9 + 0.12 * slats);
      detailed = mix(detailed, sc, shutter);
      detailed = mix(detailed, mix(glass, sc, closed), win * (1.0 - isDoor));
      float sillBand = insideX(winW * 0.5 + 0.1, x) * bandY(yIn, sill - 0.1, sill) * fits;
      detailed = mix(detailed, vec3(0.78, 0.75, 0.69), sillBand * (1.0 - isDoor));
      winMean = mix(winMean, stone, 0.25);
      winFrac *= 1.0 + 0.8 * withShutters;
    } else if (modern) {
      // Bandeaux vitres ou murs-rideaux, meneaux tous les 1,2 a 1,5 m.
      float step_ = office ? 1.5 : 1.2;
      float mx = abs(fract(m.x / step_ + 0.5) - 0.5) * step_;
      float mullion = 1.0 - stepX(0.045, mx);
      float strip = (1.0 - stepX(len * 0.5 - 0.2, abs(m.x - len * 0.5))) * wy * fits;
      detailed = mix(detailed, glass, strip * (1.0 - isDoor));
      detailed = mix(detailed, vec3(0.30, 0.31, 0.32), strip * mullion * detailP(step_, 1e6));
      winFrac = (winH / floorH) * 0.95;
    } else {
      // 1914-1974 : volets roulants plus ou moins baisses, coffre au-dessus,
      // balcons sur un immeuble sur trois.
      float box = wx * bandY(yIn, sill + winH, sill + winH + 0.2) * fits;
      detailed = mix(detailed, wall * 0.86, box * (1.0 - isDoor));
      detailed = mix(detailed, glass, win * (1.0 - isDoor));
      float roll = step(0.4, h1) * h2 * 0.75;
      float rolled = win * stepY(sill + winH * (1.0 - roll), yIn) * (1.0 - isDoor);
      float slats = mix(0.5, step(0.5, fract(yIn / 0.06)), detailP(1e6, 0.06));
      detailed = mix(detailed, vec3(0.66, 0.65, 0.62) * (0.9 + 0.1 * slats), rolled);
      float balconies = step(0.66, seed) * (ground ? 0.0 : 1.0);
      float rail = insideX(bay * 0.5 - 0.2, x) * bandY(yIn, 0.0, 1.0) * balconies * fits;
      float bars = mix(0.45, step(0.72, fract(m.x / 0.12)), detailP(0.12, 1e6));
      detailed = mix(detailed, vec3(0.22, 0.22, 0.23), rail * (0.35 + 0.5 * bars));
      detailed *= 1.0 - 0.25 * balconies * insideX(bay * 0.5 - 0.2, x) * bandY(yIn, -0.05, 0.12);
    }
    detailed = mix(detailed, vec3(0.24, 0.17, 0.12), door);

    // Coulure sous l'appui.
    float streak = insideX(winW * 0.42, x) * bandY(yIn, sill - 1.2, sill - 0.1) * fits;
    detailed *= 1.0 - 0.07 * streak * clamp(1.0 - (sill - yIn) / 1.2, 0.0, 1.0);
  }

  // --- Modenature --------------------------------------------------------------
  if (old) {
    // Bandeau a chaque plancher, soubassement de pierre, chainages d'angle.
    float bandeau = ground ? 0.0 : bandY(yIn, 0.0, 0.14);
    detailed = mix(detailed, stone, bandeau);
    float plinth = bandY(m.y, 0.0, 0.9) * (1.0 - shop);
    detailed = mix(detailed, stone * 0.82, plinth);
    float q = min(m.x, len - m.x);
    float course = mod(floor(m.y / 0.34), 2.0);
    float quoin = (1.0 - stepX(course < 0.5 ? 0.55 : 0.35, q)) * step(4.0, len);
    detailed = mix(detailed, stone, quoin * detailP(0.35, 0.34));
  } else {
    detailed = mix(detailed, wall * 0.8, bandY(m.y, 0.0, 0.5) * (1.0 - shop));
  }

  // Corniche sous le toit, et son ombre.
  detailed = mix(detailed, mix(wall, vec3(0.82, 0.8, 0.75), 0.35), stepY(H - corniceH, m.y));
  detailed *= 1.0 - 0.14 * bandY(m.y, H - corniceH - 0.12, H - corniceH);
  // Encrassement du haut des murs, que la pluie lessive moins.
  detailed *= 1.0 - 0.05 * smoothstep(H - 2.5, H, m.y);

  vec3 averaged = mix(wall, winMean, clamp(winFrac, 0.0, 0.9) * 0.9);
  return mix(averaged, detailed, detailP(bay, floorH));
}

// --- Toitures reelles ----------------------------------------------------------
//
// v_facade.xy : position sur le toit en metres, x le long du plus grand cote -
// la ligne d'egout, le plus souvent -, y perpendiculairement ; v_facade.z : code
// du materiau (1 tuiles, 2 ardoises, 3 metal, 4 beton, 5 verre), plus 10 si le
// toit est en pente ; v_facade.w : graine du batiment.
vec3 roofReal(vec3 tint) {
  vec2 r = v_facade.xy;
  float code = floor(v_facade.z + 0.5);
  float pitched = step(9.5, code);
  float mat = code - 10.0 * pitched;
  float sq = floor(v_facade.w * 997.0 + 0.5);
  vec2 salt = vec2(sq * 0.1731, sq * 0.0719);
  fx = max(fwidth(r.x), 1e-4) * 0.75;
  fy = max(fwidth(r.y), 1e-4) * 0.75;

  // Salissures, mousses, lessivage : de grandes plaques fondues, jamais un
  // bruit fin.
  float patchA = vnoise(r * 0.2 + salt);
  float patchB = vnoise(r * 0.12 + 3.1 + salt * 1.7);
  vec3 c = tint * (0.92 + 0.15 * mix(0.5, patchA, detailP(5.0, 5.0)));

  if (mat > 3.5 && mat < 4.5) {
    // --- Toit-terrasse : gravillons, relevés d'etancheite, edicules techniques.
    c *= 0.92 + 0.1 * mix(0.5, hash21(floor(r * 1.6) + salt), detailP(0.62, 0.62));
    vec2 cell = floor(r / 6.0);
    vec2 inC = r - (cell + 0.5) * 6.0;
    float hc = hash21(cell + salt * 2.3);
    float boxHalf = hc > 0.86 ? 1.1 : 0.6;
    float box = step(0.62, hc) * insideX(boxHalf, inC.x)
              * (1.0 - smoothstep(boxHalf * 0.65 - fy, boxHalf * 0.65 + fy, abs(inC.y)));
    vec3 unit = hc > 0.86 ? vec3(0.62, 0.63, 0.64) : vec3(0.2, 0.26, 0.32); // clim, lanterneau
    float d = detailP(6.0, 6.0);
    c = mix(c, unit, box * d);
    c *= 1.0 - 0.18 * d * step(0.62, hc) * insideX(boxHalf + 0.2, inC.x - 0.25)
         * (1.0 - smoothstep(boxHalf * 0.65 + 0.2 - fy, boxHalf * 0.65 + 0.2 + fy, abs(inC.y + 0.25)))
         * (1.0 - box); // ombre portee de l'edicule
    return c;
  }
  if (mat > 4.5) {
    // --- Verriere : vitrage sombre, montants tous les 1,2 m.
    float mx = abs(fract(r.x / 1.2 + 0.5) - 0.5) * 1.2;
    float my = abs(fract(r.y / 2.4 + 0.5) - 0.5) * 2.4;
    float frameL = max(1.0 - stepX(0.04, mx), 1.0 - stepY(0.04, my));
    return mix(vec3(0.16, 0.2, 0.25), vec3(0.5, 0.52, 0.55), frameL * detailP(1.2, 2.4));
  }
  if (mat > 2.5) {
    // --- Metal : zinc a joints debout, ou bac acier, tous les 55 cm dans la pente.
    float panel = floor(r.x / 0.55);
    float sx = abs(fract(r.x / 0.55 + 0.5) - 0.5) * 0.55;
    float seam = 1.0 - stepX(0.02, sx);
    float d = detailP(0.55, 1e6);
    c *= 0.95 + 0.08 * mix(0.5, hash21(vec2(panel, 1.0) + salt), d);
    return mix(c, c * 1.25, seam * d * 0.8);
  }

  // --- Tuiles ou ardoises : rangs horizontaux, joints decales d'un rang a l'autre.
  bool slate = mat > 1.5;
  float rowH = slate ? 0.22 : 0.33;
  float unitW = slate ? 0.3 : 0.22;
  float row = floor(r.y / rowH);
  float yIn = fract(r.y / rowH);
  float xT = r.x / unitW + 0.5 * mod(row, 2.0);
  // Des rangs de 33 cm se reduisent vite a quelques pixels : on les fond plus
  // tot que les autres motifs, des 10 pixels, sans quoi leurs aretes dessinent
  // des arcs de moire sur les grands toits.
  float dRow = 1.0 - smoothstep(0.1, 0.35, fy / rowH);
  float dTile = 1.0 - smoothstep(0.1, 0.35, max(fx / unitW, fy / rowH));
  // Chaque rang recouvre le precedent : une ombre fine le long de son bord bas,
  // continue d'un rang a l'autre, sans arete qui crenele.
  float lip = smoothstep(0.82, 1.0, yIn) + 1.0 - smoothstep(0.0, 0.28, yIn);
  c *= 1.0 - 0.2 * mix(0.2, lip, dRow);
  // Une tuile n'a pas tout a fait la teinte de sa voisine.
  c *= 0.94 + 0.12 * mix(0.5, hash21(vec2(floor(xT), row) + salt), dTile);
  float dj = min(fract(xT), 1.0 - fract(xT)) * unitW;
  c *= 1.0 - 0.2 * (1.0 - stepX(0.012, dj)) * dTile;
  // Mousses sur les vieux toits de tuiles, cote nord ou non.
  if (!slate) c = mix(c, vec3(0.3, 0.33, 0.22), 0.25 * smoothstep(0.62, 0.85, patchB) * detailP(8.0, 8.0));
  return c;
}

void main()
{
  vec4 base = czm_gammaCorrect(v_color);
  vec3 tex = base.rgb;
  float style = v_surf.x;

  // Alpha = interrupteur de texture. L'attribut de geometrie est fige apres
  // construction, alors que la couleur par instance reste modifiable a chaud :
  // c'est donc elle qui porte la bascule vers l'aplat du diagnostic.
  float textured = step(0.75, v_color.a);

  if (style < 0.5) {
    // --- FACADE ---------------------------------------------------------
    tex = facade(tex);

  } else if (style < 1.5) {
    // --- TOITURE --------------------------------------------------------
    // Bandes de couverture, une par metre, et granulometrie du gravier a
    // l'echelle reelle elle aussi : sans cela une petite toiture recevrait
    // autant de taches qu'une grande, et l'echelle se perdrait vue du ciel.
    float rows = max(2.0, floor(v_surf.y));
    float t = fract(v_st.t * rows);
    float dr = detail(vec2(0.0, v_st.t * rows));
    tex *= 0.91 + 0.13 * mix(0.5, step(0.5, t), dr);
    float grain = max(3.0, v_surf.y * 0.5);
    float dg = detail(v_st * grain);
    tex *= 0.93 + 0.11 * mix(0.5, hash21(floor(v_st * grain)), dg);

  } else if (style < 2.5) {
    // --- GRAVATS --------------------------------------------------------
    // Pas de trame : une ruine ne doit surtout pas avoir l'air reguliere.
    float dn = detail(v_st * 17.0);
    tex *= 0.76 + 0.36 * mix(0.5, hash21(floor(v_st * 17.0)), dn);

  } else if (style > 4.5) {
    // --- TOITURE REELLE -------------------------------------------------
    tex = roofReal(tex);

  } else if (style > 3.5) {
    // --- FACADE INCENDIEE -----------------------------------------------
    // Le gros oeuvre tient, mais les baies ne sont plus que des trous noirs,
    // et la suie monte au-dessus de chacune : c'est par elles que les flammes
    // sont sorties. D'un etage a l'autre, les trainees se rejoignent en
    // colonnes, la signature d'un immeuble qui a brule en entier.
    float floors = max(1.0, floor(v_surf.z / 3.2));
    float bays   = max(1.0, floor(v_surf.y / 3.4));
    vec2 g = vec2(v_st.s * bays, v_st.t * floors);
    vec2 cell = fract(g);
    vec2 id = floor(g);
    float d = detail(g);

    float win = step(0.20, cell.x) * step(cell.x, 0.80)
              * step(0.24, cell.y) * step(cell.y, 0.84);
    float column = 1.0 - smoothstep(0.18, 0.42, abs(cell.x - 0.5));
    float spandrel = smoothstep(0.80, 0.92, cell.y) + 1.0 - smoothstep(0.10, 0.26, cell.y);
    float soot = column * min(spandrel, 1.0) * (0.55 + 0.45 * hash21(id + 7.0));

    float dn = detail(v_st * vec2(23.0, 31.0));
    tex *= 0.82 + 0.3 * mix(0.5, hash21(floor(v_st * vec2(23.0, 31.0))), dn);
    // Moyennes sur une travee : suie ~16 %, baies 36 %.
    tex *= 1.0 - 0.6 * mix(0.16, soot, d);
    tex = mix(tex, vec3(0.025, 0.022, 0.02), mix(0.36, win, d));
  }
  // style 3 : aplat, on garde la couleur d'instance telle quelle.
  tex = mix(base.rgb, tex, textured);

  // On reprend l'eclairage de Cesium plutot que d'en ecrire un : les batiments
  // restent ainsi coherents avec le sol et avec le chassis du drone.
  vec3 positionToEyeEC = -v_positionEC;
  vec3 normalEC = normalize(v_normalEC);

  czm_materialInput materialInput;
  materialInput.normalEC = normalEC;
  materialInput.positionToEyeEC = positionToEyeEC;
  czm_material material = czm_getDefaultMaterial(materialInput);
  material.diffuse = tex;
  material.alpha = 1.0;

  out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
}
`;

/**
 * Boîte texturable : une `BoxGeometry` à laquelle on ajoute l'attribut `surf`.
 *
 * POURQUOI UN ATTRIBUT DE GÉOMÉTRIE ET PAS UN ATTRIBUT PAR INSTANCE
 * ----------------------------------------------------------------
 * Les attributs par instance de Cesium passent par sa table de lots, qui ne
 * connaît qu'une liste fermée de noms (`color`, `show`, `offset`...). Un nom
 * inédit n'y est pas réécrit, reste donc une vraie entrée de shader sans
 * colonne de sommets en face, et Cesium refuse le rendu :
 *
 *     Appearance/Geometry mismatch. The appearance requires vertex shader
 *     attribute input 'surf', which was not computed as part of the Geometry.
 *
 * Les attributs de GÉOMÉTRIE, eux, acceptent n'importe quel nom : ils sont
 * fusionnés et indexés comme `position` ou `normal`. On paie la valeur une fois
 * par sommet au lieu d'une fois par instance — 24 sommets par boîte, soit
 * quelques centaines de kilo-octets pour toute la ville. C'est sans importance.
 */
export function texturedBox(
  dimensions: Cesium.Cartesian3,
  style: number,
  bayWidth: number,
  height: number,
  variant: FacadeVariant = DEFAULT_VARIANT,
): Cesium.Geometry {
  const geometry = Cesium.BoxGeometry.createGeometry(
    Cesium.BoxGeometry.fromDimensions({ dimensions, vertexFormat: FACADE_VERTEX_FORMAT }),
  );
  if (!geometry) throw new Error('BoxGeometry.createGeometry a échoué');

  const position = geometry.attributes.position;
  if (!position) throw new Error('géométrie sans positions');

  const count = position.values.length / 3;
  const values = new Float32Array(count * 3);
  const variants = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    values[i * 3] = style;
    values[i * 3 + 1] = bayWidth;
    values[i * 3 + 2] = height;
    variants.set(variant, i * 4);
  }

  // `GeometryAttributes` est typé avec les seuls noms connus de Cesium ; les
  // noms libres sont permis à l'exécution, d'où l'élargissement du type ici.
  const attributes = geometry.attributes as unknown as Record<string, Cesium.GeometryAttribute>;
  attributes.surf = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values,
  });
  attributes.facade = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 4,
    values: variants,
  });

  return geometry;
}

// ---------------------------------------------------------------------------
// Bâtiments réels : murs, toit et arêtes tirés d'un contour
// ---------------------------------------------------------------------------
//
// Ces trois géométries sont exprimées dans le repère local du bâtiment (x vers
// l'est, y vers le nord, z vers le haut, origine au pied) et reçoivent leur
// position par la `modelMatrix` de l'instance, comme les boîtes.
//
// Elles portent EXACTEMENT les mêmes attributs que `texturedBox` — position,
// normale, coordonnées de texture, `surf` et `facade` — parce que Cesium
// fusionne toutes les instances d'un même primitive : un attribut de plus ou de
// moins sur une seule d'entre elles et la fusion échoue.

type Ring = Array<[number, number]>;

function buildGeometry(
  positions: number[],
  normals: number[],
  sts: number[],
  surfs: number[],
  facades: number[],
  indices: number[],
): Cesium.Geometry {
  const pos = new Float64Array(positions);
  const attributes = new Cesium.GeometryAttributes();
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: pos,
  });
  attributes.normal = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: new Float32Array(normals),
  });
  attributes.st = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 2,
    values: new Float32Array(sts),
  });
  const custom = attributes as unknown as Record<string, Cesium.GeometryAttribute>;
  custom.surf = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: new Float32Array(surfs),
  });
  custom.facade = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 4,
    values: new Float32Array(facades),
  });
  const vertices = positions.length / 3;
  return new Cesium.Geometry({
    attributes,
    indices: vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(pos),
  });
}

/**
 * Les murs : une face par côté du contour, cours intérieures comprises.
 *
 * Chaque face reçoit ses propres coordonnées de texture (0 à 1 sur sa longueur
 * et sur sa hauteur) et sa propre longueur dans `surf`. Le shader y pose donc
 * une travée tous les 3,4 m de CE mur-là : un pignon de 6 m aura deux
 * fenêtres de large, une façade de 40 m en aura onze.
 *
 * L'orientation des anneaux fixe le sens des faces. Le contour extérieur est
 * parcouru dans le sens trigonométrique et les cours dans le sens horaire (voir
 * `scripts/fetch-buildings.mjs`) : dans les deux cas, la normale à droite du
 * sens de parcours pointe hors de la matière, vers la rue ou vers la cour.
 */
export function footprintWalls(
  rings: Ring[],
  height: number,
  style: number,
  variant: FacadeVariant = DEFAULT_VARIANT,
): Cesium.Geometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const sts: number[] = [];
  const surfs: number[] = [];
  const facades: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const nx = (by - ay) / len;
      const ny = -(bx - ax) / len;

      const base = positions.length / 3;
      positions.push(ax, ay, 0, bx, by, 0, bx, by, height, ax, ay, height);
      for (let k = 0; k < 4; k++) {
        normals.push(nx, ny, 0);
        surfs.push(style, len, height);
        facades.push(...variant);
      }
      sts.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return buildGeometry(positions, normals, sts, surfs, facades, indices);
}

/**
 * Le toit : le contour triangulé par earcut, posé à plat au sommet des murs.
 *
 * earcut est l'algorithme de Mapbox, celui que la plupart des moteurs
 * cartographiques emploient pour trianguler des emprises de bâtiments. Il gère
 * les cours intérieures, qu'on lui passe comme des trous.
 *
 * Chaque sommet reçoit dans `facade` sa position en mètres dans un repère
 * aligné sur le plus grand côté du contour — la ligne d'égout, le plus souvent :
 * les rangs de tuiles lui sont parallèles, comme sur un vrai toit.
 */
export function footprintRoof(
  rings: Ring[],
  height: number,
  style: number,
  roof: RoofVariant = [11, 0.5],
): Cesium.Geometry {
  const flat: number[] = [];
  const holes: number[] = [];
  for (const [r, ring] of rings.entries()) {
    if (r > 0) holes.push(flat.length / 2);
    for (const [x, y] of ring) flat.push(x, y);
  }
  const tri = earcut(flat, holes);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    minX = Math.min(minX, flat[i]);
    maxX = Math.max(maxX, flat[i]);
    minY = Math.min(minY, flat[i + 1]);
    maxY = Math.max(maxY, flat[i + 1]);
  }
  const w = Math.max(maxX - minX, 0.1);
  const d = Math.max(maxY - minY, 0.1);

  // Direction du plus grand côté du contour extérieur.
  let ux = 1;
  let uy = 0;
  let longest = 0;
  const outer = rings[0] ?? [];
  for (let i = 0; i < outer.length; i++) {
    const [ax, ay] = outer[i];
    const [bx, by] = outer[(i + 1) % outer.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len > longest) {
      longest = len;
      ux = (bx - ax) / len;
      uy = (by - ay) / len;
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const sts: number[] = [];
  const surfs: number[] = [];
  const facades: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    positions.push(flat[i], flat[i + 1], height);
    normals.push(0, 0, 1);
    sts.push((flat[i] - minX) / w, (flat[i + 1] - minY) / d);
    surfs.push(style, d, height);
    const [x, y] = [flat[i], flat[i + 1]];
    facades.push(x * ux + y * uy, y * ux - x * uy, roof[0], roof[1]);
  }

  // La face doit regarder vers le ciel : un triangle parcouru dans le sens
  // horaire vu d'en haut serait éliminé avec les faces arrière.
  const indices: number[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]];
    const cross =
      (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) -
      (flat[2 * b + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
    if (cross >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }
  return buildGeometry(positions, normals, sts, surfs, facades, indices);
}

/**
 * Les arêtes, pour les vues fil de fer et scan : le contour au sol, le contour
 * au sommet, et une arête verticale à chaque angle.
 */
export function footprintOutline(rings: Ring[], height: number): Cesium.Geometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    const base = positions.length / 3;
    const n = ring.length;
    for (const [x, y] of ring) positions.push(x, y, 0, x, y, height);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const bot = base + 2 * i;
      const top = bot + 1;
      indices.push(bot, base + 2 * j, top, base + 2 * j + 1, bot, top);
    }
  }
  const pos = new Float64Array(positions);
  const attributes = new Cesium.GeometryAttributes();
  attributes.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: pos,
  });
  return new Cesium.Geometry({
    attributes,
    indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    primitiveType: Cesium.PrimitiveType.LINES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(pos),
  });
}

/** L'apparence texturée, à partager par toutes les instances de bâti. */
export function createFacadeAppearance(): Cesium.Appearance {
  return new Cesium.Appearance({
    vertexShaderSource: VERTEX_SHADER,
    fragmentShaderSource: FRAGMENT_SHADER,
    translucent: false,
    closed: true,
    // Contrairement à ses sous-classes, `Appearance` ne se donne PAS d'état de
    // rendu par défaut : le champ reste indéfini et le rendu s'arrête net sur
    // « Cannot set properties of undefined (setting 'depthMask') ». On appelle
    // donc la fabrique de Cesium nous-mêmes — elle existe à l'exécution mais
    // n'est pas déclarée dans les typages publics.
    renderState: (
      Cesium.Appearance as unknown as {
        getDefaultRenderState: (t: boolean, c: boolean) => object;
      }
    ).getDefaultRenderState(false, true),
  });
}
