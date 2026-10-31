import { useEffect, useMemo, useState } from "react";
import { PERIODS, type PeriodId } from "../constants";
import type { LineDirection, TransitLine } from "../types";
import { useStore } from "../store";
import { buildTimetable, coordinationMembers, formatDeparture, modulo, buildDailyTimetable, dailyStopDepartures, timetableRuns, type ServiceDay } from "../lib/timetable";
import { formatTakt } from "../lib/geo";

export function TimetablePanel({ line }: { line: TransitLine }) {
  const [period, setPeriod] = useState<PeriodId>("wd_am"), [direction, setDirection] = useState<LineDirection>("outbound");
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<ServiceDay>("weekday"), [stopId, setStopId] = useState("");
  const readOnly = useStore((s) => s.access === "read");
  const lines = useStore((s) => s.lines), stops = useStore((s) => s.stops);
  const setOffset = useStore((s) => s.setDepartureOffset);
  const runs = useMemo(() => buildTimetable(lines, period).filter((r) => r.lineId === line.id && r.direction === direction), [lines, line.id, period, direction]);
  const value = runs.length ? modulo(runs[0].phase, runs[0].headway) : line.departureOffsetMin ?? 0;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Number(value.toFixed(4)))), [value, line.id, period, direction]);
  const stopIds = useMemo(() => [...new Set(timetableRuns([line]).filter((r) => r.direction === direction).flatMap((r) => r.stops))], [line, direction]);
  const selectedStopId = stopIds.includes(stopId) ? stopId : stopIds[0] ?? "";
  const dailyRuns = useMemo(() => open ? buildDailyTimetable(lines, day) : [], [open, lines, day]);
  const departures = useMemo(() => dailyStopDepartures(dailyRuns, line.id, direction, selectedStopId), [dailyRuns, line.id, direction, selectedStopId]);
  const hours = Array.from({ length: Math.max(24, Math.floor((departures.at(-1) ?? 0) / 60) + 1) }, (_, h) => ({ hour: h,
    times: departures.filter((time) => Math.floor(time / 60) === h) }));
  const members = coordinationMembers(lines, line);
  const nameOf = (id: string) => stops.find((s) => s.id === id)?.name ?? id;
  return <div className="timetable-panel" aria-label="Przesunięcie i rozkład jazdy">
    <div className="timetable-selectors">
      <label className="field">Pora dla przesunięcia<select value={period} onChange={(e) => setPeriod(e.target.value as PeriodId)}>
        {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.hours}</option>)}
      </select></label>
      <label className="field">Kierunek rozkładu<select value={direction} onChange={(e) => setDirection(e.target.value as LineDirection)}>
        <option value="outbound">Kierunek tam</option><option value="inbound">Kierunek powrotny</option>
      </select></label>
    </div>
    <label className="field">Przesunięcie odjazdów (min)
      <input type="number" min={0} max={1440} step={0.5} disabled={readOnly} value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const number = Number(draft);
          if (draft.trim() && Math.abs(number - value) < .0001) return;
          if (draft.trim() && Number.isFinite(number) && number >= 0 && number <= 1440) setOffset(line.id, number, period, direction);
          else setDraft(String(Number(value.toFixed(4))));
        }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    </label>
    <p className="muted">Takt: {formatTakt(line.takt[period])}. Przesunięcie na pierwszym stanowisku wybranego kierunku,
      względem początku tej pory dnia. Zmiana przesuwa cały rozkład, w obu kierunkach i wszystkich porach.
      {members.length > 1 && ` Razem przesuwają się linie: ${members.map((l) => l.number).join(", ")}.`}</p>
    <details className="fold generated-timetable" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Generowany rozkład jazdy</summary>
      {open && <>
        <label className="field">Dzień rozkładu<select value={day} onChange={(e) => setDay(e.target.value as ServiceDay)}>
          <option value="weekday">Dzień roboczy</option><option value="weekend">Weekend</option>
        </select></label>
        <label className="field">Przystanek rozkładu<select value={selectedStopId} onChange={(e) => setStopId(e.target.value)} disabled={!stopIds.length}>
          {!stopIds.length && <option value="">Brak przystanków</option>}
          {stopIds.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
        </select></label>
        <p className="muted">Cały dzień dla wybranego stanowiska i kierunku. Godziny uwzględniają takty wszystkich pór dnia,
          przesunięcia, koordynację i czas dojazdu do przystanku.</p>
        {!departures.length ? <p className="empty-hint">Brak odjazdów w wybranym dniu i kierunku.</p> : <table className="timetable-table">
          <caption>{nameOf(selectedStopId)} · {day === "weekday" ? "dzień roboczy" : "weekend"}</caption>
          <thead><tr><th>Godzina</th><th>Minuty odjazdów</th></tr></thead>
          <tbody>{hours.map(({ hour, times }) => <tr key={hour}><th scope="row">{String(hour).padStart(2, "0")}</th>
            <td>{times.length ? times.map((time) => <span key={time}>{formatDeparture(time).slice(3)}</span>) : "—"}</td></tr>)}</tbody>
        </table>}
      </>}
    </details>
  </div>;
}
