import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseProposal } from "../src/lib/proposal.ts";
import { NETWORK_UUID } from "../src/lib/sharing.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const hash = (token) => createHash("sha256").update(token).digest();

// Publishing a revision with an exclusive hard link is an atomic compare-and-swap,
// including across server processes sharing the same filesystem. Partial writes are invisible.
async function publish(dir, document) {
  const temp = join(dir, `${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(document), { flag: "wx", mode: 0o600 });
    await link(temp, join(dir, `${document.revision}.json`));
  } finally { await unlink(temp).catch(() => {}); }
}
async function latest(dir, knownRevision) {
  const revisions = (await readdir(dir)).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number(name.slice(0, -5)));
  if (!revisions.length) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
  const revision = revisions.reduce((a, b) => Math.max(a, b), 0);
  if (revision === knownRevision) return null;
  return JSON.parse(await readFile(join(dir, `${revision}.json`), "utf8"));
}

export function createNetworkHandler({ dataDir = resolve(process.env.TRANSPLAN_DATA_DIR || "data/networks") } = {}) {
  return async (req, res, next = () => { res.writeHead(404).end(); }) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (path !== "/api/networks" && !path.startsWith("/api/networks/")) return next();
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(JSON.stringify(body));
    };
    async function body() {
      if (req.headers["sec-fetch-site"] === "cross-site") throw { status: 403 };
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw { status: 415 };
      if (Number(req.headers["content-length"]) > MAX_BYTES) throw { status: 413 };
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw { status: 413 };
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw { status: 400 }; }
    }
    try {
      if (path === "/api/networks" && req.method === "POST") {
        const input = await body();
        let proposal;
        try { proposal = parseProposal(input.proposal); } catch { return send(400, { error: "Invalid network" }); }
        const id = randomUUID(), writeToken = randomUUID();
        const dir = join(dataDir, id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "access.json"), JSON.stringify({ writeHash: hash(writeToken).toString("hex") }), { flag: "wx", mode: 0o600 });
        const document = { revision: 1, updatedAt: new Date().toISOString(), proposal };
        await publish(dir, document);
        return send(201, { id, writeToken, ...document });
      }
      if (path === "/api/networks") { res.setHeader("Allow", "POST"); return send(405, { error: "Method not allowed" }); }
      const id = path.slice("/api/networks/".length).toLowerCase();
      if (!NETWORK_UUID.test(id)) return send(404, { error: "Network not found" });
      const dir = join(dataDir, id);
      if (req.method === "GET") {
        const knownRevision = Number(new URL(req.url, "http://localhost").searchParams.get("revision"));
        const document = await latest(dir, knownRevision);
        return send(document ? 200 : 204, document ?? undefined);
      }
      if (req.method === "PUT") {
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        const access = JSON.parse(await readFile(join(dir, "access.json"), "utf8"));
        if (!NETWORK_UUID.test(token) || !timingSafeEqual(hash(token), Buffer.from(access.writeHash, "hex")))
          return send(403, { error: "Write link required" });
        const input = await body();
        let proposal;
        try { proposal = parseProposal(input.proposal); } catch { return send(400, { error: "Invalid network" }); }
        const current = await latest(dir);
        if (!Number.isSafeInteger(input.revision) || input.revision !== current.revision) return send(409, current);
        const document = { revision: current.revision + 1, updatedAt: new Date().toISOString(), proposal };
        try { await publish(dir, document); }
        catch (error) { if (error.code === "EEXIST") return send(409, await latest(dir)); throw error; }
        return send(200, document);
      }
      res.setHeader("Allow", "GET, PUT");
      return send(405, { error: "Method not allowed" });
    } catch (error) {
      if (error.status) return send(error.status, { error: "Invalid request" });
      if (error.code === "ENOENT") return send(404, { error: "Network not found" });
      console.error("Network storage failed:", error);
      if (!res.headersSent) send(500, { error: "Network storage unavailable" });
    }
  };
}
