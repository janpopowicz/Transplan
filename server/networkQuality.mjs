import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import { PERIODS } from "../src/constants.ts";
import { parseProposal, MAX_PROPOSAL_BYTES } from "../src/lib/proposal.ts";
import { mergeStopCatalogue } from "../src/lib/stopEditing.ts";
import { parseWalkingNetwork } from "../src/lib/walkingNetwork.ts";
import { runNetworkQuality } from "./networkQualityRunner.mjs";
import { normalizeNetworkQuality } from "../src/lib/networkQuality.ts";
import { createGtfsSource, warsawDate } from "./gtfs.mjs";
import { NETWORK_QUALITY_PLACES, NETWORK_QUALITY_CATALOG_VERSION } from "../src/lib/networkQualityPlaces.ts";
import { createOverpassSource, WALKING_RESPONSE_LIMIT } from "./overpass.mjs";
import { badRequest, exactObject, json, noBody, queryParams, rateLimit, readJson, safeHandler } from "./security.mjs";

const decompress = promisify(gunzip);
const signature = (info) => `${info.ino}:${info.size}:${info.mtimeMs}`;

/** Hidden analysis API. One running job per process, four cached results and no
 * unbounded queue. Identical snapshots share work; HTTP polling avoids keeping
 * a connection open for an entire city-wide calculation. */
