import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseProposal, MAX_PROPOSAL_BYTES } from "../src/lib/proposal.ts";
import { atomicJson, networkStorage } from "./networkStorage.mjs";
import { UUID, badRequest, exactObject, integerSetting, json, noBody, positiveRevision, queryParams, rateLimit, readJson, safeHandler } from "./security.mjs";

const TOKEN_LIFETIME = 30 * 24 * 3600000;
const hash = (token) => createHash("sha256").update(token).digest();
const matches = (token, digest) => typeof token === "string" && UUID.test(token) && typeof digest === "string"
  && /^[a-f0-9]{64}$/.test(digest) && timingSafeEqual(hash(token), Buffer.from(digest, "hex"));
function bearer(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string" || !/^Bearer [0-9a-f-]{36}$/i.test(value)) throw badRequest(403);
  const token = value.slice(7);
  if (!UUID.test(token)) throw badRequest(403);
  return token;
}
export function createNetworkHandler({ dataDir = resolve(process.env.TRANSPLAN_DATA_DIR || "data/networks"),
  maxNetworks = integerSetting("TRANSPLAN_MAX_NETWORKS", 1000, 100000),
  maxStorageBytes = integerSetting("TRANSPLAN_MAX_STORAGE_BYTES", 1024 * 1024 * 1024, 1024 ** 4),
  retainedRevisions = integerSetting("TRANSPLAN_RETAINED_REVISIONS", 5, 100), now = Date.now } = {}) {
  if (![maxNetworks, maxStorageBytes, retainedRevisions].every((v) => Number.isSafeInteger(v) && v >= 1)) throw new Error("Invalid storage limits");
  const storage = networkStorage({ dataDir, maxNetworks, maxStorageBytes, retainedRevisions });
  const creations = rateLimit({ perClient: 10, global: 60, now });
  const writes = rateLimit({ perClient: 120, global: 600, now });
  const reads = rateLimit({ perClient: 600, global: 6000, now });
  const proposal = (value) => { try { return parseProposal(value); } catch { throw badRequest(); } };
  return safeHandler(async (req, res, next, url) => {
    if (url.pathname !== "/api/networks" && !url.pathname.startsWith("/api/networks/")) return next();
    const send = (status, body) => json(res, status, body);
    try {
      if (url.pathname === "/api/networks") {
        queryParams(url);
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, { error: "Method not allowed" }); }
        creations(req);
        const input = exactObject(await readJson(req, MAX_PROPOSAL_BYTES), ["proposal"]);
        const value = proposal(input.proposal);
        return await storage.transaction(async (tx) => {
          const id = randomUUID(), writeToken = randomUUID(), ownerToken = randomUUID(), expiresAt = now() + TOKEN_LIFETIME;
          const access = { writeHash: hash(writeToken).toString("hex"), ownerHash: hash(ownerToken).toString("hex"), expiresAt };
          const document = { revision: 1, updatedAt: new Date(now()).toISOString(), proposal: value };
          await tx.reserve(Buffer.byteLength(JSON.stringify(access)) + Buffer.byteLength(JSON.stringify(document)) + 256, 1);
          const dir = join(storage.root, id); await mkdir(dir); await atomicJson(join(dir, "access.json"), access);
          await storage.publish(id, document, tx, true);
          return send(201, { id, writeToken, ownerToken, expiresAt, ...document });
        });
      }
      const match = /^\/api\/networks\/([^/]+)(\/access)?$/.exec(url.pathname);
      if (!match || !UUID.test(match[1])) return send(404, { error: "Network not found" });
      const id = match[1].toLowerCase(), accessRoute = !!match[2], dir = join(storage.root, id);
      if (!accessRoute && req.method === "GET") {
        const params = queryParams(url, { revision: positiveRevision }); noBody(req); reads(req);
        const document = await storage.current(id, params.revision === undefined ? undefined : Number(params.revision));
        return send(document ? 200 : 204, document ?? undefined);
      }
      queryParams(url);
      if ((!accessRoute && req.method !== "PUT") || (accessRoute && req.method !== "POST")) {
        res.setHeader("Allow", accessRoute ? "POST" : "GET, PUT"); return send(405, { error: "Method not allowed" });
      }
      writes(req); const token = bearer(req);
      // Reject invalid credentials before buffering a potentially large request body.
      async function authorize() {
        const raw = await readFile(join(dir, "access.json"), "utf8"), access = JSON.parse(raw);
        const expiresAt = access.expiresAt ?? (await stat(join(dir, "access.json"))).mtimeMs + TOKEN_LIFETIME;
        if (!Number.isFinite(expiresAt) || expiresAt <= 0 || (access.ownerHash !== undefined && !/^[a-f0-9]{64}$/.test(access.ownerHash))
          || (access.writeHash !== null && (typeof access.writeHash !== "string" || !/^[a-f0-9]{64}$/.test(access.writeHash))))
          throw new Error("Invalid access metadata");
        const owner = matches(token, access.ownerHash);
        if (accessRoute ? !owner && !(access.ownerHash === undefined && matches(token, access.writeHash) && now() < expiresAt)
          : !matches(token, access.writeHash) || now() >= expiresAt) throw badRequest(403);
        return { ...access, expiresAt, storedBytes: Buffer.byteLength(raw) };
      }
      await authorize();
      const input = exactObject(await readJson(req, accessRoute ? 128 : MAX_PROPOSAL_BYTES), accessRoute ? ["action"] : ["proposal", "revision"]);
      let value;
      if (accessRoute) { if (!["rotate", "revoke"].includes(input.action)) throw badRequest(); }
      else {
        if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw badRequest();
        value = proposal(input.proposal);
      }
      return await storage.transaction(async (tx) => {
        // Prevent racing a save against token revocation in another process.
        const access = await authorize();
        if (accessRoute) {
          const writeToken = input.action === "rotate" ? randomUUID() : null;
          const ownerToken = access.ownerHash === undefined ? randomUUID() : undefined;
          const next = { ownerHash: ownerToken ? hash(ownerToken).toString("hex") : access.ownerHash,
            writeHash: writeToken ? hash(writeToken).toString("hex") : null, expiresAt: now() + TOKEN_LIFETIME };
          const nextBytes = Buffer.byteLength(JSON.stringify(next));
          await tx.reserve(Math.max(0, nextBytes - access.storedBytes));
          tx.check(); await atomicJson(join(dir, "access.json"), next);
          if (nextBytes < access.storedBytes) await tx.reclaimed(access.storedBytes - nextBytes);
          return send(200, { writeToken, ...(ownerToken ? { ownerToken } : {}), expiresAt: next.expiresAt });
        }
        const current = await storage.scan(id);
        if (input.revision !== current.revision) return send(409, current);
        if (current.revision >= Number.MAX_SAFE_INTEGER - 1) throw badRequest(409);
        const document = { revision: current.revision + 1, updatedAt: new Date(now()).toISOString(), proposal: value };
        await storage.publish(id, document, tx);
        return send(200, document);
      });
    } catch (error) {
      if (error.code === "ENOENT") return send(404, { error: "Network not found" });
      throw error;
    }
  });
}
