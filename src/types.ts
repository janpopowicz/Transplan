import type { PeriodId } from "./constants";

export type Mode = "bus" | "tram";

export type EditorTool =
  | "select"
  | "isochrones"
  | "journey"
  | "draw-bus"
  | "draw-tram"
  | "add-stop"
  | "move-stop"
  | "draw-track"
  | "toggle-construction";

export type DrawPhase = "terminus1" | "outbound" | "inbound";
export type LineDirection = "outbound" | "inbound";

export interface InsertSlot {
  lineId: string;
  direction: LineDirection;
  afterIndex: number;
}

export type VehicleId = "8m" | "10m" | "12m" | "18m" | "26m" | "33m" | "42m";

export type Coord = [number, number]; // lng, lat

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  modes: Mode[];
  source: "osm" | "gtfs" | "local";
  stationName?: string;
  platformNumber?: string;
  gtfsIds?: string[];
  /** Old catalogue IDs, retained only for migrating saved lines. */
  aliases?: string[];
  groupId?: string;
  osmId?: number;
  /** Original catalogue position, retained when a project moves this stop. */
  originalPosition?: Coord;
  /** Catalogue values retained for project-only name/type edits. */
  originalName?: string;
  originalModes?: Mode[];
}

export type WayKind = "tram" | "road";

export interface TramTrack {
  id: string;
  geometry: Coord[];
  construction: boolean;
  source: "osm" | "local";
  kind?: WayKind;
  osmId?: number;
}

export interface LineSegment {
  id: string;
  fromStopId: string;
  toStopId: string;
  geometry: Coord[];
  travelMin: number;
  /** Route shaping points, never passenger stops. */
  waypoints?: Coord[];
  /** Missing on older projects: retain their saved time as a manual value. */
  travelTimeSource?: "auto" | "gtfs" | "gtfs-import" | "manual";
  gtfsSamples?: number;
  direction: "outbound" | "inbound";
}

export interface TransitLine {
  id: string;
  number: string;
  name: string;
  mode: Mode;
  color: string;
  vehicle: VehicleId;
  visible: boolean;
  outboundStopIds: string[];
  inboundStopIds: string[];
  terminus1Id: string | null;
  terminus2Id: string | null;
  segments: LineSegment[];
  takt: Record<PeriodId, number | null>;
  layoverMin: number;
  /** Manual phase, or the common time translation of a coordinated network. */
  departureOffsetMin?: number;
  departureOffsets?: Partial<Record<PeriodId, Partial<Record<LineDirection, number>>>>;
  serviceWindows?: Partial<Record<PeriodId, Partial<Record<LineDirection, [number, number]>>>>;
  gtfsImport?: { feed: string; route: string; variant: string; weekday: string; weekend: string };
  /** Direct coordination partners; each pair has its own common section. */
  coordinatedLineIds?: string[];
  /** Legacy all-member group, migrated to pair links. */
  coordinationId?: string;
}

export interface DrawingState {
  lineId: string;
  mode: Mode;
  phase: DrawPhase;
  placingWaypoint?: boolean;
  waypoints?: Coord[];
  waypointLegs?: Coord[][];
}

export interface TrackDraft {
  vertices: Coord[];
}

export interface PendingStop {
  lon: number;
  lat: number;
}

export interface OsmStatus {
  loading: boolean;
  error: string | null;
  stops: number;
  tracks: number;
  roads: number;
  loadedAt: number | null;
}
