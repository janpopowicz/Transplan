import { BUS_VEHICLES, PERIODS, TAKT_OPTIONS, TRAM_VEHICLES } from "../constants";
import type { Coord, LineSegment, Stop, TramTrack, TransitLine } from "../types";

export interface Proposal {
  lines: TransitLine[];
  localStops: Stop[];
  movedStops?: Stop[];
  localTracks: TramTrack[];
  constructionOverrides: Record<string, boolean>;
}
export const MAX_PROPOSAL_BYTES = 10 * 1024 * 1024;
export const PROPOSAL_LIMITS = { lines: 500, stops: 10000, tracks: 2000, stopsPerLine: 500,
  segmentsPerLine: 1000, vertices: 200000, geometry: 20000, coordinationLinks: 2000 } as const;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const fields = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const id = (v: unknown): v is string => text(v, 256) && v.length > 0 && !reserved.has(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bounded = (v: unknown, min: number, max: number): v is number => num(v) && v >= min && v <= max;
const list = <T>(v: unknown, check: (item: unknown) => item is T, max: number): v is T[] => Array.isArray(v) && v.length <= max && v.every(check);
const mode = (v: unknown): v is "bus" | "tram" => v === "bus" || v === "tram";
const modes = (v: unknown): v is ("bus" | "tram")[] => list(v, mode, 2) && v.length > 0 && new Set(v).size === v.length;
const coord = (v: unknown): v is Coord => Array.isArray(v) && v.length === 2 && bounded(v[0], -180, 180) && bounded(v[1], -85, 85);
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const ids = (v: unknown, max = 500): v is string[] => list(v, id, max);
const unique = (items: { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;
const offset = (v: unknown) => bounded(v, -1440, 1440);
export const validHeadway = (v: unknown): v is number => num(v) && (TAKT_OPTIONS as readonly number[]).includes(v);

function stop(v: unknown): v is Stop {
  return record(v) && fields(v, ["id", "name", "lon", "lat", "modes", "source", "groupId", "stationName", "platformNumber", "gtfsIds", "aliases", "osmId", "originalPosition", "originalName", "originalModes"])
    && id(v.id) && text(v.name) && coord([v.lon, v.lat]) && modes(v.modes)
    && ["osm", "gtfs", "local"].includes(v.source as string) && optional(v.groupId, id)
    && optional(v.stationName, text) && optional(v.platformNumber, (p) => text(p, 32))
    && optional(v.gtfsIds, (v) => ids(v, 100)) && optional(v.aliases, (v) => ids(v, 100))
    && optional(v.osmId, (n) => Number.isSafeInteger(n) && (n as number) > 0) && optional(v.originalPosition, coord)
    && optional(v.originalName, text) && optional(v.originalModes, modes);
}
function geometry(v: unknown): v is Coord[] {
  if (!list(v, coord, PROPOSAL_LIMITS.geometry)) return false;
  // Prevent compact two-point inputs expanding into millions of render vertices.
  let distance = 0;
  for (let i = 1; i < v.length; i++) {
    distance += Math.hypot((v[i][0] - v[i - 1][0]) * Math.cos(v[i][1] * Math.PI / 180), v[i][1] - v[i - 1][1]) * 111320;
    if (distance > 200000) return false;
  }
  return true;
}
function track(v: unknown): v is TramTrack {
  return record(v) && fields(v, ["id", "geometry", "construction", "source", "kind", "osmId"])
    && id(v.id) && geometry(v.geometry) && typeof v.construction === "boolean"
    && (v.source === "osm" || v.source === "local") && optional(v.kind, (k) => k === "tram" || k === "road")
    && optional(v.osmId, (n) => Number.isSafeInteger(n) && (n as number) > 0);
}
function segment(v: unknown): v is LineSegment {
  return record(v) && fields(v, ["id", "fromStopId", "toStopId", "geometry", "travelMin", "direction", "waypoints", "travelTimeSource", "gtfsSamples"])
    && id(v.id) && id(v.fromStopId) && id(v.toStopId) && geometry(v.geometry)
    && bounded(v.travelMin, 0, 1440) && (v.direction === "outbound" || v.direction === "inbound")
    && optional(v.waypoints, (p) => list(p, coord, 100))
    && optional(v.travelTimeSource, (s) => ["auto", "gtfs", "gtfs-import", "manual"].includes(s as string))
    && optional(v.gtfsSamples, (n) => Number.isSafeInteger(n) && bounded(n, 1, 10000000));
}
function periodDirections(value: unknown, check: (v: unknown) => boolean) {
  return record(value) && Object.entries(value).every(([period, directions]) => PERIODS.some((p) => p.id === period)
    && record(directions) && Object.entries(directions).every(([direction, item]) => ["outbound", "inbound"].includes(direction) && check(item)));
}
function line(v: unknown): v is TransitLine {
  return record(v) && fields(v, ["id", "number", "name", "mode", "color", "vehicle", "visible", "outboundStopIds", "inboundStopIds", "terminus1Id", "terminus2Id", "coordinatedLineIds", "coordinationId", "departureOffsetMin", "departureOffsets", "serviceWindows", "gtfsImport", "segments", "layoverMin", "takt"])
    && id(v.id) && text(v.number, 64) && text(v.name) && mode(v.mode) && typeof v.color === "string" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(v.color)
    && (v.mode === "bus" ? BUS_VEHICLES : TRAM_VEHICLES).some((vehicle) => vehicle.id === v.vehicle)
    && typeof v.visible === "boolean" && ids(v.outboundStopIds, PROPOSAL_LIMITS.stopsPerLine) && ids(v.inboundStopIds, PROPOSAL_LIMITS.stopsPerLine)
    && (v.terminus1Id === null || id(v.terminus1Id)) && (v.terminus2Id === null || id(v.terminus2Id))
    && optional(v.coordinatedLineIds, (v) => ids(v, 20) && new Set(v).size === v.length)
    && optional(v.coordinationId, id) && optional(v.departureOffsetMin, offset)
    && optional(v.departureOffsets, (p) => periodDirections(p, offset))
    && optional(v.serviceWindows, (p) => periodDirections(p, (w) => Array.isArray(w) && w.length === 2 && bounded(w[0], 0, 1440) && bounded(w[1], 0, 1440) && w[1] > w[0]))
    && optional(v.gtfsImport, (g) => record(g) && fields(g, ["feed", "route", "variant", "weekday", "weekend"]) && [g.feed, g.route, g.variant, g.weekday, g.weekend].every((s) => text(s)))
    && list(v.segments, segment, PROPOSAL_LIMITS.segmentsPerLine) && unique(v.segments) && bounded(v.layoverMin, 0, 1440)
    && record(v.takt) && fields(v.takt, PERIODS.map((p) => p.id))
    && PERIODS.every(({ id }) => { const t = (v.takt as Record<string, unknown>)[id]; return t === null || (t === undefined && id.endsWith("night")) || validHeadway(t); });
}

/** Strict, bounded schema shared by HTTP writes, file imports and shared snapshots. */
export function parseProposal(value: unknown): Proposal {
  if (!record(value) || !fields(value, ["lines", "localStops", "movedStops", "localTracks", "constructionOverrides"])
    || !list(value.lines, line, PROPOSAL_LIMITS.lines) || !unique(value.lines)
    || !list(value.localStops, stop, PROPOSAL_LIMITS.stops) || !unique(value.localStops)
    || !optional(value.movedStops, (v) => list(v, stop, PROPOSAL_LIMITS.stops) && unique(v))
    || !list(value.localTracks, track, PROPOSAL_LIMITS.tracks) || !unique(value.localTracks)
    || !record(value.constructionOverrides) || Object.keys(value.constructionOverrides).length > 50000
    || !Object.entries(value.constructionOverrides).every(([key, v]) => id(key) && typeof v === "boolean")
    || value.localStops.some((s) => s.source !== "local") || value.localTracks.some((t) => t.source !== "local")
    || (value.movedStops as Stop[] | undefined)?.some((s) => s.source !== "osm" && s.source !== "gtfs")) throw new Error("Nieprawidłowe dane sieci.");
  const lines = value.lines, moved = value.movedStops as Stop[] | undefined;
  if (!unique([...value.localStops, ...(moved ?? [])])) throw new Error("Powtórzone identyfikatory przystanków.");
  const lineIds = new Set(lines.map((l) => l.id));
  let vertices = 0, links = 0;
  for (const line of lines) {
    const platforms = new Set([...line.outboundStopIds, ...line.inboundStopIds, line.terminus1Id, line.terminus2Id]);
    if (line.segments.some((s) => !platforms.has(s.fromStopId) || !platforms.has(s.toStopId))
      || line.coordinatedLineIds?.some((other) => other === line.id || !lineIds.has(other))) throw new Error("Nieprawidłowe powiązania linii.");
    vertices += line.segments.reduce((sum, s) => sum + s.geometry.length + (s.waypoints?.length ?? 0), 0);
    links += line.coordinatedLineIds?.length ?? 0;
  }
  vertices += value.localTracks.reduce((sum, t) => sum + t.geometry.length, 0);
  if (vertices > PROPOSAL_LIMITS.vertices || links > PROPOSAL_LIMITS.coordinationLinks) throw new Error("Sieć przekracza limit złożoności.");
  return { lines: lines.map((l) => ({ ...l, takt: { ...l.takt, wd_night: l.takt.wd_night ?? null, we_night: l.takt.we_night ?? null } })), localStops: value.localStops,
    movedStops: moved, localTracks: value.localTracks, constructionOverrides: value.constructionOverrides as Record<string, boolean> };
}
