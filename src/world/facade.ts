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
 * réelles transmises par instance : une travée fait 3,4 m et un étage 3,2 m,
 * partout. Un immeuble de 30 m montre neuf étages parce qu'il en a neuf.
 *
 * POURQUOI UNE APPARENCE MAISON
 * -----------------------------
 * `MaterialAppearance` porterait bien une texture, mais il ignore la couleur par
 * instance — or c'est elle qui porte tout le reste du projet : teintes par usage,
 * états de dommage, et surtout la vue diagnostique qui recolore les bâtiments un
 * par un. On garde donc l'attribut `color` et on le MULTIPLIE par le motif.
 *
 * L'attribut `surf` transporte le reste :
 *   surf.x = style de surface (voir SURFACE)
 *   surf.y = largeur de référence, en mètres, pour espacer les travées
 *   surf.z = hauteur, en mètres, pour espacer les étages
 *
 * `surf` est un attribut de géométrie, figé à la construction (voir
 * `texturedBox` pour la raison). Seule la couleur par instance reste
 * modifiable à chaud : c'est donc son canal alpha qui porte la bascule vers
 * l'aplat de la vue diagnostique, sans reconstruire la géométrie.
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
} as const;

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
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;
out vec4 v_color;
out vec3 v_surf;

void main()
{
  vec4 p = czm_computePosition();
  v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
  v_normalEC = czm_normal * normal;
  v_st = st;
  v_color = color;
  v_surf = surf;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const FRAGMENT_SHADER = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
in vec4 v_color;
in vec3 v_surf;

// Bruit deterministe : deux facades voisines ne doivent pas etre identiques,
// mais une meme facade ne doit pas scintiller d'une image a l'autre.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
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
    // Une travee tous les 3,4 m, un etage tous les 3,2 m. Sur une face
    // laterale de boite, t court a la verticale et s a l'horizontale.
    float floors = max(1.0, floor(v_surf.z / 3.2));
    float bays   = max(1.0, floor(v_surf.y / 3.4));

    vec2 g = vec2(v_st.s * bays, v_st.t * floors);
    vec2 cell = fract(g);
    vec2 id = floor(g);

    // Fenetre : un rectangle centre, laissant un trumeau de maconnerie.
    float win = step(0.20, cell.x) * step(cell.x, 0.80)
              * step(0.24, cell.y) * step(cell.y, 0.84);

    // Un vitrage renvoie le ciel : jamais noir en plein jour, plus ou moins
    // clair d'une fenetre a l'autre selon ce qu'il reflete. Une sur cinq a
    // ses rideaux tires : c'est ce qui empeche la facade de ressembler a du
    // papier millimetre.
    float r = hash21(id + floor(v_surf.yz));
    vec3 glass = mix(vec3(0.11, 0.13, 0.16), vec3(0.27, 0.32, 0.39), hash21(id * 1.7 + 3.1));
    glass = mix(glass, vec3(0.62, 0.56, 0.42), step(0.80, r));
    tex = mix(tex, glass, win * 0.92);

    // Bandeau de plancher, puis salissure verticale.
    tex *= 1.0 - 0.13 * smoothstep(0.88, 1.0, cell.y);
    tex *= 0.95 + 0.05 * hash21(vec2(floor(v_st.s * 37.0), 3.0));

    // Soubassement plus sombre sur le premier metre.
    tex *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.2 / max(v_surf.z, 1.0), v_st.t));

  } else if (style < 1.5) {
    // --- TOITURE --------------------------------------------------------
    // Bandes de couverture, une par metre, et granulometrie du gravier a
    // l'echelle reelle elle aussi : sans cela une petite toiture recevrait
    // autant de taches qu'une grande, et l'echelle se perdrait vue du ciel.
    float rows = max(2.0, floor(v_surf.y));
    float t = fract(v_st.t * rows);
    tex *= 0.91 + 0.13 * step(0.5, t);
    float grain = max(3.0, v_surf.y * 0.5);
    tex *= 0.93 + 0.11 * hash21(floor(v_st * grain));

  } else if (style < 2.5) {
    // --- GRAVATS --------------------------------------------------------
    // Pas de trame : une ruine ne doit surtout pas avoir l'air reguliere.
    tex *= 0.76 + 0.36 * hash21(floor(v_st * 17.0));

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

    float win = step(0.20, cell.x) * step(cell.x, 0.80)
              * step(0.24, cell.y) * step(cell.y, 0.84);
    float column = 1.0 - smoothstep(0.18, 0.42, abs(cell.x - 0.5));
    float spandrel = smoothstep(0.80, 0.92, cell.y) + 1.0 - smoothstep(0.10, 0.26, cell.y);
    float soot = column * min(spandrel, 1.0) * (0.55 + 0.45 * hash21(id + 7.0));

    tex *= 0.82 + 0.3 * hash21(floor(v_st * vec2(23.0, 31.0)));
    tex *= 1.0 - 0.6 * soot;
    tex = mix(tex, vec3(0.025, 0.022, 0.02), win);
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
): Cesium.Geometry {
  const geometry = Cesium.BoxGeometry.createGeometry(
    Cesium.BoxGeometry.fromDimensions({ dimensions, vertexFormat: FACADE_VERTEX_FORMAT }),
  );
  if (!geometry) throw new Error('BoxGeometry.createGeometry a échoué');

  const position = geometry.attributes.position;
  if (!position) throw new Error('géométrie sans positions');

  const count = position.values.length / 3;
  const values = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    values[i * 3] = style;
    values[i * 3 + 1] = bayWidth;
    values[i * 3 + 2] = height;
  }

  // `GeometryAttributes` est typé avec les seuls noms connus de Cesium ; les
  // noms libres sont permis à l'exécution, d'où l'élargissement du type ici.
  (geometry.attributes as unknown as Record<string, Cesium.GeometryAttribute>).surf =
    new Cesium.GeometryAttribute({
      componentDatatype: Cesium.ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values,
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
// normale, coordonnées de texture et `surf` — parce que Cesium fusionne toutes
// les instances d'un même primitive : un attribut de plus ou de moins sur une
// seule d'entre elles et la fusion échoue.

type Ring = Array<[number, number]>;

function buildGeometry(
  positions: number[],
  normals: number[],
  sts: number[],
  surfs: number[],
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
  (attributes as unknown as Record<string, Cesium.GeometryAttribute>).surf =
    new Cesium.GeometryAttribute({
      componentDatatype: Cesium.ComponentDatatype.FLOAT,
      componentsPerAttribute: 3,
      values: new Float32Array(surfs),
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
export function footprintWalls(rings: Ring[], height: number, style: number): Cesium.Geometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const sts: number[] = [];
  const surfs: number[] = [];
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
      }
      sts.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return buildGeometry(positions, normals, sts, surfs, indices);
}

/**
 * Le toit : le contour triangulé par earcut, posé à plat au sommet des murs.
 *
 * earcut est l'algorithme de Mapbox, celui que la plupart des moteurs
 * cartographiques emploient pour trianguler des emprises de bâtiments. Il gère
 * les cours intérieures, qu'on lui passe comme des trous.
 */
export function footprintRoof(rings: Ring[], height: number, style: number): Cesium.Geometry {
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

  const positions: number[] = [];
  const normals: number[] = [];
  const sts: number[] = [];
  const surfs: number[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    positions.push(flat[i], flat[i + 1], height);
    normals.push(0, 0, 1);
    sts.push((flat[i] - minX) / w, (flat[i + 1] - minY) / d);
    surfs.push(style, d, height);
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
  return buildGeometry(positions, normals, sts, surfs, indices);
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
