import type { Stop, TransitLine } from "../types";
import { gtfsStopKey, legacyStopKey } from "./gtfsStops";

export const hasStopOverrides = (stop: Stop) => Boolean(stop.originalPosition || stop.groupId
  || stop.originalName !== undefined || stop.originalModes !== undefined);

/** Apply project edits after loading a fresh catalogue (or another proposal). */
export function mergeStopPositions(osm: Stop[], local: Stop[], moved: Stop[]): Stop[] {
  const stops = new Map<string, Stop>(osm.map((stop) => [stop.id, {
    ...stop, lon: stop.originalPosition?.[0] ?? stop.lon, lat: stop.originalPosition?.[1] ?? stop.lat,
    name: stop.originalName ?? stop.name, modes: stop.originalModes ?? stop.modes,
    originalPosition: undefined, originalName: undefined, originalModes: undefined, groupId: undefined,
  }]));
  for (const stop of moved) stops.set(stop.id, stop);
  for (const stop of local) stops.set(stop.id, stop);
  return [...stops.values()];
}

/** Replace old catalogue IDs in saved lines without creating legacy map markers. */
export function mergeStopCatalogue(catalogue: Stop[], project: Stop[], lines: TransitLine[]) {
  if (!catalogue.some((s) => s.source === "gtfs")) return {
    stops: mergeStopPositions(catalogue, project.filter((s) => s.source === "local"),
      project.filter((s) => s.source !== "local" && hasStopOverrides(s))), lines,
  };
  const catalogueIds = new Set(catalogue.map((s) => s.id));
  catalogue = mergeStopPositions([...catalogue, ...project.filter((s) => s.source === "gtfs" && !catalogueIds.has(s.id))], [], []);
  const known = new Map(catalogue.flatMap((s) => [s.id, ...(s.aliases ?? [])].map((id) => [id, s] as const)));
  const byName = new Map(catalogue.map((s) => [gtfsStopKey(s.stationName!, s.platformNumber!), s]));
  const ids = new Map([...known].map(([id, stop]) => [id, stop.id]));
  const referenced = new Set(lines.flatMap((line) => [line.terminus1Id, line.terminus2Id,
    ...line.outboundStopIds, ...line.inboundStopIds,
    ...line.segments.flatMap((s) => [s.fromStopId, s.toStopId])]));
  const changes = new Map<string, Stop>();
  const local = project.filter((s) => s.source === "local");
  for (const old of project) {
    if (old.source === "local") continue;
    const key = legacyStopKey(old.name);
    const target = known.get(old.id) ?? (key ? byName.get(key) : undefined);
    if (target) {
      ids.set(old.id, target.id);
      if (hasStopOverrides(old)) {
        // A group-only edit must not replace fresh GTFS coordinates with OSM coordinates.
        const previous = changes.get(target.id) ?? target;
        changes.set(target.id, { ...previous, ...(old.groupId ? { groupId: old.groupId } : {}),
          ...(old.originalName !== undefined ? { name: old.name, originalName: target.name } : {}),
          ...(old.originalModes !== undefined ? { modes: old.modes, originalModes: target.modes } : {}),
          ...(old.originalPosition ? { lon: old.lon, lat: old.lat,
            originalPosition: [target.lon, target.lat] } : {}) });
      }
    } else if (referenced.has(old.id) || hasStopOverrides(old)) {
      // Preserve an unavailable, used stop as a project proposal, rather than break a line.
      local.push({ ...old, source: "local" });
    }
  }
  const resolve = (id: string) => ids.get(id) ?? id;
  const sequence = (stops: string[]) => stops.map(resolve).filter((id, i, all) => i === 0 || id !== all[i - 1]);
  return {
    stops: mergeStopPositions(catalogue, local, [...changes.values()]),
    lines: lines.map((line) => ({ ...line,
      outboundStopIds: sequence(line.outboundStopIds), inboundStopIds: sequence(line.inboundStopIds),
      terminus1Id: line.terminus1Id ? resolve(line.terminus1Id) : null,
      terminus2Id: line.terminus2Id ? resolve(line.terminus2Id) : null,
      segments: line.segments.map((segment) => ({ ...segment,
        fromStopId: resolve(segment.fromStopId), toStopId: resolve(segment.toStopId),
      })).filter((s) => s.fromStopId !== s.toStopId),
    })),
  };
}
