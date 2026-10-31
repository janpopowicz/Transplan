import { useEffect, useId, useState } from "react";
import { clockMinutes, clockString } from "../lib/journeyTime";

export function JourneyTimePicker({ value, onChange, onNow, onReady }: { value: string; onChange: (time: string) => void; onNow: () => string; onReady: (ready: boolean) => void }) {
  const id = useId(), [draft, setDraft] = useState(value), [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(value); setInvalid(false); onReady(true); }, [value, onReady]);
  const minutes = clockMinutes(value) ?? 480;
  const choose = (time: string) => { setDraft(time); setInvalid(false); onReady(true); onChange(time); };
  const updateDraft = (text: string) => {
    setDraft(text); setInvalid(false);
    const parsed = clockMinutes(text);
    const ready = parsed !== null && (/^\d{1,2}:\d{2}$/.test(text) || /^\d{3,4}$/.test(text));
    onReady(ready);
    if (ready) onChange(clockString(parsed!));
  };
  const commit = () => {
    const parsed = clockMinutes(draft);
    if (parsed === null) { setInvalid(true); onReady(false); return; }
    const time = clockString(parsed); onReady(true); setDraft(time); onChange(time);
  };
  return <div className="journey-time-picker">
    <div className="journey-time-heading"><label htmlFor={id}>Godzina odjazdu</label><button type="button" className="ghost compact" onClick={() => choose(onNow())}>Teraz</button></div>
    <div className="journey-time-buttons">
      {[-15, -5].map((delta) => <button type="button" className="ghost compact" key={delta} aria-label={`${-delta} minut wcześniej`}
        onClick={() => choose(clockString(minutes + delta))}>−{-delta}</button>)}
      <input id={id} type="text" inputMode="numeric" value={draft} aria-invalid={invalid} maxLength={5} placeholder="HH:MM"
        onInput={(e) => updateDraft(e.currentTarget.value)} onChange={(e) => updateDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); e.currentTarget.blur(); } }} />
      {[5, 15].map((delta) => <button type="button" className="ghost compact" key={delta} aria-label={`${delta} minut później`}
        onClick={() => choose(clockString(minutes + delta))}>+{delta}</button>)}
    </div>
    <input type="range" min={0} max={1439} step={1} value={minutes} aria-label="Godzina odjazdu na osi dnia" aria-valuetext={value}
      onInput={(e) => choose(clockString(Number(e.currentTarget.value)))} onChange={(e) => choose(clockString(Number(e.target.value)))} />
    <div className="journey-time-axis" aria-hidden="true"><span>00:00</span><span>12:00</span><span>23:59</span></div>
    {invalid && <p className="err">Wpisz godzinę od 00:00 do 23:59, np. 8:30 lub 0830.</p>}
  </div>;
}
