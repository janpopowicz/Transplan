import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import "../src/index.css";
import { useStore } from "../src/store";
import { roadGraph } from "../src/lib/tramGraph";
import { loadState } from "../src/lib/persist";
import { mergeStopPositions } from "../src/lib/stopEditing";
import { stops, local, express, branch, tracks } from "./render-fixture";

// Use a separate server origin for this editable fixture: it intentionally
// exercises the real save/import actions, unlike the read-only render preview.
const osm = [{ ...stops[0], source: "osm" as const }];
const osmTracks = tracks.map((track) => ({ ...track, source: "osm" as const }));
const saved = loadState();
roadGraph.load(osmTracks);
useStore.setState({ lines: saved?.lines ?? [local, express, branch],
  stops: mergeStopPositions(osm, saved?.localStops ?? stops.slice(1), saved?.movedStops ?? []),
  tracks: osmTracks, tool: "select", selectedLineId: null, selectedStopId: null,
  drawing: null, insertSlot: null,
  osm: { loading: false, error: null, stops: 1, tracks: 0, roads: tracks.length, loadedAt: Date.now() },
});
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
