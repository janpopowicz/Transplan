import { useMemo, useState } from "react";
import { PERIODS, type PeriodId } from "../constants";
import { useStore } from "../store";
import { compatibleHeadways, coordinationEdges, coordinationMembers, coordinationPlan, findSharedSections, nextDeparture } from "../lib/timetable";
import type { TransitLine } from "../types";

export function CoordinationPanel({ line }: { line: TransitLine }) {
  const [period, setPeriod] = useState<PeriodId>("wd_am");
  const [previewOpen, setPreviewOpen] = useState(false);
  const lines = useStore((s) => s.lines), stops = useStore((s) => s.stops);
  const coordinate = useStore((s) => s.coordinateLines), uncoordinate = useStore((s) => s.uncoordinateLine);
  const partners = useMemo(() => {
    const linked = coordinationEdges(lines).flatMap(({ a, b }) => a === line.id ? [b] : b === line.id ? [a] : []);
    return lines.filter((l) => linked.includes(l.id));
  }, [lines, line.id]);
  const candidates = useMemo(() => lines.filter((l) => l.id !== line.id && !partners.some((p) => p.id === l.id))
    .map((other) => ({ other, available: findSharedSections([line, other]).length > 0 })), [lines, line, partners]);
  const members = coordinationMembers(lines, line);
  const nameOf = (id: string) => stops.find((s) => s.id === id)?.name ?? id;
  return <section className="coordination-panel" aria-label="Koordynacja linii">
    <h3>Koordynacja linii</h3>
    <p className="muted">Każda para ma własny najdłuższy wspólny odcinek, osobno w obu kierunkach.
      Równe takty lub ich wielokrotności pozwalają przeplatać odjazdy.</p>
    {members.length > 1 && <><div className="coordination-members">{members.map((m) => <span className="badge" key={m.id}
      style={{ background: m.color }}>{m.number}</span>)}</div>
      <p className="muted">Zmiana przesunięcia w sekcji taktów przesuwa wszystkie te linie razem.</p></>}
    {partners.map((other) => {
      const sections = findSharedSections([line, other]);
      return <div className="coordination-pair" key={other.id}>
        <header><strong>{line.number} ↔ {other.number}</strong><button type="button" className="ghost compact"
          onClick={() => uncoordinate(line.id, other.id)}>Odłącz od linii {other.number}</button></header>
        {sections.length ? <ul className="coordination-sections">{sections.map((section, i) => <li key={i}>
          <strong>{nameOf(section.stops[0])} → {nameOf(section.stops.at(-1)!)}</strong>
          <span>{section.stops.length} wspólnych stanowisk</span>
        </li>)}</ul> : <p className="err">Po zmianie tras brakuje wspólnego odcinka. Ta relacja jest nieaktywna.</p>}
      </div>;
    })}
    {partners.length > 0 && <details className="coordination-periods" onToggle={(e) => setPreviewOpen(e.currentTarget.open)}>
      <summary>Odstępy na wspólnych odcinkach</summary>
      {previewOpen && <>
        <label className="field">Pora koordynacji<select value={period} onChange={(e) => setPeriod(e.target.value as PeriodId)}>
          {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select></label>
        <CoordinationPreview lines={lines} line={line} partners={partners} period={period} />
      </>}
    </details>}
    <label className="field">Koordynuj z linią<select value="" onChange={(e) => { if (e.target.value) coordinate(line.id, e.target.value); }}>
      <option value="">Wybierz linię…</option>
      {candidates.sort((a, b) => a.other.number.localeCompare(b.other.number, "pl", { numeric: true })).map(({ other, available }) =>
        <option value={other.id} key={other.id} disabled={!available}>{other.number} · {other.name || "Bez nazwy"}{!available ? " — brak wspólnego odcinka" : ""}</option>)}
    </select></label>
  </section>;
}

function CoordinationPreview({ lines, line, partners, period }: { lines: TransitLine[]; line: TransitLine; partners: TransitLine[]; period: PeriodId }) {
  const plan = useMemo(() => coordinationPlan(lines, period), [lines, period]);
  const format = (n: number) => Number(n.toFixed(2)).toString().replace(".", ",");
  return <>{partners.map((other) => {
    const ta = line.takt[period], tb = other.takt[period];
    const issue = plan.issues.find((i) => (i.a === line.id && i.b === other.id) || (i.b === line.id && i.a === other.id));
    return <div key={other.id}><strong>{line.number} ↔ {other.number}</strong>
      {ta == null || tb == null ? <p className="muted">Jedna z linii nie kursuje w tej porze.</p>
        : !compatibleHeadways(ta, tb) ? <p className="muted">Takty nie są swoimi wielokrotnościami — w tej porze bez koordynacji.</p>
        : <>{issue?.kind === "conflict" && <p className="err">Relacje w tej sieci są sprzeczne. Przeplot jest przybliżony.</p>}
          {findSharedSections([line, other]).map((section, i) => {
            const departures: number[] = [];
            section.runs.forEach((route, index) => {
              const run = plan.runs.find((r) => r.lineId === route.lineId && r.direction === route.direction && r.stops.join("\0") === route.stops.join("\0"));
              if (!run) return;
              const phase = run.phase + run.elapsed[section.starts[index]];
              for (let t = nextDeparture(0, phase, run.headway); t <= 120 + run.headway; t += run.headway) departures.push(t);
            });
            departures.sort((a, b) => a - b);
            const gaps = departures.slice(1).flatMap((t, index) => departures[index] < 120 ? [t - departures[index]] : []);
            const min = Math.min(...gaps), max = Math.max(...gaps);
            return <p key={i}><span>Kierunek {i + 1}</span><strong>{gaps.length ? `${format(min)}${max - min > .001 ? `–${format(max)}` : ""} min` : "brak odjazdów"}</strong></p>;
          })}</>}
    </div>;
  })}<p className="muted">Odstępy na początku wspólnego odcinka. Dalej zależą też od czasów jazdy.</p></>;
}
