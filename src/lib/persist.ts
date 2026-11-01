import { wholeMinuteTimes } from "./travelTime";
import type { Proposal } from "./proposal";
import { browserAccess } from "./sharing";

import { encodeStoredState, decodeStoredState } from "./storageCodec";

const KEY = "transplan-krakow-v1";

type PersistShape = Proposal;

function storageKey(): string {
  const id = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("network");
  const mode = browserAccess()?.writeToken ? "write" : "read";
  return id === null ? KEY : `${KEY}:network:${id.toLowerCase()}:${mode}`;
}

export function loadState(): PersistShape | null {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const data = decodeStoredState(raw) as PersistShape;
    return { ...data, lines: wholeMinuteTimes(data.lines ?? []) };
  } catch {
    return null;
  }
}

export function saveState(data: PersistShape, strict = false): void {
  const raw = JSON.stringify(data), stored = raw.length > 1000000 ? encodeStoredState(data) : raw;
  try {
    try { localStorage.setItem(storageKey(), stored); }
    catch {
      // Old uncompressed map caches may fill the origin quota. Compact only
      // regenerable base data, preserving every saved user project and backup.
      for (const key of ["transplan-base-cache-v6", "transplan-osm-cache-v5", "transplan-osm-cache-v4", "transplan-osm-cache-v3"]) {
        const cache = localStorage.getItem(key);
        if (cache && !cache.startsWith("transplan-lz:")) localStorage.setItem(key, encodeStoredState(JSON.parse(cache)));
      }
      localStorage.setItem(storageKey(), stored);
    }
  } catch (error) {
    if (strict) throw new Error(error instanceof Error && error.name !== "QuotaExceededError" ? `Nie udało się zapisać projektu: ${error.message}`
      : "Brak miejsca na zapis projektu w przeglądarce. Wyeksportuj projekt i zwolnij miejsce przed importem.");
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
