import { useCallback, useId, useRef } from "react";
import { PERIODS } from "../constants";
import type { PeriodId } from "../constants";
import { formatTakt, tripsPerHour } from "../lib/geo";
import { TAKT_STEPS, taktFromPosition, taktStepIndex } from "../lib/takt";


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
      <p className="muted">Przeciągnij słupki. Każdy takt ma równy odstęp; wyżej = częściej.</p>
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
          last.current = {};
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
          <span className="takt-unit">min</span>
          {TAKT_STEPS.map((t, index) => (
            <span key={index} style={{ bottom: `${index / (TAKT_STEPS.length - 1) * 100}%` }}>
              {t == null ? "—" : String(t).replace(".", ",")}
            </span>
          ))}
        </div>
        <div className="takt-plot">
          <div className="takt-gridlines" aria-hidden>
            {TAKT_STEPS.map((_, index) => (
              <i key={index} style={{ bottom: `${index / (TAKT_STEPS.length - 1) * 100}%` }} />
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
  const index = taktStepIndex(takt);
  const pct = index / (TAKT_STEPS.length - 1) * 100;
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
        aria-label={`${period.label} ${period.hours}`}
        aria-valuemin={0}
        aria-valuemax={TAKT_STEPS.length - 1}
        aria-valuenow={index}
        aria-valuetext={
          takt == null ? "brak kursów" : `${formatTakt(takt)}, ${tripsPerHour(takt)} kursów na godzinę`
        }
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Home" && e.key !== "End") return;
          e.preventDefault();
          if (e.key === "Home") {
            onChange(period.id, null);
            return;
          }
          if (e.key === "End") {
            onChange(period.id, TAKT_STEPS.at(-1)!);
            return;
          }
          onChange(period.id, TAKT_STEPS[Math.max(0, Math.min(TAKT_STEPS.length - 1, index + (e.key === "ArrowUp" ? 1 : -1)))]);
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

function taktFromY(clientY: number, rect: DOMRect): number | null {
  if (rect.height <= 0) return null;
  const t = (rect.bottom - clientY) / rect.height;
  return taktFromPosition(t);
}

function shortHours(hours: string): string {
  return hours.replace(/:00/g, "");
}

function minOf(a: number | null, b: number | null): number | null {
  const xs = [a, b].filter((v): v is number => v != null);
  return xs.length ? Math.min(...xs) : null;
}
