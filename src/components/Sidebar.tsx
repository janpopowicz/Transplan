import { useState } from "react";
import type { TransitLine } from "../types";
import { useStore, linesAtStop } from "../store";
import { coordinationEdges } from "../lib/timetable";
import { peakTakt } from "../lib/takt";
import { formatTakt } from "../lib/geo";

export function Sidebar() {
  const [query, setQuery] = useState("");
  const lines = useStore((s) => s.lines);
  const selectedLineId = useStore((s) => s.selectedLineId);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectLine = useStore((s) => s.selectLine);
  const toggleLineVisible = useStore((s) => s.toggleLineVisible);
  const setModeVisible = useStore((s) => s.setModeVisible);
  const readOnly = useStore((s) => s.access === "read");
  const tramsVisible = lines.some((l) => l.mode === "tram" && l.visible);
  const busesVisible = lines.some((l) => l.mode === "bus" && l.visible);
  const deleteLine = useStore((s) => s.deleteLine);

  const matching = lines.filter((l) => `${l.number} ${l.name}`.toLocaleLowerCase("pl").includes(query.trim().toLocaleLowerCase("pl")));
  const trams = matching.filter((l) => l.mode === "tram").sort(byLineNumber);
  const buses = matching.filter((l) => l.mode === "bus").sort(byLineNumber);

  return (
    <aside className="sidebar">
      {lines.length > 15 && <div className="line-search" role="search" aria-label="Wyszukiwanie linii">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        <input type="search" aria-label="Filtruj linie" placeholder="Szukaj numeru lub nazwy…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button className="icon-btn" type="button" aria-label="Wyczyść wyszukiwanie linii" onClick={() => setQuery("")}>×</button>}
      </div>}
      {query && !matching.length && <p className="empty-hint">Brak linii pasujących do wyszukiwania.</p>}
      <section>
        <header className="side-h">
          <div className="category-title"><h2>Tramwaje</h2><span>{trams.length}</span></div>
          <button type="button" className="icon-btn" disabled={readOnly || !lines.some((l) => l.mode === "tram")}
            aria-label={`${tramsVisible ? "Ukryj" : "Pokaż"} wszystkie linie tramwajowe`} title={`${tramsVisible ? "Ukryj" : "Pokaż"} wszystkie linie tramwajowe`}
            onClick={() => setModeVisible("tram",!tramsVisible)}>{tramsVisible ? "●" : "○"}</button>
          {!readOnly && <span aria-hidden="true" />}
        </header>
        {trams.length === 0 && !query && <p className="empty-hint">Brak linii — użyj narzędzia „Linia tramwajowa”.</p>}
        <LineList items={trams} allLines={lines} selectedLineId={selectedLineId} onSelect={selectLine} onToggle={toggleLineVisible} onDelete={deleteLine} />
      </section>
      <section>
        <header className="side-h">
          <div className="category-title"><h2>Autobusy</h2><span>{buses.length}</span></div>
          <button type="button" className="icon-btn" disabled={readOnly || !lines.some((l) => l.mode === "bus")}
            aria-label={`${busesVisible ? "Ukryj" : "Pokaż"} wszystkie linie autobusowe`} title={`${busesVisible ? "Ukryj" : "Pokaż"} wszystkie linie autobusowe`}
            onClick={() => setModeVisible("bus",!busesVisible)}>{busesVisible ? "●" : "○"}</button>
          {!readOnly && <span aria-hidden="true" />}
        </header>
        {buses.length === 0 && !query && <p className="empty-hint">Brak linii — użyj narzędzia „Linia autobusowa”.</p>}
        <LineList items={buses} allLines={lines} selectedLineId={selectedLineId} onSelect={selectLine} onToggle={toggleLineVisible} onDelete={deleteLine} />
      </section>
      {selectedStopId && <MiniStop stopId={selectedStopId} />}
    </aside>
  );
}

