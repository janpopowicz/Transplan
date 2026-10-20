import React from "react";
import { createRoot } from "react-dom/client";
import { MapView } from "../src/components/MapView";
import { useStore } from "../src/store";
import { roadGraph } from "../src/lib/tramGraph";
import { buildRenderSegments } from "../src/lib/interline";
import { stops, local, express, branch, tracks } from "./render-fixture";
roadGraph.load(tracks);
useStore.setState({ lines: [local, express, branch], stops, tracks: [], tool: "select",
  selectedLineId: null, selectedStopId: null, drawing: null, insertSlot: null });
function Preview() {
  const selected = useStore((s) => s.selectedLineId);
  const drawing = useStore((s) => s.drawing);
  const detailed = Boolean(selected || drawing);
  const result = buildRenderSegments([local, express, branch], { collapseDirections: !detailed, stops });
  return <>
    <style>{`body{font:14px system-ui;color:#1a1714;background:#f6f1e8} header{padding:12px;display:flex;gap:16px;align-items:center;background:#f6f1e8}button{padding:8px}main{position:absolute;inset:100px 0 0}.map{position:absolute;inset:0}`}</style>
    <header><button onClick={() => useStore.setState({ selectedLineId: null, drawing: null })}>Widok sieci</button>
      <button onClick={() => useStore.getState().selectLine("100")}>Edytuj linię 100</button>
      <button onClick={() => useStore.setState({ selectedLineId: null, drawing: { lineId: "500", mode: "bus", phase: "outbound" } })}>Tworzenie linii</button>
      <output>{detailed ? "Przystanki i kierunki osobno" : "Grupy i wspólne odcinki"} · {result.length} odcinków · {result.filter((r) => r.oneWay).length} strzałki</output>
    </header>
    <div style={{ padding: "0 12px" }}>100 czerwona: wszystkie przystanki · 500 niebieska: ekspres Alpha–Delta · 200 zielona: wspólny odcinek i pętla jednokierunkowa</div>
    <main><MapView /></main>
  </>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
