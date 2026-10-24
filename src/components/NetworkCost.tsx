import { useMemo, useState } from "react";
import { dailyNetworkCost, formatMoney, type ServiceDay } from "../lib/costs";
import { useStore } from "../store";

export function NetworkCost() {
  const lines = useStore((s) => s.lines);
  const [day, setDay] = useState<ServiceDay>("weekday");
  const total = useMemo(() => dailyNetworkCost(lines, day), [lines, day]);
  return <details className="toolbar-menu network-cost">
    <summary title="Szacowany dzienny koszt kursowania sieci">
      <span>Koszt / {day === "weekday" ? "dzień roboczy" : "dzień weekendu"}</span>
      <strong>{formatMoney(total.cost)}</strong>
    </summary>
    <div className="toolbar-popover cost-popover">
      <label className="field">Dzień kursowania
        <select value={day} onChange={(e) => setDay(e.target.value as ServiceDay)}>
          <option value="weekday">Dzień roboczy</option><option value="weekend">Weekend</option>
        </select>
      </label>
      <dl className="cost-breakdown">
        <dt>Autobusy</dt><dd>{formatMoney(total.bus)}</dd>
        <dt>Tramwaje</dt><dd>{formatMoney(total.tram)}</dd>
        <dt>Wozokilometry / dzień</dt><dd>{Math.round(total.vehicleKm).toLocaleString("pl-PL")}</dd>
      </dl>
      <p className="muted">Autobus: 14,09 zł/km · tramwaj: 28,33 zł/km.</p>
      <p className="muted">Szacunek z długości obu kierunków i taktów w zdefiniowanych porach dnia, także dla ukrytych linii. Bez dojazdów do zajezdni i kursów poza tymi godzinami.</p>
    </div>
  </details>;
}
