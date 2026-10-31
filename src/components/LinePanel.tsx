import { AVERAGE_SPEED_KMH, BUS_VEHICLES, LINE_COLORS, TRAM_VEHICLES } from "../constants";
import { cycleMinutes, peakTakt, vehiclesNeeded } from "../lib/takt";
import { formatTakt } from "../lib/geo";
import { useStore } from "../store";
import { dailyLineCost, formatMoney } from "../lib/costs";
import { CoordinationPanel } from "./CoordinationPanel";
import { TimetablePanel } from "./TimetablePanel";
import { TaktGrid } from "./TaktGrid";

export function LinePanel() {
  const readOnly = useStore((s) => s.access === "read");
  const id = useStore((s) => s.selectedLineId);
  const line = useStore((s) => s.lines.find((l) => l.id === id));
  const stops = useStore((s) => s.stops);
  const updateLine = useStore((s) => s.updateLine);
  const setTakt = useStore((s) => s.setTakt);
  const setVehicle = useStore((s) => s.setVehicle);
  const setSegmentTime = useStore((s) => s.setSegmentTime);
  const resetSegmentTime = useStore((s) => s.resetSegmentTime);
  const removeStopFromLine = useStore((s) => s.removeStopFromLine);
  const selectStop = useStore((s) => s.selectStop);
  const selectLine = useStore((s) => s.selectLine);
  const deleteLine = useStore((s) => s.deleteLine);

  if (!line) return null;

  const vehicles = line.mode === "bus" ? BUS_VEHICLES : TRAM_VEHICLES;
  const cycle = cycleMinutes(line);
  const peak = peakTakt(line);
  const brigades = vehiclesNeeded(line, peak);
  const nameOf = (sid: string) => stops.find((s) => s.id === sid)?.name ?? sid;

  return (
    <aside className="inspector">
      <header className="insp-h">
        <span className="badge" style={{ background: line.color }}>{line.number}</span>
        <strong className="inspector-title" title={line.name}>{line.name || (line.mode === "bus" ? "Autobus" : "Tramwaj")}</strong>
        <button type="button" className="icon-btn close-inspector"
          aria-label="Zamknij panel linii" title="Zamknij panel linii" onClick={() => selectLine(null)}>×</button>
      </header>
      <fieldset className="line-fields" disabled={readOnly}>
      <label className="field">Nazwa linii
        <input className="title-input" value={line.name} placeholder="Nazwa linii"
          onChange={(e) => updateLine(line.id, { name: e.target.value })} />
      </label>
      <label className="field">
        Numer
        <input value={line.number} onChange={(e) => updateLine(line.id, { number: e.target.value })} />
      </label>

      <div className="swatches" aria-label="Kolor linii">
        {LINE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={c === line.color ? "swatch on" : "swatch"}
            style={{ background: c }}
            onClick={() => updateLine(line.id, { color: c })}
          />
        ))}
      </div>

      <CoordinationPanel line={line} />

      <StopList
        title="Kierunek tam"
        lineId={line.id}
        direction="outbound"
        ids={line.outboundStopIds}
        terminusId={line.terminus2Id}
        nameOf={nameOf}
        onSelect={selectStop}
        onRemove={(sid) => void removeStopFromLine(line.id, sid, "outbound")}
      />
      <StopList
        title="Kierunek powrotny"
        lineId={line.id}
        direction="inbound"
        ids={line.inboundStopIds}
        terminusId={line.terminus1Id}
        nameOf={nameOf}
        onSelect={selectStop}
        onRemove={(sid) => void removeStopFromLine(line.id, sid, "inbound")}
      />

      <details key={line.id} className="fold">
        <summary>
          Czasy międzyprzystankowe
          {line.segments.length > 0 && <span>{line.segments.length}</span>}
        </summary>
        <p className="muted">Czas z GTFS, jeśli istnieje bezpośrednia relacja dla tych stanowisk i kierunku
          (mediana kursów). W pozostałych przypadkach: długość trasy przy {String(AVERAGE_SPEED_KMH[line.mode]).replace(".", ",")} km/h.
          Czasy zaokrąglamy do 1 min. Przycisk ↻ przywraca czas automatyczny; możesz też wpisać własny.</p>
        {line.segments.length === 0 ? (
          <p className="empty-hint">Brak odcinków — pojawią się po dodaniu przystanków.</p>
        ) : (
          <ul className="seg-times">
            {line.segments.map((seg) => (
              <li key={seg.id}>
                <button type="button" className="linkish" onClick={() => selectStop(seg.toStopId)}>
                  {nameOf(seg.fromStopId)} → {nameOf(seg.toStopId)}
                </button>
                <input
                  aria-label={`Czas: ${nameOf(seg.fromStopId)} → ${nameOf(seg.toStopId)}`}
                  title={(seg.travelTimeSource === "gtfs" || seg.travelTimeSource === "gtfs-import") ? `GTFS: mediana z ${seg.gtfsSamples ?? 0} przejazdów`
                    : seg.travelTimeSource === "auto" ? "Czas obliczony z długości trasy" : "Czas ustawiony ręcznie"}
                  type="number"
                  min={1}
                  step={1}
                  value={seg.travelMin}
                  onChange={(e) => setSegmentTime(line.id, seg.id, Number(e.target.value))}
                />
                <span>min{(seg.travelTimeSource === "gtfs" || seg.travelTimeSource === "gtfs-import") && <small className="time-source">GTFS</small>}</span>
                <button type="button" className="icon-btn" title="Przywróć czas z GTFS lub oszacowanie z długości trasy"
                  aria-label={`Oblicz czas: ${nameOf(seg.fromStopId)} → ${nameOf(seg.toStopId)}`}
                  onClick={() => resetSegmentTime(line.id, seg.id)}>↻</button>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="fold">
        <summary>Koszt kursowania</summary>
        <dl className="cost-breakdown">
          <dt>Dzień roboczy</dt><dd>{formatMoney(dailyLineCost(line, "weekday").cost)}</dd>
          <dt>Dzień weekendu</dt><dd>{formatMoney(dailyLineCost(line, "weekend").cost)}</dd>
        </dl>
        <p className="muted">Długość obu kierunków × liczba kursów wynikająca z taktów.
          Stawka: {line.mode === "bus" ? "14,09" : "28,33"} zł/wozokm. Bez dojazdów do zajezdni.</p>
      </details>
      <fieldset className="seg">
        <legend>Tabor</legend>
        <div className="pills">
          {vehicles.map((v) => (
            <button
              key={v.id}
              type="button"
              className={line.vehicle === v.id ? "pill on" : "pill"}
              onClick={() => setVehicle(line.id, v.id)}
            >
              {v.label}
              <small>{v.hint}</small>
            </button>
          ))}
        </div>
        <p className="muted">Częstsze linie są nieco grubsze. Długość pojazdu ma niewielki wpływ; krótki autobus i krótki tramwaj mają tę samą grubość przy tym samym takcie.</p>
      </fieldset>

      <TaktGrid value={line.takt} color={line.color} onChange={(p, v) => setTakt(line.id, p, v)} />
      </fieldset>
      <TimetablePanel key={line.id} line={line} />
      <fieldset className="line-fields" disabled={readOnly}>

      <div className="stats">
        <div>
          <span>Czas obiegu</span>
          <strong>{cycle ? `${cycle.toString().replace(".", ",")} min` : "—"}</strong>
        </div>
        <div>
          <span>Brygady w szczycie</span>
          <strong>{brigades ?? "—"}</strong>
        </div>
        <div>
          <span>Takt szczytowy</span>
          <strong>{formatTakt(peak)}</strong>
        </div>
      </div>

      <label className="field">
        Postój na krańcówce (min)
        <input
          type="number"
          min={0}
          step={0.5}
          value={line.layoverMin}
          onChange={(e) => updateLine(line.id, { layoverMin: Number(e.target.value) || 0 })}
        />
      </label>

      <button type="button" className="danger-block" onClick={() => deleteLine(line.id)}>
        Usuń linię
      </button>
      </fieldset>
    </aside>
  );
}

function StopList({
  title,
  lineId,
  direction,
  ids,
  terminusId,
  nameOf,
  onSelect,
  onRemove,
}: {
  title: string;
  lineId: string;
  direction: "outbound" | "inbound";
  ids: string[];
  terminusId: string | null;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const insertSlot = useStore((s) => s.insertSlot);
  const drawing = useStore((s) => s.drawing);
  const resumeDrawing = useStore((s) => s.resumeDrawing);
  const beginInsert = useStore((s) => s.beginInsert);
  const appendingHere =
    drawing?.lineId === lineId &&
    ((direction === "outbound" && (drawing.phase === "outbound" || drawing.phase === "terminus1")) ||
      (direction === "inbound" && drawing.phase === "inbound"));

  return (
    <div className="stop-list-block">
      <h3>{title}</h3>
      {ids.length === 0 && <p className="empty-hint">Brak przystanków</p>}
      <ol className="stop-seq">
        {ids.map((id, i) => (
          <li key={`${id}-${i}`}>
            <button type="button" onClick={() => onSelect(id)}>
              <span className="n">{i + 1}</span>
              {nameOf(id)}
              {(i === 0 || id === terminusId) && <em className="kr">kraniec</em>}
            </button>
            <button type="button" className="icon-btn danger" title="Zdejmij z linii" onClick={() => onRemove(id)}>
              ×
            </button>
            {i < ids.length - 1 && (
              <button
                type="button"
                className={
                  insertSlot?.lineId === lineId &&
                  insertSlot.direction === direction &&
                  insertSlot.afterIndex === i
                    ? "insert-gap on"
                    : "insert-gap"
                }
                title={`Wstaw przystanek między ${nameOf(id)} a ${nameOf(ids[i + 1])}`}
                onClick={() => beginInsert(lineId, direction, i)}
              >
                <span>+</span>
                <em>wstaw</em>
              </button>
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className={appendingHere ? "add-more on" : "add-more"}
        onClick={() => resumeDrawing(lineId, direction)}
      >
        + dodaj przystanki dalej
      </button>
    </div>
  );
}
