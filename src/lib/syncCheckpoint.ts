import type { Proposal } from "./proposal";
import type { SharedDocument } from "./sharing";
import { serializeCheckpoint, type SyncCheckpoint } from "./syncCheckpointCodec";

/** Coalesce edits and compress large recovery copies outside the UI thread. */
export class SyncCheckpointWriter {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: SyncCheckpoint | undefined;
  private version = 0;
  private saved = 0;
  private attempted = 0;
  private running = false;
  private disposed = false;
  constructor(private key: string) {
    if (typeof Worker !== "undefined") {
      try {
        this.worker = new Worker(new URL("./syncCheckpoint.worker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = ({ data }: MessageEvent<{ version: number; stored: string }>) => {
          if (this.disposed) return;
          this.running = false;
          // Keep recovery progressing during continuous edits, but never overwrite
          // a newer persisted checkpoint (including a synchronous unload flush).
          if (data.version > this.saved) this.write(data.stored, data.version);
          this.defer();
        };
        this.worker.onerror = () => {
          this.worker?.terminate(); this.worker = null; this.running = false;
          this.attempted = 0;
          this.defer();
        };
      } catch { this.worker = null; }
    }
  }
  schedule(base: SharedDocument, local: Proposal) {
    if (this.disposed) return;
    if (this.latest?.base === base && this.latest.local === local) return;
    this.latest = { base, local }; this.version++;
    this.defer();
  }
  private defer() {
    if (this.disposed || !this.latest || this.attempted === this.version || this.saved === this.version
      || this.timer !== undefined || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.latest || this.saved === this.version) return;
      this.attempted = this.version;
      if (this.worker) {
        try {
          this.running = true;
          this.worker.postMessage({ version: this.version, data: this.latest });
          return;
        } catch { this.worker.terminate(); this.worker = null; this.running = false; }
      }
      this.write(serializeCheckpoint(this.latest), this.version);
    }, 300);
  }
  private write(stored: string, version: number) {
    try { localStorage.setItem(this.key, stored); this.saved = version; }
    catch { /* Keep the live draft; retry on the next edit or unload. */ }
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.latest && this.saved !== this.version) this.write(serializeCheckpoint(this.latest), this.version);
  }
  dispose() {
    this.flush(); this.disposed = true; this.worker?.terminate(); this.worker = null;
  }
}
