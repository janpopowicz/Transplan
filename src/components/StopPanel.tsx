import { useEffect, useState } from "react";
import { StopGroupSuggestions } from "./StopGroupSuggestions";
import { useStore, linesAtStop } from "../store";
import type { Mode, Stop } from "../types";

export function StopPanel() {
  const readOnly = useStore((s) => s.access === "read");
  const joinStopGroup = useStore((s) => s.joinStopGroup);
  const id = useStore((s) => s.selectedStopId);
  const stop = useStore((s) => s.stops.find((x) => x.id === id));
  const allLines = useStore((s) => s.lines);
  const lines = id ? linesAtStop(allLines, id) : [];
  const selectLine = useStore((s) => s.selectLine);
  const removeLineFromStop = useStore((s) => s.removeLineFromStop);
  const deleteLocalStop = useStore((s) => s.deleteLocalStop);
  const setTool = useStore((s) => s.setTool);
  const selectStop = useStore((s) => s.selectStop);
  const routing = useStore((s) => s.routing);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [id]);

  if (!stop) return null;

  return (
    <div className="stop-sheet">
      <header>
        <div>
          <p className="kicker">Przystanek</p>
          <h2>{stop.name}</h2>
          <p className="muted">
            {(stop.modes ?? []).map((m) => (m === "bus" ? "autobus" : "tramwaj")).join(" · ")}
            {stop.source === "local" ? " · propozycja" : stop.source === "gtfs" ? " · GTFS ZTP" : " · OSM"}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={() => selectStop(null)} title="Zamknij">
          ×
        </button>
      </header>

      {!readOnly && <>
        <div className="stop-edit-actions">
          <button type="button" className="ghost" disabled={routing} onClick={() => setTool("move-stop")}>Przesuń przystanek</button>
          <button type="button" className="ghost" disabled={routing} onClick={() => setEditing(!editing)}
            aria-expanded={editing}>Edytuj nazwę i typ</button>
        </div>
        {editing && <StopDetailsEditor key={stop.id} stop={stop} onClose={() => setEditing(false)} />}
      </>}

      {!readOnly && <StopGroupSuggestions lon={stop.lon} lat={stop.lat} stopId={stop.id}
        onChoose={(nearbyId) => joinStopGroup(stop.id, nearbyId)} />}
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
              {!readOnly && <button
                type="button"
                className="ghost compact"
                onClick={() => void removeLineFromStop(stop.id, l.id)}
              >
                Zdejmij linię
              </button>}
            </li>
          );
        })}
      </ul>

      {!readOnly && stop.source === "local" && (
        <button type="button" className="danger-block" onClick={() => deleteLocalStop(stop.id)}>
          Usuń proponowany przystanek
        </button>
      )}
    </div>
  );
}

function StopDetailsEditor({ stop, onClose }: { stop: Stop; onClose: () => void }) {
  const updateStop = useStore((s) => s.updateStop);
  const routing = useStore((s) => s.routing);
  const [name, setName] = useState(stop.name);
  const [type, setType] = useState(stop.modes.length === 2 ? "both" : stop.modes[0]);
  const [error, setError] = useState("");
  return <form className="stop-details-editor" aria-label="Edycja przystanku" onSubmit={(event) => {
    event.preventDefault();
    const modes: Mode[] = type === "both" ? ["bus", "tram"] : [type as Mode];
    if (updateStop(stop.id, name, modes)) onClose();
    else setError("Podaj nazwę i wybierz rodzaj przystanku. Spróbuj ponownie po zakończeniu obliczania trasy.");
  }}>
    <label className="field">Nazwa przystanku
      <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={10000} />
    </label>
    <label className="field">Rodzaj przystanku
      <select value={type} onChange={(event) => setType(event.target.value)}>
        <option value="bus">Autobus</option><option value="tram">Tramwaj</option><option value="both">Autobus + tramwaj</option>
      </select>
    </label>
    <div className="stop-edit-actions">
      <button type="submit" className="primary" disabled={routing || !name.trim()}>Zapisz zmiany</button>
      <button type="button" className="ghost" onClick={onClose}>Anuluj</button>
    </div>
    {error && <p role="alert" className="err">{error}</p>}
  </form>;
}
