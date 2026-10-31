import { BUS_VEHICLES, PERIODS, TRAM_VEHICLES } from "../constants";
import type { Coord, LineSegment, Stop, TramTrack, TransitLine } from "../types";

export interface Proposal {
  lines: TransitLine[];
  localStops: Stop[];
  movedStops?: Stop[];
  localTracks: TramTrack[];
  constructionOverrides: Record<string, boolean>;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length <= 10000;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const list = <T>(v: unknown, check: (item: unknown) => item is T): v is T[] => Array.isArray(v) && v.every(check);
const mode = (v: unknown): v is "bus" | "tram" => v === "bus" || v === "tram";
const coord = (v: unknown): v is Coord => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1])
  && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90;
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);

function stop(v: unknown): v is Stop {
  return record(v) && str(v.id) && str(v.name) && coord([v.lon, v.lat]) && list(v.modes, mode)
    && (v.source === "osm" || v.source === "gtfs" || v.source === "local") && optional(v.groupId, str)
    && optional(v.stationName, str) && optional(v.platformNumber, str)
    && optional(v.gtfsIds, (ids) => list(ids, str)) && optional(v.aliases, (ids) => list(ids, str))
    && optional(v.osmId, num) && optional(v.originalPosition, coord)
    && optional(v.originalName, str) && optional(v.originalModes, (modes) => list(modes, mode) && modes.length > 0);
}

function track(v: unknown): v is TramTrack {
  return record(v) && str(v.id) && list(v.geometry, coord) && typeof v.construction === "boolean"
    && (v.source === "osm" || v.source === "local") && optional(v.kind, (k) => k === "tram" || k === "road")
    && optional(v.osmId, num);
}

function segment(v: unknown): v is LineSegment {
  return record(v) && str(v.id) && str(v.fromStopId) && str(v.toStopId) && list(v.geometry, coord)
    && num(v.travelMin) && v.travelMin >= 0 && (v.direction === "outbound" || v.direction === "inbound")
    && optional(v.waypoints, (p) => list(p, coord))
    && optional(v.travelTimeSource, (s) => s === "auto" || s === "gtfs" || s === "gtfs-import" || s === "manual")
    && optional(v.gtfsSamples, (n) => num(n) && Number.isSafeInteger(n) && n > 0);
}

function periodDirections(value: unknown, check: (v: unknown) => boolean) {
  return record(value) && Object.entries(value).every(([period, directions]) => PERIODS.some((p) => p.id === period)
    && record(directions) && Object.entries(directions).every(([direction, item]) => ["outbound", "inbound"].includes(direction) && check(item)));
}
function line(v: unknown): v is TransitLine {
  return record(v) && str(v.id) && str(v.number) && str(v.name) && mode(v.mode) && str(v.color)
    && [...BUS_VEHICLES, ...TRAM_VEHICLES].some((vehicle) => vehicle.id === v.vehicle)
    && typeof v.visible === "boolean" && list(v.outboundStopIds, str) && list(v.inboundStopIds, str)
    && (v.terminus1Id === null || str(v.terminus1Id)) && (v.terminus2Id === null || str(v.terminus2Id))
    && optional(v.coordinatedLineIds, (ids) => list(ids, str))
    && optional(v.coordinationId, (id) => str(id) && id.length > 0)
    && optional(v.departureOffsetMin, num)
    && optional(v.departureOffsets, (p) => periodDirections(p, num))
    && optional(v.serviceWindows, (p) => periodDirections(p, (w) => Array.isArray(w) && w.length === 2 && w.every(num) && w[0] >= 0 && w[1] > w[0] && w[1] <= 1440))
    && optional(v.gtfsImport, (g) => record(g) && [g.feed, g.route, g.variant, g.weekday, g.weekend].every(str))
    && list(v.segments, segment) && num(v.layoverMin) && v.layoverMin >= 0 && record(v.takt)
    && PERIODS.every(({ id }) => { const t = (v.takt as Record<string, unknown>)[id]; return t === null || (t === undefined && id.endsWith("night")) || (num(t) && t > 0); });
}

/** Validate at both API and browser boundaries before data reaches the editor. */
export function parseProposal(value: unknown): Proposal {
  if (!record(value) || !list(value.lines, line) || !list(value.localStops, stop)
    || !optional(value.movedStops, (v) => list(v, stop)) || !list(value.localTracks, track)
    || !record(value.constructionOverrides) || !Object.values(value.constructionOverrides).every((v) => typeof v === "boolean")
    || value.localStops.some((s) => s.source !== "local") || value.localTracks.some((t) => t.source !== "local")
    || (value.movedStops as Stop[] | undefined)?.some((s) => s.source !== "osm" && s.source !== "gtfs")) {
    throw new Error("Nieprawidłowe dane sieci.");
  }
  return { lines: value.lines.map((l) => ({ ...l, takt: Object.assign({ wd_night: null, we_night: null }, l.takt) })), localStops: value.localStops, movedStops: value.movedStops as Stop[] | undefined,
    localTracks: value.localTracks, constructionOverrides: value.constructionOverrides as Record<string, boolean> };
}
