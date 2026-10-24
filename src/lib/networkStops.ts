import { STOP_GROUP_METERS } from "../constants";
import type { Coord, Stop, TransitLine } from "../types";
import type { RenderSegment } from "./interline";
import { bearing, clusterCentroid, clusterStops, nearestPointOnLine } from "./geo";

export interface NetworkStopMarker {
  group: Stop[];
  lineId: string;
  coord: Coord;
  color: string;
  radius: number;
  direction: number | null;
}

/** Project a group's centroid onto each service that actually calls there. */
export function buildNetworkStopMarkers(
  lines: TransitLine[], stops: Stop[], render: RenderSegment[],
): NetworkStopMarker[] {
  const groups = clusterStops([...stops].sort((a, b) => a.id.localeCompare(b.id)), STOP_GROUP_METERS);
  const groupByStop = new Map<string, Stop[]>();
  for (const group of groups) for (const stop of group) groupByStop.set(stop.id, group);
  const incident = new Map<string, RenderSegment[]>();
  for (const segment of render) for (const id of [segment.fromGroupId, segment.toGroupId]) {
    if (!id) continue;
    const key = JSON.stringify([segment.lineId, id]);
    const parts = incident.get(key) ?? [];
    parts.push(segment);
    incident.set(key, parts);
  }
  const markers: NetworkStopMarker[] = [];
  for (const line of lines) {
    if (!line.visible) continue;
    // Segment endpoints also cover partial routes still being drawn/imported.
    // Virtual cuts created for express snapping never enter this list.
    const served = new Set([...line.outboundStopIds, ...line.inboundStopIds,
      ...line.segments.flatMap((s) => [s.fromStopId, s.toStopId])]
      .map((id) => groupByStop.get(id)).filter((g): g is Stop[] => Boolean(g)));
    for (const group of served) {
      const parts = incident.get(JSON.stringify([line.id, group[0].id]));
      if (!parts?.length) continue;
      const center = clusterCentroid(group);
      const projections = parts.map((s) => ({ segment: s, ...nearestPointOnLine(center, s.geometry) }));
      const nearest = projections.reduce((a, b) => a.dist <= b.dist ? a : b);
      const memberIds = new Set(group.map((stop) => stop.id));
      const serves = (direction: "outbound" | "inbound") => {
        const ids = direction === "outbound" ? line.outboundStopIds : line.inboundStopIds;
        // Saved stop sequences describe actual calls; segment endpoints cover drafts.
        return ids.length ? ids.some((id) => memberIds.has(id))
          : line.segments.some((segment) => segment.direction === direction &&
            (memberIds.has(segment.fromStopId) || memberIds.has(segment.toStopId)));
      };
      const outbound = serves("outbound"), inbound = serves("inbound");
      let direction: number | null = null;
      if (outbound !== inbound) {
        const travel = outbound ? "outbound" : "inbound";
        const legs = line.segments.filter((segment) => segment.direction === travel && segment.geometry.length >= 2);
        const leg = legs.find((segment) => memberIds.has(segment.fromStopId))
          ?? legs.find((segment) => memberIds.has(segment.toStopId));
        if (leg) {
          const atStart = memberIds.has(leg.fromStopId);
          const i = atStart ? 0 : leg.geometry.length - 2;
          const actual = bearing(leg.geometry[i], leg.geometry[i + 1]);
          // A collapsed corridor may be stored opposite to this service's travel.
          const tangent = bearing(nearest.segment.geometry[nearest.index], nearest.segment.geometry[nearest.index + 1]);
          direction = Math.cos((actual - tangent) * Math.PI / 180) >= 0 ? tangent : (tangent + 180) % 360;
        }
      }
      markers.push({ direction, group, lineId: line.id, coord: nearest.coord, color: line.color,
        radius: Math.max(1.8, Math.min(4.2, nearest.segment.width * 0.35)) });
    }
  }
  return markers;
}
