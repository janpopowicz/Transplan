import type { PeriodId } from "./constants";

export type Mode = "bus" | "tram";

export type EditorTool =
  | "select"
  | "draw-bus"
  | "draw-tram"
  | "add-stop"
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
  source: "osm" | "local";
  osmId?: number;
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
}

export interface DrawingState {
  lineId: string;
  mode: Mode;
  phase: DrawPhase;
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
