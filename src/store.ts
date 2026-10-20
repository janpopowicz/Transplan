import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  DEFAULT_LAYOVER_MIN,
  DEFAULT_TAKT,
  LINE_COLORS,
  SNAP_METERS,
} from "./constants";
import type { PeriodId } from "./constants";
import type {
  Coord,
  DrawingState,
  EditorTool,
  InsertSlot,
  LineDirection,
  Mode,
  OsmStatus,
  PendingStop,
  Stop,
  TrackDraft,
  TramTrack,
  TransitLine,
  VehicleId,
} from "./types";
import { fetchOsmRoads, fetchOsmStops, fetchTramTracks, findOppositeStops, readOsmCache, writeOsmCache } from "./lib/overpass";
import { routeBetween } from "./lib/routing";
import { roadGraph, tramGraph } from "./lib/tramGraph";
import { exportProposal, loadState, saveState } from "./lib/persist";
import { mergeStopPositions } from "./lib/stopEditing";
import { haversine, nearestPointOnLine, pathDistances } from "./lib/geo";
import { estimateTravelMinutes } from "./lib/travelTime";

interface AppState {
  tool: EditorTool;
  stops: Stop[];
  tracks: TramTrack[];
  constructionOverrides: Record<string, boolean>;
  lines: TransitLine[];
  selectedLineId: string | null;
  selectedStopId: string | null;
  drawing: DrawingState | null;
  routing: boolean;
  routingError: string | null;
  trackDraft: TrackDraft | null;
  pendingStop: PendingStop | null;
  hoverStopId: string | null;
  oppositeHintIds: string[];
  osm: OsmStatus;
  stopPicker: Stop[] | null;
  insertSlot: InsertSlot | null;

  loadOsm: (force?: boolean) => Promise<void>;
  setTool: (tool: EditorTool) => void;
  setHoverStop: (id: string | null) => void;
  selectLine: (id: string | null) => void;
  selectStop: (id: string | null) => void;
  setStopPicker: (stops: Stop[] | null) => void;

  startLine: (mode: Mode, number: string, name: string) => void;
  addStopToDrawing: (stopId: string) => Promise<void>;
  toggleWaypointMode: () => void;
  addDrawingWaypoint: (coord: Coord) => Promise<void>;
  markTerminus2: () => void;
  finishInbound: () => void;
  undoDrawingStop: () => void;
  cancelDrawing: () => void;
  resumeDrawing: (lineId: string, direction: LineDirection) => void;
  beginInsert: (lineId: string, direction: LineDirection, afterIndex: number) => void;
  cancelInsert: () => void;
  insertStopAtSlot: (stopId: string) => Promise<void>;

  updateLine: (id: string, patch: Partial<TransitLine>) => void;
  setTakt: (lineId: string, period: PeriodId, value: number | null) => void;
  setVehicle: (lineId: string, vehicle: VehicleId) => void;
  setSegmentTime: (lineId: string, segmentId: string, minutes: number) => void;
  resetSegmentTime: (lineId: string, segmentId: string) => void;
  toggleLineVisible: (id: string) => void;
  deleteLine: (id: string) => void;
  removeStopFromLine: (lineId: string, stopId: string, direction?: "outbound" | "inbound") => Promise<void>;
  removeLineFromStop: (stopId: string, lineId: string) => Promise<void>;

  openAddStop: (coord: Coord) => void;
  confirmAddStop: (name: string, modes: Mode[]) => void;
  cancelAddStop: () => void;
  deleteLocalStop: (id: string) => void;
  moveStop: (id: string, coord: Coord) => Promise<void>;

  startTrackDraft: (coord: Coord) => void;
  appendTrackVertex: (coord: Coord) => void;
  finishTrackDraft: () => void;
  cancelTrackDraft: () => void;
  toggleConstruction: (trackId: string) => void;
  deleteLocalTrack: (id: string) => void;

  exportJson: () => void;
  importJson: (file: File) => Promise<void>;
}

function persistSlice(s: AppState): void {
  saveState({
    lines: s.lines,
    localStops: s.stops.filter((x) => x.source === "local"),
    movedStops: s.stops.filter((x) => x.source === "osm" && x.originalPosition),
    localTracks: s.tracks.filter((x) => x.source === "local"),
    constructionOverrides: s.constructionOverrides,
  });
}

function wayKind(t: TramTrack): "tram" | "road" {
  return t.kind ?? "tram";
}

function withKind(t: TramTrack): TramTrack {
  return t.kind ? t : { ...t, kind: "tram" };
}

function applyOverrides(tracks: TramTrack[], overrides: Record<string, boolean>): TramTrack[] {
  return tracks.map((t) =>
    t.id in overrides ? { ...t, construction: overrides[t.id] } : t,
  );
}

