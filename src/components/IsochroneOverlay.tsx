import { useEffect, useState } from "react";
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl";
import { PERIODS, type PeriodId } from "../constants";
import { ISOCHRONE_BANDS, type IsochroneResult } from "../lib/isochrones";
import { useIsochroneState } from "../lib/isochroneState";
import type { IsochroneReply } from "../lib/isochrones.worker";
import { useStore } from "../store";

const AREAS = "isochrone-areas";
const ORIGIN = "isochrone-origin";
const LAYERS = ["isochrone-fill", "isochrone-contours", "isochrone-labels", "isochrone-origin-dot"];
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function IsochroneOverlay({ map }: { map: MapLibre }) {
  const { origin, period, maxMinutes, setOrigin, setPeriod, setMaxMinutes } = useIsochroneState();
  const stops = useStore((s) => s.stops);
  const lines = useStore((s) => s.lines);
  const [result, setResult] = useState<IsochroneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    map.addSource(AREAS, { type: "geojson", data: EMPTY });
    map.addSource(ORIGIN, { type: "geojson", data: EMPTY });
    const before = map.getLayer("tracks-construction") ? "tracks-construction" : undefined;
    map.addLayer({ id: LAYERS[0], type: "fill", source: AREAS,
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.23, "fill-antialias": false },
    }, before);
    map.addLayer({ id: LAYERS[1], type: "line", source: AREAS,
      paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": 0.95 },
    }, before);
    map.addLayer({ id: LAYERS[2], type: "symbol", source: AREAS,
      layout: { "symbol-placement": "line", "symbol-spacing": 230,
        "text-field": ["concat", ["to-string", ["get", "minutes"]], " min"],
        "text-font": ["Noto Sans Regular"], "text-size": 12,
      },
      paint: { "text-color": "#1a1714", "text-halo-color": "#ffffff", "text-halo-width": 2 },
    });
    map.addLayer({ id: LAYERS[3], type: "circle", source: ORIGIN,
      paint: { "circle-radius": 7, "circle-color": "#1a1714", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
    });
    return () => {
      // The parent may already have removed the map during application teardown.
      if (!map.getStyle()) return;
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [AREAS, ORIGIN]) if (map.getSource(id)) map.removeSource(id);
    };
  }, [map]);

  useEffect(() => {
    const data = (id: string, value: GeoJSON.GeoJSON) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(value);
    data(AREAS, EMPTY);
    data(ORIGIN, origin ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: origin } } : EMPTY);
    setResult(null);
    setError(null);
    setLoading(Boolean(origin));
    if (!origin) return;
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL("../lib/isochrones.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<IsochroneReply>) => {
        setLoading(false);
        if (event.data.result) {
          setResult(event.data.result);
          data(AREAS, event.data.result.areas);
        } else setError(event.data.error);
      };
      worker.onerror = () => {
        setLoading(false);
        setError("Nie udało się obliczyć izochron. Wybierz punkt ponownie.");
      };
      worker.postMessage({ origin, stops, lines, period, maxMinutes });
    } catch {
      setLoading(false);
      setError("Nie udało się uruchomić obliczeń. Wybierz punkt ponownie.");
    }
    // Terminating prevents older clicks/settings from overwriting newer results.
    return () => worker?.terminate();
  }, [map, origin, stops, lines, period, maxMinutes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") useStore.getState().setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <section className="isochrone-panel" aria-label="Izochrony dostępności" aria-busy={loading}>
    <header>
      <div><div className="kicker">Dostępność komunikacją</div><h2>Izochrony</h2></div>
      <button className="icon-btn" aria-label="Zamknij izochrony" onClick={() => useStore.getState().setTool("select")}>×</button>
    </header>
    <p>{origin ? "Kliknij inne miejsce na mapie, aby zmienić punkt startowy." : "Kliknij dowolne miejsce na mapie, aby sprawdzić czas dojazdu."}</p>
    <label className="field">Pora dnia
      <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodId)}>
        {(["weekday", "weekend"] as const).map((group) => <optgroup key={group} label={group === "weekday" ? "Dzień roboczy" : "Weekend"}>
          {PERIODS.filter((p) => p.group === group).map((p) => <option key={p.id} value={p.id}>{p.label} · {p.hours}</option>)}
        </optgroup>)}
      </select>
    </label>
    <label className="field">Maksymalny czas podróży
      <select value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))}>
        {[30, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
      </select>
    </label>
    <ul className="isochrone-legend" aria-label="Legenda czasu dojazdu">
      {ISOCHRONE_BANDS.filter((b) => b.minutes <= maxMinutes).map((band, index) => <li key={band.minutes}>
        <i style={{ background: band.color }} aria-hidden="true" />
        <span>{index === 0 ? "0" : ISOCHRONE_BANDS[index - 1].minutes}–{band.minutes} min</span>
      </li>)}
    </ul>
    <div role="status" aria-live="polite">
      {loading && <p className="live">Obliczam dostępność…</p>}
      {result && <p>{result.activeLines === 0 ? "Brak kursujących linii w projekcie o tej porze — pokazuję zasięg pieszy." :
        `Czynne linie: ${result.activeLines} · osiągalne przystanki: ${result.reachableStops}`}</p>}
    </div>
    {error && <p className="err" role="alert">{error}</p>}
    <details className="isochrone-assumptions">
      <summary>Jak liczymy czas?</summary>
      <p>Linie z tego projektu, także ukryte na mapie. Dojście i odejście pieszo: 4,8 km/h.
        Oczekiwanie: połowa taktu przy każdym wejściu do pojazdu. Przesiadki piesze do 600 m.
        Czas jazdy pochodzi z odcinków linii.</p>
      <p>Wynik szacunkowy: pieszo w linii prostej, bez uwzględnienia rzek, ogrodzeń i przejść.
        Bez bieżącego rozkładu i opóźnień.{result && ` Dokładność siatki: około ${Math.round(result.resolutionMeters)} m.`}</p>
    </details>
    {origin && <div className="isochrone-point"><span>Start: {origin[1].toFixed(4)}, {origin[0].toFixed(4)}</span>
      <button className="ghost compact" onClick={() => setOrigin(null)}>Wyczyść</button>
    </div>}
  </section>;
}
