import assert from "node:assert/strict";
import { test } from "node:test";
import { createStation, parseStation, sortStationsByChainage, stationsMatch } from "../lib/corridor/stations";

function names(list: { name: string }[]) {
  return list.map((item) => item.name);
}

const make = (name: string) => {
  const station = createStation(name);
  assert.ok(station, name);
  return station;
};

test("parseStation reads plus notation and bare feet", () => {
  assert.equal(parseStation("20+50"), 2050);
  assert.equal(parseStation("22+00.04"), 2200.04);
  assert.equal(parseStation("9+99"), 999);
  assert.equal(parseStation("100+00"), 10000);
  assert.equal(parseStation("2050"), 2050);
  assert.ok(Number.isNaN(parseStation("")));
});

test("sortStationsByChainage is numeric, not lexicographic", () => {
  const input = ["22+00.04", "100+00", "21+00", "9+99", "20+75", "20+50"].map(make);
  assert.deepEqual(names(sortStationsByChainage(input)), ["9+99", "20+50", "20+75", "21+00", "22+00.04", "100+00"]);
  // A string sort would put 100+00 first and 9+99 last.
  assert.notDeepEqual(names(input.map((s) => s).sort((a, b) => a.name.localeCompare(b.name))), names(sortStationsByChainage(input)));
});

test("sortStationsByChainage keeps ids, numbers and the input array", () => {
  const input = ["21+00", "20+50"].map(make);
  const before = input.map((s) => [s.id, s.name, s.stationFt]);
  const sorted = sortStationsByChainage(input);
  assert.deepEqual(input.map((s) => [s.id, s.name, s.stationFt]), before);
  assert.equal(sorted[0], input[1]);
});

test("equal station feet sort by name then id, independent of input order", () => {
  const a = { ...make("20+50"), id: "a" };
  const b = { ...make("20+50.00"), id: "b" };
  assert.deepEqual(sortStationsByChainage([b, a]).map((s) => s.id), sortStationsByChainage([a, b]).map((s) => s.id));
});

test("stationsMatch treats 20+50 and 20+50.00 as one station", () => {
  assert.ok(stationsMatch(parseStation("20+50"), parseStation("20+50.00")));
  assert.ok(!stationsMatch(parseStation("20+50"), parseStation("20+50.01")));
});
