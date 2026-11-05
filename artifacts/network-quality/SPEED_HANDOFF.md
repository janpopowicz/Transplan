# Network quality performance handoff

Updated 2026-11-04. All implementation changes are in the current, uncommitted worktree. Do not reset it: the worktree also contains the user's existing edits to `miejsca.txt`.

## User objective

Implement a hidden engine/API metric of weighted geometric accessibility from destinations in `miejsca.txt`, including Stadion Wisły, Stadion Cracovii and Tauron Arena. Keep coordinates outside the already large constants module; export a KMZ for geographic review. Support a numerical scale where today's GTFS is 100, walking without transit is 0, and improvements may exceed 100. The latest implementation task was to make the full-city calculation substantially faster. The user then requested this handoff to Claude Code.

## Confirmed performance

Measured on Intel i7-8650U @ 1.90 GHz, Node 22.23.4, period `wd_am`, the same GTFS/OSM inputs and full catalog:

| Implementation | Calculation time | Comparison against original |
| --- | ---: | --- |
| Original | 566.458 s (9m26s) | Reference |
| Optimized, 4 compute workers, shared prepared model | **76.501 s (1m16.5s)** | Same final score; all place areas identical |
| Optimized, 2 compute workers, shared prepared model | 107.788 s (1m47.8s) | Same final score; maximum place-area error 1.42e-14 km² |

Four workers give approximately **7.4× speedup**. These are single runs, not statistical benchmarks. Times include worker startup and graph/raster preparation, exclude reading/parsing input files, and do not use the result cache. Four-worker input preparation was another 15.118 s; two-worker preparation was 12.425 s. Those preparation figures use an already imported GTFS snapshot; the original 31.716 s preparation also included GTFS import, so they are not directly comparable.

The workload is unchanged: 88 destinations, 93 origins, 120 departure samples at 30-second intervals, 100 m raster, thresholds 15/30/45/60 minutes, 849,404 walking vertices, 911,018 walking edges, 256 lines (217 active), 3,282 stops. All origins connect, no unconnected stops. Final raw score: **108.74038749999998 km²**.

Reports and complete results:

- `artifacts/network-quality/krakow-benchmark.json` and `.result.json`: original reference.
- `artifacts/network-quality/krakow-optimized-benchmark.json` and `.result.json`: current four-worker implementation.
- `artifacts/network-quality/krakow-optimized-2-workers-benchmark.json` and `.result.json`: current two-worker implementation, completed successfully.
- `artifacts/network-quality/krakow-normalization-benchmark.json`: earlier walking-only reference, 41.116 s before the new optimization. No new optimized walking-only or complete cold normalized-request benchmark yet.

## What changed to improve speed

1. `src/lib/meanAccessibility.ts` builds the common accessibility graph once for all origins, prunes unprotected walking dead-end trees, contracts suitable degree-two chains, and creates compact CSR arrays. Transit attachment points, origin snaps, direction changes and junctions are retained. A one-origin profile reduced roughly 865k total nodes to 131k retained nodes.
2. `src/lib/native/meanRouting.c` is a freestanding C routing kernel compiled to WebAssembly. It uses f64 time values, numeric heaps, reusable buffers, incremental backward departure sampling and sparse piecewise-constant arrival profiles. It reconstructs chain interiors from both endpoint profiles and restores removed tree nodes. This preserves the sampled mean field rather than approximating it.
3. `src/lib/meanRoutingKernel.ts` copies prepared arrays into WASM once and reuses the solver for successive origins. Returned time arrays are copied so a later origin cannot mutate an earlier result.
4. `src/lib/meanRoutingWasm.ts` embeds the generated WASM as base64 with its C-source SHA256. `scripts/build-mean-routing.mjs` regenerates it (`npm run build:routing-kernel`). Clang/wasm-ld are needed only to regenerate the checked-in module, not for ordinary builds or runtime. Current payload was generated from the current C implementation.
5. `src/lib/accessibilityRaster.ts` exposes a serializable prepared raster and `rasterAreasKm2`, so graph/raster preparation can be shared.
6. `src/lib/networkQuality.ts` separates model preparation (`prepareNetworkQualityModel`) from computation (`calculatePreparedNetworkQualityAsync`) and can compute subsets of origins. `combineNetworkQualityParts` validates a complete, disjoint partition and merges partial results.
7. `server/networkQuality.worker.mjs` prepares the model once in a coordinator, copies numeric arrays to SharedArrayBuffer, and distributes origins round-robin among compute workers. Children receive the compact prepared model rather than a cloned full OSM network. An earlier attempt that cloned/rebuilt the full network per child took 110.764 s; the shared version takes 76.501 s.
8. `server/networkQualityRunner.mjs` automatically uses up to four workers for graphs with at least 50k coordinates, bounded by available CPUs and a free-memory heuristic (1.5 GiB per worker). Small graphs use one. An optional fourth argument `{ workers: 1..4 }` supports explicit benchmarks. Work runs outside the HTTP event loop with a 15-minute timeout.

