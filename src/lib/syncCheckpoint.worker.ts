import { serializeCheckpoint, type SyncCheckpoint } from "./syncCheckpointCodec";

self.onmessage = ({ data }: MessageEvent<{ version: number; data: SyncCheckpoint }>) => {
  self.postMessage({ version: data.version, stored: serializeCheckpoint(data.data) });
};
