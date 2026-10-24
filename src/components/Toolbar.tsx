import { useRef, useState } from "react";
import { useStore } from "../store";
import { NetworkCost } from "./NetworkCost";
import type { Mode } from "../types";

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const drawing = useStore((s) => s.drawing);
  const loadOsm = useStore((s) => s.loadOsm);
  const osm = useStore((s) => s.osm);
  const setTool = useStore((s) => s.setTool);
  const exportJson = useStore((s) => s.exportJson);
  const importJson = useStore((s) => s.importJson);
  const [dialog, setDialog] = useState<Mode | null>(null);

  const menuRef = useRef<HTMLDetailsElement>(null);
  const lineMenuRef = useRef<HTMLDetailsElement>(null);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <div>
          <h1>Transplan</h1>
          <p>Kraków · planowanie sieci</p>
        </div>
      </div>

      <nav className="tools" aria-label="Narzędzia">
        <ToolBtn active={tool === "select" && !drawing} onClick={() => setTool("select")} label="Wybór" kbd="V" />
        <ToolBtn active={tool === "isochrones"} onClick={() => setTool(tool === "isochrones" ? "select" : "isochrones")} label="Izochrony" />
        <details className="toolbar-menu new-line-menu" ref={lineMenuRef}>
          <summary className={drawing ? "tool on" : "tool"}>Nowa linia ▾</summary>
          <div className="toolbar-popover menu-tools">
            {(["bus", "tram"] as const).map((mode) => (
              <button key={mode} className="tool" onClick={() => {
                setDialog(mode);
                if (lineMenuRef.current) lineMenuRef.current.open = false;
              }}>{mode === "bus" ? "Autobusowa" : "Tramwajowa"}</button>
            ))}
          </div>
        </details>
        <span className="tools-split" aria-hidden />
        <ToolBtn active={tool === "add-stop"} onClick={() => setTool("add-stop")} label="Nowy przystanek" />
        <ToolBtn active={tool === "move-stop"} onClick={() => setTool("move-stop")} label="Przesuń przystanek" />
        <ToolBtn active={tool === "draw-track"} onClick={() => setTool("draw-track")} label="Rysuj torowisko" />
        <ToolBtn active={tool === "toggle-construction"} onClick={() => setTool("toggle-construction")} label="Budowa ↔ ruch" />
      </nav>

      <NetworkCost />
      <details className="toolbar-menu more-tools" ref={menuRef}>
        <summary className="tool" aria-label="Plik i dane projektu">Plik ▾</summary>
        <div className="toolbar-popover">
          <p className="kicker">Dane projektu</p>
          <div className="menu-file-actions">
            <button className="ghost" onClick={() => loadOsm(true)} disabled={osm.loading}>
              {osm.loading ? "Wczytuję OSM…" : "Odśwież OSM"}
            </button>
            <button className="ghost" onClick={() => { exportJson(); if (menuRef.current) menuRef.current.open = false; }}>
              Eksportuj
            </button>
            <label className="ghost file-btn">
              Importuj
              <input
                type="file"
                accept="application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importJson(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      </details>

      {dialog && <NewLineDialog mode={dialog} onClose={() => setDialog(null)} />}
    </header>
  );
}

function ToolBtn({
  active,
  onClick,
  label,
  kbd,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  kbd?: string;
}) {
  return (
    <button className={active ? "tool on" : "tool"} onClick={onClick} type="button" aria-pressed={active}>
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

function NewLineDialog({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const startLine = useStore((s) => s.startLine);
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const title = mode === "bus" ? "Nowa linia autobusowa" : "Nowa linia tramwajowa";

  return (
    <div className="modal-bg" onClick={onClose} role="presentation">
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          startLine(mode, number, name);
          onClose();
        }}
      >
        <h2>{title}</h2>
        <p className="lede">
          Numer linii i nazwa trasy (np. krańcówki). Trasę narysujesz na mapie: najpierw
          krańcówka 1, potem przystanki do krańcówki 2, następnie powrót po drugiej stronie
          jezdni.
        </p>
        <label>
          Numer
          <input
            autoFocus
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder={mode === "tram" ? "np. 52" : "np. 152"}
          />
        </label>
        <label>
          Nazwa (opcjonalnie)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="np. Czerwone Maki — Mistrzejowice"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="primary">
            Rysuj trasę
          </button>
        </div>
      </form>
    </div>
  );
}
