import { useMemo } from "react";
import { STOP_GROUP_METERS } from "../constants";
import { clusterStops, haversine, stopGroupLabel } from "../lib/geo";
import { useStore } from "../store";

export function StopGroupSuggestions({ lon, lat, stopId, selectedId, onChoose }: {
  lon: number; lat: number; stopId?: string; selectedId?: string;
  onChoose: (id: string) => void;
}) {
  const stops = useStore((s) => s.stops);
  const { current, nearby } = useMemo(() => {
    const groups = clusterStops(stops, STOP_GROUP_METERS);
    const byStop = new Map(groups.flatMap((group) => group.map((stop) => [stop.id, group] as const)));
    const current = groups.find((g) => g.some((s) => s.id === stopId));
    const excluded = new Set(current?.map((s) => s.id) ?? []);
    const nearby = stops.filter((s) => !excluded.has(s.id))
      .map((stop) => ({ stop, distance: haversine([lon, lat], [stop.lon, stop.lat]),
        group: byStop.get(stop.id)! }))
      .filter((s) => s.distance <= 600)
      .sort((a, b) => a.distance - b.distance).slice(0, 5);
    return { current, nearby };
  }, [stops, lon, lat, stopId]);
  return (
    <section className="stop-group-suggestions">
      <h3>Grupa przystankowa</h3>
      {current && (current.length > 1 || current[0].groupId) &&
        <p className="muted">Obecna grupa: {stopGroupLabel(current[0].name)} · {current.length} stanowisk</p>}
      <p className="muted">Dodać do grupy pobliskiego przystanku?</p>
      {!stopId && <button type="button" className={selectedId ? "group-choice" : "group-choice selected"}
        aria-pressed={!selectedId} onClick={() => onChoose("")}>Bez przypisania do grupy</button>}
      {nearby.map(({ stop, distance, group }) => (
        <button key={stop.id} type="button" className={selectedId === stop.id ? "group-choice selected" : "group-choice"}
          aria-pressed={selectedId === stop.id} onClick={() => onChoose(stop.id)}>
          <span><strong>{stop.name}</strong><small>{group.length > 1 || stop.groupId
            ? `Dołącz do grupy · ${group.length} stanowisk` : "Utwórz wspólną grupę"}</small></span>
          <span>{Math.round(distance)} m</span>
        </button>
      ))}
      {!nearby.length && <p className="empty-hint">Brak innych przystanków w promieniu 600 m.</p>}
    </section>
  );
}
