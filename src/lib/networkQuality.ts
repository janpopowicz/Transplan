import { BBOX, type PeriodId } from "../constants";
import type { Stop, TransitLine } from "../types";
import { prepareMeanAccessibilityModel, createMeanAccessibilitySolver } from "./meanAccessibility";
import { prepareAreaRaster, rasterAreasKm2 } from "./accessibilityRaster";
import { NETWORK_QUALITY_PLACES, NETWORK_QUALITY_CATALOG_VERSION, type QualityPlace } from "./networkQualityPlaces";
import type { WalkingNetwork } from "./walkingNetwork";

export const QUALITY_THRESHOLDS = [15, 30, 45, 60] as const;
export const QUALITY_RESOLUTION_METERS = 100;
export interface NetworkQualityRequest {
  stops: Stop[];
  lines: TransitLine[];
  period: PeriodId;
  network: WalkingNetwork;
  /** Engine-only override for experiments/tests; HTTP uses the versioned catalog. */
  places?: readonly QualityPlace[];
}
export interface PlaceQuality {
  id: string;
  name: string;
  weight: number;
  areasKm2: number[];
  scoreKm2: number;
  anchors: { coord: [number, number]; connected: boolean; snapMeters: number | null }[];
}
export interface NetworkQualityResult {
  metric: "weighted-isochrone-area-v1";
  catalogVersion: string;
  period: PeriodId;
  scenario: "mean";
  direction: "from-places";
  scoreKm2: number;
  thresholdsMinutes: readonly number[];
  weightedAreasKm2: number[];
  resolutionMeters: number;
  bbox: typeof BBOX;
  walkingFetchedAt: number;
  totalWeight: number;
  connectedWeight: number;
  complete: boolean;
  activeLines: number;
  unconnectedStops: number;
  places: PlaceQuality[];
  normalization?: {
    scale: "gtfs-baseline-100";
    score: number | null;
    baselineDate: string;
    baselineScoreKm2: number;
    walkingOnlyScoreKm2: number;
    reason?: "baseline-has-no-transit-gain";
  };
}

/** Remove walking accessibility before scaling: no transit = 0, today's GTFS
 * = 100, an improvement may exceed 100. Degenerate baselines have no scale.
 * All three fields must use the same walking data, places and service period. */
export function normalizeNetworkQuality(result: NetworkQualityResult, baseline: NetworkQualityResult,
  walkingOnly: NetworkQualityResult, baselineDate: string): NetworkQualityResult {
  const signature = (value: NetworkQualityResult) => JSON.stringify([value.metric, value.catalogVersion,
    value.period, value.scenario, value.direction, value.thresholdsMinutes, value.resolutionMeters, value.bbox,
    value.walkingFetchedAt, value.places.map((place) => [place.id, place.weight, place.anchors.map((a) => a.coord)])]);
  const key = signature(result);
  if (signature(baseline) !== key || signature(walkingOnly) !== key
    || !/^\d{8}$/.test(baselineDate) || ![result.scoreKm2, baseline.scoreKm2, walkingOnly.scoreKm2].every(Number.isFinite)) {
    throw new Error("Niezgodne warunki normalizacji jakości sieci.");
  }
  const gain = baseline.scoreKm2 - walkingOnly.scoreKm2;
  const available = gain > 1e-9;
  return { ...result, normalization: { scale: "gtfs-baseline-100",
    score: available ? Math.max(0, 100 * (result.scoreKm2 - walkingOnly.scoreKm2) / gain) : null,
    baselineDate, baselineScoreKm2: baseline.scoreKm2, walkingOnlyScoreKm2: walkingOnly.scoreKm2,
    ...(!available ? { reason: "baseline-has-no-transit-gain" as const } : {}) } };
}

