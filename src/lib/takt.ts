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

/** Equal-sized steps, from no service at the bottom to the shortest headway. */
export const TAKT_STEPS: (number | null)[] = [null, ...[...TAKT_OPTIONS].reverse()];

export function taktStepIndex(takt: number | null): number {
  if (takt == null) return 0;
  let best = 1;
  for (let i = 2; i < TAKT_STEPS.length; i++) {
    if (Math.abs(TAKT_STEPS[i]! - takt) < Math.abs(TAKT_STEPS[best]! - takt)) best = i;
  }
  return best;
}

export function taktFromPosition(fraction: number): number | null {
  return TAKT_STEPS[Math.round(Math.max(0, Math.min(1, fraction)) * (TAKT_STEPS.length - 1))];
}

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
