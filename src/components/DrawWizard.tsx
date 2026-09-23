import { useEffect } from "react";
import { haversine } from "../lib/geo";
import { useStore } from "../store";

export function DrawWizard() {
  const drawing = useStore((s) => s.drawing);
  const line = useStore((s) => s.lines.find((l) => l.id === drawing?.lineId));
  const stops = useStore((s) => s.stops);
  const routing = useStore((s) => s.routing);
  const routingError = useStore((s) => s.routingError);
  const markTerminus2 = useStore((s) => s.markTerminus2);
  const finishInbound = useStore((s) => s.finishInbound);
  const undoDrawingStop = useStore((s) => s.undoDrawingStop);
  const cancelDrawing = useStore((s) => s.cancelDrawing);
  const finishTrackDraft = useStore((s) => s.finishTrackDraft);
  const cancelTrackDraft = useStore((s) => s.cancelTrackDraft);
  const insertSlot = useStore((s) => s.insertSlot);
  const cancelInsert = useStore((s) => s.cancelInsert);
  const tool = useStore((s) => s.tool);
  const trackDraft = useStore((s) => s.trackDraft);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (insertSlot) cancelInsert();
        else if (drawing) cancelDrawing();
        else if (trackDraft) cancelTrackDraft();
      }
      if ((e.key === "Backspace" || e.key === "z") && drawing && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        undoDrawingStop();
      }
      if (e.key === "Enter" && drawing?.phase === "outbound") markTerminus2();
      if (e.key === "Enter" && drawing?.phase === "inbound") finishInbound();
      if (e.key === "Enter" && tool === "draw-track") finishTrackDraft();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawing, trackDraft, tool, insertSlot, cancelInsert, cancelDrawing, cancelTrackDraft, undoDrawingStop, markTerminus2, finishInbound, finishTrackDraft]);

  if (tool === "draw-track") {
    return (
      <div className="wizard">
        <div className="wizard-copy">
          <p className="kicker">Torowisko</p>
          <h2>Rysuj nowy tor tramwajowy</h2>
          <p>
            Klikaj kolejne punkty wzdłuż ulicy. Końce przyciągają się do istniejącej sieci.
            Podwójne kliknięcie albo Enter kończy odcinek. To warstwa planistyczna — nic nie
            zapisuje się w OSM.
          </p>
        </div>
        <div className="wizard-actions">
          <button type="button" className="ghost" onClick={cancelTrackDraft}>
            Anuluj
          </button>
          <button
            type="button"
            className="primary"
            disabled={!trackDraft || trackDraft.vertices.length < 2}
            onClick={finishTrackDraft}
          >
            Zakończ tor ({trackDraft?.vertices.length ?? 0} pkt)
          </button>
        </div>
      </div>
    );
  }

  if (tool === "add-stop") {
    return (
      <div className="wizard">
        <div className="wizard-copy">
          <p className="kicker">Przystanek</p>
          <h2>Kliknij mapę, aby dodać przystanek</h2>
          <p>
            Na ulicach bez oznaczenia w OSM możesz zaproponować nowy słupek. Zostanie tylko w
            tym wariancie sieci.
          </p>
        </div>
      </div>
    );
  }

  if (tool === "toggle-construction") {
    return (
      <div className="wizard">
        <div className="wizard-copy">
          <p className="kicker">Sieć</p>
          <h2>Budowa ↔ ruch</h2>
          <p>
            Kliknij drogę albo torowisko, żeby przełączyć: pomarańczowa kreska to budowa (bez
            kursów), ciągła linia to ruch. Kliknij jeszcze raz, aby wrócić. Autobusy i tramwaje
            omijają odcinki w budowie.
          </p>
        </div>
      </div>
    );
  }

  if (insertSlot) {
    const host = useStore.getState().lines.find((l) => l.id === insertSlot.lineId);
    const ids = insertSlot.direction === "outbound" ? host?.outboundStopIds : host?.inboundStopIds;
    const a = ids?.[insertSlot.afterIndex];
    const b = ids?.[insertSlot.afterIndex + 1];
    return (
      <div className="wizard">
        <div className="wizard-copy">
          <p className="kicker">Wstawianie przystanku</p>
          <h2>Kliknij przystanek na mapie</h2>
          <p>
            Wstawisz go między{" "}
            <strong>{a ? stops.find((s) => s.id === a)?.name : "?"}</strong> a{" "}
            <strong>{b ? stops.find((s) => s.id === b)?.name : "?"}</strong>. Trasa między nimi
            przeliczy się sama.
          </p>
          {routing && <p className="live">Wyznaczam trasę OSM…</p>}
          {routingError && <p className="err">{routingError}</p>}
        </div>
        <div className="wizard-actions">
          <button type="button" className="ghost" onClick={cancelInsert}>
            Anuluj
          </button>
        </div>
      </div>
    );
  }

  if (!drawing || !line) return null;

  const step =
    drawing.phase === "terminus1" ? 1 : drawing.phase === "outbound" ? 2 : 3;
  const lastOut = line.outboundStopIds[line.outboundStopIds.length - 1];
  const lastIn = line.inboundStopIds[line.inboundStopIds.length - 1];
  const t1 = line.terminus1Id ? stops.find((s) => s.id === line.terminus1Id) : null;
  const lastInStop = lastIn ? stops.find((s) => s.id === lastIn) : null;
  const nearHome =
    drawing.phase === "inbound" &&
    t1 &&
    lastInStop &&
    haversine([t1.lon, t1.lat], [lastInStop.lon, lastInStop.lat]) < 120;

  const titles = [
    "Wskaż krańcówkę początkową",
    "Jedź do krańcówki 2 — klikaj przystanki po kolei",
    "Wracaj po przeciwnej stronie jezdni",
  ];
  const texts = [
    "Kliknij pierwszy przystanek (krańcówkę). Silnik OSM poprowadzi dalej drogą / torowiskiem.",
    "Klikaj kolejne słupki w kierunku drugiej krańcówki. Pomarańczowa obwódka podpowiada przystanek o tej samej nazwie po drugiej stronie. Gdy dotrzesz na koniec, oznacz krańcówkę 2.",
    "Wybieraj przystanki po przeciwnej stronie ulicy, aż wrócisz w okolice krańcówki 1. Interlining wielu linii układa się sam — grubsza kreska to dłuższy tabor.",
  ];

  return (
    <div className="wizard">
      <div className="steps" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span key={n} className={n === step ? "step on" : n < step ? "step done" : "step"}>
            {n}
          </span>
        ))}
      </div>
      <div className="wizard-copy">
        <p className="kicker">
          {line.mode === "bus" ? "Autobus" : "Tramwaj"} {line.number} · krok {step} z 3
        </p>
        <h2>{titles[step - 1]}</h2>
        <p>{texts[step - 1]}</p>
        {routing && <p className="live">Wyznaczam trasę OSM…</p>}
        {routingError && <p className="err">{routingError}</p>}
        {drawing.phase === "outbound" && lastOut && (
          <p className="muted">Ostatni: {stops.find((s) => s.id === lastOut)?.name}</p>
        )}
        {nearHome && <p className="ok">Jesteś przy krańcówce 1 — możesz zakończyć linię.</p>}
      </div>
      <div className="wizard-actions">
        <button type="button" className="ghost" onClick={cancelDrawing}>
          Anuluj
        </button>
        <button type="button" className="ghost" onClick={undoDrawingStop} disabled={routing}>
          Cofnij przystanek
        </button>
        {drawing.phase === "outbound" && (
          <button
            type="button"
            className="primary"
            disabled={line.outboundStopIds.length < 2 || routing}
            onClick={markTerminus2}
          >
            To jest krańcówka 2
          </button>
        )}
        {drawing.phase === "inbound" && (
          <button
            type="button"
            className="primary"
            disabled={line.inboundStopIds.length < 1 || routing}
            onClick={finishInbound}
          >
            Zakończ linię
          </button>
        )}
      </div>
    </div>
  );
}
