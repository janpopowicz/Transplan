import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibre } from "maplibre-gl";
import { useStore } from "../store";
import { useJourneyState } from "../lib/journeyState";
import { getIsochroneWorker, nextIsochroneRequestId, resetIsochroneWorker } from "../lib/isochroneClient";
import type { JourneyJob, JourneyPoint, JourneyReply, JourneyResult } from "../lib/journey";
import { formatDeparture, type ServiceDay } from "../lib/timetable";
import { JourneyTimePicker } from "./JourneyTimePicker";
import { clockMinutes, warsawNow } from "../lib/journeyTime";
import { searchPlaces, searchStops } from "../lib/places";

const SOURCE = "journey-route", EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const layers = ["journey-casing", "journey-walk", "journey-ride"];
const transfers = (n: number) => n === 0 ? "bez przesiadek" : n === 1 ? "1 przesiadka"
  : `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "przesiadki" : "przesiadek"}`;
const duration = (minutes: number) => minutes > 0 && minutes < 1 ? "<1 min" : `${Math.max(0, Math.round(minutes))} min`;

export function JourneyPlanner({ map }: { map: MapLibre }) {
  const { points, picking, time, day, setPoint, setPicking, setDay, setTime, swap } = useJourneyState();
  const lines = useStore((s) => s.lines), stops = useStore((s) => s.stops);
  const [result, setResult] = useState<JourneyResult | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [progress, setProgress] = useState("");
  const [timeReady, setTimeReady] = useState(true);
  const [retry, setRetry] = useState(0);
  const hasSearched = useRef(false), searchRef = useRef<() => void>(() => {});
  const requestId = useRef(0), workerRef = useRef<Worker | null>(null);
  const stopName = (id?: string) => stops.find((s) => s.id === id)?.name ?? "przystanek";
  useEffect(() => {
    map.addSource(SOURCE, { type: "geojson", data: EMPTY });
    map.addLayer({ id: layers[0], type: "line", source: SOURCE, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": .95 } });
    map.addLayer({ id: layers[1], type: "line", source: SOURCE, filter: ["==", ["get", "kind"], "walk"],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#174ea6", "line-width": 4, "line-dasharray": [1, 1.5] } });
    map.addLayer({ id: layers[2], type: "line", source: SOURCE, filter: ["==", ["get", "kind"], "ride"],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 7 } });
    return () => {
      if (!map.getStyle()) return;
      for (const layer of layers.slice().reverse()) if (map.getLayer(layer)) map.removeLayer(layer);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    };
  }, [map]);
  useEffect(() => {
    const markers = points.flatMap((point, index) => {
      if (!point) return [];
      const element = document.createElement("div"); element.className = `journey-marker point-${index}`;
      element.textContent = index ? "B" : "A"; element.title = `Przeciągnij punkt ${index ? "B" : "A"}: ${point.name}`;
      element.setAttribute("aria-label", element.title);
      const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat(point.coord).addTo(map);
      marker.on("dragend", () => {
        const position = marker.getLngLat(), coord: [number, number] = [position.lng, position.lat];
        setPoint(index as 0 | 1, { coord, name: `Punkt ${index ? "B" : "A"} (${coord[1].toFixed(4)}, ${coord[0].toFixed(4)})` });
      });
      return [marker];
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [map, points, setPoint]);
  useEffect(() => {
    const worker = getIsochroneWorker(); workerRef.current = worker;
    const receive = (event: MessageEvent<JourneyReply>) => {
      const reply = event.data;
      if (reply.id !== requestId.current) return;
      if (reply.progress) { setProgress(reply.progress); return; }
      setLoading(false);
      if (reply.result) {
        setResult(reply.result);
        const features: GeoJSON.Feature<GeoJSON.LineString>[] = reply.result.legs.filter((leg) => leg.geometry.length >= 2).map((leg) => ({
          type: "Feature", properties: { kind: leg.kind, color: leg.color ?? "#174ea6" }, geometry: { type: "LineString", coordinates: leg.geometry },
        }));
        (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
        const coords = features.flatMap((f) => f.geometry.coordinates);
        if (coords.length) {
          const bounds = new maplibregl.LngLatBounds(); coords.forEach((coord) => bounds.extend(coord as [number, number]));
          const left = map.getContainer().clientWidth > 700 ? 400 : 40;
          map.fitBounds(bounds, { padding: { top: 60, right: 50, bottom: 60, left }, maxZoom: 16, duration: 600 });
        }
      } else setError(reply.error || "Nie udało się znaleźć trasy.");
    };
    const fail = () => { resetIsochroneWorker(); workerRef.current = null; setLoading(false); setError("Błąd obliczeń. Spróbuj ponownie."); setRetry((n) => n + 1); };
    worker.addEventListener("message", receive); worker.addEventListener("error", fail);
    return () => { worker.removeEventListener("message", receive); worker.removeEventListener("error", fail); workerRef.current = null; };
  }, [map, retry]);
  useEffect(() => {
    requestId.current = nextIsochroneRequestId(); setResult(null); setError(""); setLoading(false);
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY);
    if (hasSearched.current && points[0] && points[1] && timeReady && clockMinutes(time) !== null) {
      setLoading(true); setProgress("Przeliczam trasę po zmianie punktu lub godziny…");
      const timer = window.setTimeout(() => searchRef.current(), 250);
      return () => window.clearTimeout(timer);
    }
  }, [map, points, day, time, timeReady, lines, stops]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") useStore.getState().setTool("select"); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, []);
  const find = () => {
    if (!points[0] || !points[1]) return;
    const departureMinute = clockMinutes(time);
    if (departureMinute === null) { setError("Wybierz godzinę odjazdu."); return; }
    hasSearched.current = true;
    setError(""); setResult(null); setLoading(true); setProgress("Przygotowuję rozkłady i sieć pieszą…");
    const id = nextIsochroneRequestId(); requestId.current = id;
    try {
      const worker = getIsochroneWorker(); workerRef.current = worker;
      worker.postMessage({ kind: "journey", id, request: { origin: points[0], destination: points[1], lines, stops, day, departureMinute } } satisfies JourneyJob);
    } catch { setLoading(false); setError("Nie udało się uruchomić obliczeń."); }
  };
  searchRef.current = find;
  return <section className="journey-panel" aria-label="Planer przejazdu" aria-busy={loading}>
    <header><div><div className="kicker">Przejazd komunikacją</div><h2>Znajdź trasę</h2></div>
      <button type="button" className="icon-btn" aria-label="Zamknij planer trasy" onClick={() => useStore.getState().setTool("select")}>×</button></header>
    <p className="muted">Wybierz start i cel. Wyszukaj miejsce lub wskaż punkt na mapie. Znaczniki A i B możesz przeciągać. Po pierwszym wyszukaniu trasa przelicza się automatycznie.</p>
    {([0, 1] as const).map((index) => <PointSearch key={index} index={index} point={points[index]} active={picking === index}
      choose={(point) => setPoint(index, point)} pick={() => setPicking(picking === index ? null : index)} />)}
    <button type="button" className="ghost compact journey-swap" onClick={swap}>⇅ Zamień start i cel</button>
    {picking !== null && <p className="journey-picking" role="status">Kliknij na mapie: {picking === 0 ? "punkt startowy A" : "cel B"}.</p>}
    <label className="field">Dzień przejazdu<select value={day} onChange={(e) => setDay(e.target.value as ServiceDay)}>
      <option value="weekday">Dzień roboczy</option><option value="weekend">Weekend</option></select></label>
    <JourneyTimePicker value={time} onReady={setTimeReady} onChange={setTime} onNow={() => { const now = warsawNow(); setTime(now.time); setDay(now.day); return now.time; }} />
    <button type="button" className="primary journey-find" disabled={!points[0] || !points[1] || !timeReady || loading} onClick={find}>{loading ? "Szukam…" : "Znajdź trasę"}</button>
    <div role="status" aria-live="polite">{loading && <p className="live">{progress}</p>}</div>
    {error && <p className="err" role="alert">{error}</p>}
    {result && <div className="journey-result">
      <h3>{duration(result.arrivalMinute - result.departureMinute)} · {formatDeparture(result.departureMinute)} → {formatDeparture(result.arrivalMinute)}</h3>
      <p className="muted">Pieszo {duration(result.walkMinutes)} · oczekiwanie {duration(result.waitMinutes)} · {transfers(result.transfers)}</p>
      {!result.legs.length && <p>Start i cel znajdują się w tym samym miejscu.</p>}
      <ol className="journey-legs">{result.legs.map((leg, index) => <li key={index}>
        <div className="journey-leg-time">{formatDeparture(leg.departureMinute)}–{formatDeparture(leg.arrivalMinute)}</div>
        {leg.kind === "ride" ? <><span className="badge" style={{ background: leg.color }}>{leg.number}</span>
          <strong>{stopName(leg.fromStopId)} → {stopName(leg.toStopId)}</strong><span>{leg.stops} przyst. · {duration(leg.arrivalMinute - leg.departureMinute)}</span></>
          : leg.kind === "wait" ? <><strong>Oczekiwanie na linię {leg.number}</strong><span>{stopName(leg.fromStopId)} · {duration(leg.arrivalMinute - leg.departureMinute)}</span></>
          : <><strong>Przejdź pieszo</strong><span>{Math.round((leg.arrivalMinute - leg.departureMinute) * 80)} m · {duration(leg.arrivalMinute - leg.departureMinute)}</span></>}
      </li>)}</ol>
    </div>}
    <p className="journey-footnote">Linie i rozkłady z projektu, także ukryte na mapie. Trasa uwzględnia przesiadki, koordynację i zmiany taktów w ciągu dnia. Bez opóźnień.</p>
  </section>;
}

function PointSearch({ index, point, active, choose, pick }: { index: 0 | 1; point: JourneyPoint | null; active: boolean;
  choose: (point: JourneyPoint | null) => void; pick: () => void }) {
  const stops = useStore((s) => s.stops), [query, setQuery] = useState(point?.name ?? "");
  const [places, setPlaces] = useState<JourneyPoint[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null), label = index ? "Cel" : "Start";
  useEffect(() => { if (point) setQuery(point.name); setPlaces([]); setError(""); controller.current?.abort(); setLoading(false); }, [point]);
  useEffect(() => () => controller.current?.abort(), []);
  const local = useMemo(() => point?.name === query ? [] : searchStops(stops, query), [stops, query, point]);
  const select = (value: JourneyPoint) => { choose(value); setQuery(value.name); setPlaces([]); setError(""); };
  const search = async () => {
    if (query.trim().length < 3) { setError("Wpisz co najmniej 3 znaki."); return; }
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setError(""); setLoading(true);
    try {
      const result = await searchPlaces(query, current.signal);
      if (!current.signal.aborted) { setPlaces(result); if (!result.length) setError("Brak miejsc. Wybierz przystanek lub wskaż punkt na mapie."); }
    } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : "Błąd wyszukiwania."); }
    finally { if (!current.signal.aborted) setLoading(false); }
  };
  return <div className="journey-point">
    <label className="field">{index ? "B · Cel" : "A · Start"}<input aria-label={label} value={query} placeholder="Przystanek, adres lub miejsce"
      onChange={(e) => { setQuery(e.target.value); setPlaces([]); setError(""); controller.current?.abort(); setLoading(false); if (point) choose(null); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} /></label>
    <div className="journey-point-actions"><button type="button" className="ghost compact" onClick={() => void search()} disabled={loading} aria-label={`Wyszukaj adres lub miejsce: ${label}`}>
      {loading ? "Wyszukuję…" : "Szukaj miejsca"}</button>
      <button type="button" className={active ? "ghost compact on" : "ghost compact"} aria-pressed={active} onClick={pick} aria-label={`Wskaż ${index ? "cel" : "start"} na mapie`}>Na mapie</button>
      {(point || query) && <button type="button" className="icon-btn" aria-label={`Wyczyść: ${label}`} onClick={() => { controller.current?.abort(); setLoading(false); choose(null); setQuery(""); setPlaces([]); setError(""); }}>×</button>}
    </div>
    {(local.length > 0 || places.length > 0) && <ul className="journey-search-results" aria-label={`Wyniki: ${label}`}>
      {local.map((place, i) => <li key={`stop-${i}`}><button type="button" onClick={() => select(place)}><small>Przystanek</small>{place.name}</button></li>)}
      {places.map((place, i) => <li key={`place-${i}`}><button type="button" onClick={() => select(place)}><small>Miejsce · OSM / Photon</small>{place.name}</button></li>)}
    </ul>}
    {error && <p className="err" role="alert">{error}</p>}
  </div>;
}
