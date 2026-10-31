import { BBOX } from "../constants";
import type { Mode, Stop } from "../types";

export type GtfsRow = Record<string, string>;
export interface GtfsFeed { id: string; mode: Mode; rows: GtfsRow[] }

/** Stream records so large stop_times files do not become arrays of row objects. */
export function* gtfsCsvRows(text: string): Generator<GtfsRow> {
  let row: string[] = [], field = "", quoted = false, header: string[] | undefined;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(field); field = "";
      if (c !== ",") {
        if (row.some(Boolean)) {
          if (!header) header = row;
          else yield Object.fromEntries(header.map((key, j) => [key, row[j] ?? ""]));
        }
        row = [];
        if (c === "\r" && input[i + 1] === "\n") i++;
      }
    } else field += c;
  }
  if (quoted) throw new Error("Niekompletny CSV GTFS.");
  if (field || row.length) {
    row.push(field);
    if (!header) header = row;
    else yield Object.fromEntries(header.map((key, j) => [key, row[j] ?? ""]));
  }
  if (!header?.length) throw new Error("Pusty CSV GTFS.");
}

/** RFC 4180: quoted commas, escaped quotes and embedded line breaks. */
export function parseGtfsCsv(text: string): GtfsRow[] { return [...gtfsCsvRows(text)]; }

export const gtfsStopKey = (name: string, platform: string) => JSON.stringify([name, platform]);

export function importGtfsStops(feeds: GtfsFeed[]): Stop[] {
  const stops = new Map<string, Stop>();
  for (const feed of feeds) for (const row of feed.rows) {
    if (row.location_type && row.location_type !== "0") continue;
    const stationName = row.stop_name?.trim();
    const rawPlatform = row.platform_code?.trim() || row.stop_desc?.trim() || row.stop_code?.split("-").at(-1)?.trim();
    if (!row.stop_id || !stationName || !rawPlatform || !/^\d+$/.test(rawPlatform)
      || !row.stop_lat?.trim() || !row.stop_lon?.trim()) throw new Error(`Nieprawidłowe stanowisko GTFS ${feed.id}:${row.stop_id}`);
    const platformNumber = rawPlatform.padStart(2, "0");
    const lat = Number(row.stop_lat), lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`Nieprawidłowa pozycja GTFS ${feed.id}:${row.stop_id}`);
    if (lat < BBOX.south || lat > BBOX.north || lon < BBOX.west || lon > BBOX.east) continue;
    const key = gtfsStopKey(stationName, platformNumber);
    let stop = stops.get(key);
    if (!stop) {
      stop = { id: `gtfs-${encodeURIComponent(stationName)}-${platformNumber}`, name: `${stationName} ${platformNumber}`,
        stationName, platformNumber, lat, lon, modes: [], source: "gtfs", gtfsIds: [] };
      stops.set(key, stop);
    }
    if (!stop.modes.includes(feed.mode)) stop.modes.push(feed.mode);
    const id = `${feed.id}:${row.stop_id}`;
    if (!stop.gtfsIds!.includes(id)) stop.gtfsIds!.push(id);
  }
  return [...stops.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Only exact full names with a platform number can migrate legacy OSM IDs. */
export function legacyStopKey(name: string): string | null {
  const match = /^(.*?)\s+(\d{1,3})$/.exec(name.trim());
  return match ? gtfsStopKey(match[1], match[2].padStart(2, "0")) : null;
}

export function attachLegacyStopIds(stops: Stop[], legacy: Pick<Stop, "id" | "name">[]): Stop[] {
  const byKey = new Map(stops.map((s) => [gtfsStopKey(s.stationName!, s.platformNumber!), s]));
  for (const old of legacy) {
    const key = legacyStopKey(old.name);
    const stop = key ? byKey.get(key) : undefined;
    if (stop && old.id !== stop.id) stop.aliases = [...new Set([...(stop.aliases ?? []), old.id])];
  }
  return stops;
}

export async function fetchGtfsStops(): Promise<Stop[]> {
  const res = await fetch("/stops.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Nie udało się wczytać katalogu GTFS (${res.status}).`);
  const data = await res.json() as { version?: number; stops?: Stop[] };
  if (data.version !== 1 || !data.stops?.length || data.stops.some((s) => s.source !== "gtfs" || !s.stationName || !s.platformNumber)) {
    throw new Error("Nieprawidłowy katalog przystanków GTFS.");
  }
  const identities = new Set(data.stops.map((s) => gtfsStopKey(s.stationName!, s.platformNumber!)));
  if (identities.size !== data.stops.length) throw new Error("Powtórzone stanowiska w katalogu GTFS.");
  return data.stops;
}
