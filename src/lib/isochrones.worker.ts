import { calculateIsochrones, type IsochroneRequest, type IsochroneResult } from "./isochrones";
import { loadWalkingNetwork } from "./walkingNetwork";

export type IsochroneJob = { id: number; request: Omit<IsochroneRequest, "network"> };
export type IsochroneReply = { id: number } & (
  { result: IsochroneResult; error?: never; progress?: never } |
  { error: string; result?: never; progress?: never } |
  { progress: string; result?: never; error?: never }
);

// Begin loading on entering the tool, before the first map click.
void loadWalkingNetwork().catch(() => {});

let latest = 0;
self.onmessage = async (event: MessageEvent<IsochroneJob>) => {
  const { id, request } = event.data;
  latest = id;
  try {
    self.postMessage({ id, progress: "Wczytuję drogi i przejścia piesze OSM…" } satisfies IsochroneReply);
    const network = await loadWalkingNetwork();
    if (latest !== id) return;
    self.postMessage({ id, progress: "Obliczam dojazdy i dojścia po sieci pieszej…" } satisfies IsochroneReply);
    self.postMessage({ id, result: calculateIsochrones({ ...request, network }) } satisfies IsochroneReply);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Nie udało się obliczyć izochron. Wybierz punkt ponownie." } satisfies IsochroneReply);
  }
};