A single-origin profile went from roughly 6.2–6.6 s to 2.81 s cold and 0.76–0.79 s on repeated prepared calculations. Per-node times differed by at most about 2.7e-12 minutes in that comparison.

## Important correctness constraints

- Every shard must use the SAME model prepared with ALL origin snaps and the SAME raster. Splitting the POI catalog before graph preparation changes edge splitting/raster geometry and can change scores.
- Do not reconstruct interior chain means from endpoint means alone: the winning endpoint can differ between departure samples. The kernel deliberately retains endpoint profiles and processes their crossings.
- Do not cap individual departure travel times at 60 or 120 minutes merely because the largest mean threshold is 60. Long headways can make individual samples much longer while their mean remains relevant.
- Preserve one-way walking directions, scheduled boarding semantics and the original 1e-9 departure epsilon. No sample reduction, coarser raster or heuristic time cutoff was used.

## Existing feature implementation

- `src/lib/networkQualityPlaces.ts`: separate catalog, version `2026-11-04.v2`, weights 1/2/3; AGH and UJ Ruczaj use three anchors each and UR two, sharing each destination's weight.
- `artifacts/network-quality/miejsca.kmz` and `.kml`: geographic review exports, generated by `scripts/export-quality-places.mjs`.
- `server/networkQuality.mjs`: asynchronous `POST /api/network-quality` with `{ proposal, period, scale? }`, polling `GET /api/network-quality/:id`, and places endpoint. Default raw scale; `scale: "gtfs"` uses `(candidate - walking) / (GTFS - walking) * 100`, with null for a zero reference gain. Reference calculations are cached separately. The feature has no UI.
- Shared GTFS/Overpass acquisition is integrated through `server/gtfs.mjs`, `server/overpass.mjs`, `server/index.mjs` and Vite.
- Production embeds a separately bundled worker via `scripts/build-server.mjs`; development lazily compiles the worker with esbuild.
- Walking Overpass budget was raised to 192 MiB / 2 million geometry vertices to handle the actual Kraków response (~154 MiB JSON, 1.296 million geometry vertices).

## Verification state: finish this before calling the work complete

- The last full suite passed **184 tests**, BEFORE the latest prepared-model sharing refactor and the latest tree/parallel/hash tests were added.
- TypeScript checking passed after the shared-model refactor. `git diff --check` passed at the last check.
- Both real full-city benchmarks above exercise the latest shared-model worker path and match the original result.
- **The full suite, production build and production smoke test have NOT been rerun on the final version.** New tests include tree restoration, profile correctness, result-buffer isolation, partition merging, real two-worker equivalence, and generated-WASM source-hash/import checks.
- README/test documentation still needs review: earlier documentation describes the old timing and single-worker architecture.
- No final optimized normalization benchmark or worker cancellation/memory stress test has been completed.

Use Node 22: this environment's system Node 26 crashed tests natively. A working Node binary and installed dependencies are already present:

```sh
PATH=/tmp/node-v22.23.4-linux-x64/bin:$PATH npm test
PATH=/tmp/node-v22.23.4-linux-x64/bin:$PATH npm run build
PATH=/tmp/node-v22.23.4-linux-x64/bin:$PATH npm run test:production
```

Some test subprocess/loopback-listen operations need sandbox escalation in this environment. Do not interpret sandbox EPERM as an application regression. Rebuild before the production smoke test so it does not test stale bundles. The production smoke script uses local fixtures, not live GTFS downloads.

## Reproducing the full-city benchmark

Existing input files on this machine (temporary files may not survive transfer):

