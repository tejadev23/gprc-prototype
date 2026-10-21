import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePick, marksMatchRenderedPage, rasterIsCurrent, resolveStationPage } from "../lib/corridor/page-ref";
import { applyCalibration } from "../lib/corridor/calibration";
import { createStation } from "../lib/corridor/stations";
import { emptyProject, independentProjectCopy } from "../lib/corridor/storage";

const base = () => createStation("10+50")!;

test("resolveStationPage keeps 1-based pages and reports bad references", () => {
  const s = { name: "10+50", pageNumber: 3 as number | null };
  assert.deepEqual(resolveStationPage(s, 8), { ok: true, page: 3 });
  assert.deepEqual(resolveStationPage({ ...s, pageNumber: 8 }, 8), { ok: true, page: 8 });
  for (const page of [0, 9, -1, 2.5]) {
    const r = resolveStationPage({ ...s, pageNumber: page }, 8);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "invalid");
    assert.match(!r.ok ? r.message : "", /10\+50 points to page/);
  }
  const none = resolveStationPage({ ...s, pageNumber: null }, 8);
  assert.equal(!none.ok && none.reason, "no-page");
  const noPdf = resolveStationPage(s, null);
  assert.equal(!noPdf.ok && noPdf.reason, "no-pdf");
});

test("a pick claims the page for a station without one", () => {
  assert.deepEqual(decidePick(base(), 4), { allow: true, assignPage: true });
});

test("a pick on the station's own page is allowed and keeps the page", () => {
  const s = { ...base(), pageNumber: 4 };
  assert.deepEqual(decidePick(s, 4), { allow: true, assignPage: false });
});

test("browsing to another page never moves a marked station", () => {
  const s = { ...base(), pageNumber: 4, existing: [{ offset: 0, elevation: 1 }] };
  const d = decidePick(s, 5);
  assert.equal(d.allow, false);
  const calibrated = { ...base(), pageNumber: 4 };
  calibrated.calibration = applyCalibration([
    { px: 1, py: 1, offset: 0, elevation: 0 },
    { px: null, py: null, offset: null, elevation: null },
    { px: null, py: null, offset: null, elevation: null },
  ]);
  assert.equal(decidePick(calibrated, 5).allow, false);
});

test("an empty station may be re-pointed at the page being viewed", () => {
  assert.deepEqual(decidePick({ ...base(), pageNumber: 4 }, 5), { allow: true, assignPage: true });
});

test("marks draw only on the page that is actually rendered", () => {
  assert.equal(marksMatchRenderedPage(3, 3), true);
  assert.equal(marksMatchRenderedPage(3, 7), false, "station A must not paint on page B");
  assert.equal(marksMatchRenderedPage(3, null), false, "a page that is still loading shows no marks");
  assert.equal(marksMatchRenderedPage(null, 3), true, "a station with no page yet may use the page on screen");
  assert.equal(marksMatchRenderedPage(null, null), false);
});

test("duplicating a project copies station pages and traces onto a new id", () => {
  const source = emptyProject("Lakeside");
  const station = createStation("20+50")!;
  station.pageNumber = 4;
  station.existing = [{ offset: -10, elevation: 100 }];
  station.proposed = [{ offset: 10, elevation: 98 }];
  station.calibration = applyCalibration([
    { px: 0, py: 0, offset: 0, elevation: 0 },
    { px: 100, py: 0, offset: 10, elevation: 0 },
    { px: 0, py: 100, offset: 0, elevation: 10 },
  ]);
  source.stations = [station];
  source.activeStationId = station.id;
  const copy = independentProjectCopy(source, "Lakeside copy", "2026-10-17T00:00:00.000Z");
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.stations[0].pageNumber, 4);
  assert.equal(copy.stations[0].existing[0].elevation, 100);
  assert.equal(copy.stations[0].calibration.transform != null, true);
  copy.stations[0].pageNumber = 9;
  copy.stations[0].existing = [];
  assert.equal(source.stations[0].pageNumber, 4);
  assert.equal(source.stations[0].existing.length, 1);
});

test("stale rasters are rejected: A, B, A page switching", () => {
  const doc = {};
  const other = {};
  const pageA = { doc, page: 2 };
  const pageB = { doc, page: 7 };
  assert.equal(rasterIsCurrent(pageA, doc, 2), true);
  assert.equal(rasterIsCurrent(pageA, doc, 7), false, "A's image must not draw while B is shown");
  assert.equal(rasterIsCurrent(pageB, doc, 7), true);
  assert.equal(rasterIsCurrent(pageB, doc, 2), false);
  assert.equal(rasterIsCurrent(pageA, other, 2), false, "a replaced PDF invalidates the image");
  assert.equal(rasterIsCurrent(null, doc, 2), false);
  assert.equal(rasterIsCurrent(pageA, null, 2), false);
});
