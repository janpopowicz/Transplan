import type { Stop } from "../types";

/** Apply project positions after loading fresh OSM data (or another proposal). */
export function mergeStopPositions(osm: Stop[], local: Stop[], moved: Stop[]): Stop[] {
  const stops = new Map(osm.map((stop) => [stop.id, stop.originalPosition
    ? { ...stop, lon: stop.originalPosition[0], lat: stop.originalPosition[1], originalPosition: undefined }
    : stop]));
  for (const stop of moved) stops.set(stop.id, stop);
  for (const stop of local) stops.set(stop.id, stop);
  return [...stops.values()];
}
