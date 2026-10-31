import LZString from "lz-string";

const PREFIX = "transplan-lz:";
/** Compress large networks in browser storage; exported and shared files remain
 * ordinary JSON. The prefix keeps existing local projects backwards compatible. */
export function encodeStoredState(value: unknown): string {
  return encodeStoredJson(JSON.stringify(value));
}
export function encodeStoredJson(raw: string): string {
  return PREFIX + LZString.compressToUTF16(raw);
}
export function decodeStoredState(raw: string): unknown {
  return JSON.parse(raw.startsWith(PREFIX) ? LZString.decompressFromUTF16(raw.slice(PREFIX.length)) : raw);
}
