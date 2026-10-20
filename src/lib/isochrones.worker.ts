import { calculateIsochrones, type IsochroneRequest, type IsochroneResult } from "./isochrones";

export type IsochroneReply = { result: IsochroneResult; error?: never } | { error: string; result?: never };

self.onmessage = (event: MessageEvent<IsochroneRequest>) => {
  try {
    self.postMessage({ result: calculateIsochrones(event.data) } satisfies IsochroneReply);
  } catch {
    self.postMessage({ error: "Nie udało się obliczyć izochron. Wybierz punkt ponownie." } satisfies IsochroneReply);
  }
};
