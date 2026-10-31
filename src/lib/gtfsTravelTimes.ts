import type { GtfsRow } from "./gtfsStops";
import type { Mode, Stop } from "../types";

/** Mode, canonical departure/arrival platform IDs, median seconds, sample count. */
export type GtfsTravelTimeEntry = [Mode, string, string, number, number];
const key = (mode: Mode, from: string, to: string) => JSON.stringify([mode, from, to]);

export function gtfsTimeSeconds(value: string): number | undefined {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}

interface TimedCall {
  id: string; sequence: number; arrival?: number; departure?: number; pickup: string; dropOff: string;
}

/** Import-only collector: keep frequency histograms, not every observed time. */
export function createGtfsTravelTimeCollector(stops: Stop[]) {
  const canonical = new Map(stops.flatMap((s) => (s.gtfsIds ?? []).map((id) => [id, s.id] as const)));
  const pairs = new Map<string, { mode: Mode; from: string; to: string; seconds: Map<number, number>; count: number }>();
  return {
    addFeed(feed: { id: string; mode: Mode; routes: GtfsRow[]; trips: GtfsRow[]; stopTimes: Iterable<GtfsRow> }) {
      const modes = new Map(feed.routes.map((route) => [route.route_id,
        (route.route_type === "0" || route.route_type === "900") ? "tram" : ["3", "11"].includes(route.route_type) ? "bus" : undefined] as const));
      const trips = new Map(feed.trips.map((trip) => [trip.trip_id, modes.get(trip.route_id)]));
      const calls = new Map<string, Map<number, TimedCall | null>>();
      const invalid = new Set<string>();
      for (const row of feed.stopTimes) {
        if (!row.trip_id || !trips.get(row.trip_id)) continue;
        if (!/^\d+$/.test(row.stop_sequence)) { invalid.add(row.trip_id); continue; }
        const sequence = Number(row.stop_sequence);
        const list = calls.get(row.trip_id) ?? new Map<number, TimedCall | null>();
        const call = { id: row.stop_id, sequence, arrival: gtfsTimeSeconds(row.arrival_time),
          departure: gtfsTimeSeconds(row.departure_time), pickup: row.pickup_type, dropOff: row.drop_off_type };
        list.set(sequence, list.has(sequence) ? null : call);
        calls.set(row.trip_id, list);
      }
      for (const [id, callsBySequence] of calls) {
        if (invalid.has(id)) continue;
        const mode = trips.get(id)!;
        // File order is not guaranteed; stop_sequence also handles interleaved trips.
        const ordered = [...callsBySequence].sort(([a], [b]) => a - b).map(([, call]) => call);
        for (let i = 1; i < ordered.length; i++) {
          const a = ordered[i - 1], b = ordered[i];
          if (!a || !b || a.departure === undefined || b.arrival === undefined || a.pickup === "1" || b.dropOff === "1") continue;
          const from = canonical.get(`${feed.id}:${a.id}`), to = canonical.get(`${feed.id}:${b.id}`);
          const seconds = b.arrival - a.departure;
          if (!from || !to || from === to || seconds < 0) continue;
          const pairKey = key(mode, from, to);
          const pair = pairs.get(pairKey) ?? { mode, from, to, seconds: new Map<number, number>(), count: 0 };
          pair.seconds.set(seconds, (pair.seconds.get(seconds) ?? 0) + 1);
          pair.count++; pairs.set(pairKey, pair);
        }
      }
    },
    entries(): GtfsTravelTimeEntry[] {
      return [...pairs].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => {
        const middle1 = Math.floor((pair.count - 1) / 2), middle2 = Math.floor(pair.count / 2);
        let count = 0, left = 0, right = 0;
        for (const [seconds, frequency] of [...pair.seconds].sort(([a], [b]) => a - b)) {
          if (count <= middle1 && count + frequency > middle1) left = seconds;
          if (count <= middle2 && count + frequency > middle2) { right = seconds; break; }
          count += frequency;
        }
        return [pair.mode, pair.from, pair.to, (left + right) / 2, pair.count];
      });
    },
  };
}

let times = new Map<string, { seconds: number; samples: number }>();
let loaded = false;
let pending: Promise<boolean> | undefined;

export function installGtfsTravelTimes(entries: GtfsTravelTimeEntry[]) {
  times = new Map(entries.map(([mode, from, to, seconds, samples]) => [key(mode, from, to), { seconds, samples }]));
  loaded = true;
}

export function lookupGtfsTravelTime(from: Stop, to: Stop, mode: Mode) {
  return times.get(key(mode, from.id, to.id));
}
export const gtfsTravelTimesReady = () => loaded;

export function loadGtfsTravelTimes(force = false): Promise<boolean> {
  if (pending) return pending;
  if (loaded && !force) return Promise.resolve(true);
  pending = (async () => {
    try {
      const response = await fetch("/gtfs-times.json", { cache: "no-cache", signal: AbortSignal.timeout(5000) });
      if (!response.ok) return false;
      const data = await response.json() as { version?: number; entries?: GtfsTravelTimeEntry[] };
      if (data.version !== 1 || !Array.isArray(data.entries) || !data.entries.every((entry) => Array.isArray(entry)
        && entry.length === 5 && ["bus", "tram"].includes(entry[0]) && typeof entry[1] === "string" && typeof entry[2] === "string"
        && Number.isFinite(entry[3]) && entry[3] >= 0 && Number.isSafeInteger(entry[4]) && entry[4] > 0)) return false;
      installGtfsTravelTimes(data.entries);
      return true;
    } catch { return false; }
  })().finally(() => { pending = undefined; });
  return pending;
}