export function createNetworkQualityHandler({ source = createOverpassSource(), stopsFile = resolve("public/stops.json"),
  now = Date.now, calculate = runNetworkQuality, places = NETWORK_QUALITY_PLACES,
  gtfsSource = createGtfsSource(), date = warsawDate } = {}) {
  const starts = rateLimit({ perClient: 6, global: 12, now });
  const reads = rateLimit({ perClient: 120, global: 600, now });
  const jobs = new Map();
  const references = new Map();
  let active = false, walkingCache, catalogueCache;
  async function context() {
    let file, stale;
    try { ({ file, stale } = await source("walking")); } catch { throw badRequest(502); }
    const [walkInfo, stopInfo] = await Promise.all([stat(file), stat(stopsFile)]);
    const walkVersion = signature(walkInfo), stopVersion = signature(stopInfo);
    if (walkingCache?.version !== walkVersion) {
      const data = JSON.parse(await decompress(await readFile(file), { maxOutputLength: WALKING_RESPONSE_LIMIT }));
      const network = parseWalkingNetwork(data.elements);
      if (!network.edges.length) throw badRequest(502);
      network.fetchedAt = walkInfo.mtimeMs;
      walkingCache = { version: walkVersion, network };
    }
    if (catalogueCache?.version !== stopVersion) {
      const data = JSON.parse(await readFile(stopsFile, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.stops)) throw badRequest(502);
      catalogueCache = { version: stopVersion, stops: data.stops };
    }
    return { network: walkingCache.network, stops: catalogueCache.stops, stale, walkVersion, stopVersion };
  }
  return safeHandler(async (req, res, next, url) => {
    if (url.pathname !== "/api/network-quality" && !url.pathname.startsWith("/api/network-quality/")) return next();
    queryParams(url);
    if (req.method === "GET") {
      noBody(req); reads(req);
      if (url.pathname === "/api/network-quality/places") return json(res, 200,
        { catalogVersion: NETWORK_QUALITY_CATALOG_VERSION, places });
      const match = /^\/api\/network-quality\/([a-f0-9]{64})$/.exec(url.pathname);
      const job = match && jobs.get(match[1]);
      if (!job || now() - job.updatedAt > 15 * 60_000 && job.status !== "running") return json(res, 404, { error: "Analysis not found" });
      if (job.status === "running") res.setHeader("Retry-After", "1");
      return json(res, job.status === "running" ? 202 : job.status === "failed" ? 502 : 200, job);
    }
    if (req.method !== "POST" || url.pathname !== "/api/network-quality") {
      res.setHeader("Allow", url.pathname === "/api/network-quality" ? "POST" : "GET");
      return json(res, 405, { error: "Method not allowed" });
    }
    starts(req);
    const input = exactObject(await readJson(req, MAX_PROPOSAL_BYTES), ["proposal", "period", "scale"], ["proposal", "period"]);
    if (!PERIODS.some((p) => p.id === input.period)) throw badRequest();
    const scale = input.scale ?? "raw";
    if (scale !== "raw" && scale !== "gtfs") throw badRequest();
    let proposal;
    try { proposal = parseProposal(input.proposal); } catch { throw badRequest(); }
    const snapshotKey = createHash("sha256").update(JSON.stringify({ proposal, period: input.period, scale,
      baselineDay: scale === "gtfs" ? date() : null })).digest("hex");
    // Deduplicate an in-flight calculation before loading or parsing any OSM.
    const pending = [...jobs.values()].find((job) => job.status === "running" && job.snapshotKey === snapshotKey);
    if (pending) return json(res, 202, pending);
    if (active) throw badRequest(429);
    active = true;
    try {
      const ctx = await context();
      let baseline;
      if (scale === "gtfs") {
        try { baseline = await gtfsSource({ requireToday: true }); } catch { throw badRequest(502); }
        if (baseline.date !== date()) throw badRequest(502);
      }
      const referenceKey = createHash("sha256").update(JSON.stringify([ctx.walkVersion, input.period,
        NETWORK_QUALITY_CATALOG_VERSION, baseline?.date, baseline?.snapshot])).digest("hex");
      const id = createHash("sha256").update(`${snapshotKey}:${ctx.walkVersion}:${ctx.stopVersion}:${referenceKey}`).digest("hex");
      const cached = jobs.get(id);
      if (cached?.status === "done" && now() - cached.updatedAt <= 15 * 60_000) { active = false; return json(res, 200, cached); }
      const merged = mergeStopCatalogue(ctx.stops, [...proposal.localStops, ...(proposal.movedStops ?? [])], proposal.lines);
      const stopIds = new Set(merged.stops.map((s) => s.id));
      if (merged.lines.some((line) => [...line.outboundStopIds, ...line.inboundStopIds,
        ...line.segments.flatMap((s) => [s.fromStopId, s.toStopId])].some((id) => !stopIds.has(id)))) throw badRequest();
      while (jobs.size >= 4) jobs.delete(jobs.keys().next().value);
      const originCount = places.reduce((sum, p) => sum + p.points.length, 0);
      const reference = references.get(referenceKey);
      const job = { id, snapshotKey, status: "running", phase: "network", completedOrigins: 0,
        totalOrigins: originCount * (baseline && !reference ? 3 : 1), walkingStale: ctx.stale, updatedAt: now() };
      jobs.set(id, job);
      // Start after the 202 response; the default runner uses a CPU worker.
      void (async () => {
        try {
          await setImmediate();
          let completedBefore = 0;
          const evaluate = async (network, phase) => {
            job.phase = phase;
            const result = await calculate({ ...network, period: input.period, network: ctx.network, places },
              () => setImmediate(), (completed) => { job.completedOrigins = completedBefore + completed; });
            completedBefore += originCount;
            return result;
          };
          let ref = reference;
          if (baseline && !ref) {
            const walkingOnly = await evaluate({ stops: baseline.snapshot.stops, lines: [] }, "walking-reference");
            const gtfs = await evaluate(baseline.snapshot, "gtfs-reference");
            ref = { walkingOnly, gtfs };
            while (references.size >= 2) references.delete(references.keys().next().value);
            references.set(referenceKey, ref);
          }
          const result = await evaluate(merged, "network");
          job.result = baseline ? normalizeNetworkQuality(result, ref.gtfs, ref.walkingOnly, baseline.date) : result;
          job.status = "done";
        } catch { job.status = "failed"; job.error = "Nie udało się obliczyć jakości sieci."; }
        finally { job.updatedAt = now(); active = false; }
      })();
      res.setHeader("Location", `/api/network-quality/${id}`);
      res.setHeader("Retry-After", "1");
      return json(res, 202, job);
    } catch (error) { active = false; throw error; }
  });
}
