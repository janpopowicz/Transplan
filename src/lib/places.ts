import type { Stop } from "../types";
import type { JourneyPoint } from "./journey";
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pl").replace(/ł/g, "l").trim();
export function searchStops(stops: Stop[], query: string): JourneyPoint[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  return stops.filter((stop) => normalize(stop.name).includes(q)).sort((a, b) =>
    Number(normalize(b.name).startsWith(q)) - Number(normalize(a.name).startsWith(q)) || a.name.localeCompare(b.name, "pl", { numeric: true }))
    .slice(0, 6).map((stop) => ({ name: stop.name, coord: [stop.lon, stop.lat] }));
}
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<JourneyPoint[]> {
  const response = await fetch(`/geocode?q=${encodeURIComponent(query.trim())}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Nie udało się wyszukać miejsca.");
  const places = data as JourneyPoint[];
  return places.filter((place, index) => places.findIndex((other) => other.name === place.name) === index);
}