- `/tmp/transplan-walking-mail.json`: raw validated OSM walking response.
- `/tmp/transplan-city-snapshot.json`: imported GTFS snapshot used in comparisons.
- `/tmp/transplan-GTFS-T.zip`, `/tmp/transplan-GTFS-A.zip`, `/tmp/transplan-GTFS-M.zip`: source feeds.
- `data/overpass/0877af51a18c2b8359d070986f1e340682fbbe980432edf9becb8a0dc7681264.json.gz`: cached gzip of walking data (~22 MiB).

```sh
/tmp/node-v22.23.4-linux-x64/bin/node scripts/benchmark-quality-city.mjs \
  --walking /tmp/transplan-walking-mail.json \
  --gtfs /tmp/transplan-city-snapshot.json \
  --workers 4 \
  --compare-result artifacts/network-quality/krakow-benchmark.result.json \
  --output artifacts/network-quality/krakow-optimized-benchmark.json
```

The script also accepts raw feed ZIP arguments `--tram`, `--bus`, `--mobilis`, period/runs options and a walking-reference mode; inspect it before varying inputs. The original benchmark report records input hashes/feed versions. Current comparison checks result areas and final score against the saved reference, not input hashes automatically.

## Suggested next work

1. Run the outstanding validation and fix any failures, then update documentation.
2. Profile the remaining 76.5 s, including preparation/structured cloning, WASM routing and per-origin JS raster processing. The full network is still cloned once from the runner into the coordinator; repeated jobs still rebuild the prepared model.
3. Consider a bounded prepared-model cache or a resident worker/model, with keys covering network, proposal, period, catalog and raster options. Measure memory before retaining large graphs.
4. Benchmark the complete cold normalized request and subsequent cached-reference requests. Current 76.5 s is one raw GTFS-network evaluation, not all three evaluations of a cold normalized request.
5. Keep the full-city exact-result comparison when optimizing. Four workers currently outperform two on this machine; no latest single-worker full-city timing is available.

## Follow-up by Claude Code (2026-11-04, afternoon)

Validation finished on the final version: `tsc`, full suite **187/187**, `npm run build`, `npm run test:production` (all pass) and `git diff --check`.

**The 76.5 s above was measured on a throttled CPU.** On the same machine at full clock, the *unchanged* four-worker implementation took 26.4–27.8 s; the laptop (15 W, `powersave` governor) swings between 0.8 and 3.1 GHz, so single runs vary by ±2 s and earlier figures can be ~3× too slow. Compare only runs made back to back.

Inputs were rebuilt after `/tmp` was wiped: the walking extract from `data/overpass/0877af51….json.gz` (same byte size and OSM timestamp) and a GTFS snapshot re-imported from freshly downloaded feeds with the same versions (T 20261103, A 20261103_20261104, M 1699_1700_1701_1697). Every run reproduces the reference exactly (max place-area error 0).

Changes:

1. `meanRouting.c` restore: crossings are bucketed at the first interior vertex past them (binary search) instead of insertion sort. That was ~67 M shifts per origin; restore 165 → 138 ms per origin in wasm. Only the summation order changes (max time difference 1.8e-12 min; areas identical).
2. `accessibilityRaster.ts` preparation: dense `Int32Array` cell index and growable typed columns instead of `Map` + plain arrays, and `Math.sqrt` instead of `Math.hypot`. Preparation 4.0 → ~3.0 s; all prepared arrays byte-identical.

End to end with 4 workers the gain is within noise (final 25.9–27.7 s vs. 26.4–27.8 s for the original kernel). Report: `krakow-final-benchmark.json`.

Tried and rejected (measured in wasm, not just natively):

- 4-ary heap: 20% faster natively with bit-identical output, but **slower** in V8 wasm (318 vs 278 ms).
- Node state as a struct, heap entries as structs, compacted boarding lists, forced inlining: no gain or slower in wasm.
- Hilbert-curve node renumbering: bit-identical results, no measurable gain (OSM order is already spatially coherent enough).
- 8 workers (hyperthreads): 21.0 s vs. 25.9 s in one run; a modest gain with more memory, so the cap stays at 4.

Where the time goes now (per origin, single thread, wasm, 3.1 GHz): solve ~280 ms (120-sample loop ~85%: ~1.45 M heap pops, 3.8 M relaxations), restore ~138 ms, raster ~40 ms. Preparation ~3 s, then structured clone + worker start ~2–3 s. Remaining large wins need a change of approach, not micro-tuning: reusing a resident prepared model/workers between evaluations (only stops/lines change between proposals), or fewer heap operations in the sample loop.
