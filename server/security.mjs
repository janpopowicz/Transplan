import { TextDecoder } from "node:util";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const badRequest = (status = 400, message = "Invalid request") => Object.assign(new Error(message), { status });
export function integerSetting(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new Error(`Invalid setting: ${name}`);
  return Number(raw);
}
export const securityHeaders = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // MapLibre uses blob workers; inline styles are required by map positioning and React.
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://protomaps.github.io; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self' https://protomaps.github.io https://tile.openstreetmap.org https://valhalla1.openstreetmap.de https://router.project-osrm.org https://routing.openstreetmap.de; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/** All entry points, including independently mounted Vite middleware, share this boundary. */
export function requestUrl(req) {
  const singletonHeaders = new Set(["host", "authorization", "origin", "content-type", "content-length", "content-encoding", "sec-fetch-site", "transfer-encoding"]);
  const seen = new Set();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (singletonHeaders.has(name) && seen.has(name)) throw badRequest();
    seen.add(name);
  }
  const raw = req.url || "/";
  if (raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u0020\u007f#]/u.test(raw)
    || /%(?:2f|5c|00)/i.test(raw.split("?")[0])) throw badRequest();
  let decoded, url;
  try { decoded = decodeURIComponent(raw); url = new URL(raw, "http://localhost"); } catch { throw badRequest(); }
  if (/[\u0000-\u001f\u007f]/u.test(decoded) || decoded.split("?")[0].split("/").some((p) => p === "." || p === "..")) throw badRequest();
  const host = req.headers.host;
  if (host !== undefined && (typeof host !== "string" || !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(host))) throw badRequest();
  if (![undefined, "same-origin", "same-site", "cross-site", "none"].includes(req.headers["sec-fetch-site"])) throw badRequest();
  return url;
}

export function queryParams(url, validators = {}) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(validators, key) || Object.hasOwn(result, key) || !validators[key](value)) throw badRequest();
    result[key] = value;
  }
  return result;
}
export const positiveRevision = (value) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
export function noBody(req) {
  if (req.headers["transfer-encoding"] || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw badRequest();
}
export function sameOrigin(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") throw badRequest(403);
  if (req.headers.origin !== undefined) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw badRequest(403); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== req.headers.origin
      || origin.host.toLowerCase() !== req.headers.host?.toLowerCase()) throw badRequest(403);
  }
}
export function exactObject(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) throw badRequest();
  return value;
}
export async function readBody(req, maxBytes, mime) {
  sameOrigin(req);
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw badRequest(415);
  if (typeof req.headers["content-type"] !== "string" || !mime.test(req.headers["content-type"])) throw badRequest(415);
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw badRequest(413);
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw badRequest(413);
    chunks.push(chunk);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw badRequest(); }
}
let bufferedRequests = 0;
let bufferedBytes = 0;
export async function readJson(req, maxBytes) {
  if (bufferedRequests >= 64 || bufferedBytes + maxBytes > 40 * 1024 * 1024) throw badRequest(429);
  bufferedRequests++; bufferedBytes += maxBytes;
  try {
    const raw = await readBody(req, maxBytes, /^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i);
    try { return JSON.parse(raw); } catch { throw badRequest(); }
  } finally { bufferedRequests--; bufferedBytes -= maxBytes; }
}

/** Bound responses before buffering, including chunked/decompressed upstream bodies. */
export async function limitedBytes(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw badRequest(502); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw badRequest(502, "Upstream response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}
export function safeHandler(handler) {
  return async (req, res, next = () => { res.writeHead(404).end(); }) => {
    try {
      for (const [key, value] of Object.entries(securityHeaders)) if (!res.hasHeader(key)) res.setHeader(key, value);
      const url = requestUrl(req);
      return await handler(req, res, next, url);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      if (status === 429) res.setHeader("Retry-After", "60");
      if (!req.complete) res.setHeader("Connection", "close");
      // Do not log URLs, authorization, request bodies or share credentials.
      if (status === 500) console.error("Request failed:", error.code || error.name);
      json(res, status, { error: status === 500 ? "Service unavailable" : "Invalid request" });
    }
  };
}

/** Fixed windows with bounded cardinality; X-Forwarded-For is deliberately not trusted. */
export function rateLimit({ perClient = 120, global = 600, windowMs = 60000, maxClients = 2000, now = Date.now } = {}) {
  let start = now(), total = 0;
  const clients = new Map();
  return (req) => {
    if (now() - start >= windowMs) { start = now(); total = 0; clients.clear(); }
    const key = req.socket?.remoteAddress || "local";
    const count = clients.get(key) || 0;
    if (total >= global || count >= perClient || (!clients.has(key) && clients.size >= maxClients)) throw badRequest(429);
    clients.set(key, count + 1); total++;
  };
}
