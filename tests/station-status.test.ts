import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAlignment, type AlignmentMarker, type PlanAlignment } from "../lib/corridor/alignment";
import { buildStationRows } from "../lib/corridor/station-status";
import { applyCalibration } from "../lib/corridor/calibration";
import { createStation } from "../lib/corridor/stations";
import type { Station } from "../lib/corridor/types";

function station(name: string, level: "none" | "calibrated" | "existing" | "ready" = "none"): Station {
  const s = createStation(name)!;
  if (level === "none") return s;
  s.calibration = applyCalibration([
    { px: 0, py: 0, offset: 0, elevation: 0 },
    { px: 100, py: 0, offset: 10, elevation: 0 },
    { px: 0, py: 100, offset: 0, elevation: 10 },
  ]);
  if (level === "calibrated") return s;
  s.existing = [
    { offset: -5, elevation: 5 },
    { offset: 5, elevation: 5 },
  ];
  if (level === "existing") return s;
  s.proposed = [
    { offset: -5, elevation: 4 },
    { offset: 5, elevation: 4 },
  ];
  return s;
}

function marker(label: string, stationFt: number, distancePx: number, stationId: string | null = null): AlignmentMarker {
  return { id: `m-${label}`, label, stationFt, distancePx, stationId };
}

function scaled(markers: AlignmentMarker[]): PlanAlignment {
  return { ...emptyAlignment(), points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], markers };
}

test("calibration fixture is usable", () => {
  assert.ok(station("1+00", "calibrated").calibration.transform);
});

test("sections without any mainline are 'unplaced' and sorted in engineering order", () => {
  const rows = buildStationRows([station("21+00", "ready"), station("9+99", "calibrated"), station("20+50")], emptyAlignment());
  assert.deepEqual(rows.map((r) => r.name), ["9+99", "20+50", "21+00"]);
  assert.ok(rows.every((r) => r.kind === "unplaced" && !r.onMainline && !r.ready3d));
  assert.deepEqual(rows.map((r) => r.calibrated), [true, false, true]);
  assert.equal(rows[2].existingTraced && rows[2].proposedTraced, true);
});

test("a marker links to its record by normalized station value, not by label text", () => {
  const rec = station("20+50", "ready");
  const a = scaled([marker("20+50.00", 2050, 0), marker("21+00", 2100, 500)]);
  const rows = buildStationRows([rec], a);
  const linked = rows.find((r) => r.stationId === rec.id)!;
  assert.equal(linked.onMainline, true);
  assert.equal(linked.ready3d, true);
  assert.equal(linked.kind, "ready");
  assert.equal(rows.length, 2, "no duplicate row for the matched marker");
});

test("a marker with no record is 'no-section' and keeps its own position in the order", () => {
  const a = scaled([marker("20+00", 2000, 0), marker("21+00", 2100, 500)]);
  const rows = buildStationRows([station("20+50", "ready")], a);
  assert.deepEqual(rows.map((r) => [r.name, r.kind]), [
    ["20+00", "no-section"],
    ["20+50", "unplaced"],
    ["21+00", "no-section"],
  ]);
  assert.equal(rows[0].hasRecord, false);
  assert.equal(rows[0].stationId, null);
});

test("not ready for 3D until the section is finished and the mainline scale exists", () => {
  const rec = station("20+50", "existing");
  const one = scaled([marker("20+50", 2050, 0, rec.id)]);
  assert.equal(buildStationRows([rec], one)[0].kind, "incomplete");
  const ready = station("20+50", "ready");
  const noScale = scaled([marker("20+50", 2050, 0, ready.id)]);
  assert.equal(buildStationRows([ready], noScale)[0].ready3d, false);
  const withScale = scaled([marker("20+50", 2050, 0, ready.id), marker("21+00", 2100, 500)]);
  assert.equal(buildStationRows([ready], withScale).find((r) => r.stationId === ready.id)!.ready3d, true);
});

test("rows are derived from the live records and never invent positions", () => {
  const rec = station("20+50", "ready");
  const a = scaled([marker("21+00", 2100, 500), marker("22+00", 2200, 900)]);
  const rows = buildStationRows([rec], a);
  const row = rows.find((r) => r.stationId === rec.id)!;
  assert.equal(row.markerId, null);
  assert.equal(row.onMainline, false);
  rec.proposed = [];
  assert.equal(buildStationRows([rec], a).find((r) => r.stationId === rec.id)!.proposedTraced, false);
});

import { relinkMarkers } from "../lib/corridor/station-status";

test("relinkMarkers repairs stale links by station value and never duplicates or overwrites", () => {
  const rec = station("20+50", "ready");
  const stale = scaled([marker("20+50.00", 2050, 0, "deleted-id"), marker("21+00", 2100, 500)]);
  const fixed = relinkMarkers(stale, [rec]);
  assert.equal(fixed.markers[0].stationId, rec.id);
  assert.equal(fixed.markers[1].stationId, null);
  assert.equal(stale.markers[0].stationId, "deleted-id", "input is not mutated");
  assert.equal(relinkMarkers(fixed, [rec]), fixed, "already linked: same object back");
  const twoMarkers = scaled([marker("20+50", 2050, 0), marker("20+50.00", 2050.0, 100)]);
  const out = relinkMarkers(twoMarkers, [rec]);
  assert.equal(out.markers.filter((m) => m.stationId === rec.id).length, 1);
  const live = scaled([{ ...marker("20+50", 2050, 0), stationId: rec.id }]);
  assert.equal(relinkMarkers(live, [rec, station("20+50")]), live, "a valid link is kept");
});
