/**
 * Le lieu du vol : Mulhouse par défaut, ou n'importe quelle ville du monde.
 *
 * Le lieu se choisit dans le simulateur (bouton en haut à gauche) ou dans
 * l'adresse de la page : `?lieu=Strasbourg`, ou `?lieu=Strasbourg&lat=48.58&lon=7.75`
 * pour un point précis. Changer de lieu recharge la page : toute la scène —
 * bâtiments, relief, terrain, relevé photoréaliste — se reconstruit autour.
 *
 * QUEL GÉOCODEUR
 * --------------
 * Les conditions de Google n'autorisent, avec ses tuiles photoréalistes, que
 * son propre géocodeur. Quand la ville photoréaliste est active, la recherche
 * passe donc par Google, au travers de Cesium ion et de son jeton ; sinon,
 * par l'IGN pour la France et Photon (OpenStreetMap) pour le reste du monde.
 * Dans tous les cas, on peut aussi taper des coordonnées : « 48.5818, 7.7509 ».
 */

import { CONFIG } from '../core/config';

export interface Place {
  /** Nom affiché : « Strasbourg », « Mulhouse — centre ». */
  name: string;
  lat: number;
  lon: number;
}

/** Le lieu livré avec le projet, données préparées dans `public/data/`. */
export const MULHOUSE: Place = { name: 'Mulhouse — centre', lat: 47.7466, lon: 7.3389 };

/** Le lieu est-il Mulhouse, dont les données sont livrées toutes prêtes ? */
export function isMulhouse(place: Place): boolean {
  return Math.abs(place.lat - MULHOUSE.lat) < 1e-4 && Math.abs(place.lon - MULHOUSE.lon) < 1e-4;
}

/** Ce que demande l'adresse de la page : un lieu précis, un nom à chercher, ou rien. */
export function placeFromUrl(): Place | { query: string } | null {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('lieu')?.trim();
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (params.has('lat') && params.has('lon') && isLatLon(lat, lon)) {
    return { name: name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
  }
  return name ? { query: name } : null;
}

const isLatLon = (lat: number, lon: number) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** La recherche passe-t-elle par Google ? Oui dès que ses tuiles peuvent s'afficher. */
export function searchesWithGoogle(): boolean {
  const params = new URLSearchParams(window.location.search);
  return !!CONFIG.ionToken && params.get('ville') !== 'dessinee';
}

/** Un résultat de recherche, avec la source à citer. */
export interface Found extends Place {
  /** Libellé complet : « Strasbourg, 67, Bas-Rhin, Grand Est ». */
  label: string;
}

/**
 * Cherche un lieu par son nom, ou lit des coordonnées tapées telles quelles.
 * @throws Error si le service de recherche ne répond pas.
 */
export async function searchPlaces(query: string): Promise<Found[]> {
  const q = query.trim();
  const coords = q.match(/^(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (coords) {
    const lat = Number(coords[1].replace(',', '.'));
    const lon = Number(coords[2].replace(',', '.'));
    if (isLatLon(lat, lon)) {
      const name = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      return [{ name, label: `Coordonnées ${name}`, lat, lon }];
    }
  }
  if (q.length < 2) return [];
  if (searchesWithGoogle()) return searchGoogle(q);
  // L'IGN connaît mieux la France ; Photon (OpenStreetMap) couvre le reste du
  // monde. Les deux sont interrogés ensemble, et Photon ne garde que l'étranger.
  const [ign, world] = await Promise.allSettled([searchIgn(q), searchPhoton(q)]);
  if (ign.status === 'rejected' && world.status === 'rejected') throw ign.reason;
  const french = ign.status === 'fulfilled' ? ign.value : [];
  const abroad = world.status === 'fulfilled' ? world.value : [];
  // L'IGN propose toujours quelque chose en France, même pour « Berlin » (un
  // lieu-dit, une rue) : seule une commune du nom exact passe avant l'étranger.
  const exact = (f: IgnFound) => f.municipality && simplify(f.name) === simplify(q);
  return [...french.filter(exact), ...abroad, ...french.filter((f) => !exact(f))];
}

/**
 * Géocodeur Photon, fondé sur OpenStreetMap : le monde entier. Les résultats
 * français sont écartés, l'IGN les donne déjà, et mieux.
 */
async function searchPhoton(q: string): Promise<Found[]> {
  const params = new URLSearchParams({ q, limit: '6', lang: 'fr' });
  const res = await fetch(`https://photon.komoot.io/api/?${params}`);
  if (!res.ok) throw new Error(`recherche mondiale indisponible (HTTP ${res.status})`);
  const data = (await res.json()) as {
    features: Array<{
      geometry: { coordinates: [number, number] };
      properties: {
        name?: string;
        city?: string;
        state?: string;
        country?: string;
        countrycode?: string;
      };
    }>;
  };
  return data.features
    .filter((f) => f.properties.countrycode !== 'FR' && f.properties.name)
    .map((f) => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      const where = [p.city !== p.name ? p.city : '', p.state, p.country]
        .filter(Boolean)
        .join(', ');
      return { name: p.name!, label: where ? `${p.name} — ${where}` : p.name!, lat, lon };
    });
}

/** Nom comparable : sans casse, sans accents, sans ponctuation. */
const simplify = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface IgnFound extends Found {
  municipality: boolean;
}

/** Géocodeur de l'IGN (Géoplateforme) : communes et adresses françaises. */
async function searchIgn(q: string): Promise<IgnFound[]> {
  const params = new URLSearchParams({ q, limit: '6', autocomplete: '1' });
  const res = await fetch(`https://data.geopf.fr/geocodage/search?${params}`);
  if (!res.ok) throw new Error(`recherche indisponible (HTTP ${res.status})`);
  const data = (await res.json()) as {
    features: Array<{
      geometry: { coordinates: [number, number] };
      properties: { label: string; city?: string; name?: string; context?: string; type?: string };
    }>;
  };
  return data.features.map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const municipality = p.type === 'municipality';
    const name = municipality ? (p.city ?? p.name ?? p.label) : p.label;
    return {
      name,
      label: p.context ? `${p.label} — ${p.context}` : p.label,
      lat,
      lon,
      municipality,
    };
  });
}

