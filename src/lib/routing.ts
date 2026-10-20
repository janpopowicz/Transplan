import type { Coord, Mode } from "../types";
import { haversine } from "./geo";
import { roadGraph, tramGraph } from "./tramGraph";

const VALHALLA = ["/valhalla", "https://valhalla1.openstreetmap.de/route"];

const OSRM = [
  "https://router.project-osrm.org/route/v1/driving",
  "https://routing.openstreetmap.de/routed-car/route/v1/driving",
];

export async function routeBetween(
  from: Coord,
  to: Coord,
  mode: Mode,
  waypoints: Coord[] = [],
): Promise<Coord[]> {
  if (waypoints.length) {
    const points = [from, ...waypoints, to];
    const geometry: Coord[] = [];
    for (let i = 1; i < points.length; i++) {
      const leg = await routeLeg(points[i - 1], points[i], mode, true);
      const last = geometry.at(-1);
      geometry.push(...(last && haversine(last, leg[0]) < 0.1 ? leg.slice(1) : leg));
    }
    return geometry;
  }
  return routeLeg(from, to, mode);
}

async function routeLeg(from: Coord, to: Coord, mode: Mode, preserveEndpoints = false): Promise<Coord[]> {
  if (mode === "tram") {
    const path = tramGraph.route(from, to);
    if (path && path.length >= 2) return path;
    throw new Error(
      "Brak połączenia torowego między przystankami. Dorysuj torowisko albo wybierz inny przystanek.",
    );
  }
  return routeBus(from, to, preserveEndpoints);
}

async function routeBus(from: Coord, to: Coord, preserveEndpoints: boolean): Promise<Coord[]> {
  if (!roadGraph.isEmpty()) {
    const path = roadGraph.route(from, to);
    if (path && path.length >= 2) return path;
    throw new Error(
      "Brak przejezdnego połączenia drogowego (odcinek w budowie albo poza siecią). Przełącz budowę albo wybierz inny przystanek.",
    );
  }
  let last: Error | null = null;
  try {
    return await routeValhallaBus(from, to, preserveEndpoints);
  } catch (e) {
    last = e instanceof Error ? e : new Error(String(e));
  }
  for (const base of OSRM) {
    try {
      return await routeOsrm(base, from, to, preserveEndpoints);
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last ?? new Error("Nie udało się wyznaczyć trasy");
}

async function routeValhallaBus(from: Coord, to: Coord, preserveEndpoints: boolean): Promise<Coord[]> {
  const body = {
    locations: [
      { lon: from[0], lat: from[1] },
      { lon: to[0], lat: to[1] },
    ],
    costing: "bus",
    costing_options: {
      bus: {
        ignore_restrictions: true,
        use_highways: 1,
        use_tolls: 1,
      },
    },
    directions_type: "none",
  };
  let last: Error | null = null;
  for (const url of VALHALLA) {
    try {
      const res = await fetch(`${url}?json=${encodeURIComponent(JSON.stringify(body))}`);
      if (!res.ok) throw new Error(`Valhalla ${res.status}`);
      const json = (await res.json()) as {
        trip?: { status?: number; legs?: { shape?: string }[] };
        error?: string;
        error_code?: number;
      };
      if (json.error) throw new Error(json.error);
      const shape = json.trip?.legs?.[0]?.shape;
      if (!shape) throw new Error("Brak trasy");
      const decoded = decodePolyline(shape, 6);
      const geom = preserveEndpoints ? decoded : trimStopSpurs(decoded, from, to);
      if (geom.length < 2) throw new Error("Brak trasy");
      return geom;
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw last ?? new Error("Valhalla niedostępna");
}

async function routeOsrm(base: string, from: Coord, to: Coord, preserveEndpoints: boolean): Promise<Coord[]> {
  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const res = await fetch(
    `${base}/${coords}?overview=full&geometries=geojson&continue_straight=false`,
  );
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = (await res.json()) as {
    routes?: { geometry: { coordinates: Coord[] } }[];
  };
  const geom = json.routes?.[0]?.geometry?.coordinates;
  if (!geom || geom.length < 2) throw new Error("Brak trasy");
  return preserveEndpoints ? geom : trimStopSpurs(geom, from, to);
}

/**
 * External routers include a spur from the carriageway to the exact stop.
 * Drop points that only exist to reach the platform.
 */
function trimStopSpurs(geom: Coord[], from: Coord, to: Coord): Coord[] {
  const g = geom.slice();
  while (
    g.length > 2 &&
    haversine(g[0], from) < 80 &&
    haversine(g[0], from) + 4 < haversine(g[1], from)
  ) {
    g.shift();
  }
  while (g.length > 2) {
    const n = g.length;
    if (haversine(g[n - 1], to) < 80 && haversine(g[n - 1], to) + 4 < haversine(g[n - 2], to)) {
      g.pop();
    } else break;
  }
  return g.length >= 2 ? g : geom;
}

/** Google polyline, precision 6 (Valhalla default). */
function decodePolyline(encoded: string, precision: number): Coord[] {
  const factor = 10 ** precision;
  const coords: Coord[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < encoded.length) {
    lat += decodeDelta();
    lon += decodeDelta();
    coords.push([lon / factor, lat / factor]);
  }
  return coords;

  function decodeDelta(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}
