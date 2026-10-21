import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAlignment, type PlanAlignment } from "../lib/corridor/alignment";
import { buildAlignedCorridorGeometry } from "../lib/corridor/alignment-geometry";
import { applyCalibration } from "../lib/corridor/calibration";
import { createStation } from "../lib/corridor/stations";
import type { ProfilePoint, Station } from "../lib/corridor/types";
import { computeAreas } from "../lib/corridor/areas";
import { averageEndAreaVolumes } from "../lib/corridor/volumes";

function section(name: string, existing: ProfilePoint[], proposed: ProfilePoint[]): Station {
  const s = createStation(name)!;
  s.calibration = applyCalibration([
    { px: 0, py: 0, offset: 0, elevation: 0 },
    { px: 100, py: 0, offset: 10, elevation: 0 },
    { px: 0, py: 100, offset: 0, elevation: 10 },
  ]);
  s.existing = existing;
  s.proposed = proposed;
  return s;
}

const flat = (elev: number): ProfilePoint[] => [
  { offset: -10, elevation: elev },
  { offset: 0, elevation: elev },
  { offset: 10, elevation: elev },
];

function line(stations: Station[]): PlanAlignment {
  return {
    ...emptyAlignment(),
    points: [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
    ],
    markers: stations.map((s, i) => ({
      id: `m${i}`,
      label: s.name,
      stationFt: s.stationFt,
      distancePx: (s.stationFt - stations[0].stationFt) * 10,
      stationId: s.id,
    })),
  };
}

test("existing above proposed draws cut walls; the reverse draws fill walls", () => {
  const cutA = section("0+00", flat(10), flat(8));
  const cutB = section("0+50", flat(10), flat(8));
  const cut = buildAlignedCorridorGeometry([cutA, cutB], line([cutA, cutB]));
  assert.deepEqual(cut.ribbons.map((mesh) => mesh.kind).sort(), ["existing", "proposed"]);
  assert.deepEqual(cut.prisms.map((p) => p.kind), ["cut"]);
  assertWallsBetween(cut.prisms[0], 8, 10);
  const volumes = averageEndAreaVolumes([cutA, cutB]);
  assert.equal(volumes.fillCy, 0);
  assert.ok(Math.abs(volumes.cutCy - (40 * 50) / 27) < 1e-9);

  const fillA = section("0+00", flat(8), flat(10));
  const fillB = section("0+50", flat(8), flat(10));
  const fill = buildAlignedCorridorGeometry([fillA, fillB], line([fillA, fillB]));
  assert.deepEqual(fill.ribbons.map((mesh) => mesh.kind).sort(), ["existing", "proposed"]);
  assert.deepEqual(fill.prisms.map((p) => p.kind), ["fill"]);
  assertWallsBetween(fill.prisms[0], 8, 10);
});

/** Viewer Y is elevation minus the scene base. A wall triangle uses both surfaces; a cap would use only one. */
function assertWallsBetween(mesh: { positions: Float32Array; indices: Uint32Array }, low: number, high: number) {
  assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0);
  const base = Math.floor(low / 10) * 10 - 5;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ys = [0, 1, 2].map((k) => mesh.positions[mesh.indices[i + k] * 3 + 1] + base);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    assert.ok(Math.abs(min - low) < 1e-3 && Math.abs(max - high) < 1e-3, `wall ${min}..${max}`);
  }
}

test("a mixed bay produces both cut and fill", () => {
  const a = section("0+00", flat(10), [
    { offset: -10, elevation: 8 },
    { offset: 0, elevation: 10 },
    { offset: 10, elevation: 12 },
  ]);
  const b = section("0+50", flat(10), [
    { offset: -10, elevation: 8 },
    { offset: 0, elevation: 10 },
    { offset: 10, elevation: 12 },
  ]);
  const g = buildAlignedCorridorGeometry([a, b], line([a, b]));
  assert.deepEqual(g.prisms.map((p) => p.kind).sort(), ["cut", "fill"]);
});

test("a missing section opens a gap: no ribbons or prisms bridge it", () => {
  const a = section("0+00", flat(10), flat(8));
  const gap = createStation("0+50")!; // record with no profiles
  const c = section("1+00", flat(10), flat(8));
  const g = buildAlignedCorridorGeometry([a, gap, c], line([a, gap, c]));
  assert.equal(g.prisms.length, 0);
  assert.equal(g.ribbons.length, 0);
  assert.equal(g.labels.find((l) => l.stationId === gap.id)?.missing, true);
});

test("equal surfaces produce no prisms", () => {
  const a = section("0+00", flat(10), flat(10));
  const b = section("0+50", flat(10), flat(10));
  assert.equal(buildAlignedCorridorGeometry([a, b], line([a, b])).prisms.length, 0);
});

test("volume math ignores the geometry and is unchanged", () => {
  const a = section("0+00", flat(10), flat(8));
  const b = section("0+50", flat(10), flat(8));
  const areas = computeAreas(a)!;
  assert.ok(Math.abs(areas.cut - 40) < 1e-9, `cut area ${areas.cut}`);
  const before = JSON.stringify(averageEndAreaVolumes([a, b]));
  buildAlignedCorridorGeometry([a, b], line([a, b]));
  assert.equal(JSON.stringify(averageEndAreaVolumes([a, b])), before);
});
