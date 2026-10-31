import { AVERAGE_SPEED_KMH } from "../constants";
import type { Coord, LineSegment, Mode, Stop, TransitLine } from "../types";
import { lineLength } from "./geo";
import { gtfsTravelTimesReady, lookupGtfsTravelTime } from "./gtfsTravelTimes";

/** Whole minutes, consistent with the timetable editor. */
export function estimateTravelMinutes(geometry: Coord[], mode: Mode): number {
  return Math.max(1, Math.round(lineLength(geometry) / 1000 / AVERAGE_SPEED_KMH[mode] * 60));
}

export function automaticTravelTime(from: Stop | undefined, to: Stop | undefined, geometry: Coord[], mode: Mode):
  Pick<LineSegment, "travelMin" | "travelTimeSource" | "gtfsSamples"> {
  const match = from && to ? lookupGtfsTravelTime(from, to, mode) : undefined;
  return match ? { travelMin: Math.max(1, Math.round(match.seconds / 60)), travelTimeSource: "gtfs", gtfsSamples: match.samples }
    : { travelMin: estimateTravelMinutes(geometry, mode), travelTimeSource: "auto", gtfsSamples: undefined };
}

/** Upgrade previous automatic estimates without overwriting manual times. */
export function refreshAutomaticTravelTimes(lines: TransitLine[], stops: Stop[]): TransitLine[] {
  const byId = new Map(stops.map((s) => [s.id, s]));
  return lines.map((line) => {
    let changed = false;
    const segments = line.segments.map((segment) => {
      if (segment.travelTimeSource !== "auto" && segment.travelTimeSource !== "gtfs") return segment;
      if (segment.travelTimeSource === "gtfs" && !gtfsTravelTimesReady()) return segment;
      const time = automaticTravelTime(byId.get(segment.fromStopId), byId.get(segment.toStopId), segment.geometry, line.mode);
      if (segment.travelMin === time.travelMin && segment.travelTimeSource === time.travelTimeSource && segment.gtfsSamples === time.gtfsSamples) return segment;
      changed = true;
      return { ...segment, ...time };
    });
    return changed ? { ...line, segments } : line;
  });
}

export function wholeMinuteTimes(lines: TransitLine[]): TransitLine[] {
  return lines.map((line) => ({ ...line, takt: Object.assign({ wd_night: null, we_night: null }, line.takt), segments: line.segments.map((segment) => ({ ...segment,
    travelMin: Math.max(1, Math.round(segment.travelMin)),
  })) }));
}
