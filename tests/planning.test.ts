import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAKT, TAKT_OPTIONS } from "../src/constants";
import { dailyLineCost, dailyNetworkCost } from "../src/lib/costs";
import { TAKT_STEPS, taktStepIndex, taktFromPosition } from "../src/lib/takt";
import { wholeMinuteTimes } from "../src/lib/travelTime";
import { useStore } from "../src/store";
import type { TransitLine } from "../src/types";

const oneKm = 1000 / 111194.92664455874;
const route: TransitLine = {
  id: "cost", number: "1", name: "Cost", mode: "bus", color: "#000", vehicle: "12m", visible: false,
  outboundStopIds: ["a", "b"], inboundStopIds: ["b", "a"], terminus1Id: "a", terminus2Id: "b", layoverMin: 5,
  takt: { ...DEFAULT_TAKT, wd_early: null, wd_am: 10, wd_mid: null, wd_pm: null, wd_eve: null,
    we_morn: 20, we_day: null, we_late: null },
  segments: [
    { id: "out", direction: "outbound", fromStopId: "a", toStopId: "b", geometry: [[19.94, 50], [19.94, 50 + oneKm]], travelMin: 2.5 },
    { id: "in", direction: "inbound", fromStopId: "b", toStopId: "a", geometry: [[19.94, 50 + oneKm], [19.94, 50]], travelMin: 3.5 },
  ],
};

test("network cost uses both directions and the duration of active timetable periods", () => {
  const weekday = dailyLineCost(route, "weekday");
  // Three hours at a 10-minute takt: 18 departures in each direction, 36 km.
  assert.ok(Math.abs(weekday.vehicleKm - 36) < 1e-6);
  assert.ok(Math.abs(weekday.cost - 36 * 14.09) < 1e-6);
  assert.ok(Math.abs(dailyLineCost(route, "weekend").cost - 24 * 14.09) < 1e-6);
  const network = dailyNetworkCost([route, { ...route, id: "tram", mode: "tram" }], "weekday");
  assert.ok(Math.abs(network.cost - 36 * (14.09 + 28.33)) < 1e-6);
  assert.equal(dailyNetworkCost([], "weekday").cost, 0);
});

test("every configured headway occupies one equally spaced slider step", () => {
  assert.deepEqual(TAKT_STEPS, [null, ...[...TAKT_OPTIONS].reverse()]);
  for (let i = 0; i < TAKT_STEPS.length; i++) {
    assert.equal(taktFromPosition(i / (TAKT_STEPS.length - 1)), TAKT_STEPS[i]);
    assert.equal(taktStepIndex(TAKT_STEPS[i]), i);
  }
  assert.equal(taktFromPosition(-1), null);
  assert.equal(taktFromPosition(2), TAKT_OPTIONS[0]);
});

test("saved and manually entered segment times use whole minutes", () => {
  const normalized = wholeMinuteTimes([route])[0];
  assert.deepEqual(normalized.segments.map((s) => s.travelMin), [3, 4]);
  useStore.setState({ lines: [normalized] });
  useStore.getState().setSegmentTime(route.id, "out", 5.6);
  assert.equal(useStore.getState().lines[0].segments[0].travelMin, 6);
  useStore.getState().setSegmentTime(route.id, "out", 0.4);
  assert.equal(useStore.getState().lines[0].segments[0].travelMin, 1);
});
