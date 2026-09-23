import { useEffect, useRef } from "react";
import maplibregl, { Map, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { KRAKOW_CENTER } from "../constants";
import { buildRenderSegments } from "../lib/interline";
import { distToLine } from "../lib/geo";
import { useStore } from "../store";
import type { Coord, Stop } from "../types";

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: "osm-simple",
  glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap",
      maxzoom: 19,
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const TRACKS = "tracks";
const DRAFT = "draft";
const LINES = "lines";
const STOPS = "stops";
const HINTS = "hints";
const PENDING = "pending";
const SELECTED = "selected-stop";

export function MapView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    if (!rootRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: rootRef.current,
      style: STYLE,
      center: KRAKOW_CENTER,
      zoom: 12.4,
      maxPitch: 0,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    mapRef.current = map;

    const onReady = () => {
      readyRef.current = true;
      ensureSources(map);
      syncLayers(map);
    };
    map.on("load", onReady);
    map.on("style.load", onReady);

    map.on("mousemove", onMove);
    map.on("click", onClick);
    map.on("dblclick", onDblClick);

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(rootRef.current);

    const unsub = useStore.subscribe((s, prev) => {
      if (!mapRef.current || !readyRef.current) return;
      const mapRelevant =
        s.lines !== prev.lines ||
        s.stops !== prev.stops ||
        s.tracks !== prev.tracks ||
        s.selectedStopId !== prev.selectedStopId ||
        s.oppositeHintIds !== prev.oppositeHintIds ||
        s.pendingStop !== prev.pendingStop ||
        s.trackDraft !== prev.trackDraft ||
        s.drawing !== prev.drawing ||
        s.insertSlot !== prev.insertSlot ||
        s.tool !== prev.tool;
      if (mapRelevant) syncLayers(mapRef.current);
    });

    return () => {
      unsub();
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  return <div ref={rootRef} className="map" />;
}

function ensureSources(map: Map): void {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const add = (id: string) => {
    if (!map.getSource(id)) {
      map.addSource(id, { type: "geojson", data: empty });
    }
  };
  add(TRACKS);
  add(DRAFT);
  add(LINES);
  add(STOPS);
  add(HINTS);
  add(PENDING);
  add(SELECTED);

  if (!map.getLayer("tracks-construction")) {
    map.addLayer({
      id: "tracks-construction",
      type: "line",
      source: TRACKS,
      filter: ["==", ["get", "construction"], true],
      paint: {
        "line-color": "#c2410c",
        "line-width": 3.2,
        "line-dasharray": [1.4, 1.2],
        "line-opacity": 0.9,
      },
    });
    map.addLayer({
      id: "tracks-live",
      type: "line",
      source: TRACKS,
      filter: ["all", ["==", ["get", "construction"], false], ["!=", ["get", "kind"], "road"]],
      paint: {
        "line-color": ["case", ["==", ["get", "local"], true], "#7c3aed", "#57534e"],
        "line-width": ["case", ["==", ["get", "local"], true], 3.6, 2.2],
        "line-opacity": 0.85,
      },
    });
    map.addLayer({
      id: "roads-live",
      type: "line",
      source: TRACKS,
      filter: ["all", ["==", ["get", "construction"], false], ["==", ["get", "kind"], "road"]],
      paint: {
        "line-color": "#2563ab",
        "line-width": 2.4,
        "line-opacity": 0.45,
      },
    });
    map.addLayer({
      id: "tracks-hit",
      type: "line",
      source: TRACKS,
      paint: { "line-color": "transparent", "line-width": 14 },
    });
    map.addLayer({
      id: "draft-line",
      type: "line",
      source: DRAFT,
      paint: {
        "line-color": "#7c3aed",
        "line-width": 3.5,
        "line-dasharray": [2, 1],
      },
    });
    map.addLayer({
      id: "draft-pts",
      type: "circle",
      source: DRAFT,
      filter: ["==", ["get", "kind"], "vertex"],
      paint: {
        "circle-radius": 4.5,
        "circle-color": "#7c3aed",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
    map.addLayer({
      id: "lines-casing",
      type: "line",
      source: LINES,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#1a1714",
        "line-width": ["+", ["get", "width"], 1.8],
        "line-offset": ["get", "offset"],
        "line-opacity": 0.35,
      },
    });
    map.addLayer({
      id: "lines-main",
      type: "line",
      source: LINES,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["get", "width"],
        "line-offset": ["get", "offset"],
        "line-opacity": 0.95,
      },
    });
    map.addLayer({
      id: "lines-label",
      type: "symbol",
      source: LINES,
      layout: {
        "symbol-placement": "line-center",
        "text-field": ["get", "number"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#1a1714",
        "text-halo-color": "#f6f1e8",
        "text-halo-width": 1.6,
      },
    });
    map.addLayer({
      id: "hints-ring",
      type: "circle",
      source: HINTS,
      paint: {
        "circle-radius": 11,
        "circle-color": "transparent",
        "circle-stroke-color": "#d97706",
        "circle-stroke-width": 2.5,
        "circle-opacity": 1,
      },
    });
    map.addLayer({
      id: "stops-circle",
      type: "circle",
      source: STOPS,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          2.2,
          13,
          4.2,
          16,
          7,
        ],
        "circle-color": [
          "case",
          ["==", ["get", "local"], 1],
          "#7c3aed",
          ["==", ["get", "tram"], 1],
          "#d1242f",
          "#1f4e79",
        ],
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#fff",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 13, 0.95],
      },
    });
    map.addLayer({
      id: "stops-hit",
      type: "circle",
      source: STOPS,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          12,
          12,
          15,
          20,
        ],
        "circle-color": "#000000",
        "circle-opacity": 0.01,
      },
    });
    map.addLayer({
      id: "selected-pt",
      type: "circle",
      source: SELECTED,
      paint: {
        "circle-radius": 9,
        "circle-color": "#facc15",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#1a1714",
      },
    });
    map.addLayer({
      id: "pending-pt",
      type: "circle",
      source: PENDING,
      paint: {
        "circle-radius": 8,
        "circle-color": "#7c3aed",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#fff",
      },
    });
  }
  if (!map.getLayer("selected-pt") && map.getSource(SELECTED)) {
    map.addLayer({
      id: "selected-pt",
      type: "circle",
      source: SELECTED,
      paint: {
        "circle-radius": 9,
        "circle-color": "#facc15",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#1a1714",
      },
    });
  }
}

