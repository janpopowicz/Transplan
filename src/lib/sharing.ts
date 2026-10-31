import { parseProposal, type Proposal } from "./proposal";

export const NETWORK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface SharedDocument { revision: number; updatedAt: string; proposal: Proposal }
export interface SharedAccess { id: string; writeToken: string | null }
export interface SharedLinks { read: string; write: string }
export class RevisionConflict extends Error {
  constructor(public document: SharedDocument) { super("Sieć została zmieniona przez inną osobę."); }
}
export function networkAccess(search: string): SharedAccess | null {
  const params = new URLSearchParams(search), id = params.get("network"), writeToken = params.get("write");
  if (id === null) return null;
  if (!NETWORK_UUID.test(id) || (writeToken !== null && !NETWORK_UUID.test(writeToken))) throw new Error("Link do sieci jest nieprawidłowy.");
  return { id: id.toLowerCase(), writeToken };
}
export function networkId(search: string): string | null { return networkAccess(search)?.id ?? null; }
export function networkLinks(access: SharedAccess, href: string): SharedLinks {
  const url = new URL(href);
  url.search = ""; url.hash = "";
  url.searchParams.set("network", access.id);
  const read = url.href;
  if (access.writeToken) url.searchParams.set("write", access.writeToken);
  return { read, write: access.writeToken ? url.href : "" };
}
function document(value: unknown): SharedDocument {
  const data = value as SharedDocument;
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 1 || typeof data.updatedAt !== "string")
    throw new Error("Serwer zwrócił nieprawidłowe dane sieci.");
  return { revision: data.revision, updatedAt: data.updatedAt, proposal: parseProposal(data.proposal) };
}
async function api(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...init, cache: "no-store", signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("Brak połączenia z serwerem. Synchronizacja zostanie ponowiona."); }
  if (response.status === 404) throw new Error("Nie znaleziono udostępnionej sieci. Sprawdź link.");
  if (response.status === 403) throw new Error("Ten link nie pozwala na zapis. Poproś o link do edycji.");
  if (response.status === 413) throw new Error("Sieć jest za duża do udostępnienia (maks. 10 MB).");
  if (response.status === 204) return null;
  let result: unknown;
  try { result = await response.json(); } catch { throw new Error("Serwer nie obsługuje udostępniania sieci."); }
  if (response.status === 409) throw new RevisionConflict(document(result));
  if (!response.ok) throw new Error("Nie udało się zsynchronizować sieci. Spróbuj ponownie.");
  return result;
}
export async function createNetwork(proposal: Proposal): Promise<{ access: SharedAccess; document: SharedDocument }> {
  const result = await api("/api/networks", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proposal: parseProposal(proposal) }) }) as { id: string; writeToken: string };
  if (!result || typeof result.id !== "string" || typeof result.writeToken !== "string"
    || !NETWORK_UUID.test(result.id) || !NETWORK_UUID.test(result.writeToken)) throw new Error("Serwer zwrócił nieprawidłowy link.");
  return { access: { id: result.id, writeToken: result.writeToken }, document: document(result) };
}
export async function fetchNetwork(id: string): Promise<SharedDocument> {
  if (!NETWORK_UUID.test(id)) throw new Error("Link do sieci jest nieprawidłowy.");
  return document(await api(`/api/networks/${id}`));
}
export async function pollNetwork(id: string, revision: number): Promise<SharedDocument | null> {
  const result = await api(`/api/networks/${id}?revision=${revision}`);
  return result === null ? null : document(result);
}
export async function updateNetwork(access: SharedAccess, revision: number, proposal: Proposal): Promise<SharedDocument> {
  if (!access.writeToken) throw new Error("Ten link pozwala tylko na podgląd.");
  return document(await api(`/api/networks/${access.id}`, { method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.writeToken}` },
    body: JSON.stringify({ revision, proposal: parseProposal(proposal) }) }));
}
