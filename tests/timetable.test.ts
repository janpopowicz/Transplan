import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TAKT } from "../src/constants";
import type { TransitLine } from "../src/types";
import { buildTimetable, cleanCoordination, coordinationEdges, coordinationPlan, findSharedSections, formatDeparture, modulo, shiftDeparture, timetableDepartures } from "../src/lib/timetable";
import { useStore } from "../src/store";

function line(id: string, stops: string[], takt = 10): TransitLine {
  return { id, number: id, name: id, mode: "tram", vehicle: "33m", color: "#123456", visible: true,
    outboundStopIds: stops, inboundStopIds: [...stops].reverse(), terminus1Id: stops[0], terminus2Id: stops.at(-1)!,
    takt: Object.fromEntries(Object.keys(DEFAULT_TAKT).map((id) => [id, takt])) as TransitLine["takt"], layoverMin: 5,
    segments: (["outbound", "inbound"] as const).flatMap((direction) => {
      const ids = direction === "outbound" ? stops : [...stops].reverse();
      return ids.slice(1).map((id, i) => ({ id: `${direction}-${i}`, direction, fromStopId: ids[i], toStopId: id, geometry: [], travelMin: 3 }));
    }) };
}
function example() {
  const a = { ...line("7A", ["Kurdwanów", "Górka", "Łagiewniki", "Borek"]), coordinatedLineIds: ["7B", "8"] };
  const b = { ...line("7B", ["Kurdwanów", "Górka", "B-terminal"]), coordinatedLineIds: ["7A"] };
  const c = { ...line("8", ["C-terminal", "Łagiewniki", "Borek"], 5), coordinatedLineIds: ["7A"] };
  return [a, b, c];
}
function assertRelations(lines: TransitLine[]) {
  const plan = coordinationPlan(lines, "wd_am");
  assert.deepEqual(plan.issues, []);
  for (const { a, b } of coordinationEdges(lines)) {
    const first = lines.find((l) => l.id === a)!, second = lines.find((l) => l.id === b)!;
    for (const section of findSharedSections([first, second])) {
      const departures = section.runs.map((route, i) => {
        const run = plan.runs.find((r) => r.lineId === route.lineId && r.direction === route.direction)!;
        return run.phase + run.elapsed[section.starts[i]];
      });
      const fastest = Math.min(first.takt.wd_am!, second.takt.wd_am!);
      assert.ok(Math.abs(modulo(departures[1] - departures[0], fastest) - fastest / 2) < 1e-7, `${a}–${b} ${section.runs[0].direction}`);
    }
  }
  return plan.runs;
}

test("7A–7B and 7A–8 coordinate on different corridors in both directions", () => {
  const routes = example();
  assert.deepEqual(findSharedSections(routes), []);
  const runs = assertRelations(routes);
  const a = runs.find((r) => r.lineId === "7A" && r.direction === "outbound")!;
  const b = runs.find((r) => r.lineId === "7B" && r.direction === "outbound")!;
  assert.equal(modulo(b.phase - a.phase, 10), 5);
  const c = runs.find((r) => r.lineId === "8" && r.direction === "outbound")!;
  assert.equal(modulo(a.phase + a.elapsed[2] - c.phase - c.elapsed[1], 5), 2.5);
});

test("editing any member rotates the entire linked network, all periods and both directions", () => {
  const routes = [...example(), line("unrelated", ["x", "y"])];
  const before = assertRelations(routes);
  const c = before.find((r) => r.lineId === "8" && r.direction === "inbound")!;
  const shifted = shiftDeparture(routes, "8", modulo(c.phase, c.headway) + 1.25, "wd_am", "inbound");
  const after = assertRelations(shifted);
  for (const run of before) {
    const next = after.find((r) => r.lineId === run.lineId && r.direction === run.direction)!;
    assert.ok(Math.abs(modulo(next.phase - run.phase, run.headway) - (run.lineId === "unrelated" ? 0 : 1.25)) < 1e-7);
  }
  assert.equal(shifted.at(-1), routes.at(-1));
  const eve = buildTimetable(shifted, "wd_eve"), originalEve = buildTimetable(routes, "wd_eve");
  for (let i = 0; i < eve.length - 2; i++) assert.ok(Math.abs(modulo(eve[i].phase - originalEve[i].phase, eve[i].headway) - 1.25) < 1e-7);
  assert.deepEqual(buildTimetable([...shifted].reverse(), "wd_am").sort((a,b)=>a.lineId.localeCompare(b.lineId)||a.direction.localeCompare(b.direction)),
    [...after].sort((a,b)=>a.lineId.localeCompare(b.lineId)||a.direction.localeCompare(b.direction)));
});

