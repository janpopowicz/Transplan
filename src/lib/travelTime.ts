import { AVERAGE_SPEED_KMH } from "../constants";
import type { Coord, Mode } from "../types";
import { lineLength } from "./geo";

/** Round to the half-minute steps used by the timetable editor. */
export function estimateTravelMinutes(geometry: Coord[], mode: Mode): number {
  return Math.max(0.5, Math.round(lineLength(geometry) / 1000 / AVERAGE_SPEED_KMH[mode] * 60 * 2) / 2);
}
