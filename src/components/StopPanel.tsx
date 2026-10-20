import { useStore, linesAtStop } from "../store";

export function StopPanel() {
  const id = useStore((s) => s.selectedStopId);
  const stop = useStore((s) => s.stops.find((x) => x.id === id));
  const allLines = useStore((s) => s.lines);
  const lines = id ? linesAtStop(allLines, id) : [];
  const selectLine = useStore((s) => s.selectLine);
  const removeLineFromStop = useStore((s) => s.removeLineFromStop);
  const deleteLocalStop = useStore((s) => s.deleteLocalStop);
  const setTool = useStore((s) => s.setTool);
  const selectStop = useStore((s) => s.selectStop);

  if (!stop) return null;

  return (
    <div className="stop-sheet">
      <header>
        <div>
          <p className="kicker">Przystanek</p>
          <h2>{stop.name}</h2>
          <p className="muted">
            {(stop.modes ?? []).map((m) => (m === "bus" ? "autobus" : "tramwaj")).join(" · ")}
            {stop.source === "local" ? " · propozycja (warstwa planistyczna, nie OSM)" : " · OSM"}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={() => selectStop(null)} title="Zamknij">
          ×
        </button>
      </header>

      <button type="button" className="ghost" onClick={() => setTool("move-stop")}>Przesuń przystanek</button>

      <h3>Linie na tym przystanku</h3>
      {lines.length === 0 && <p className="empty-hint">Żadna linia tu nie zatrzymuje.</p>}
      <ul className="stop-lines">
        {lines.map((l) => {
          const dirs = [
            l.outboundStopIds.includes(stop.id) ? "tam" : null,
            l.inboundStopIds.includes(stop.id) ? "powrót" : null,
          ]
            .filter(Boolean)
            .join(" + ");
          return (
            <li key={l.id}>
              <button type="button" className="line-chip" onClick={() => selectLine(l.id)}>
                <span className="badge" style={{ background: l.color }}>
                  {l.number}
                </span>
                <span>
                  {l.name || l.mode}
                  <em>{dirs}</em>
                </span>
              </button>
              <button
                type="button"
                className="ghost compact"
                onClick={() => void removeLineFromStop(stop.id, l.id)}
              >
                Zdejmij linię
              </button>
            </li>
          );
        })}
      </ul>

      {stop.source === "local" && (
        <button type="button" className="danger-block" onClick={() => deleteLocalStop(stop.id)}>
          Usuń proponowany przystanek
        </button>
      )}
    </div>
  );
}
