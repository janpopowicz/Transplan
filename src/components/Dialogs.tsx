import { useState } from "react";
import { useStore } from "../store";
import type { Mode } from "../types";

export function AddStopDialog() {
  const pending = useStore((s) => s.pendingStop);
  const confirmAddStop = useStore((s) => s.confirmAddStop);
  const cancelAddStop = useStore((s) => s.cancelAddStop);
  const [name, setName] = useState("");
  const [bus, setBus] = useState(true);
  const [tram, setTram] = useState(false);

  if (!pending) return null;

  const modes: Mode[] = [];
  if (bus) modes.push("bus");
  if (tram) modes.push("tram");

  return (
    <div className="modal-bg" onClick={cancelAddStop} role="presentation">
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          confirmAddStop(name, modes.length ? modes : ["bus"]);
          setName("");
          setBus(true);
          setTram(false);
        }}
      >
        <h2>Nowy przystanek</h2>
        <p className="lede">
          Propozycja na warstwie planistycznej. Nie trafia do OpenStreetMap — służy do pokazania
          obsługi ulicy, której OSM jeszcze nie ma.
        </p>
        <label>
          Nazwa
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Os. nowy" />
        </label>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={bus} onChange={(e) => setBus(e.target.checked)} />
            Autobus
          </label>
          <label className="check">
            <input type="checkbox" checked={tram} onChange={(e) => setTram(e.target.checked)} />
            Tramwaj
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={cancelAddStop}>
            Anuluj
          </button>
          <button type="submit" className="primary">
            Dodaj
          </button>
        </div>
      </form>
    </div>
  );
}

export function StopPicker() {
  const picker = useStore((s) => s.stopPicker);
  const setStopPicker = useStore((s) => s.setStopPicker);
  const drawing = useStore((s) => s.drawing);
  const insertSlot = useStore((s) => s.insertSlot);
  const addStopToDrawing = useStore((s) => s.addStopToDrawing);
  const insertStopAtSlot = useStore((s) => s.insertStopAtSlot);
  const selectStop = useStore((s) => s.selectStop);

  if (!picker?.length) return null;

  return (
    <div className="picker">
      <p>Kilka przystanków w tym miejscu — który?</p>
      <ul>
        {picker.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => {
                if (insertSlot) void insertStopAtSlot(s.id);
                else if (drawing) void addStopToDrawing(s.id);
                else selectStop(s.id);
                setStopPicker(null);
              }}
            >
              <strong>{s.name}</strong>
              <span>
                {s.modes.map((m) => (m === "bus" ? "A" : "T")).join("/")} ·{" "}
                {s.source === "local" ? "propozycja" : "OSM"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="ghost compact" onClick={() => setStopPicker(null)}>
        Zamknij
      </button>
    </div>
  );
}