function LineList({ items, allLines, selectedLineId, onSelect, onToggle, onDelete }: {
  items: TransitLine[]; allLines: TransitLine[]; selectedLineId: string | null;
  onSelect: (id: string) => void; onToggle: (id: string) => void; onDelete: (id: string) => void;
}) {
  const pairs = coordinationEdges(allLines).filter(({ a, b }) => items.some((l) => l.id === a || l.id === b));
  const width = pairs.length ? 12 + pairs.length * 8 : 0;
  return <div className="line-tree" style={{ paddingLeft: width }}>
    {pairs.length > 0 && <svg className="coordination-tree" width={width} height={items.length * 64} aria-hidden="true">
      {pairs.map(({ a, b }, lane) => {
        const rows = items.flatMap((line, i) => line.id === a || line.id === b ? [i] : []);
        const x = 4 + lane * 8, top = rows[0] * 64 + 30, bottom = rows.at(-1)! * 64 + 30;
        const color = allLines.find((line) => line.id === a)!.color;
        return <g key={JSON.stringify([a, b])} stroke={color} fill={color} strokeWidth="2">
          <path d={`M ${width} ${top} H ${x} V ${bottom}`} fill="none" />
          {rows.map((row) => <g key={row}><path d={`M ${x} ${row * 64 + 30} H ${width - 3}`} />
            <circle cx={x} cy={row * 64 + 30} r="3" /><path d={`M ${width - 5} ${row * 64 + 27} l 3 3 l -3 3`} fill="none" /></g>)}
        </g>;
      })}
    </svg>}
    <ul className="line-list">{items.map((line) => <LineRow key={line.id} number={line.number} name={line.name}
      color={line.color} vehicle={line.vehicle} takt={formatTakt(peakTakt(line))} visible={line.visible}
      active={line.id === selectedLineId} onSelect={() => onSelect(line.id)} onToggle={() => onToggle(line.id)}
      onDelete={() => onDelete(line.id)} coordinatedWith={pairs.flatMap(({ a, b }) => a === line.id ? [b] : b === line.id ? [a] : [])
        .map((id) => allLines.find((l) => l.id === id)!).sort(byLineNumber).map((l) => l.number).join(" · ")} />)}</ul>
  </div>;
}

function LineRow({
  number,
  name,
  color,
  vehicle,
  takt,
  visible,
  active,
  coordinatedWith,
  onSelect,
  onToggle,
  onDelete,
}: {
  number: string;
  name: string;
  color: string;
  vehicle: string;
  takt: string;
  visible: boolean;
  active: boolean;
  coordinatedWith: string;
  onSelect: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const readOnly = useStore((s) => s.access === "read");
  return (
    <li className={active ? "line-row on" : "line-row"}>
      <button type="button" className="line-main" onClick={onSelect}>
        <span className="badge" style={{ background: color }}>
          {number}
        </span>
        <span className="line-meta">
          <strong>{name || "Bez nazwy"}</strong>
          <em>
            {vehicle} · szczyt {takt}
          </em>
          {coordinatedWith && <small className="coordination-link" title={`Skoordynowana z: ${coordinatedWith}`}>↳ {coordinatedWith}</small>}
        </span>
      </button>
      <button type="button" className="icon-btn" disabled={readOnly} title={visible ? "Ukryj" : "Pokaż"} onClick={onToggle}>
        {visible ? "●" : "○"}
      </button>
      {!readOnly && <button type="button" className="icon-btn danger" title="Usuń linię" onClick={onDelete}>
        ×
      </button>}
    </li>
  );
}

function byLineNumber(a: { number: string }, b: { number: string }): number {
  const pa = parseLineNumber(a.number);
  const pb = parseLineNumber(b.number);
  if (pa.n !== pb.n) return pa.n - pb.n;
  const suf = pa.suffix.localeCompare(pb.suffix, "pl", { numeric: true, sensitivity: "base" });
  if (suf !== 0) return suf;
  const pre = pa.prefix.localeCompare(pb.prefix, "pl", { sensitivity: "base" });
  if (pre !== 0) return pre;
  return a.number.localeCompare(b.number, "pl", { sensitivity: "base" });
}

function parseLineNumber(raw: string): { prefix: string; n: number; suffix: string } {
  const s = raw.trim();
  const m = s.match(/^([^0-9]*?)(\d+(?:[.,]\d+)?)(.*)$/);
  if (!m) return { prefix: s, n: Number.POSITIVE_INFINITY, suffix: "" };
  return {
    prefix: m[1].trim(),
    n: Number(m[2].replace(",", ".")),
    suffix: m[3].trim(),
  };
}

function MiniStop({ stopId }: { stopId: string }) {
  const stop = useStore((s) => s.stops.find((x) => x.id === stopId));
  const allLines = useStore((s) => s.lines);
  const lines = linesAtStop(allLines, stopId);
  if (!stop) return null;
  return (
    <section className="mini-stop">
      <h2>Przystanek</h2>
      <p>
        <strong>{stop.name}</strong>
        {stop.source === "local" && <span className="tag">propozycja</span>}
      </p>
      <p className="muted">
        {lines.length ? [...lines].sort(byLineNumber).map((l) => l.number).join(" · ") : "żadna linia"}
      </p>
    </section>
  );
}
