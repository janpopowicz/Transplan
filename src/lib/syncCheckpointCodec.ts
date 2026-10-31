import type { Proposal } from "./proposal";
import type { SharedDocument } from "./sharing";
import { encodeStoredJson } from "./storageCodec";

export interface SyncCheckpoint { base: SharedDocument; local: Proposal }
export function serializeCheckpoint(data: SyncCheckpoint): string {
  const raw = JSON.stringify(data);
  return raw.length > 1000000 ? encodeStoredJson(raw) : raw;
}
