import type { Stop, TramTrack, TransitLine } from "../types";

const KEY = "transplan-krakow-v1";

interface PersistShape {
  lines: TransitLine[];
  localStops: Stop[];
  localTracks: TramTrack[];
  constructionOverrides: Record<string, boolean>;
}

export function loadState(): PersistShape | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistShape;
  } catch {
    return null;
  }
}

export function saveState(data: PersistShape): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* quota */
  }
}

export function exportProposal(data: PersistShape): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `transplan-krakow-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
