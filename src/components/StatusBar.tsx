import { useStore } from "../store";

export function StatusBar() {
  const osm = useStore((s) => s.osm);
  const lines = useStore((s) => s.lines.length);
  const localStops = useStore((s) => s.stops.filter((s) => s.source === "local").length);
  const localTracks = useStore((s) => s.tracks.filter((t) => t.source === "local").length);

  return (
    <footer className="status">
      <span>
        OSM: {osm.loading ? "wczytywanie…" : osm.error ? osm.error : `${osm.stops} przystanków · ${osm.tracks} torów${osm.roads ? ` · ${osm.roads} dróg` : ""}`}
      </span>
      <span>{lines} linii</span>
      <span>
        Propozycje: {localStops} przyst. · {localTracks} torów
      </span>
      <span className="grow" />
      <span>Mapa © OpenStreetMap · routing autobusowy Valhalla / torowisko OSM</span>
    </footer>
  );
}