export function prepareNetworkQualityModel(request: NetworkQualityRequest) {
  const places = request.places ?? NETWORK_QUALITY_PLACES;
  if (!places.length || new Set(places.map((p) => p.id)).size !== places.length
    || places.some((p) => !Number.isFinite(p.weight) || p.weight <= 0 || !p.points.length
      || p.points.some(({ coord }) => coord.length !== 2 || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])
        || coord[0] < BBOX.west || coord[0] > BBOX.east || coord[1] < BBOX.south || coord[1] > BBOX.north))) {
    throw new Error("Nieprawidłowy katalog miejsc metryki.");
  }
  const origins = places.flatMap((place) => place.points.map((point) => point.coord));
  const { graph, model } = prepareMeanAccessibilityModel(request, origins);
  const raster = prepareAreaRaster(graph.xy, graph.walkEdges, graph.project, QUALITY_RESOLUTION_METERS);
  return { places, origins, mean: model, raster: raster.model, period: request.period,
    walkingFetchedAt: request.network.fetchedAt, activeLines: graph.activeLines, unconnectedStops: graph.missed.size };
}

export type PreparedNetworkQuality = ReturnType<typeof prepareNetworkQualityModel>;

function calculationFromModel(model: PreparedNetworkQuality, originIndices?: readonly number[]) {
  const { places, origins } = model;
  const included = originIndices ? new Set(originIndices) : undefined;
  if (included && (included.size !== originIndices!.length || originIndices!.some((i) => !Number.isInteger(i) || i < 0 || i >= origins.length))) {
    throw new Error("Nieprawidłowy podział obliczeń metryki.");
  }
  const batch = createMeanAccessibilitySolver(model.mean);
  const results: PlaceQuality[] = places.map((p) => ({ id: p.id, name: p.name, weight: p.weight,
    areasKm2: QUALITY_THRESHOLDS.map(() => 0), scoreKm2: 0, anchors: [] }));
  let originIndex = 0, placeIndex = 0;
  return {
    total: origins.length,
    step() {
      const place = places[placeIndex], result = results[placeIndex];
      const access = !included || included.has(originIndex) ? batch.calculate(originIndex) : null;
      const areas = access ? rasterAreasKm2(model.raster, access.times, QUALITY_THRESHOLDS) : QUALITY_THRESHOLDS.map(() => 0);
      for (let i = 0; i < areas.length; i++) result.areasKm2[i] += areas[i] / place.points.length;
      result.anchors.push({ coord: origins[originIndex], connected: !!access, snapMeters: access?.originSnapMeters ?? null });
      if (result.anchors.length === place.points.length) {
        result.scoreKm2 = result.areasKm2.reduce((sum, area) => sum + area, 0) / QUALITY_THRESHOLDS.length;
        placeIndex++;
      }
      return ++originIndex;
    },
    result(): NetworkQualityResult {
      if (originIndex !== origins.length) throw new Error("Obliczenie metryki nie zostało zakończone.");
      const totalWeight = places.reduce((sum, p) => sum + p.weight, 0);
      const connectedWeight = results.reduce((sum, p) => sum + p.weight * p.anchors.filter((a) => a.connected).length / p.anchors.length, 0);
      const weightedAreasKm2 = QUALITY_THRESHOLDS.map((_, i) => results.reduce((sum, p) => sum + p.weight * p.areasKm2[i], 0) / totalWeight);
      return { metric: "weighted-isochrone-area-v1", catalogVersion: NETWORK_QUALITY_CATALOG_VERSION,
        period: model.period, scenario: "mean", direction: "from-places",
        scoreKm2: weightedAreasKm2.reduce((sum, area) => sum + area, 0) / QUALITY_THRESHOLDS.length,
        thresholdsMinutes: [...QUALITY_THRESHOLDS], weightedAreasKm2, resolutionMeters: QUALITY_RESOLUTION_METERS,
        bbox: { ...BBOX }, walkingFetchedAt: model.walkingFetchedAt, totalWeight, connectedWeight,
        complete: results.every((p) => p.anchors.every((a) => a.connected)),
        activeLines: model.activeLines, unconnectedStops: model.unconnectedStops, places: results };
    },
  };
}

