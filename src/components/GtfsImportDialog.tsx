import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { GtfsNetwork } from "../lib/gtfsNetwork";
import { parseProposal } from "../lib/proposal";

const date = (value: string) => `${value.slice(6,8)}.${value.slice(4,6)}.${value.slice(0,4)}`;
export function GtfsImportDialog({ onClose }: { onClose: () => void }) {
  const [network, setNetwork] = useState<GtfsNetwork | null>(null), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const count = useStore((s) => s.lines.length), importGtfs = useStore((s) => s.importGtfs);
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 240000);
    setNetwork(null); setError("");
    void fetch(`/api/gtfs${attempt ? "?refresh=1" : ""}`, { signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Nie udało się pobrać GTFS.");
      parseProposal({ lines: data.lines, movedStops: data.stops, localStops: [], localTracks: [], constructionOverrides: {} });
      if (!controller.signal.aborted) setNetwork(data);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Błąd importu GTFS.");
      else if (controller.signal.reason?.name === "AbortError") setError("Pobieranie trwa zbyt długo. Spróbuj ponownie."); });
    return () => { clearTimeout(timeout); controller.abort("closed"); };
  }, [attempt]);
  useEffect(() => {
    const previous = document.activeElement;
    modal.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = modal.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length-1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  return <div className="modal-bg" role="presentation" onClick={onClose}>
    <div className="modal gtfs-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="gtfs-title" onClick={(e) => e.stopPropagation()}>
      <h2 id="gtfs-title">Import bieżącego GTFS</h2>
      <p className="lede">Aktualna sieć ZTP Kraków: tramwaje, autobusy MPK i Mobilis. Po imporcie linie, takty, przesunięcia i czasy przejazdu można edytować.</p>
      {!network && !error && <p role="status">Pobieram i przetwarzam GTFS… Pierwsze pobranie może potrwać kilka minut.</p>}
      {network && <>
        <div className="gtfs-summary"><strong>{network.lines.length} linii i wariantów</strong><span>{network.lines.filter((l) => l.mode === "tram").length} tramwajowych · {network.lines.filter((l) => l.mode === "bus").length} autobusowych</span></div>
        <ul className="gtfs-notes">
          <li>Takty zaokrąglone do wartości edytora, przesunięcia co 30 sekund, osobno dla kierunków i pór dnia. Zachowane ramy kursowania, również w nocy.</li>
          <li>Regularne warianty otrzymują sufiksy A, B… Pominięto {network.report.skippedPatterns} rzadkich wariantów i {network.report.skippedTrips} kursów bez użytecznej trasy.</li>
          <li>Obszar projektu ogranicza trasy na granicy Krakowa i okolic. Domyślny tabor: autobus 12 m, tramwaj 33 m.</li>
          {network.report.fallbackSegments > 0 && <li>{network.report.fallbackSegments} odcinków bez poprawnego kształtu trasy połączono bezpośrednio między przystankami.</li>}
        </ul>
        <details className="fold"><summary>Dni i wersje źródłowe</summary>
          <p className="muted">Typowy dzień roboczy i sobota z najbliższych trzech tygodni; weekend jest przybliżony rozkładem sobotnim.</p>
          {network.feeds.map((feed) => <p className="muted" key={feed.id}>{feed.id} · {feed.version}<br />Roboczy: {date(feed.weekday)} · sobota: {date(feed.weekend)}</p>)}
          <p className="muted">Pobrano {new Date(network.at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })} · <a href="https://gtfs.ztp.krakow.pl/" target="_blank" rel="noreferrer">Źródło: ZTP Kraków</a></p>
        </details>
        <p className="lede">Import zastąpi {count} obecnych linii. Przystanki projektu i torowiska zostaną zachowane. Przed zmianą pobierze się kopia JSON obecnego projektu.</p>
      </>}
      {error && <p role="alert" className="err">{error}</p>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose} disabled={busy}>Anuluj</button>
        <button className="ghost" disabled={!network && !error || busy} onClick={() => setAttempt((n) => n+1)}>Sprawdź aktualizacje</button>
        <button className="primary" disabled={!network || busy} onClick={() => {
          if (!network) return; setBusy(true);
          try { importGtfs(network); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Błąd importu."); setBusy(false); }
        }}>{busy ? "Importuję…" : "Zastąp linie i importuj"}</button>
      </div>
    </div>
  </div>;
}