test("solver chooses alternate slow-line slots to satisfy a compatible cycle", () => {
  const a = { ...line("A", ["x", "y"], 5), coordinatedLineIds: ["B", "C"] };
  const b = { ...line("B", ["x", "y"]), coordinatedLineIds: ["A", "C"] };
  const c = { ...line("C", ["x", "y"]), coordinatedLineIds: ["A", "B"] };
  const runs = assertRelations([a, b, c]);
  assert.equal(modulo(runs.find((r) => r.lineId === "C")!.phase - runs.find((r) => r.lineId === "B")!.phase, 10), 5);
});

test("incompatible takts and contradictory cycles are reported without promising an even takt", () => {
  const a = { ...line("A", ["x", "y"], 10), coordinatedLineIds: ["B"] };
  const b = { ...line("B", ["x", "y"], 15), coordinatedLineIds: ["A"] };
  const plan = coordinationPlan([a, b], "wd_am");
  assert.equal(plan.issues[0].kind, "incompatible");
  assert.ok(plan.runs.every((r) => r.phase === 0));
  const triangle = ["A", "B", "C"].map((id) => ({ ...line(id, ["x", "y"]), coordinatedLineIds: ["A", "B", "C"].filter((other) => id !== other) }));
  assert.ok(coordinationPlan(triangle, "wd_am").issues.some((i) => i.kind === "conflict"));
});

test("legacy groups migrate to reciprocal pair links and deleted IDs do not reappear", () => {
  const old = [line("A", ["x", "y"]), line("B", ["x", "y"])].map((l) => ({ ...l, coordinationId: "old" }));
  const migrated = cleanCoordination(old);
  assert.deepEqual(migrated.map((l) => l.coordinatedLineIds), [["B"], ["A"]]);
  assert.ok(migrated.every((l) => !l.coordinationId));
  assert.equal(coordinationEdges(cleanCoordination(migrated.slice(0, 1))).length, 0);
});

test("generated timetable uses the same takt, phase and travel times as routing", () => {
  const route = { ...line("A", ["x", "y"], 7.5), departureOffsetMin: 2.5 };
  const run = buildTimetable([route], "wd_am")[0];
  assert.deepEqual(timetableDepartures(run, "wd_am").map(formatDeparture),
    ["06:02:30", "06:10", "06:17:30", "06:25", "06:32:30", "06:40", "06:47:30", "06:55"]);
  assert.equal(formatDeparture(timetableDepartures(run, "wd_am", 1)[0]), "06:05:30");
  assert.equal(formatDeparture(timetableDepartures(buildTimetable([route], "wd_eve")[0], "wd_eve")[0]), "18:02:30");
});

test("store can add the second corridor and shift all connected lines without a common three-line section", () => {
  const routes = example().map((l) => ({ ...l, coordinatedLineIds: undefined }));
  useStore.setState({ access: "local", lines: routes });
  useStore.getState().coordinateLines("7A", "7B");
  useStore.getState().coordinateLines("7A", "8");
  assertRelations(useStore.getState().lines);
  const runs = buildTimetable(useStore.getState().lines, "wd_am"), c = runs.find((r) => r.lineId === "8")!;
  useStore.getState().setDepartureOffset("8", c.phase + 2, "wd_am", c.direction);
  assertRelations(useStore.getState().lines);
  assert.ok(useStore.getState().lines.every((l) => l.departureOffsetMin === 2));
});

test("pair coordination follows physical direction even when route direction labels are reversed", () => {
  const routes = example(), c = routes[2];
  routes[2] = { ...c, outboundStopIds: c.inboundStopIds, inboundStopIds: c.outboundStopIds,
    terminus1Id: c.terminus2Id, terminus2Id: c.terminus1Id,
    segments: c.segments.map((s) => ({ ...s, direction: s.direction === "outbound" ? "inbound" : "outbound" })) };
  assertRelations(routes);
});
