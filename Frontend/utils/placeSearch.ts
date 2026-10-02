/**
 * Place search over OpenStreetMap Nominatim - ONE implementation, used by both
 * MapLocationPicker and the onboarding location screen.
 *
 * Why this exists as a shared module: the location screen shipped its own
 * 130-line hardcoded list of Indian cities/areas/roads and filtered it in
 * memory. That can never suggest a user's own locality, it goes stale, and it
 * silently omits anywhere the list forgot. Live geocoding fixes all three.
 *
 * Two behaviours matter and are easy to get wrong:
 *  - FILTERING: Nominatim returns whatever OSM has at that name. "Koramangala"
 *    returned a BUS STOP as result #3 - a true row and a useless suggestion.
 *  - NEAR-ME ORDERING: unsorted, the list is "everything named X". Sorted by
 *    distance from where the user is looking, it becomes "what you probably
 *    meant", which is the suggestion the user actually asked for.
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const UA = 'susej-marketplace-demo/1.0';

/** OSM `type` values that are a real place a user could live/sell in. */
const PLACE_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter',
  'borough', 'municipality', 'city_district', 'district', 'county',
  'state_district', 'locality', 'island', 'island_hollow', 'islet',
  'square', 'traffic_square', 'park', 'airport', 'railway_station', 'station',
]);
const PLACE_CLASSES = new Set(['place', 'boundary', 'landuse', 'tourism', 'amenity', 'railway']);

export interface PlaceSuggestion {
  label: string;
  lat: number;
  lng: number;
  kind: string;
  /** Straight-line km from the origin used for the search. */
  distanceKm: number;
}

export function kmBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function formatDistance(km: number): string {
  if (!Number.isFinite(km)) return '';
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** "Koramangala, Sri Lakshmi Devi Ward, Bengaluru" -> the last two useful parts. */
function tidyLabel(displayName: string): string {
  return String(displayName ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

/**
 * Live place search. `origin` biases and orders results by distance - pass the
 * user's current location when known, otherwise the map centre.
 * Returns [] on any failure; the caller must show an honest empty state rather
 * than a stale hardcoded list.
 */
export async function searchPlaces(
  query: string,
  origin: { lat: number; lng: number },
  limit = 8,
): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  try {
    const res = await fetch(
      `${NOMINATIM}/search?format=json&q=${encodeURIComponent(q)}&limit=${limit}&countrycodes=in&addressdetails=1`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) return [];
    const rows: Array<Record<string, unknown>> = await res.json();
    if (!Array.isArray(rows)) return [];

    return rows
      .map((it) => {
        const lat = Number(it.lat);
        const lng = Number(it.lon);
        const kind = String(it.type ?? '');
        const cls = String(it.class ?? '');
        return {
          label: tidyLabel(String(it.display_name ?? '')),
          lat,
          lng,
          kind,
          cls,
          distanceKm: kmBetween(origin.lat, origin.lng, lat, lng),
        };
      })
      .filter((it) => it.label.length > 0 && Number.isFinite(it.lat) && Number.isFinite(it.lng))
      .filter((it) => PLACE_TYPES.has(it.kind) || (PLACE_CLASSES.has(it.cls) && it.kind !== ''))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      // `cls` is only needed for filtering; the UI never renders it.
      .map(({ cls: _cls, ...rest }) => rest);
  } catch {
    return [];
  }
}

/** Reverse-geocode a dropped pin so the label is a real place, never invented. */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const r = await fetch(
      `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`,
      { headers: { 'User-Agent': UA } },
    );
    const j = await r.json();
    const a = (j && j.address) || {};
    const primary = j?.name || a.house_number || a.road || a.suburb || a.neighbourhood;
    const area = a.city || a.town || a.village || a.county || a.state_district || a.state;
    if (primary && area && String(primary) !== String(area)) return `${primary}, ${area}`;
    return String(primary || area || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  } catch {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
}
