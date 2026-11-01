import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { Map, Popup } from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { KRAKOW_CENTER } from "../constants";
import { buildRenderSegments } from "../lib/interline";
import { buildNetworkStopMarkers } from "../lib/networkStops";
import { isNetworkView } from "../lib/mapViewMode";
import { distToLine, metersPerPixel, stopGroupLabel } from "../lib/geo";
import { useStore } from "../store";
import type { Coord, Stop } from "../types";
import { IsochroneOverlay } from "./IsochroneOverlay";
import { JourneyPlanner } from "./JourneyPlanner";
import { useJourneyState } from "../lib/journeyState";
import { useIsochroneState } from "../lib/isochroneState";

// MapLibre 6 ships a separate worker. Let Vite emit and version it with this build.
maplibregl.setWorkerUrl(mapWorkerUrl);

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: "osm-simple",
  glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
const WAYPOINTS = "route-waypoints";
const WAYPOINT_DRAFT = "route-waypoint-draft";

export function MapView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const readyRef = useRef(false);
  const [readyMap, setReadyMap] = useState<Map | null>(null);
  const journey = useStore((s) => s.tool === "journey");
  const isochrones = useStore((s) => s.tool === "isochrones");
  const moveMarkerRef = useRef<maplibregl.Marker | null>(null);
  const moving = useStore((s) => s.tool === "move-stop");
  const selectedStop = useStore((s) => s.stops.find((stop) => stop.id === s.selectedStopId));
  const routing = useStore((s) => s.routing);
  const routingError = useStore((s) => s.routingError);

  useEffect(() => {
    if (!rootRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: rootRef.current,
      style: STYLE,
      center: KRAKOW_CENTER,
      zoom: 12.4,
      maxPitch: 0,
      attributionControl: { compact: false },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    mapRef.current = map;

    const onReady = () => {
      readyRef.current = true;
      ensureSources(map);
      syncLayers(map);
      setReadyMap(map);
    };
    map.on("load", onReady);
    map.on("style.load", onReady);

    map.on("mousemove", onMove);
    map.on("click", onClick);
    map.on("dblclick", onDblClick);
    let networkMode = isNetworkView(map.getZoom(), useStore.getState());
    const onZoom = () => {
      const next = isNetworkView(map.getZoom(), useStore.getState());
      if (next === networkMode || !readyRef.current) {
        networkMode = next;
        return;
      }
      networkMode = next;
      syncLayers(map);
    };
    map.on("zoom", onZoom);
    const onZoomEnd = () => {
      if (readyRef.current) syncLayers(map);
    };
    map.on("zoomend", onZoomEnd);

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(rootRef.current);

    const unsub = useStore.subscribe((s, prev) => {
      if (!mapRef.current || !readyRef.current) return;
      const mapRelevant =
        s.lines !== prev.lines ||
        s.stops !== prev.stops ||
        s.tracks !== prev.tracks ||
        s.selectedStopId !== prev.selectedStopId ||
        s.selectedLineId !== prev.selectedLineId ||
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
      map.off("zoom", onZoom);
      map.off("zoomend", onZoomEnd);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!moving || !selectedStop || !mapRef.current) return;
    const element = document.createElement("button");
    element.type = "button";
    element.className = "move-stop-handle";
    element.title = `Przeciągnij: ${selectedStop.name}`;
    element.setAttribute("aria-label", element.title);
    element.addEventListener("click", (event) => event.stopPropagation());
    const marker = new maplibregl.Marker({ element, draggable: !useStore.getState().routing })
      .setLngLat([selectedStop.lon, selectedStop.lat]).addTo(mapRef.current);
    moveMarkerRef.current = marker;
    marker.on("dragstart", () => popupRefSingleton.current?.remove());
    marker.on("dragend", () => {
      const point = marker.getLngLat();
      void useStore.getState().moveStop(selectedStop.id, [point.lng, point.lat]).finally(() => {
        const current = useStore.getState().stops.find((stop) => stop.id === selectedStop.id);
        if (current) marker.setLngLat([current.lon, current.lat]);
      });
    });
    return () => { marker.remove(); moveMarkerRef.current = null; };
  }, [moving, selectedStop]);

  useEffect(() => { moveMarkerRef.current?.setDraggable(!routing); }, [routing]);

  return <>
    <div ref={rootRef} className="map" />
    {journey && readyMap && <JourneyPlanner map={readyMap} />}
    {isochrones && readyMap && <IsochroneOverlay map={readyMap} />}
    {moving && <div className="move-stop-hint" role="status">
      <p>{routing ? "Przeliczam trasy…" : selectedStop
        ? `${selectedStop.name}: przeciągnij znacznik albo kliknij nowe miejsce na mapie.`
        : "Wybierz przystanek, który chcesz przesunąć."}</p>
      {routingError && <p role="alert">{routingError}</p>}
      <button type="button" className="ghost compact" onClick={() => useStore.getState().setTool("select")}>Zakończ przesuwanie</button>
    </div>}
  </>;
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
  add(WAYPOINTS);
  add(WAYPOINT_DRAFT);
  if (!map.getLayer("route-waypoint-line")) {
    map.addLayer({ id: "route-waypoint-line", type: "line", source: WAYPOINT_DRAFT,
      paint: { "line-color": "#7c3aed", "line-width": 4, "line-dasharray": [2, 1] } });
    map.addLayer({ id: "route-waypoint-dots", type: "circle", source: WAYPOINTS,
      paint: { "circle-radius": 6, "circle-color": "#7c3aed", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  }

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
      filter: ["==", ["get", "directional"], false],
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          ["case", ["==", ["get", "network"], 1], ["get", "radius"], 2.2],
          13.5,
          ["case", ["==", ["get", "network"], 1], ["get", "radius"], 4],
          16,
          ["case", ["==", ["get", "network"], 1], ["get", "radius"], 7],
        ],
        "circle-color": [
          "case",
          ["==", ["get", "network"], 1],
          "#fff",
          ["==", ["get", "local"], 1],
          "#7c3aed",
          ["==", ["get", "tram"], 1],
          "#d1242f",
          "#1f4e79",
        ],
        "circle-stroke-width": ["case", ["==", ["get", "network"], 1], 1, 1.2],
        "circle-stroke-color": ["case", ["==", ["get", "network"], 1], ["get", "color"], "#fff"],
        "circle-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          11,
          ["case", ["==", ["get", "network"], 1], 1, 0.55],
          13,
          ["case", ["==", ["get", "network"], 1], 1, 0.95],
        ],
      },
    });
    map.addLayer({
      id: "stops-direction",
      type: "symbol",
      source: STOPS,
      filter: ["==", ["get", "directional"], true],
      layout: {
        "icon-image": ["get", "triangleImage"],
        "icon-size": ["/", ["+", ["*", ["get", "radius"], 2], 3], 16],
        "icon-rotate": ["get", "direction"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
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
          ["case", ["==", ["get", "network"], 1], 6, 12],
          15,
          ["case", ["==", ["get", "network"], 1], 7, 20],
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
        "circle-color": ["case", ["==", ["get", "network"], 1], "transparent", "#facc15"],
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
        "circle-color": ["case", ["==", ["get", "network"], 1], "transparent", "#facc15"],
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
  // Keep the shaping handles visible above the wider line strokes.
  map.moveLayer("route-waypoint-line");
  map.moveLayer("route-waypoint-dots");
  const selected = s.selectedStopId;
  const drawing = s.drawing;
  const editedLine = s.lines.find((line) => line.id === (drawing?.lineId ?? s.selectedLineId));
  const waypointCoords = [...(editedLine?.segments.flatMap((segment) => segment.waypoints ?? []) ?? []),
    ...(drawing?.waypoints ?? [])];
  setData(map, WAYPOINTS, { type: "FeatureCollection", features: waypointCoords.map((coord) => ({
    type: "Feature", properties: {}, geometry: { type: "Point", coordinates: coord },
  })) });
  setData(map, WAYPOINT_DRAFT, { type: "FeatureCollection", features: (drawing?.waypointLegs ?? []).map((geometry) => ({
    type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: geometry },
  })) });
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

  const network = isNetworkView(map.getZoom(), useStore.getState());
  const metersPerPx = metersPerPixel(map.getCenter().lat, map.getZoom());
  const render = buildRenderSegments(s.lines, {
    collapseDirections: network,
    stops: s.stops,
    metersPerPx,
  });
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
        oneWay: r.oneWay,
      },
      geometry: { type: "LineString", coordinates: r.geometry },
    })),
  });

  const visibleStops = s.stops.filter((st) => {
    if (!modeFilter) return true;
    return st.modes.includes(modeFilter);
  });

  const projected = network ? buildNetworkStopMarkers(s.lines, s.stops, render) : [];
  const markers = network
    ? projected.map((marker) => ({ ...marker, network: 1 }))
    : visibleStops.map((stop) => ({ group: [stop], coord: [stop.lon, stop.lat] as Coord,
      network: 0, lineId: "", color: "#fff", radius: 0, direction: null }));
  for (const marker of markers) {
    if (marker.direction === null || map.hasImage(`stop-triangle-${marker.color}`)) continue;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(16, 3); ctx.lineTo(29, 28); ctx.lineTo(3, 28); ctx.closePath();
    ctx.fillStyle = "#fff"; ctx.strokeStyle = marker.color; ctx.lineWidth = 3;
    ctx.lineJoin = "round"; ctx.fill(); ctx.stroke();
    map.addImage(`stop-triangle-${marker.color}`, ctx.getImageData(0, 0, 32, 32), { pixelRatio: 2 });
  }
  const stopFeatures: GeoJSON.Feature[] = markers.map(({ group, coord, network, lineId, color, radius, direction }) => ({
    type: "Feature",
    properties: {
      id: group[0].id,
      name: network ? stopGroupLabel(group[0].name) : group[0].name,
      members: group.map((st) => st.id).join("|"),
      count: group.length,
      grouped: network && group.length > 1 ? 1 : 0,
      network, lineId, color, radius, direction: direction ?? 0,
      directional: direction !== null, triangleImage: `stop-triangle-${color}`,
      local: group.every((st) => st.source === "local") ? 1 : 0,
      tram: group.every((st) => st.modes.includes("tram") && !st.modes.includes("bus")) ? 1 : 0,
    },
    geometry: { type: "Point", coordinates: coord },
  }));

  setData(map, STOPS, { type: "FeatureCollection", features: stopFeatures });

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
  const selectedCoords = network
    ? projected.filter((marker) => marker.group.some((st) => st.id === selected)).map((marker) => marker.coord)
    : chosen ? [[chosen.lon, chosen.lat] as Coord] : [];
  setData(map, SELECTED, {
    type: "FeatureCollection",
    features: selectedCoords.map((coord) => ({
      type: "Feature", properties: { network: network ? 1 : 0 },
      geometry: { type: "Point", coordinates: coord },
    })),
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
  if (["isochrones", "journey"].includes(useStore.getState().tool)) {
    popupRefSingleton.current?.remove();
    return;
  }
  if (!map.getLayer("stops-hit")) return;
  let hits: maplibregl.MapGeoJSONFeature[] = [];
  try {
    hits = map.queryRenderedFeatures(e.point, { layers: ["stops-hit"] });
  } catch {
    return;
  }
  const id = (hits[0]?.properties?.id as string) ?? null;

  const popup = popupRefEnsure(map);
  if (id) {
    const count = Number(hits[0]?.properties?.count ?? 1);
    const name = String(hits[0]?.properties?.name ?? "");
    const lng = (hits[0]?.geometry as GeoJSON.Point | undefined)?.coordinates as Coord | undefined;
    if (count > 1 && name && lng) {
      popup
        .setLngLat(lng)
        .setHTML(`<strong>${escapeHtml(name)}</strong><span>${count} przystanków</span>`)
        .addTo(map);
      return;
    }
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

  if (st.tool === "journey") {
    popupRefSingleton.current?.remove();
    const state = useJourneyState.getState();
    if (state.picking !== null) state.setPoint(state.picking, { coord, name: `Punkt na mapie (${coord[1].toFixed(4)}, ${coord[0].toFixed(4)})` });
    return;
  }

  if (st.tool === "isochrones") {
    popupRefSingleton.current?.remove();
    useIsochroneState.getState().setOrigin(coord);
    return;
  }

  if (st.drawing?.placingWaypoint) {
    popupRefSingleton.current?.remove();
    void st.addDrawingWaypoint(coord);
    return;
  }

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
  const nearby = uniqueStops(stopsFromHits(stopHits, st.stops));
  if (st.tool === "move-stop") {
    if (st.routing) return;
    if (nearby.length > 1) st.setStopPicker(nearby);
    else if (nearby.length === 1) st.selectStop(nearby[0].id);
    else if (st.selectedStopId) void st.moveStop(st.selectedStopId, coord);
    return;
  }

  if (nearby.length > 1 && (st.tool === "select" || st.drawing || st.insertSlot)) {
    st.setStopPicker(nearby);
    return;
  }
  if (nearby.length === 1) {
    handleStopClick(nearby[0].id);
    return;
  }

  const pixel = map.project(e.lngLat);
  const around =
    isNetworkView(map.getZoom(), useStore.getState())
      ? []
      : st.stops.filter((s) => {
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

function stopsFromHits(features: maplibregl.MapGeoJSONFeature[], all: Stop[]): Stop[] {
  const ids: string[] = [];
  for (const f of features) {
    const raw = String(f.properties?.members ?? f.properties?.id ?? "");
    for (const id of raw.split("|")) if (id) ids.push(id);
  }
  return ids
    .map((id) => all.find((s) => s.id === id))
    .filter((s): s is Stop => Boolean(s));
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
