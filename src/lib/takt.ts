import { TAKT_OPTIONS } from "../constants";
import type { TransitLine } from "../types";

export function cycleMinutes(line: TransitLine): number {
  const travel = line.segments.reduce((s, seg) => s + seg.travelMin, 0);
  const termini = (line.terminus1Id ? 1 : 0) + (line.terminus2Id ? 1 : 0);
  return travel + line.layoverMin * Math.max(termini, 1);
}

export function vehiclesNeeded(line: TransitLine, takt: number | null): number | null {
  if (takt == null || takt <= 0) return null;
  const cycle = cycleMinutes(line);
  if (cycle <= 0) return null;
  return Math.ceil(cycle / takt);
}

export const MAX_TRIPS_PER_HOUR = 15; // takt 4 min

export function tripsPerHourNum(takt: number | null): number {
  if (takt == null || takt <= 0) return 0;
  return 60 / takt;
}

export function snapTaktFromTrips(trips: number): number | null {
  if (trips < 0.45) return null;
  let best: number = TAKT_OPTIONS[TAKT_OPTIONS.length - 1];
  let bestD = Infinity;
  for (const t of TAKT_OPTIONS) {
    const d = Math.abs(60 / t - trips);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export function peakTakt(line: TransitLine): number | null {
  const peak = [line.takt.wd_am, line.takt.wd_pm].filter((v): v is number => v != null);
  if (!peak.length) {
    const any = Object.values(line.takt).filter((v): v is number => v != null);
    return any.length ? Math.min(...any) : null;
  }
  return Math.min(...peak);
}
