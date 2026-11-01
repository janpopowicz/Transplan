import lockfile from "proper-lockfile";
import { mkdir, readFile, readdir, writeFile, link, unlink, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { badRequest, UUID } from "./security.mjs";

export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
const revisionNames = async (dir) => (await readdir(dir)).filter((name) => /^[1-9]\d*\.json$/.test(name));
export function networkStorage({ dataDir, maxNetworks = 1000, maxStorageBytes = 1024 * 1024 * 1024, retainedRevisions = 5 } = {}) {
  const root = resolve(dataDir), ledgerFile = join(root, ".budget.json");
  let queued = 0;
  async function transaction(work) {
    if (queued >= 8) throw badRequest(429);
    queued++;
    let release, compromised = false;
    try {
      await mkdir(root, { recursive: true });
      release = await lockfile.lock(root, { stale: 30000, update: 10000,
        retries: { retries: 40, minTimeout: 10, maxTimeout: 50, factor: 1.2 },
        onCompromised: () => { compromised = true; } });
      let budget;
      try { budget = JSON.parse(await readFile(ledgerFile, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        budget = { networks: 0, bytes: 0 };
        // One-time migration. Account for existing data before admitting new writes.
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
          budget.networks++; budget.bytes += 256; // pointer/temp metadata allowance
          for (const name of await readdir(join(root, entry.name))) {
            const info = await stat(join(root, entry.name, name));
            if (info.isFile()) budget.bytes += info.size;
          }
        }
        await atomicJson(ledgerFile, budget);
      }
      if (!Number.isSafeInteger(budget.networks) || budget.networks < 0 || !Number.isSafeInteger(budget.bytes) || budget.bytes < 0)
        throw new Error("Invalid storage budget");
      const check = () => { if (compromised) throw new Error("Storage lock lost"); };
      return await work({
        check,
        async reserve(bytes, networks = 0) {
          check();
          if (budget.networks + networks > maxNetworks || budget.bytes + bytes > maxStorageBytes) throw badRequest(507, "Storage quota exceeded");
          budget = { networks: budget.networks + networks, bytes: budget.bytes + bytes };
          // Reserve before writing: interruption can overcount, never silently exceed quota.
          await atomicJson(ledgerFile, budget);
        },
        async reclaimed(bytes) {
          check(); budget.bytes = Math.max(0, budget.bytes - bytes); await atomicJson(ledgerFile, budget);
        },
      });
    } catch (error) { if (error.code === "ELOCKED") throw badRequest(429); throw error; }
    finally { queued--; if (release && !compromised) await release(); }
  }
  async function scan(id) {
    const dir = join(root, id), names = await revisionNames(dir);
    if (!names.length) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    const revision = names.reduce((max, name) => Math.max(max, Number(name.slice(0, -5))), 0);
    return JSON.parse(await readFile(join(dir, `${revision}.json`), "utf8"));
  }
  async function current(id, knownRevision) {
    const dir = join(root, id);
    // Pointer reads are constant-time even when migrating a large historical archive.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const pointer = JSON.parse(await readFile(join(dir, "current.json"), "utf8"));
        if (!Number.isSafeInteger(pointer.revision) || pointer.revision < 1) throw new Error("Invalid revision pointer");
        if (pointer.revision === knownRevision) return null;
        return JSON.parse(await readFile(join(dir, `${pointer.revision}.json`), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // Legacy directories get a pointer exactly once, under the same cross-process lock.
        if (attempt === 0) await transaction(async ({ check }) => {
          const value = await scan(id); check(); await atomicJson(join(dir, "current.json"), { revision: value.revision });
        });
      }
    }
    throw Object.assign(new Error("Not found"), { code: "ENOENT" });
  }
  async function publish(id, document, tx, reserved = false) {
    tx.check();
    const dir = join(root, id), raw = JSON.stringify(document), temp = join(dir, `${randomUUID()}.tmp`);
    async function prune(keep) {
      const obsolete = (await revisionNames(dir)).map((name) => Number(name.slice(0, -5))).sort((a, b) => b - a).slice(keep);
      let freed = 0;
      for (const revision of obsolete) {
        tx.check(); const file = join(dir, `${revision}.json`), info = await stat(file); await unlink(file); freed += info.size;
      }
      if (freed) await tx.reclaimed(freed);
    }
    if (!reserved) {
      // Free only old history; always retain the currently readable snapshot until publication.
      await prune(Math.max(1, retainedRevisions - 1));
      await tx.reserve(Buffer.byteLength(raw));
    }
    try { await writeFile(temp, raw, { flag: "wx", mode: 0o600 }); tx.check(); await link(temp, join(dir, `${document.revision}.json`)); }
    finally { await unlink(temp).catch(() => {}); }
    await atomicJson(join(dir, "current.json"), { revision: document.revision });
    await prune(retainedRevisions);
  }
  return { root, transaction, scan, current, publish };
}
