// Approximate coordinates only — good enough for a fleet/shipment overview
// map, not turn-by-turn precision. No external geocoding API key required.

export type LatLng = [number, number];

const US_STATE_CENTROIDS: Record<string, LatLng> = {
  AL: [32.806671, -86.79113], AK: [61.370716, -152.404419], AZ: [33.729759, -111.431221],
  AR: [34.969704, -92.373123], CA: [36.116203, -119.681564], CO: [39.059811, -105.311104],
  CT: [41.597782, -72.755371], DE: [39.318523, -75.507141], FL: [27.766279, -81.686783],
  GA: [33.040619, -83.643074], HI: [21.094318, -157.498337], ID: [44.240459, -114.478828],
  IL: [40.349457, -88.986137], IN: [39.849426, -86.258278], IA: [42.011539, -93.210526],
  KS: [38.5266, -96.726486], KY: [37.66814, -84.670067], LA: [31.169546, -91.867805],
  ME: [44.693947, -69.381927], MD: [39.063946, -76.802101], MA: [42.230171, -71.530106],
  MI: [43.326618, -84.536095], MN: [45.694454, -93.900192], MS: [32.741646, -89.678696],
  MO: [38.456085, -92.288368], MT: [46.921925, -110.454353], NE: [41.12537, -98.268082],
  NV: [38.313515, -117.055374], NH: [43.452492, -71.563896], NJ: [40.298904, -74.521011],
  NM: [34.840515, -106.248482], NY: [42.165726, -74.948051], NC: [35.630066, -79.806419],
  ND: [47.528912, -99.784012], OH: [40.388783, -82.764915], OK: [35.565342, -96.928917],
  OR: [44.572021, -122.070938], PA: [40.590752, -77.209755], RI: [41.680893, -71.51178],
  SC: [33.856892, -80.945007], SD: [44.299782, -99.438828], TN: [35.747845, -86.692345],
  TX: [31.054487, -97.563461], UT: [40.150032, -111.862434], VT: [44.045876, -72.710686],
  VA: [37.769337, -78.169968], WA: [47.400902, -121.490494], WV: [38.491226, -80.954453],
  WI: [44.268543, -89.616508], WY: [42.755966, -107.30249], DC: [38.897438, -77.026817],
};

// Logistics-specific hubs worth pinning precisely rather than falling back
// to a whole-state centroid: your own warehouses, the LA/LB port gateway,
// and the Asia-Pacific origin ports/cities that actually show up in IMPORTS.
const CITY_OVERRIDES: Record<string, LatLng> = {
  "buena park,ca": [33.8675, -117.9981],
  "santa fe springs,ca": [33.9459, -118.0631],
  "saddle brook,nj": [40.8987, -74.0937],
  "los angeles,ca": [34.0522, -118.2437],
  "long beach,ca": [33.7701, -118.1937],
  "newark,nj": [40.7357, -74.1724],
  "elizabeth,nj": [40.6639, -74.2107],
  "seoul,kr": [37.5665, 126.978],
  "busan,kr": [35.1796, 129.0756],
  "incheon,kr": [37.4563, 126.7052],
  "shanghai,cn": [31.2304, 121.4737],
  "ningbo,cn": [29.8683, 121.544],
  "shenzhen,cn": [22.5431, 114.0579],
  "yantian,cn": [22.5764, 114.2653],
  "qingdao,cn": [36.0671, 120.3826],
  "xiamen,cn": [24.4798, 118.0894],
  "hong kong,hk": [22.3193, 114.1694],
  "ho chi minh city,vn": [10.8231, 106.6297],
  "tokyo,jp": [35.6762, 139.6503],
  "yokohama,jp": [35.4437, 139.638],
};

const COUNTRY_CENTROIDS: Record<string, LatLng> = {
  KR: [36.5, 127.75], CN: [35.0, 105.0], VN: [16.0, 106.0], JP: [36.0, 138.0],
  HK: [22.3193, 114.1694], TW: [23.7, 121.0], US: [39.5, -98.35],
};

function normalize(value?: string) {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Best-effort geocode from carrier-tracking or IMPORTS-sheet place names.
 * Tries, in order: exact "city,state" or "city,country" override, then
 * state centroid, then country centroid. Returns null if nothing matches —
 * callers should skip the marker rather than guess.
 */
export function geocode(city?: string, state?: string, country?: string): LatLng | null {
  const cityKey = normalize(city);
  const stateKey = normalize(state);
  const countryKey = normalize(country);

  if (cityKey && stateKey) {
    const hit = CITY_OVERRIDES[`${cityKey},${stateKey}`];
    if (hit) return hit;
  }
  if (cityKey && countryKey) {
    const hit = CITY_OVERRIDES[`${cityKey},${countryKey}`];
    if (hit) return hit;
  }
  if (stateKey) {
    const code = stateKey.toUpperCase();
    if (US_STATE_CENTROIDS[code]) return US_STATE_CENTROIDS[code];
  }
  if (countryKey) {
    const code = countryKey.toUpperCase();
    if (COUNTRY_CENTROIDS[code]) return COUNTRY_CENTROIDS[code];
    if (code === "US" || code === "USA") return COUNTRY_CENTROIDS.US;
  }
  return null;
}

/** Parses freeform "City, ST" / "City, Country" text (e.g. IMPORTS "origin"/"destination" columns) into a geocode() call. */
export function geocodeLabel(label?: string): LatLng | null {
  if (!label) return null;
  const parts = label.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const city = parts[0];
  const region = parts[parts.length - 1];
  const isUsStateCode = /^[A-Za-z]{2}$/.test(region) && Boolean(US_STATE_CENTROIDS[region.toUpperCase()]);
  return isUsStateCode ? geocode(city, region) : geocode(city, undefined, region);
}
