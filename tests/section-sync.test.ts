import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCalibration } from "../lib/corridor/calibration";
import { computeAreas } from "../lib/corridor/areas";
import { convertStationToPdfUser } from "../lib/corridor/pdf-space";
import { acceptPageRaster, framePoints, sectionPixels, stationById, turnPage, viewForStation } from "../lib/corridor/section-sync";
import { createStation } from "../lib/corridor/stations";
import { imageToCss } from "../lib/tracing/coords";
import type { Station } from "../lib/corridor/types";

function withSection(name: string, page: number, originX: number, originY: number): Station {
  const station = createStation(name);
  assert.ok(station);
  station.pageNumber = page;
  station.calibration = applyCalibration([
    { px: originX, py: originY, offset: 0, elevation: 100 },
    { px: originX + 100, py: originY, offset: 10, elevation: 100 },
    { px: originX, py: originY - 40, offset: 0, elevation: 110 },
  ]);
  station.existing = [
    { offset: -10, elevation: 100 },
    { offset: 10, elevation: 102 },
  ];
  station.proposed = [
    { offset: -10, elevation: 104 },
    { offset: 10, elevation: 104 },
  ];
  return station;
}

test("selecting a station shows that station's page and its own traces", () => {
  const a = withSection("107+65", 2, 40, 700);
  const b = withSection("110+09.29", 5, 40, 120);
  const first = viewForStation(a, 8, 1);
  assert.equal(first.page, 2);
  assert.equal(stationById([a, b], a.id)?.existing[0]?.elevation, 100);
  const second = viewForStation(b, 8, first.page);
  assert.equal(second.page, 5);
  assert.equal(stationById([a, b], b.id)?.name, "110+09.29");
  assert.notEqual(stationById([a, b], b.id)?.calibration.points[0]?.py, a.calibration.points[0]?.py);
});

test("two stations on one page keep distinct calibration and traces", () => {
  const upper = withSection("108+00", 3, 30, 80);
  const lower = withSection("110+09.29", 3, 30, 640);
  assert.equal(viewForStation(upper, 4, 1).page, viewForStation(lower, 4, 1).page);
  assert.equal(stationById([upper, lower], lower.id)?.id, lower.id);
  assert.notEqual(stationById([upper, lower], lower.id)?.calibration, upper.calibration);
  assert.notDeepEqual(sectionPixels(upper), sectionPixels(lower));
});

test("a stale page render is rejected after the selection moves on", () => {
  assert.equal(acceptPageRaster(2, 2), true);
  assert.equal(acceptPageRaster(2, 5), false);
});

test("turning the page does not retarget the station, and selecting it returns to its page", () => {
  const station = withSection("110+09.29", 4, 10, 10);
  const before = station.pageNumber;
  const viewed = turnPage(4, 1, 6);
  assert.equal(viewed, 5);
  assert.equal(station.pageNumber, before);
  assert.equal(viewForStation(station, 6, viewed).page, 4);
});

test("selection does not rewrite calibration or apply the PDF conversion again", () => {
  const station = withSection("12+00", 1, 80, 200);
  const before = station.calibration.points.map((point) => [point.px, point.py]);
  viewForStation(station, 3, 1);
  assert.deepEqual(
    station.calibration.points.map((point) => [point.px, point.py]),
    before,
  );
  const user = convertStationToPdfUser({ ...station, pdfSpace: "pdf-user" }, 612, 792);
  assert.equal(user.calibration.points[0]?.px, station.calibration.points[0]?.px);
});

test("framing centers the selected section rather than another diagram on the same page", () => {
  const upper = withSection("108+00", 3, 100, 80);
  const lower = withSection("110+09.29", 3, 100, 700);
  const upperView = framePoints(800, 600, sectionPixels(upper));
  const lowerView = framePoints(800, 600, sectionPixels(lower));
  assert.ok(upperView && lowerView);
  const upperHit = imageToCss({ x: 100, y: 80 }, upperView);
  const lowerHit = imageToCss({ x: 100, y: 700 }, lowerView);
  assert.ok(Math.abs(upperHit.x - 400) < 120 && Math.abs(upperHit.y - 300) < 160);
  assert.ok(Math.abs(lowerHit.x - 400) < 120 && Math.abs(lowerHit.y - 300) < 160);
  assert.ok(Math.abs(upperView.originY - lowerView.originY) > 50);
});

test("saved stations still resolve by id after a round trip, and areas follow that station", () => {
  const a = withSection("107+65", 2, 40, 700);
  const b = withSection("110+09.29", 2, 40, 200);
  b.proposed = [
    { offset: -10, elevation: 90 },
    { offset: 10, elevation: 90 },
  ];
  const saved = structuredClone([a, b]);
  const opened = stationById(saved, b.id);
  assert.equal(opened?.pageNumber, 2);
  assert.equal(opened?.calibration.transform?.ox, b.calibration.transform?.ox);
  assert.equal(opened?.existing.length, b.existing.length);
  const activeAreas = computeAreas(opened);
  const otherAreas = computeAreas(stationById(saved, a.id));
  assert.ok(activeAreas && otherAreas);
  assert.notEqual(activeAreas.cut, otherAreas.cut);
});
