import { calculateIsochrones, type IsochroneRequest, type IsochroneResult } from "./isochrones";
import { calculateJourney, type JourneyJob, type JourneyReply } from "./journey";
import { loadWalkingNetwork } from "./walkingNetwork";

export type IsochroneJob = { kind?: "isochrone"; id: number; request: Omit<IsochroneRequest, "network"> };
export type IsochroneReply = { id: number } & (
  { result: IsochroneResult; error?: never; progress?: never } |
  { error: string; result?: never; progress?: never } |
  { progress: string; result?: never; error?: never }
);

// Begin loading on entering the tool, before the first map click.
void loadWalkingNetwork().catch(() => {});

let latest = 0;
let cacheKey = "";
const results = new Map<string, IsochroneResult>();
self.onmessage = async (event: MessageEvent<IsochroneJob | JourneyJob>) => {
  const job = event.data;
  const { id } = job;
  latest = id;
  try {
    self.postMessage({ id, progress: "Wczytuję drogi i przejścia piesze OSM…" } satisfies IsochroneReply);
    const network = await loadWalkingNetwork();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (latest !== id) return;
    if (job.kind === "journey") {
      self.postMessage({ id, progress: "Szukam najszybszego przejazdu i przesiadek…" } satisfies JourneyReply);
      self.postMessage({ id, result: calculateJourney({ ...job.request, network }) } satisfies JourneyReply);
      return;
    }
    const request = job.request;
    const { scenario = "mean", ...inputs } = request;
    const key = JSON.stringify(inputs);
    if (cacheKey !== key) { cacheKey = key; results.clear(); }
    const cached = results.get(scenario);
    if (cached) { self.postMessage({ id, result: cached } satisfies IsochroneReply); return; }
    self.postMessage({ id, progress: "Symuluję odjazdy, przesiadki i 120 momentów startu w ciągu godziny…" } satisfies IsochroneReply);
    const result = calculateIsochrones({ ...request, network });
    results.set(scenario, result);
    self.postMessage({ id, result } satisfies IsochroneReply);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Nie udało się obliczyć izochron. Wybierz punkt ponownie." } satisfies IsochroneReply);
  }
};