function rebuildGraph(tracks: TramTrack[], overrides: Record<string, boolean>): void {
  const live = applyOverrides(tracks, overrides);
  tramGraph.load(live.filter((t) => wayKind(t) === "tram" && !t.construction));
  roadGraph.load(live.filter((t) => wayKind(t) === "road" && !t.construction));
}

let roadsFetch: Promise<void> | null = null;

function pullOsmRoads(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
): void {
  if (get().tracks.some((t) => wayKind(t) === "road" && t.source === "osm")) return;
  if (roadsFetch) return;
  roadsFetch = (async () => {
    const roads = await fetchOsmRoads();
    const cur = get();
    const rest = cur.tracks.filter((t) => wayKind(t) !== "road" || t.source === "local");
    const tracks = applyOverrides([...rest, ...roads], cur.constructionOverrides);
    rebuildGraph(tracks, cur.constructionOverrides);
    set({
      tracks,
      osm: { ...get().osm, roads: roads.length },
    });
  })()
    .catch((e) => {
      console.warn("osm roads", e);
    })
    .finally(() => {
      roadsFetch = null;
    });
}

function nextColor(lines: TransitLine[]): string {
  const used = new Set(lines.map((l) => l.color));
  return LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[lines.length % LINE_COLORS.length];
}

function defaultVehicle(mode: Mode): VehicleId {
  return mode === "bus" ? "12m" : "33m";
}

function currentStops(line: TransitLine, drawing: DrawingState | null): string[] {
  if (!drawing || drawing.lineId !== line.id) {
    return [...line.outboundStopIds, ...line.inboundStopIds];
  }
  if (drawing.phase === "inbound") return line.inboundStopIds;
  return line.outboundStopIds;
}

function stopById(stops: Stop[], id: string): Stop | undefined {
  return stops.find((s) => s.id === id);
}

async function rebuildSegments(
  line: TransitLine,
  stops: Stop[],
  direction: "outbound" | "inbound",
): Promise<LineSegs> {
  const ids = direction === "outbound" ? line.outboundStopIds : line.inboundStopIds;
  const old = line.segments.filter((s) => s.direction === direction);
  const next = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const fromId = ids[i];
    const toId = ids[i + 1];
    const existing = old.find((s) => s.fromStopId === fromId && s.toStopId === toId);
    if (existing) {
      next.push(existing);
      continue;
    }
    const a = stopById(stops, fromId);
    const b = stopById(stops, toId);
    if (!a || !b) continue;
    const waypoints = inheritedWaypoints(old, ids, i, a, b);
    const geometry = await routeBetween([a.lon, a.lat], [b.lon, b.lat], line.mode, waypoints);
    next.push({
      id: nanoid(8),
      fromStopId: fromId,
      toStopId: toId,
      geometry,
      waypoints,
      travelMin: estimateTravelMinutes(geometry, line.mode),
      travelTimeSource: "auto" as const,
      direction,
    });
  }
  return next;
}

type LineSegs = TransitLine["segments"];

/** Preserve shaping points when removing a stop or splitting an existing leg. */
function inheritedWaypoints(old: LineSegs, ids: string[], index: number, from: Stop, to: Stop): Coord[] {
  let cursor = from.id;
  const merged: Coord[] = [];
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const segment = old.find((s) => s.fromStopId === cursor);
    if (!segment) break;
    merged.push(...(segment.waypoints ?? []));
    cursor = segment.toStopId;
    if (cursor === to.id) return merged;
  }
  const parent = old.find((segment) => {
    const a = ids.indexOf(segment.fromStopId), b = ids.indexOf(segment.toStopId);
    return a >= 0 && a <= index && b > index;
  });
  if (!parent?.waypoints?.length || parent.geometry.length < 2) return [];
  const distances = pathDistances(parent.geometry);
  const along = (coord: Coord) => {
    const near = nearestPointOnLine(coord, parent.geometry);
    return distances[near.index] + haversine(parent.geometry[near.index], near.coord);
  };
  const lower = from.id === parent.fromStopId ? -Infinity : along([from.lon, from.lat]);
  const upper = to.id === parent.toStopId ? Infinity : along([to.lon, to.lat]);
  return parent.waypoints.filter((point) => { const position = along(point); return position > lower && position <= upper; });
}

const boot = loadState();

