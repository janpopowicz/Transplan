import { useCallback, useId, useRef } from "react";
import { PERIODS, TAKT_OPTIONS } from "../constants";
import type { PeriodId } from "../constants";
import { formatTakt, tripsPerHour } from "../lib/geo";
import { MAX_TRIPS_PER_HOUR, snapTaktFromTrips, tripsPerHourNum } from "../lib/takt";

const Y_TICKS = [
  { trips: 15, label: "15" },
  { trips: 10, label: "10" },
  { trips: 6, label: "6" },
  { trips: 3, label: "3" },
  { trips: 0, label: "0" },
];

export function TaktGrid({
  value,
  color,
  onChange,
}: {
  value: Record<PeriodId, number | null>;
  color?: string;
  onChange: (period: PeriodId, v: number | null) => void;
}) {
  const weekday = PERIODS.filter((p) => p.group === "weekday");
  const weekend = PERIODS.filter((p) => p.group === "weekend");
  const peak = minOf(value.wd_am, value.wd_pm);

  return (
    <div className="takt" style={{ ["--takt-fill" as string]: color ?? "var(--accent)" }}>
      <h3>Takt w ciągu dnia</h3>
      <p className="muted">Wyżej = więcej kursów. Przeciągnij słupki — skaczą po taktach 4–60 min.</p>
      <ProfileBand title="Dzień powszedni" periods={weekday} value={value} onChange={onChange} />
      <ProfileBand title="Weekend" periods={weekend} value={value} onChange={onChange} />
      <p className="takt-foot">
        Szczyt: {formatTakt(peak)} · {tripsPerHour(peak)} kursów/h
      </p>
    </div>
  );
}

function ProfileBand({
  title,
  periods,
  value,
  onChange,
}: {
  title: string;
  periods: readonly (typeof PERIODS)[number][];
  value: Record<PeriodId, number | null>;
  onChange: (period: PeriodId, v: number | null) => void;
}) {
  const dragging = useRef(false);
  const last = useRef<Partial<Record<PeriodId, number | null>>>({});

  const paint = useCallback(
    (clientX: number, clientY: number) => {
      const hit = document.elementFromPoint(clientX, clientY);
      const col = hit?.closest("[data-period]") as HTMLElement | null;
      if (!col) return;
      const track = col.querySelector(".takt-track");
      if (!track) return;
      const id = col.dataset.period as PeriodId;
      const next = taktFromY(clientY, track.getBoundingClientRect());
      if (last.current[id] === next) return;
      last.current[id] = next;
      onChange(id, next);
    },
    [onChange],
  );

  return (
    <div className="takt-band">
      <p className="takt-band-title">{title}</p>
      <div
        className="takt-board"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          paint(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          paint(e.clientX, e.clientY);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <div className="takt-yaxis" aria-hidden>
          <span className="takt-unit">kurs./h</span>
          {Y_TICKS.map((t) => (
            <span key={t.trips} style={{ bottom: `${(t.trips / MAX_TRIPS_PER_HOUR) * 100}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="takt-plot">
          <div className="takt-gridlines" aria-hidden>
            {Y_TICKS.filter((t) => t.trips > 0).map((t) => (
              <i key={t.trips} style={{ bottom: `${(t.trips / MAX_TRIPS_PER_HOUR) * 100}%` }} />
            ))}
          </div>
          {periods.map((p) => (
            <TaktColumn key={p.id} period={p} takt={value[p.id]} onChange={onChange} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TaktColumn({
  period,
  takt,
  onChange,
}: {
  period: (typeof PERIODS)[number];
  takt: number | null;
  onChange: (period: PeriodId, v: number | null) => void;
}) {
  const labelId = useId();
  const trips = tripsPerHourNum(takt);
  const pct = (trips / MAX_TRIPS_PER_HOUR) * 100;
  const peakish = period.id === "wd_am" || period.id === "wd_pm";

  return (
    <div
      className={peakish ? "takt-col peak" : "takt-col"}
      data-period={period.id}
    >
      <div className="takt-readout" id={labelId}>
        <strong>{takt == null ? "brak" : formatTakt(takt)}</strong>
        <span>{takt == null ? "—" : `${tripsPerHour(takt)}/h`}</span>
      </div>
      <div
        className="takt-track"
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-label={`${period.label} ${period.hours}`}
        aria-valuemin={0}
        aria-valuemax={MAX_TRIPS_PER_HOUR}
        aria-valuenow={Math.round(trips * 10) / 10}
        aria-valuetext={
          takt == null ? "brak kursów" : `${formatTakt(takt)}, ${tripsPerHour(takt)} kursów na godzinę`
        }
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Home" && e.key !== "End") return;
          e.preventDefault();
          if (e.key === "Home") {
            onChange(period.id, 4);
            return;
          }
          if (e.key === "End") {
            onChange(period.id, null);
            return;
          }
          onChange(period.id, stepTakt(takt, e.key === "ArrowUp" ? -1 : 1));
        }}
      >
        <div className="takt-bar" style={{ height: `${pct}%` }} />
      </div>
      <div className="takt-lab">
        <strong>{shortHours(period.hours)}</strong>
        <span>{period.short}</span>
      </div>
    </div>
  );
}

function stepTakt(current: number | null, dir: -1 | 1): number | null {
  const ladder: (number | null)[] = [...TAKT_OPTIONS, null];
  const i = ladder.findIndex((x) => x === current);
  const idx = i < 0 ? 0 : i;
  const next = idx + dir;
  if (next < 0) return ladder[0];
  if (next >= ladder.length) return null;
  return ladder[next];
}

function taktFromY(clientY: number, rect: DOMRect): number | null {
  if (rect.height <= 0) return null;
  const t = (rect.bottom - clientY) / rect.height;
  return snapTaktFromTrips(t * MAX_TRIPS_PER_HOUR);
}

function shortHours(hours: string): string {
  return hours.replace(/:00/g, "");
}

function minOf(a: number | null, b: number | null): number | null {
  const xs = [a, b].filter((v): v is number => v != null);
  return xs.length ? Math.min(...xs) : null;
}
