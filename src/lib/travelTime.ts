import { AVERAGE_SPEED_KMH } from "../constants";
import type { Coord, Mode, TransitLine } from "../types";
import { lineLength } from "./geo";

/** Whole minutes, consistent with the timetable editor. */
export function estimateTravelMinutes(geometry: Coord[], mode: Mode): number {
  return Math.max(1, Math.round(lineLength(geometry) / 1000 / AVERAGE_SPEED_KMH[mode] * 60));
}

export function wholeMinuteTimes(lines: TransitLine[]): TransitLine[] {
  return lines.map((line) => ({ ...line, segments: line.segments.map((segment) => ({ ...segment,
    travelMin: Math.max(1, Math.round(segment.travelMin)),
  })) }));
}
