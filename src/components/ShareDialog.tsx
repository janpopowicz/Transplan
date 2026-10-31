import { useEffect, useRef, useState } from "react";
import { ensureSharedNetwork } from "../lib/sharedSession";
import type { SharedLinks } from "../lib/sharing";

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const [links, setLinks] = useState<SharedLinks | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<Promise<SharedLinks> | null>(null);
  const modal = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    request.current ??= ensureSharedNetwork();
    void request.current.then((result) => { if (active) setLinks(result); }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Nie udało się udostępnić sieci.");
    });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    const previous = document.activeElement;
    modal.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = modal.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);

  return <div className="modal-bg" onClick={onClose} role="presentation">
    <div className="modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={(e) => e.stopPropagation()}>
      <h2 id="share-title">Udostępnij sieć</h2>
      <p className="lede">Bez kont. Podgląd pokazuje zmiany na bieżąco. Link do edycji pozwala wspólnie zmieniać tę samą sieć.
        Zmiany zapisują się automatycznie.</p>
      {!links && !error && <p role="status">Zapisuję sieć i tworzę linki…</p>}
      {links && ([{ title: "Podgląd na żywo", link: links.read }, { title: "Wspólna edycja", link: links.write }]).filter((item) => item.link).map((item) =>
        <div key={item.title} className="share-link-field"><label>{item.title}
          <input readOnly value={item.link} onFocus={(e) => e.target.select()} onClick={(e) => e.currentTarget.select()} />
          </label>
          <button className="ghost compact" onClick={async (event) => {
            const field = event.currentTarget.parentElement?.querySelector("input");
            try { await navigator.clipboard.writeText(item.link); setCopied(true); setError(""); }
            catch {
              field?.focus(); field?.select();
              setError("Skopiuj zaznaczony link ręcznie (Ctrl+C / ⌘C).");
            }
          }}>Kopiuj link: {item.title.toLowerCase()}</button>
        </div>)}
      {links?.write && <p className="lede">Link do edycji przekazuj tylko osobom, którym pozwalasz zmieniać sieć.</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {copied && <p className="ok" role="status">Link skopiowany.</p>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Zamknij</button>
        {error && !links && <button className="primary" onClick={() => {
          request.current = null; setError(""); setAttempt((n) => n + 1);
        }}>Spróbuj ponownie</button>}
      </div>
    </div>
  </div>;
}