function syncLayers(map: Map): void {
  try {
    syncLayersInner(map);
  } catch (err) {
    console.warn("map sync", err);
  }
}

function syncLayersInner(map: Map): void {
  if (!map.isStyleLoaded?.() && !map.getSource(TRACKS)) {
    ensureSources(map);
  } else if (!map.getSource(TRACKS)) {
    ensureSources(map);
  }
  if (!map.getSource(TRACKS)) return;
  const s = useStore.getState();
  const selected = s.selectedStopId;
  const drawing = s.drawing;
  const modeFilter: "bus" | "tram" | null =
    drawing?.mode ??
    (s.insertSlot
      ? (s.lines.find((l) => l.id === s.insertSlot?.lineId)?.mode ?? null)
      : null) ??
    (s.tool === "draw-bus" ? "bus" : s.tool === "draw-tram" ? "tram" : null);

  const showRoads = s.tool === "toggle-construction";
  const trackFc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: s.tracks
      .filter((t) => showRoads || (t.kind ?? "tram") !== "road" || t.construction)
      .map((t) => ({
      type: "Feature",
      properties: {
        id: t.id,
        construction: t.construction,
        local: t.source === "local",
        kind: t.kind ?? "tram",
      },
      geometry: { type: "LineString", coordinates: t.geometry },
    })),
  };
  setData(map, TRACKS, trackFc);

  const draftFeatures: GeoJSON.Feature[] = [];
  if (s.trackDraft) {
    if (s.trackDraft.vertices.length >= 2) {
      draftFeatures.push({
        type: "Feature",
        properties: { kind: "line" },
        geometry: { type: "LineString", coordinates: s.trackDraft.vertices },
      });
    }
    for (const v of s.trackDraft.vertices) {
      draftFeatures.push({
        type: "Feature",
        properties: { kind: "vertex" },
        geometry: { type: "Point", coordinates: v },
      });
    }
  }
  setData(map, DRAFT, { type: "FeatureCollection", features: draftFeatures });

  const render = buildRenderSegments(s.lines);
  setData(map, LINES, {
    type: "FeatureCollection",
    features: render.map((r) => ({
      type: "Feature",
      properties: {
        id: r.id,
        lineId: r.lineId,
        color: r.color,
        width: r.width,
        offset: r.offset,
        number: r.number,
      },
      geometry: { type: "LineString", coordinates: r.geometry },
    })),
  });

  const visibleStops = s.stops.filter((st) => {
    if (!modeFilter) return true;
    return st.modes.includes(modeFilter);
  });

  setData(map, STOPS, {
    type: "FeatureCollection",
    features: visibleStops.map((st) => ({
      type: "Feature",
      properties: {
        id: st.id,
        name: st.name,
        local: st.source === "local" ? 1 : 0,
        tram: st.modes.includes("tram") && !st.modes.includes("bus") ? 1 : 0,
        bus: st.modes.includes("bus"),
      },
      geometry: { type: "Point", coordinates: [st.lon, st.lat] },
    })),
  });

  setData(map, HINTS, {
    type: "FeatureCollection",
    features: s.stops
      .filter((st) => s.oppositeHintIds.includes(st.id))
      .map((st) => ({
        type: "Feature",
        properties: { id: st.id },
        geometry: { type: "Point", coordinates: [st.lon, st.lat] },
      })),
  });

  const chosen = selected ? s.stops.find((st) => st.id === selected) : undefined;
  setData(map, SELECTED, {
    type: "FeatureCollection",
    features: chosen
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [chosen.lon, chosen.lat] },
          },
        ]
      : [],
  });

  setData(map, PENDING, {
    type: "FeatureCollection",
    features: s.pendingStop
      ? [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Point",
              coordinates: [s.pendingStop.lon, s.pendingStop.lat],
            },
          },
        ]
      : [],
  });

  const canvas = map.getCanvas();
  canvas.style.cursor =
    s.tool === "select" ? "" : s.tool === "toggle-construction" ? "pointer" : "crosshair";
  if (s.tool === "draw-track") map.doubleClickZoom.disable();
  else map.doubleClickZoom.enable();
}