export const useStore = create<AppState>((set, get) => ({
  tool: "select",
  stops: mergeStopPositions([], boot?.localStops ?? [], boot?.movedStops ?? []),
  tracks: (boot?.localTracks ?? []).map(withKind),
  constructionOverrides: boot?.constructionOverrides ?? {},
  lines: boot?.lines ?? [],
  selectedLineId: null,
  selectedStopId: null,
  drawing: null,
  routing: false,
  routingError: null,
  trackDraft: null,
  pendingStop: null,
  hoverStopId: null,
  oppositeHintIds: [],
  osm: { loading: false, error: null, stops: 0, tracks: 0, roads: 0, loadedAt: null },
  stopPicker: null,
  insertSlot: null,

  loadOsm: async (force = false) => {
    const { osm, stops, constructionOverrides } = get();
    if (osm.loading) return;
    if (!force && osm.loadedAt && stops.some((s) => s.source === "osm")) {
      pullOsmRoads(get, set);
      return;
    }

    const saved = loadState();
    const localStops = saved?.localStops ?? get().stops.filter((s) => s.source === "local");
    const localTracks = saved?.localTracks ?? get().tracks.filter((t) => t.source === "local");
    const overrides = saved?.constructionOverrides ?? constructionOverrides;
    const cache = force ? null : readOsmCache();

    if (cache) {
      const mergedStops = mergeStopPositions(cache.stops, localStops, get().stops.filter((s) => s.originalPosition));
      const mergedTracks = applyOverrides(
        [...cache.tracks.map(withKind), ...localTracks.map(withKind)],
        overrides,
      );
      rebuildGraph(mergedTracks, overrides);
      set({
        stops: mergedStops,
        tracks: mergedTracks,
        constructionOverrides: overrides,
        lines: get().lines.length ? get().lines : saved?.lines ?? [],
        osm: {
          loading: false,
          error: null,
          stops: cache.stops.length,
          tracks: cache.tracks.length,
          roads: 0,
          loadedAt: cache.at,
        },
      });
      pullOsmRoads(get, set);
      return;
    }

    set({ osm: { ...osm, loading: true, error: null } });
    try {
      const [osmStops, osmTracks] = await Promise.all([fetchOsmStops(), fetchTramTracks()]);
      writeOsmCache(osmStops, osmTracks);
      const mergedStops = mergeStopPositions(osmStops, get().stops.filter((s) => s.source === "local"), get().stops.filter((s) => s.originalPosition));
      const mergedTracks = applyOverrides(
        [...osmTracks.map(withKind), ...localTracks.map(withKind)],
        overrides,
      );
      rebuildGraph(mergedTracks, overrides);
      const lines = get().lines.length ? get().lines : saved?.lines ?? [];
      set({
        stops: mergedStops,
        tracks: mergedTracks,
        constructionOverrides: overrides,
        lines,
        osm: {
          loading: false,
          error: null,
          stops: osmStops.length,
          tracks: osmTracks.length,
          roads: 0,
          loadedAt: Date.now(),
        },
      });
      persistSlice(get());
      pullOsmRoads(get, set);
    } catch (e) {
      set({
        osm: {
          ...get().osm,
          loading: false,
          error: e instanceof Error ? e.message : "Błąd OSM",
        },
      });
    }
  },

  setTool: (tool) => {
    const drawing = get().drawing;
    if (drawing && tool !== "draw-bus" && tool !== "draw-tram") {
      get().cancelDrawing();
    }
    set({
      tool,
      ...(tool === "isochrones" ? { selectedLineId: null, selectedStopId: null } : {}),
      pendingStop: null,
      trackDraft: tool === "draw-track" ? get().trackDraft : null,
      stopPicker: null,
      insertSlot: tool === "draw-bus" || tool === "draw-tram" ? get().insertSlot : null,
    });
    if (tool === "toggle-construction") pullOsmRoads(get, set);
  },

  setHoverStop: (id) => set({ hoverStopId: id }),
  selectLine: (id) => {
    const next = id === get().selectedLineId ? null : id;
    set({ selectedLineId: next, drawing: null, insertSlot: null, oppositeHintIds: [],
      tool: get().tool === "draw-bus" || get().tool === "draw-tram" ? "select" : get().tool });
  },
  selectStop: (id) => set({ selectedStopId: id, stopPicker: null }),
  setStopPicker: (stops) => set({ stopPicker: stops }),

  startLine: (mode, number, name) => {
    const { lines } = get();
    const line: TransitLine = {
      id: nanoid(10),
      number: number.trim() || (mode === "tram" ? "T" : "A"),
      name: name.trim(),
      mode,
      color: nextColor(lines),
      vehicle: defaultVehicle(mode),
      visible: true,
      outboundStopIds: [],
      inboundStopIds: [],
      terminus1Id: null,
      terminus2Id: null,
      segments: [],
      takt: { ...DEFAULT_TAKT },
      layoverMin: DEFAULT_LAYOVER_MIN,
    };
    set({
      lines: [...lines, line],
      selectedLineId: line.id,
      drawing: { lineId: line.id, mode, phase: "terminus1" },
      tool: mode === "bus" ? "draw-bus" : "draw-tram",
      routingError: null,
      oppositeHintIds: [],
    });
    persistSlice(get());
  },

  addStopToDrawing: async (stopId) => {
    const { drawing, lines, stops, routing } = get();
    if (!drawing || routing) return;
    const line = lines.find((l) => l.id === drawing.lineId);
    const stop = stopById(stops, stopId);
    if (!line || !stop) return;
    if (!stop.modes.includes(line.mode) && stop.modes.length) {
      set({ routingError: `Ten przystanek nie obsługuje ${line.mode === "bus" ? "autobusów" : "tramwajów"}.` });
      return;
    }

    const ids = currentStops(line, drawing);
    if (ids[ids.length - 1] === stopId) return;

    if (drawing.phase === "terminus1") {
      set({
        lines: lines.map((l) =>
          l.id === line.id
            ? { ...l, outboundStopIds: [stopId], terminus1Id: stopId }
            : l,
        ),
        drawing: { ...drawing, phase: "outbound" },
        routingError: null,
        selectedStopId: stopId,
        oppositeHintIds: findOppositeStops(stop, stops).map((s) => s.id),
      });
      persistSlice(get());
      return;
    }

    const prevId =
      drawing.phase === "inbound" && ids.length === 0
        ? line.terminus2Id
        : ids[ids.length - 1];
    if (!prevId) return;
    const prev = stopById(stops, prevId);
    if (!prev) return;

    set({ routing: true, routingError: null });
    try {
      const geometry = await routeBetween(
        [prev.lon, prev.lat],
        [stop.lon, stop.lat],
        line.mode,
        drawing.waypoints,
      );
      if (get().drawing !== drawing) { set({ routing: false }); return; }
      const seg = {
        id: nanoid(8),
        fromStopId: prevId,
        toStopId: stopId,
        geometry,
        waypoints: drawing.waypoints ?? [],
        travelMin: estimateTravelMinutes(geometry, line.mode),
        travelTimeSource: "auto" as const,
        direction: (drawing.phase === "inbound" ? "inbound" : "outbound") as
          | "outbound"
          | "inbound",
      };

      const nextLines = get().lines.map((l) => {
        if (l.id !== line.id) return l;
        if (drawing.phase === "inbound") {
          return {
            ...l,
            inboundStopIds: [...l.inboundStopIds, stopId],
            segments: [...l.segments, seg],
          };
        }
        return {
          ...l,
          outboundStopIds: [...l.outboundStopIds, stopId],
          terminus2Id: l.terminus2Id === prevId ? stopId : l.terminus2Id,
          segments: [...l.segments, seg],
        };
      });

      const headingFrom: Coord = [prev.lon, prev.lat];
      const hints = findOppositeStops(stop, get().stops, headingFrom).map((s) => s.id);

      set({
        lines: nextLines,
        routing: false,
        oppositeHintIds: hints,
        selectedStopId: stopId,
        drawing: { ...drawing, placingWaypoint: false, waypoints: [], waypointLegs: [] },
      });
      persistSlice(get());
    } catch (e) {
      set({
        routing: false,
        routingError: e instanceof Error ? e.message : "Błąd routingu",
      });
    }
  },

  toggleWaypointMode: () => {
    const { drawing, routing } = get();
    if (!drawing || drawing.phase === "terminus1" || routing) return;
    set({ drawing: { ...drawing, placingWaypoint: !drawing.placingWaypoint }, stopPicker: null });
  },

  addDrawingWaypoint: async (coord) => {
    const { drawing, routing, lines, stops } = get();
    if (!drawing || drawing.phase === "terminus1" || routing || !coord.every(Number.isFinite)) return;
    const line = lines.find((l) => l.id === drawing.lineId);
    if (!line) return;
    const ids = currentStops(line, drawing);
    const lastId = ids.at(-1) ?? line.terminus2Id;
    const stop = lastId ? stopById(stops, lastId) : undefined;
    if (!stop) return;
    const waypoints = drawing.waypoints ?? [];
    const from: Coord = waypoints.at(-1) ?? [stop.lon, stop.lat];
    if (haversine(from, coord) < 1) return;
    set({ routing: true, routingError: null });
    try {
      const geometry = await routeBetween(from, coord, line.mode);
      if (get().drawing !== drawing) { set({ routing: false }); return; }
      set({ routing: false, drawing: { ...drawing, placingWaypoint: false,
        waypoints: [...waypoints, coord], waypointLegs: [...(drawing.waypointLegs ?? []), geometry] } });
    } catch (e) {
      set({ routing: false, routingError: e instanceof Error ? e.message : "Nie udało się dodać punktu trasy." });
    }
  },

  markTerminus2: () => {
    const { drawing, lines, stops } = get();
    if (!drawing || drawing.phase !== "outbound" || get().routing || drawing.waypoints?.length) return;
    const line = lines.find((l) => l.id === drawing.lineId);
    if (!line || line.outboundStopIds.length < 2) return;
    const t2 = line.outboundStopIds[line.outboundStopIds.length - 1];
    const stop = stopById(stops, t2);
    const hints = stop ? findOppositeStops(stop, stops).map((s) => s.id) : [];
    set({
      lines: lines.map((l) =>
        l.id === line.id ? { ...l, terminus2Id: t2, inboundStopIds: [] } : l,
      ),
      drawing: { ...drawing, phase: "inbound", placingWaypoint: false, waypoints: [], waypointLegs: [] },
      oppositeHintIds: hints,
      routingError: null,
    });
    persistSlice(get());
  },

  finishInbound: () => {
    const { drawing, lines } = get();
    if (!drawing || get().routing || drawing.waypoints?.length) return;
    const line = lines.find((l) => l.id === drawing.lineId);
    if (!line) return;
    if (drawing.phase === "inbound" && line.inboundStopIds.length < 1) return;
    set({
      drawing: null,
      tool: "select",
      oppositeHintIds: [],
      selectedLineId: line.id,
    });
    persistSlice(get());
  },

  undoDrawingStop: () => {
    const { drawing, lines } = get();
    if (!drawing || get().routing) return;
    if (drawing.waypoints?.length) {
      set({ drawing: { ...drawing, waypoints: drawing.waypoints.slice(0, -1),
        waypointLegs: drawing.waypointLegs?.slice(0, -1), placingWaypoint: false }, routingError: null });
      return;
    }
    const line = lines.find((l) => l.id === drawing.lineId);
    if (!line) return;

    if (drawing.phase === "inbound") {
      if (line.inboundStopIds.length === 0) {
        set({ drawing: { ...drawing, phase: "outbound" }, oppositeHintIds: [] });
        return;
      }
      const inboundStopIds = line.inboundStopIds.slice(0, -1);
      const drop = line.inboundStopIds[line.inboundStopIds.length - 1];
      set({
        lines: lines.map((l) =>
          l.id === line.id
            ? {
                ...l,
                inboundStopIds,
                segments: l.segments.filter(
                  (s) => !(s.direction === "inbound" && s.toStopId === drop),
                ),
              }
            : l,
        ),
      });
      persistSlice(get());
      return;
    }

    if (line.outboundStopIds.length <= 1) {
      set({
        lines: lines.filter((l) => l.id !== line.id),
        drawing: null,
        tool: "select",
        selectedLineId: null,
        oppositeHintIds: [],
      });
      persistSlice(get());
      return;
    }
    const outboundStopIds = line.outboundStopIds.slice(0, -1);
    const drop = line.outboundStopIds[line.outboundStopIds.length - 1];
    set({
      lines: lines.map((l) =>
        l.id === line.id
          ? {
              ...l,
              outboundStopIds,
              terminus2Id: l.terminus2Id === drop ? null : l.terminus2Id,
              segments: l.segments.filter(
                (s) => !(s.direction === "outbound" && s.toStopId === drop),
              ),
            }
          : l,
      ),
    });
    persistSlice(get());
  },

  cancelDrawing: () => {
    const { drawing } = get();
    set({
      drawing: null,
      tool: "select",
      oppositeHintIds: [],
      insertSlot: null,
      selectedLineId: drawing?.lineId ?? get().selectedLineId,
    });
    persistSlice(get());
  },

  resumeDrawing: (lineId, direction) => {
    const line = get().lines.find((l) => l.id === lineId);
    if (!line) return;
    let phase: DrawingState["phase"] =
      direction === "inbound" ? "inbound" : line.outboundStopIds.length === 0 ? "terminus1" : "outbound";
    if (direction === "inbound" && !line.terminus2Id && line.outboundStopIds.length >= 2) {
      const t2 = line.outboundStopIds[line.outboundStopIds.length - 1];
      set({
        lines: get().lines.map((l) => (l.id === lineId ? { ...l, terminus2Id: t2 } : l)),
      });
    }
    if (direction === "inbound" && get().lines.find((l) => l.id === lineId)!.outboundStopIds.length < 1) {
      phase = "terminus1";
    }
    set({
      selectedLineId: lineId,
      drawing: { lineId, mode: line.mode, phase },
      insertSlot: null,
      tool: line.mode === "bus" ? "draw-bus" : "draw-tram",
      routingError: null,
      oppositeHintIds: [],
    });
  },

  beginInsert: (lineId, direction, afterIndex) => {
    const line = get().lines.find((l) => l.id === lineId);
    if (!line) return;
    set({
      selectedLineId: lineId,
      drawing: null,
      insertSlot: { lineId, direction, afterIndex },
      tool: line.mode === "bus" ? "draw-bus" : "draw-tram",
      routingError: null,
      oppositeHintIds: [],
    });
  },

  cancelInsert: () => {
    set({
      insertSlot: null,
      tool: "select",
      routingError: null,
    });
  },

  insertStopAtSlot: async (stopId) => {
    const slot = get().insertSlot;
    if (!slot || get().routing) return;
    const line = get().lines.find((l) => l.id === slot.lineId);
    const stop = stopById(get().stops, stopId);
    if (!line || !stop) return;
    if (!stop.modes.includes(line.mode) && stop.modes.length) {
      set({ routingError: `Ten przystanek nie obsługuje ${line.mode === "bus" ? "autobusów" : "tramwajów"}.` });
      return;
    }
    const ids = slot.direction === "outbound" ? line.outboundStopIds : line.inboundStopIds;
    if (ids.includes(stopId)) {
      set({ routingError: "Ten przystanek już jest na tym kierunku." });
      return;
    }
    const nextIds = [...ids.slice(0, slot.afterIndex + 1), stopId, ...ids.slice(slot.afterIndex + 1)];
    const patched: TransitLine = {
      ...line,
      outboundStopIds: slot.direction === "outbound" ? nextIds : line.outboundStopIds,
      inboundStopIds: slot.direction === "inbound" ? nextIds : line.inboundStopIds,
    };
    set({ routing: true, routingError: null });
    try {
      const outSegs = await rebuildSegments(patched, get().stops, "outbound");
      const inSegs = await rebuildSegments(patched, get().stops, "inbound");
      set({
        routing: false,
        insertSlot: null,
        tool: "select",
        selectedStopId: stopId,
        lines: get().lines.map((l) =>
          l.id === line.id ? { ...patched, segments: [...outSegs, ...inSegs] } : l,
        ),
      });
      persistSlice(get());
    } catch (e) {
      set({
        routing: false,
        routingError: e instanceof Error ? e.message : "Błąd wstawiania przystanku",
      });
    }
  },

  updateLine: (id, patch) => {
    set({
      lines: get().lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    });
    persistSlice(get());
  },

  setTakt: (lineId, period, value) => {
    set({
      lines: get().lines.map((l) =>
        l.id === lineId ? { ...l, takt: { ...l.takt, [period]: value } } : l,
      ),
    });
    persistSlice(get());
  },

  setVehicle: (lineId, vehicle) => {
    set({
      lines: get().lines.map((l) => (l.id === lineId ? { ...l, vehicle } : l)),
    });
    persistSlice(get());
  },

  setSegmentTime: (lineId, segmentId, minutes) => {
    if (!Number.isFinite(minutes)) return;
    const v = Math.max(0.5, minutes);
    set({
      lines: get().lines.map((l) =>
        l.id === lineId
          ? {
              ...l,
              segments: l.segments.map((s) =>
                s.id === segmentId ? { ...s, travelMin: v, travelTimeSource: "manual" } : s,
              ),
            }
          : l,
      ),
    });
    persistSlice(get());
  },

  resetSegmentTime: (lineId, segmentId) => {
    set({ lines: get().lines.map((line) => line.id !== lineId ? line : { ...line,
      segments: line.segments.map((segment) => segment.id !== segmentId ? segment : { ...segment,
        travelMin: estimateTravelMinutes(segment.geometry, line.mode), travelTimeSource: "auto" }) }) });
    persistSlice(get());
  },

  toggleLineVisible: (id) => {
    set({
      lines: get().lines.map((l) =>
        l.id === id ? { ...l, visible: !l.visible } : l,
      ),
    });
    persistSlice(get());
  },

  deleteLine: (id) => {
    set({
      lines: get().lines.filter((l) => l.id !== id),
      selectedLineId: get().selectedLineId === id ? null : get().selectedLineId,
      drawing: get().drawing?.lineId === id ? null : get().drawing,
    });
    persistSlice(get());
  },

  removeStopFromLine: async (lineId, stopId, direction) => {
    const line = get().lines.find((l) => l.id === lineId);
    if (!line) return;
    const strip = (ids: string[]) => ids.filter((id) => id !== stopId);
    let outboundStopIds = direction === "inbound" ? line.outboundStopIds : strip(line.outboundStopIds);
    let inboundStopIds = direction === "outbound" ? line.inboundStopIds : strip(line.inboundStopIds);
    if (!direction) {
      outboundStopIds = strip(line.outboundStopIds);
      inboundStopIds = strip(line.inboundStopIds);
    }
    if (outboundStopIds.length < 1) {
      get().deleteLine(lineId);
      return;
    }
    const patched: TransitLine = {
      ...line,
      outboundStopIds,
      inboundStopIds,
      terminus1Id:
        line.terminus1Id === stopId ? outboundStopIds[0] ?? null : line.terminus1Id,
      terminus2Id:
        line.terminus2Id === stopId
          ? outboundStopIds[outboundStopIds.length - 1] ?? null
          : line.terminus2Id,
    };
    set({ routing: true, routingError: null });
    try {
      const outSegs = await rebuildSegments(patched, get().stops, "outbound");
      const inSegs = await rebuildSegments(patched, get().stops, "inbound");
      set({
        routing: false,
        lines: get().lines.map((l) =>
          l.id === lineId ? { ...patched, segments: [...outSegs, ...inSegs] } : l,
        ),
      });
      persistSlice(get());
    } catch (e) {
      set({
        routing: false,
        routingError: e instanceof Error ? e.message : "Błąd przeliczania trasy",
      });
    }
  },

  removeLineFromStop: async (stopId, lineId) => {
    await get().removeStopFromLine(lineId, stopId);
  },

  openAddStop: (coord) => set({ pendingStop: { lon: coord[0], lat: coord[1] }, tool: "add-stop" }),
  confirmAddStop: (name, modes) => {
    const p = get().pendingStop;
    if (!p) return;
    const stop: Stop = {
      id: `local-${nanoid(8)}`,
      name: name.trim() || "Nowy przystanek",
      lat: p.lat,
      lon: p.lon,
      modes: modes.length ? modes : ["bus"],
      source: "local",
    };
    set({
      stops: [...get().stops, stop],
      pendingStop: null,
      selectedStopId: stop.id,
      tool: "select",
    });
    persistSlice(get());
  },
  cancelAddStop: () => set({ pendingStop: null }),

  moveStop: async (id, coord) => {
    const snapshot = get();
    const stop = snapshot.stops.find((s) => s.id === id);
    if (!stop || snapshot.routing || !coord.every(Number.isFinite) ||
      Math.abs(coord[0]) > 180 || Math.abs(coord[1]) > 85 || haversine([stop.lon, stop.lat], coord) < 0.1) return;
    const moved: Stop = { ...stop, lon: coord[0], lat: coord[1],
      ...(stop.source === "osm" ? { originalPosition: stop.originalPosition ?? [stop.lon, stop.lat] as Coord } : {}) };
    const stops = new Map(snapshot.stops.map((s) => [s.id, s.id === id ? moved : s]));
    set({ routing: true, routingError: null });
    try {
      const replacements = new Map<string, { before: TransitLine["segments"][number]; geometry: Coord[] }>();
      const segmentKey = (lineId: string, segmentId: string) => JSON.stringify([lineId, segmentId]);
      for (const line of snapshot.lines) for (const segment of line.segments) {
        if (segment.fromStopId !== id && segment.toStopId !== id) continue;
        const from = stops.get(segment.fromStopId), to = stops.get(segment.toStopId);
        if (!from || !to) throw new Error("Brakuje przystanku potrzebnego do przeliczenia trasy.");
        replacements.set(segmentKey(line.id, segment.id), { before: segment,
          geometry: await routeBetween([from.lon, from.lat], [to.lon, to.lat], line.mode, segment.waypoints) });
      }
      // Commit position and routes together. Preserve changes to other lines
      // made while routing, and never resurrect a deleted stop or segment.
      if (!get().stops.some((s) => s.id === id)) { set({ routing: false }); return; }
      for (const line of get().lines) for (const segment of line.segments) {
        if (segment.fromStopId !== id && segment.toStopId !== id) continue;
        const replacement = replacements.get(segmentKey(line.id, segment.id));
        if (!replacement || replacement.before.geometry !== segment.geometry ||
          replacement.before.fromStopId !== segment.fromStopId || replacement.before.toStopId !== segment.toStopId) {
          throw new Error("Trasa została zmieniona podczas przesuwania. Spróbuj ponownie.");
        }
      }
      set({
        stops: get().stops.map((s) => s.id === id ? { ...s, lon: moved.lon, lat: moved.lat,
          originalPosition: moved.originalPosition } : s),
        lines: get().lines.map((line) => ({ ...line, segments: line.segments.map((segment) => {
          const replacement = replacements.get(segmentKey(line.id, segment.id));
          return replacement ? { ...segment, geometry: replacement.geometry,
            travelMin: segment.travelTimeSource === "auto" ? estimateTravelMinutes(replacement.geometry, line.mode) : segment.travelMin } : segment;
        }) })),
        routing: false,
      });
      persistSlice(get());
    } catch (e) {
      set({ routing: false, routingError: `Nie przesunięto przystanku: ${e instanceof Error ? e.message : "błąd trasy"}` });
    }
  },

  deleteLocalStop: (id) => {
    const used = get().lines.some(
      (l) => l.outboundStopIds.includes(id) || l.inboundStopIds.includes(id),
    );
    if (used) {
      set({ routingError: "Przystanek jest używany przez linię — najpierw zdejmij z niej kursy." });
      return;
    }
    set({
      stops: get().stops.filter((s) => s.id !== id),
      selectedStopId: get().selectedStopId === id ? null : get().selectedStopId,
    });
    persistSlice(get());
  },

  startTrackDraft: (coord) => {
    const snapped = snapToTracks(coord, get().tracks);
    set({ trackDraft: { vertices: [snapped] }, tool: "draw-track" });
  },
  appendTrackVertex: (coord) => {
    const draft = get().trackDraft;
    if (!draft) {
      get().startTrackDraft(coord);
      return;
    }
    const snapped = snapToTracks(coord, get().tracks);
    const last = draft.vertices[draft.vertices.length - 1];
    if (haversine(last, snapped) < 2) return;
    set({ trackDraft: { vertices: [...draft.vertices, snapped] } });
  },
  finishTrackDraft: () => {
    const draft = get().trackDraft;
    if (!draft || draft.vertices.length < 2) {
      set({ trackDraft: null });
      return;
    }
    const track: TramTrack = {
      id: `local-way-${nanoid(8)}`,
      geometry: draft.vertices,
      construction: false,
      source: "local",
      kind: "tram",
    };
    const tracks = [...get().tracks, track];
    rebuildGraph(tracks, get().constructionOverrides);
    set({ tracks, trackDraft: null, tool: "select" });
    persistSlice(get());
  },
  cancelTrackDraft: () => set({ trackDraft: null }),

  toggleConstruction: (trackId) => {
    const tracks = get().tracks.map((t) =>
      t.id === trackId ? { ...t, construction: !t.construction } : t,
    );
    const t = tracks.find((x) => x.id === trackId);
    const overrides = {
      ...get().constructionOverrides,
      [trackId]: t?.construction ?? false,
    };
    rebuildGraph(tracks, overrides);
    set({ tracks, constructionOverrides: overrides });
    persistSlice(get());
  },

  deleteLocalTrack: (id) => {
    const tracks = get().tracks.filter((t) => t.id !== id);
    const overrides = { ...get().constructionOverrides };
    delete overrides[id];
    rebuildGraph(tracks, overrides);
    set({ tracks, constructionOverrides: overrides });
    persistSlice(get());
  },

  exportJson: () => {
    const s = get();
    exportProposal({
      lines: s.lines,
      localStops: s.stops.filter((x) => x.source === "local"),
      movedStops: s.stops.filter((x) => x.source === "osm" && x.originalPosition),
      localTracks: s.tracks.filter((t) => t.source === "local"),
      constructionOverrides: s.constructionOverrides,
    });
  },

  importJson: async (file) => {
    const text = await file.text();
    const data = JSON.parse(text) as ReturnType<typeof loadState>;
    if (!data) return;
    const osmStops = get().stops.filter((s) => s.source === "osm");
    const osmTracks = get().tracks.filter((t) => t.source === "osm");
    const tracks = [...osmTracks, ...(data.localTracks ?? [])];
    rebuildGraph(tracks, data.constructionOverrides ?? {});
    set({
      lines: data.lines ?? [],
      stops: mergeStopPositions(osmStops, data.localStops ?? [], data.movedStops ?? []),
      tracks,
      constructionOverrides: data.constructionOverrides ?? {},
    });
    persistSlice(get());
  },
}));

function snapToTracks(coord: Coord, tracks: TramTrack[]): Coord {
  let best: Coord = coord;
  let bestD = SNAP_METERS;
  for (const t of tracks) {
    if (wayKind(t) !== "tram") continue;
    for (const v of t.geometry) {
      const d = haversine(coord, v);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
  }
  return best;
}

export function linesAtStop(lines: TransitLine[], stopId: string): TransitLine[] {
  return lines.filter(
    (l) => l.outboundStopIds.includes(stopId) || l.inboundStopIds.includes(stopId),
  );
}
