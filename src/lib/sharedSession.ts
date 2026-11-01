import { create } from "zustand";
import { decodeStoredState } from "./storageCodec";
import { createProjectSnapshotReader, projectSnapshot, useStore } from "../store";
import { SyncCheckpointWriter } from "./syncCheckpoint";
import { parseProposal, type Proposal } from "./proposal";
import { equal, NetworkSync, type SyncStatus } from "./networkSync";
import { browserAccess, changeNetworkAccess, createNetwork, fetchNetwork, networkLinks, rememberAccess, type SharedAccess, type SharedDocument } from "./sharing";

export const useSharedSession = create<{ access: SharedAccess | null; status: SyncStatus }>(() => ({
  access: null, status: { message: "Łączę…", pending: false, conflict: false },
}));
let sync: NetworkSync | null = null;
let checkpointWriter: SyncCheckpointWriter | null = null;
// Each tab retains its own unsent edits, even when two tabs share the write link.
let checkpointId: string | null = null;
export function migrateCheckpointKeys() {
  try {
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    const pattern = new RegExp(`^transplan-sync:(${uuid}):${uuid}:(${uuid})$`, "i");
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const old = localStorage.key(i), match = old && pattern.exec(old);
      if (!old || !match) continue;
      const next = `transplan-sync:${match[1]}:${match[2]}`, value = localStorage.getItem(old);
      if (value && !localStorage.getItem(next)) localStorage.setItem(next, value);
      localStorage.removeItem(old);
    }
  } catch { /* A full/unavailable store must not destroy the only recovery copy. */ }
}
function key(access: SharedAccess): string {
  if (!checkpointId) {
    try {
      checkpointId = sessionStorage.getItem("transplan-sync-client") || crypto.randomUUID();
      sessionStorage.setItem("transplan-sync-client", checkpointId);
    } catch { checkpointId = crypto.randomUUID(); }
  }
  return `transplan-sync:${access.id}:${checkpointId}`;
}
function checkpoint(access: SharedAccess): { base: SharedDocument; local: Proposal } | null {
  if (!access.writeToken) return null;
  try {
    // Migrate legacy recovery keys once, then remove the embedded secret from storage keys.
    const currentKey = key(access), legacyKey = `transplan-sync:${access.id}:${access.writeToken}:${checkpointId}`;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy && !localStorage.getItem(currentKey)) localStorage.setItem(currentKey, legacy);
    if (legacy) localStorage.removeItem(legacyKey);
    const saved = decodeStoredState(localStorage.getItem(key(access)) || "null") as { base: SharedDocument; local: Proposal };
    if (!saved || !Number.isSafeInteger(saved.base.revision) || saved.base.revision < 1) return null;
    return { base: { ...saved.base, proposal: parseProposal(saved.base.proposal) }, local: parseProposal(saved.local) };
  } catch { return null; }
}
function connect(access: SharedAccess, document: SharedDocument, local = document.proposal) {
  sync?.dispose();
  checkpointWriter?.dispose();
  checkpointWriter = access.writeToken ? new SyncCheckpointWriter(key(access)) : null;
  const writer = checkpointWriter;
  useStore.setState({ access: access.writeToken ? "write" : "read" });
  useStore.getState().openProposal(local, true);
  sync = new NetworkSync(access, document, {
    read: createProjectSnapshotReader(),
    apply: (proposal) => useStore.getState().openProposal(proposal, true),
    busy: () => useStore.getState().routing,
    status: (status) => {
      const previous = useSharedSession.getState().status;
      if (previous.message !== status.message || previous.pending !== status.pending || previous.conflict !== status.conflict)
        useSharedSession.setState({ status });
    },
    checkpoint: (base, proposal) => writer?.schedule(base, proposal),
  });
  sync.checkpoint();
  useSharedSession.setState({ access, status: { message: "Łączę…", pending: sync.pending, conflict: false } });
}
let opening: Promise<void> | null = null;
export function openSharedNetwork(): Promise<void> {
  if (!opening) opening = (async () => {
    migrateCheckpointKeys();
    const access = browserAccess();
    if (!access) return;
    rememberAccess(access);
    const saved = checkpoint(access);
    let remote: SharedDocument;
    try { remote = await fetchNetwork(access.id); }
    catch (error) {
      if (!saved) throw error;
      connect(access, saved.base, saved.local); return;
    }
    if (saved && !equal(saved.base.proposal, saved.local)) connect(access, saved.base, saved.local);
    else connect(access, remote);
  })().catch((error) => { opening = null; throw error; });
  return opening;
}
let creating: Promise<void> | null = null;
export async function ensureSharedNetwork() {
  if (!useSharedSession.getState().access) {
    creating ??= (async () => {
      const created = await createNetwork(projectSnapshot(useStore.getState(), true));
      const latest = projectSnapshot(useStore.getState(), true);
      window.history.replaceState(null, "", networkLinks(created.access, window.location.href).write);
      rememberAccess(created.access);
      connect(created.access, created.document, latest);
    })().finally(() => { creating = null; });
    await creating;
  }
  return networkLinks(useSharedSession.getState().access!, window.location.href);
}
export function startSharedSync(): () => void {
  const controller = sync;
  const writer = checkpointWriter;
  if (!controller) return () => {};
  void controller.tick();
  const timer = window.setInterval(() => { void controller.tick(); }, 1000);
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.lines !== prev.lines || state.stops !== prev.stops || state.tracks !== prev.tracks
      || state.constructionOverrides !== prev.constructionOverrides) controller.checkpoint();
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    controller.checkpoint();
    writer?.flush();
    if (controller.pending) { event.preventDefault(); event.returnValue = ""; }
  };
  const wake = () => { void controller.tick(); };
  const pageHide = () => { controller.checkpoint(); writer?.flush(); };
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("online", wake);
  window.addEventListener("pagehide", pageHide);
  return () => {
    clearInterval(timer); unsubscribe(); writer?.flush();
    window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("online", wake);
    window.removeEventListener("pagehide", pageHide);
  };
}
export function resolveSharedConflict(prefer: "local" | "remote") { sync?.resolve(prefer); }
export async function manageSharedAccess(action: "rotate" | "revoke") {
  const previous = useSharedSession.getState().access;
  if (!previous) throw new Error("Najpierw udostępnij sieć.");
  if (sync?.pending) throw new Error("Poczekaj na zapis zmian przed zmianą linków.");
  useStore.setState({ access: "read" });
  try {
    const access = await changeNetworkAccess(previous, action);
    rememberAccess(access);
    // Preserve the exact sync base instead of rebasing a draft onto a newer snapshot.
    const base = sync?.document ?? await fetchNetwork(access.id);
    connect(access, base, projectSnapshot(useStore.getState(), true));
    return networkLinks(access, window.location.href);
  } finally { useStore.setState({ access: useSharedSession.getState().access?.writeToken ? "write" : "read" }); }
}