/**
 * Géocodeur de Google, au travers de Cesium ion. Il rend une emprise : le lieu
 * retenu en est le centre.
 */
async function searchGoogle(q: string): Promise<Found[]> {
  const params = new URLSearchParams({
    text: q,
    geocoder: 'google',
    access_token: CONFIG.ionToken,
  });
  const res = await fetch(`https://api.cesium.com/v1/geocode/search?${params}`);
  if (!res.ok) throw new Error(`recherche indisponible (HTTP ${res.status})`);
  const data = (await res.json()) as {
    features: Array<{
      geometry?: { coordinates: [number, number] };
      bbox?: [number, number, number, number];
      properties: { label: string };
    }>;
  };
  return data.features.flatMap((f) => {
    const point = f.geometry?.coordinates;
    const box = f.bbox;
    const lon = point ? point[0] : box ? (box[0] + box[2]) / 2 : NaN;
    const lat = point ? point[1] : box ? (box[1] + box[3]) / 2 : NaN;
    if (!isLatLon(lat, lon)) return [];
    const label = f.properties.label;
    return [{ name: label.split(',')[0].trim(), label: `${label} (Google)`, lat, lon }];
  });
}

/** Recharge le simulateur sur un autre lieu, en gardant les autres réglages de l'adresse. */
export function goToPlace(place: Place): void {
  const params = new URLSearchParams(window.location.search);
  if (isMulhouse(place)) {
    params.delete('lieu');
    params.delete('lat');
    params.delete('lon');
  } else {
    params.set('lieu', place.name);
    params.set('lat', place.lat.toFixed(6));
    params.set('lon', place.lon.toFixed(6));
  }
  const search = params.toString();
  window.location.search = search ? `?${search}` : '';
}
