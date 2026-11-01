import type { Proposal } from "./proposal";
import { pollNetwork, RevisionConflict, updateNetwork, type SharedAccess, type SharedDocument } from "./sharing";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Proposals are immutable JSON data. Reuse unchanged geometry instead of serializing it. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  if (!object(a) || !object(b)) return false;
  // Optional undefined fields have the same meaning as absent fields in JSON.
  const ak = Object.keys(a).filter((key) => a[key] !== undefined);
  const bk = Object.keys(b).filter((key) => b[key] !== undefined);
  return ak.length === bk.length && ak.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const entities = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every((item) => object(item) && typeof item.id === "string");

/** Merge independent edits by entity and field. Ordered route/geometry arrays stay atomic. */
export function mergeProposals(base: Proposal, local: Proposal, remote: Proposal, prefer: "local" | "remote" = "local") {
  const conflicts: string[] = [];
  function merge(b: unknown, l: unknown, r: unknown, path: string): unknown {
    if (equal(l, b)) return r;
    if (equal(r, b) || equal(l, r)) return l;
    if (["lines", "localStops", "movedStops", "localTracks"].includes(path) && entities(b ?? []) && entities(l ?? []) && entities(r ?? [])) {
      const byId = (value: unknown) => new Map(((value ?? []) as { id: string }[]).map((item) => [item.id, item]));
      const bm = byId(b), lm = byId(l), rm = byId(r);
      return [...new Set([...rm.keys(), ...lm.keys()])].map((id) => merge(bm.get(id), lm.get(id), rm.get(id), `${path}.${id}`))
        .filter((item) => item !== undefined);
    }
    if (object(b) && object(l) && object(r)) {
      return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])]
        .map((key) => [key, merge(b[key], l[key], r[key], path ? `${path}.${key}` : key)])
        .filter(([, value]) => value !== undefined));
    }
    conflicts.push(path);
    return prefer === "local" ? l : r;
  }
  const proposal = merge(base, local, remote, "") as Proposal;
  return { proposal, conflicts };
}

export interface SyncStatus { message: string; conflict: boolean; pending: boolean }
export interface SyncAdapter {
  read: () => Proposal;
  apply: (proposal: Proposal) => void;
  busy: () => boolean;
  status: (status: SyncStatus) => void;
  checkpoint?: (base: SharedDocument, local: Proposal) => void;
}
export class NetworkSync {
  private running = false;
  private disposed = false;
  private conflict: SharedDocument | null = null;
  private comparison?: { local: Proposal; base: Proposal; pending: boolean };
  constructor(public access: SharedAccess, private base: SharedDocument, private adapter: SyncAdapter) {}
  private report(message: string, pending = false) { this.adapter.status({ message, pending, conflict: !!this.conflict }); }
  get pending() {
    if (!this.access.writeToken) return false;
    const local = this.adapter.read(), base = this.base.proposal;
    if (this.comparison?.local !== local || this.comparison.base !== base)
      this.comparison = { local, base, pending: !equal(local, base) };
    return this.comparison.pending;
  }
  checkpoint() { if (this.access.writeToken) this.adapter.checkpoint?.(this.base, this.adapter.read()); }
  get document() { return this.base; }
  dispose() { this.disposed = true; this.checkpoint(); }
  private accept(remote: SharedDocument) {
    const local = this.adapter.read();
    const merged = this.access.writeToken ? mergeProposals(this.base.proposal, local, remote.proposal)
      : { proposal: remote.proposal, conflicts: [] };
    if (merged.conflicts.length) {
      this.conflict = remote;
      this.report(`Konflikt zmian (${merged.conflicts.length}). Wybierz, które sporne zmiany zachować.`, true);
      return;
    }
    this.base = remote;
    if (!equal(local, merged.proposal)) this.adapter.apply(merged.proposal);
    this.checkpoint();
  }
  resolve(prefer: "local" | "remote") {
    if (!this.conflict) return;
    const merged = mergeProposals(this.base.proposal, this.adapter.read(), this.conflict.proposal, prefer);
    this.base = this.conflict; this.conflict = null;
    this.adapter.apply(merged.proposal); this.checkpoint();
    this.report("Synchronizuję…", this.pending);
    return this.tick();
  }
  async tick() {
    if (this.disposed || this.running || this.conflict) return;
    if (this.adapter.busy()) { this.report("Obliczam trasę…", this.pending); return; }
    this.running = true;
    try {
      const local = this.adapter.read();
      if (this.pending) {
        this.report("Zapisuję zmiany…", true);
        const saved = await updateNetwork(this.access, this.base.revision, local);
        if (this.disposed) return;
        this.base = saved; this.checkpoint();
      } else {
        const remote = await pollNetwork(this.access.id, this.base.revision);
        if (this.disposed) return;
        // Routing operations hold references to their input; retry after they finish.
        if (this.adapter.busy()) return;
        if (remote && remote.revision > this.base.revision) this.accept(remote);
      }
      if (!this.conflict) {
        const pending = this.pending;
        this.report(pending ? "Zmiany czekają na zapis…" : "Na bieżąco", pending);
      }
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof RevisionConflict) {
        if (!this.adapter.busy()) this.accept(error.document);
        if (!this.conflict) this.report("Łączę zmiany…", true);
      } else this.report(error instanceof Error ? error.message : "Błąd synchronizacji.", this.pending);
    } finally { this.running = false; }
  }
}
