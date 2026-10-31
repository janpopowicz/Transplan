import { useEffect, useState } from "react";
import { AddStopDialog, StopPicker } from "./components/Dialogs";
import { DrawWizard } from "./components/DrawWizard";
import { LinePanel } from "./components/LinePanel";
import { MapView } from "./components/MapView";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { StopPanel } from "./components/StopPanel";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";
import { openSharedNetwork, resolveSharedConflict, startSharedSync, useSharedSession } from "./lib/sharedSession";

export default function App() {
  const loadOsm = useStore((s) => s.loadOsm);
  const hasInspector = useStore((s) => s.lines.some((l) => l.id === s.selectedLineId));
  const movingStop = useStore((s) => s.tool === "move-stop");
  const selectedStopId = useStore((s) => s.selectedStopId);
  const setTool = useStore((s) => s.setTool);
  const [startup, setStartup] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const access = useSharedSession((s) => s.access);
  const syncStatus = useSharedSession((s) => s.status);

  useEffect(() => {
    let active = true;
    void openSharedNetwork().then(() => {
      if (!active) return;
      setStartup("ready");
      void loadOsm();
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "Nie udało się wczytać sieci.");
      setStartup("error");
    });
    return () => { active = false; };
  }, [loadOsm, attempt]);

  useEffect(() => {
    if (startup === "ready" && access) return startSharedSync();
  }, [startup, access]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)
        return;
      if (e.key === "v" || e.key === "V") setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTool]);

  if (startup !== "ready") return (
    <div className="modal-bg">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="network-startup-title">
        <h2 id="network-startup-title">{startup === "loading" ? "Wczytuję sieć…" : "Nie udało się otworzyć sieci"}</h2>
        {startup === "error" && <>
          <p className="err" role="alert">{error}</p>
          <div className="modal-actions">
            <a className="ghost" href={window.location.pathname}>Mój projekt</a>
            <button className="primary" onClick={() => { setStartup("loading"); setAttempt((n) => n + 1); }}>Spróbuj ponownie</button>
          </div>
        </>}
      </div>
    </div>
  );

  return (
    <div className={access && !access.writeToken ? "app read-only" : "app"}>
      <Toolbar />
      {access && <div className="shared-network-note" role="status">
        <span>{access.writeToken ? "Wspólna edycja" : "Podgląd na żywo"} · {syncStatus.message}</span>
        {syncStatus.conflict && <span className="sync-conflict-actions">
          <button className="ghost compact" onClick={() => resolveSharedConflict("remote")}>Przyjmij sporne zmiany z serwera</button>
          <button className="ghost compact" onClick={() => resolveSharedConflict("local")}>Zachowaj moje sporne zmiany</button>
        </span>}
        <a href={window.location.pathname}>Mój lokalny projekt</a>
      </div>}
      <div className={hasInspector ? "workspace" : "workspace without-inspector"}>
        <Sidebar />
        <main className="map-wrap">
          <MapView />
          <DrawWizard />
          <StopPicker />
          {selectedStopId && !movingStop && <StopPanel />}
        </main>
        <LinePanel />
      </div>
      <StatusBar />
      <AddStopDialog />
    </div>
  );
}
