import { useStore, linesAtStop } from "../store";
import { peakTakt } from "../lib/takt";
import { formatTakt } from "../lib/geo";

export function Sidebar() {
  const lines = useStore((s) => s.lines);
  const selectedLineId = useStore((s) => s.selectedLineId);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectLine = useStore((s) => s.selectLine);
  const toggleLineVisible = useStore((s) => s.toggleLineVisible);
  const deleteLine = useStore((s) => s.deleteLine);

  const trams = lines.filter((l) => l.mode === "tram").sort(byLineNumber);
  const buses = lines.filter((l) => l.mode === "bus").sort(byLineNumber);

  return (
    <aside className="sidebar">
      <section>
        <header className="side-h">
          <h2>Tramwaje</h2>
          <span>{trams.length}</span>
        </header>
        {trams.length === 0 && <p className="empty-hint">Brak linii — użyj narzędzia „Linia tramwajowa”.</p>}
        <ul className="line-list">
          {trams.map((l) => (
            <LineRow
              key={l.id}
              number={l.number}
              name={l.name}
              color={l.color}
              vehicle={l.vehicle}
              takt={formatTakt(peakTakt(l))}
              visible={l.visible}
              active={l.id === selectedLineId}
              onSelect={() => selectLine(l.id)}
              onToggle={() => toggleLineVisible(l.id)}
              onDelete={() => deleteLine(l.id)}
            />
          ))}
        </ul>
      </section>
      <section>
        <header className="side-h">
          <h2>Autobusy</h2>
          <span>{buses.length}</span>
        </header>
        {buses.length === 0 && <p className="empty-hint">Brak linii — użyj narzędzia „Linia autobusowa”.</p>}
        <ul className="line-list">
          {buses.map((l) => (
            <LineRow
              key={l.id}
              number={l.number}
              name={l.name}
              color={l.color}
              vehicle={l.vehicle}
              takt={formatTakt(peakTakt(l))}
              visible={l.visible}
              active={l.id === selectedLineId}
              onSelect={() => selectLine(l.id)}
              onToggle={() => toggleLineVisible(l.id)}
              onDelete={() => deleteLine(l.id)}
            />
          ))}
        </ul>
      </section>
      {selectedStopId && <MiniStop stopId={selectedStopId} />}
    </aside>
  );
}

function LineRow({
  number,
  name,
  color,
  vehicle,
  takt,
  visible,
  active,
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
  onSelect: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
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
        </span>
      </button>
      <button type="button" className="icon-btn" title={visible ? "Ukryj" : "Pokaż"} onClick={onToggle}>
        {visible ? "●" : "○"}
      </button>
      <button type="button" className="icon-btn danger" title="Usuń linię" onClick={onDelete}>
        ×
      </button>
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
