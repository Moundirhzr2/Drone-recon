/**
 * Dessin de la carte des ruines, hors du fil principal (voir `photoreal.ts`).
 *
 * Remplir quelques centaines de contours sur un canevas de deux millions de
 * pixels, puis relire l'image, coûtait une trentaine de millisecondes par mise
 * à jour : autant d'images sautées, plusieurs fois par seconde pendant un
 * sinistre. Le fil principal n'a plus qu'à envoyer les contours et à
 * téléverser le résultat.
 */

export interface MaskJob {
  id: number;
  width: number;
  height: number;
  /** Emprise de la carte : origine x, y et taille, en mètres locaux. */
  extent: [number, number, number, number];
  /**
   * Ruines, sommets à plat (x0, y0, x1, y1…) : leur contour élargi de la
   * bande à effacer, et leur contour propre.
   */
  ruined: Array<{ band: Float64Array; core: Float64Array }>;
  /**
   * Voisins debout : leur contour élargi de la marge qui leur est laissée côté
   * ruine (`party`) et sur leurs autres côtés (`free`), puis de quoi porter la
   * hauteur de leur toit (`reach`). Hauteurs codées de 0 à 255 : leur faîtage
   * (`level`) et leur gouttière (`eave`).
   */
  standing: Array<{
    party: Float64Array;
    free: Float64Array;
    reach: Float64Array;
    level: number;
    eave: number;
  }>;
  /** Contours à noircir. */
  burnt: Float64Array[];
  /**
   * Poussière autour des ruines : étalement du flou, en pixels (écart type),
   * et gain appliqué au résultat, pour qu'elle soit pleine au bord de
   * l'effacement.
   */
  dust: { spread: number; gain: number };
}

export interface MaskResult {
  id: number;
  /** Pixels RGBA, lignes du sud au nord. */
  pixels: ArrayBuffer;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MaskJob>) => void) | null;
  postMessage(message: MaskResult, transfer: Transferable[]): void;
};

/** Canevas gardés d'une carte à l'autre : la carte, les ruines seules, leur flou. */
const surfaces: OffscreenCanvasRenderingContext2D[] = [];

function surface(index: number, width: number, height: number): OffscreenCanvasRenderingContext2D {
  let ctx = surfaces[index];
  if (!ctx || ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
    surfaces[index] = ctx;
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  return ctx;
}

scope.onmessage = (event) => {
  const job = event.data;
  const { width, height } = job;
  const [ox, oy, ew, eh] = job.extent;
  const sx = width / ew;
  const sy = height / eh;
  const trace = (ctx: OffscreenCanvasRenderingContext2D, ring: Float64Array) => {
    ctx.moveTo((ring[0] - ox) * sx, (ring[1] - oy) * sy);
    for (let i = 2; i < ring.length; i += 2) {
      ctx.lineTo((ring[i] - ox) * sx, (ring[i + 1] - oy) * sy);
    }
    ctx.closePath();
  };
  const fill = (ctx: OffscreenCanvasRenderingContext2D, ring: Float64Array, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    trace(ctx, ring);
    ctx.fill();
  };

  // Fond opaque, puis couleurs additionnées : sur un bord, le rouge vaut la
  // part du pixel couverte. Sur un fond transparent, le canevas rendrait un
  // rouge plein au moindre recouvrement.
  const map = surface(0, width, height);
  map.globalCompositeOperation = 'lighter';
  for (const r of job.ruined) fill(map, r.band, '#ff0000');
  // Les voisins debout : là où l'effacement les touchait, le rouge tombe à
  // moitié (au plus), sur une marge large…
  map.globalCompositeOperation = 'darken';
  for (const n of job.standing) fill(map, n.free, '#80ffff');
  // …mais une ruine s'efface entière jusqu'à son contour…
  map.globalCompositeOperation = 'lighter';
  for (const r of job.ruined) fill(map, r.core, '#ff0000');
  // …hormis la marge étroite de leur mur mitoyen.
  map.globalCompositeOperation = 'darken';
  for (const n of job.standing) fill(map, n.party, '#80ffff');
  // Leur hauteur dans le bleu (la plus haute l'emporte, là où deux marges se
  // recouvrent), un peu au-delà de leurs marges : le filtrage de la texture
  // la mêlerait sinon au zéro d'à côté, et rabaisserait la coupe sur leur
  // bord.
  map.globalCompositeOperation = 'lighten';
  for (const n of job.standing) fill(map, n.reach, `rgb(0, 0, ${n.level})`);
  // Dans l'emprise d'une ruine, leur marge mitoyenne ne garde rien au-dessus
  // de leur gouttière : plus haut, c'était le toit de la ruine, qui restait en
  // lambeaux au-dessus du mur mitoyen quand elle était la plus haute des deux.
  // Le mur mitoyen monte, lui, jusqu'à leur toit.
  map.save();
  map.beginPath();
  for (const r of job.ruined) trace(map, r.core);
  map.clip();
  map.globalCompositeOperation = 'darken';
  for (const n of job.standing) fill(map, n.party, `rgb(255, 255, ${n.eave})`);
  map.restore();
  map.globalCompositeOperation = 'lighter';
  for (const ring of job.burnt) fill(map, ring, '#00ff00');
  const pixels = map.getImageData(0, 0, width, height).data;

  // La poussière va dans l'alpha, que le canevas ne sait pas écrire seul : ses
  // couleurs sont prémultipliées, et un alpha nul effacerait les trois autres
  // canaux. Les ruines sont donc floutées à part, puis recopiées.
  const ruins = surface(1, width, height);
  for (const r of job.ruined) fill(ruins, r.band, '#ffffff');
  const dust = surface(2, width, height);
  dust.filter = `blur(${job.dust.spread}px)`;
  dust.drawImage(ruins.canvas, 0, 0);
  const spread = dust.getImageData(0, 0, width, height).data;
  // Tableau borné : le gain sature à 255.
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = spread[i - 3] * job.dust.gain;

  scope.postMessage({ id: job.id, pixels: pixels.buffer }, [pixels.buffer]);
};