function setData(map: Map, id: string, data: GeoJSON.GeoJSON): void {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  src?.setData(data);
}

function onMove(e: maplibregl.MapMouseEvent): void {
  const map = e.target;
  if (!map.getLayer("stops-hit")) return;
  let id: string | null = null;
  try {
    const hits = map.queryRenderedFeatures(e.point, { layers: ["stops-hit"] });
    id = (hits[0]?.properties?.id as string) ?? null;
  } catch {
    return;
  }

  const popup = popupRefEnsure(map);
  if (id) {
    const stop = useStore.getState().stops.find((s) => s.id === id);
    if (stop) {
      popup.setLngLat([stop.lon, stop.lat]).setHTML(stopTooltip(stop)).addTo(map);
    }
  } else {
    popup.remove();
  }
}

function popupRefEnsure(map: Map): Popup {
  void map;
  if (!popupRefSingleton.current) {
    popupRefSingleton.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: "stop-tip",
    });
  }
  return popupRefSingleton.current;
}

const popupRefSingleton: { current: Popup | null } = { current: null };

function stopTooltip(stop: Stop): string {
  const modes = stop.modes.map((m) => (m === "bus" ? "autobus" : "tramwaj")).join(" · ");
  const extra = stop.source === "local" ? " · propozycja" : "";
  return `<strong>${escapeHtml(stop.name)}</strong><span>${modes}${extra}</span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function onClick(e: maplibregl.MapMouseEvent): void {
  const map = e.target;
  const st = useStore.getState();
  const coord: Coord = [e.lngLat.lng, e.lngLat.lat];

  if (st.tool === "add-stop") {
    st.openAddStop(coord);
    return;
  }

  if (st.tool === "draw-track") {
    st.appendTrackVertex(coord);
    return;
  }

  if (st.tool === "toggle-construction") {
    const hits = map.queryRenderedFeatures(e.point, { layers: ["tracks-hit"] });
    const id = hits[0]?.properties?.id as string | undefined;
    if (id) st.toggleConstruction(id);
    else {
      const nearest = nearestTrack(coord, st.tracks);
      if (nearest) st.toggleConstruction(nearest);
    }
    return;
  }

  let stopHits: maplibregl.MapGeoJSONFeature[] = [];
  try {
    stopHits = map.queryRenderedFeatures(e.point, { layers: ["stops-hit"] });
  } catch {
    stopHits = [];
  }
  const nearby = uniqueStops(
    stopHits
      .map((f) => f.properties?.id as string)
      .filter(Boolean)
      .map((id) => st.stops.find((s) => s.id === id))
      .filter((s): s is Stop => Boolean(s)),
  );

  if (nearby.length > 1 && (st.tool === "select" || st.drawing || st.insertSlot)) {
    st.setStopPicker(nearby);
    return;
  }
  if (nearby.length === 1) {
    handleStopClick(nearby[0].id);
    return;
  }

  const pixel = map.project(e.lngLat);
  const around = st.stops.filter((s) => {
    const p = map.project({ lng: s.lon, lat: s.lat });
    return Math.hypot(p.x - pixel.x, p.y - pixel.y) < 28;
  });
  const mode =
    st.drawing?.mode ??
    (st.insertSlot ? st.lines.find((l) => l.id === st.insertSlot!.lineId)?.mode : undefined);
  const filtered = mode ? around.filter((s) => s.modes.includes(mode)) : around;
  if (filtered.length > 1) {
    st.setStopPicker(filtered);
    return;
  }
  if (filtered.length === 1) {
    handleStopClick(filtered[0].id);
    return;
  }

  if (st.tool === "select") {
    const lineHits = map.queryRenderedFeatures(e.point, { layers: ["lines-main"] });
    const lineId = lineHits[0]?.properties?.lineId as string | undefined;
    st.selectLine(lineId ?? null);
    if (!lineId) st.selectStop(null);
  }
}

function onDblClick(e: maplibregl.MapMouseEvent): void {
  const st = useStore.getState();
  if (st.tool === "draw-track") {
    e.preventDefault();
    st.finishTrackDraft();
  }
}

function handleStopClick(stopId: string): void {
  const st = useStore.getState();
  if (st.insertSlot) {
    void st.insertStopAtSlot(stopId);
    return;
  }
  if (st.drawing) {
    void st.addStopToDrawing(stopId);
    return;
  }
  st.selectStop(stopId);
}

function uniqueStops(list: Stop[]): Stop[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

function nearestTrack(coord: Coord, tracks: { id: string; geometry: Coord[] }[]): string | null {
  let best: string | null = null;
  let d = 24;
  for (const t of tracks) {
    const dist = distToLine(coord, t.geometry);
    if (dist < d) {
      d = dist;
      best = t.id;
    }
  }
  return best;
}