/** Areas of the mean travel-time field, not the mean of 120 separate areas.
 * Higher is better. Each campus has one weight shared equally by its anchors.
 * Missing walking connections contribute zero, preserving the denominator. */
export function calculateNetworkQuality(request: NetworkQualityRequest): NetworkQualityResult {
  const calculation = calculationFromModel(prepareNetworkQualityModel(request));
  for (let i = 0; i < calculation.total; i++) calculation.step();
  return calculation.result();
}

/** Release the event loop between origins; server jobs report real progress. */
export async function calculateNetworkQualityAsync(request: NetworkQualityRequest,
  yieldBetweenOrigins: () => Promise<void>, progress: (completed: number, total: number) => void = () => {}, originIndices?: readonly number[]) {
  return calculatePreparedNetworkQualityAsync(prepareNetworkQualityModel(request), yieldBetweenOrigins, progress, originIndices);
}

export async function calculatePreparedNetworkQualityAsync(model: PreparedNetworkQuality,
  yieldBetweenOrigins: () => Promise<void>, progress: (completed: number, total: number) => void = () => {}, originIndices?: readonly number[]) {
  const calculation = calculationFromModel(model, originIndices);
  for (let i = 0; i < calculation.total; i++) {
    progress(calculation.step(), calculation.total);
    await yieldBetweenOrigins();
  }
  return calculation.result();
}

/** Merge a complete, disjoint partition. Every worker prepares the SAME graph
 * and raster with ALL origins; splitting the catalog itself changes edge snaps. */
export function combineNetworkQualityParts(parts: { indices: readonly number[]; result: NetworkQualityResult }[]): NetworkQualityResult {
  if (!parts.length) throw new Error("Brak wyników częściowych metryki.");
  const first = parts[0].result, origins = first.places.reduce((n, p) => n + p.anchors.length, 0);
  const owner = new Int32Array(origins).fill(-1);
  const signature = (r: NetworkQualityResult) => JSON.stringify([r.metric, r.catalogVersion, r.period,
    r.walkingFetchedAt, r.resolutionMeters, r.thresholdsMinutes, r.bbox, r.activeLines, r.unconnectedStops,
    r.places.map((p) => [p.id, p.weight, p.anchors.map((a) => a.coord)])]);
  const expected = signature(first);
  parts.forEach((part, i) => {
    if (signature(part.result) !== expected) throw new Error("Niezgodne wyniki częściowe metryki.");
    for (const index of part.indices) {
      if (!Number.isInteger(index) || index < 0 || index >= origins || owner[index] !== -1) throw new Error("Nieprawidłowy podział obliczeń metryki.");
      owner[index] = i;
    }
  });
  if (owner.some((i) => i < 0)) throw new Error("Niepełny podział obliczeń metryki.");
  let origin = 0;
  const places = first.places.map((p, placeIndex) => {
    const areasKm2 = p.areasKm2.map((_, band) => parts.reduce((sum, part) => sum + part.result.places[placeIndex].areasKm2[band], 0));
    return { ...p, areasKm2, scoreKm2: areasKm2.reduce((sum, area) => sum + area, 0) / areasKm2.length,
      anchors: p.anchors.map((_, point) => parts[owner[origin++]].result.places[placeIndex].anchors[point]) };
  });
  const totalWeight = places.reduce((sum, p) => sum + p.weight, 0);
  const weightedAreasKm2 = first.thresholdsMinutes.map((_, band) => places.reduce((sum, p) => sum + p.weight * p.areasKm2[band], 0) / totalWeight);
  return { ...first, places, totalWeight, weightedAreasKm2,
    scoreKm2: weightedAreasKm2.reduce((sum, area) => sum + area, 0) / weightedAreasKm2.length,
    connectedWeight: places.reduce((sum, p) => sum + p.weight * p.anchors.filter((a) => a.connected).length / p.anchors.length, 0),
    complete: places.every((p) => p.anchors.every((a) => a.connected)) };
}
