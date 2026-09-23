import { useEffect } from "react";
import { AddStopDialog, StopPicker } from "./components/Dialogs";
import { DrawWizard } from "./components/DrawWizard";
import { LinePanel } from "./components/LinePanel";
import { MapView } from "./components/MapView";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { StopPanel } from "./components/StopPanel";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";

export default function App() {
  const loadOsm = useStore((s) => s.loadOsm);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const setTool = useStore((s) => s.setTool);

  useEffect(() => {
    void loadOsm();
  }, [loadOsm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)
        return;
      if (e.key === "v" || e.key === "V") setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTool]);

  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <Sidebar />
        <main className="map-wrap">
          <MapView />
          <DrawWizard />
          <StopPicker />
          {selectedStopId && <StopPanel />}
        </main>
        <LinePanel />
      </div>
      <StatusBar />
      <AddStopDialog />
    </div>
  );
}
