import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCalibration, pxToReal } from "../lib/corridor/calibration";
import { knownDistanceAgrees, knownDistanceScale } from "../lib/corridor/known-distance";
import { nextNavMode } from "../lib/corridor/nav";
import {
  adoptPdfPlanSpace,
  convertStationToPdfUser,
  displayRenderScale,
  legacyRasterScale,
  migrateStationsToPdfUser,
} from "../lib/corridor/pdf-space";
import { displayProfile, insertOnDisplaySegment, nearestSegment } from "../lib/corridor/profile";
import { createStation, reuseSource } from "../lib/corridor/stations";
import { emptyAlignment } from "../lib/corridor/alignment";
import type { Calibration, Station } from "../lib/corridor/types";
import { cssToImage, imageToCss, pan } from "../lib/tracing/coords";
import { isEditableTarget, resolveShortcut, type ShortcutContext } from "../lib/ui/shortcuts";

const baseShortcut: ShortcutContext = {
  editable: false,
  drawerOpen: false,
  overlayOpen: false,
  insertActive: false,
  moveActive: false,
  expanded: false,
  fullscreen: false,
  pointerLocked: false,
  roaming: false,
  mod: false,
  alt: false,
};

function placed(name: string, page: number, stationFt: number): Station {
  const station = createStation(name);
  assert.ok(station);
  const calibration: Calibration = applyCalibration([
    { px: 0, py: 0, offset: 0, elevation: 100 },
    { px: 100, py: 0, offset: 10, elevation: 100 },
    { px: 0, py: -50, offset: 0, elevation: 110 },
  ]);
  return { ...station, stationFt, pageNumber: page, calibration, pdfSpace: "pdf-user" };
}

test("pan moves the drawing with the pointer and keeps image coordinates", () => {
  const view = { scale: 2, originX: 10, originY: 20 };
  const image = { x: 30, y: 40 };
  const moved = pan(view, 15, -5);
  assert.deepEqual(imageToCss(image, moved), { x: imageToCss(image, view).x + 15, y: imageToCss(image, view).y - 5 });
  assert.deepEqual(cssToImage({ x: 50, y: 30 }, view), cssToImage({ x: 65, y: 25 }, moved));
});

test("insert puts the new point between the chosen vertices and leaves the others", () => {
  const points = [
    { offset: 0, elevation: 10 },
    { offset: 10, elevation: 11 },
    { offset: 20, elevation: 9 },
    { offset: 30, elevation: 12 },
  ];
  const next = insertOnDisplaySegment(points, 2, { offset: 25, elevation: 8 });
  assert.deepEqual(
    next.map((point) => point.offset),
    [0, 10, 20, 25, 30],
  );
  assert.deepEqual(displayProfile(next).map((point) => point.elevation), [10, 11, 9, 8, 12]);
  assert.deepEqual(points.map((point) => point.offset), [0, 10, 20, 30]);
});

test("nearest segment hit is the closest edge, not the polyline end", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ];
  const hit = nearestSegment(points, 16, 1, 5);
  assert.ok(hit);
  assert.equal(hit.index, 1);
  assert.ok(hit.t > 0.5 && hit.t < 0.7);
  assert.equal(nearestSegment(points, 16, 20, 5), null);
});

test("escape dismisses a dialog before it leaves an expanded workspace", () => {
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, drawerOpen: true, expanded: true, fullscreen: true }), "close-drawer");
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, overlayOpen: true, expanded: true }), "dismiss-overlay");
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, insertActive: true, expanded: true }), "cancel-insert");
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, moveActive: true, expanded: true }), "cancel-move");
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, expanded: true, fullscreen: true }), "exit-expanded");
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, fullscreen: true }), "exit-fullscreen");
  assert.equal(resolveShortcut("Escape", { ...baseShortcut, pointerLocked: true, fullscreen: true }), "ignore");
});

test("delete and undo stay out of text fields; space pans unless free roam owns it", () => {
  assert.equal(resolveShortcut("Backspace", { ...baseShortcut, editable: true }), "native");
  assert.equal(resolveShortcut("Delete", baseShortcut), "delete");
  assert.equal(resolveShortcut("z", { ...baseShortcut, mod: true }), "undo");
  assert.equal(resolveShortcut("z", { ...baseShortcut, mod: true, editable: true }), "native");
  assert.equal(resolveShortcut("Enter", baseShortcut), "ignore");
  assert.equal(resolveShortcut(" ", baseShortcut), "space-pan");
  assert.equal(resolveShortcut(" ", { ...baseShortcut, roaming: true }), "native");
  assert.equal(resolveShortcut(" ", { ...baseShortcut, roaming: true, expanded: true }), "space-pan");
  assert.equal(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget), false);
});

test("free roam toggles off and frames the corridor", () => {
  assert.deepEqual(nextNavMode("orbit", "roam"), { mode: "roam", frame: false });
  assert.deepEqual(nextNavMode("roam", "roam"), { mode: "orbit", frame: true });
  assert.deepEqual(nextNavMode("orbit", "orbit"), { mode: "orbit", frame: false });
});

test("reuse offers the nearest calibrated station on another page", () => {
  const far = placed("10+00", 1, 1000);
  const near = placed("12+00", 2, 1200);
  const active = createStation("12+50");
  assert.ok(active);
  active.pageNumber = 4;
  assert.equal(reuseSource([far, near, active], active, 4)?.id, near.id);
  const own = placed("12+50", 4, 1250);
  assert.equal(reuseSource([far, near, own], own, 9)?.id, own.id);
});

test("legacy raster pixels convert to the same engineering point", () => {
  const userWidth = 612;
  const userHeight = 792;
  const scale = legacyRasterScale(userWidth, userHeight);
  assert.equal(scale, 4);
  const legacy = applyCalibration([
    { px: 100, py: 400, offset: 0, elevation: 100 },
    { px: 500, py: 400, offset: 50, elevation: 100 },
    { px: 100, py: 200, offset: 0, elevation: 120 },
  ]);
  assert.ok(legacy.transform);
  const before = pxToReal(legacy.transform, 300, 300);
  const station = createStation("10+00");
  assert.ok(station);
  station.pdfSpace = "legacy-raster";
  station.pageNumber = 1;
  station.calibration = legacy;
  const converted = convertStationToPdfUser(station, userWidth, userHeight);
  assert.equal(converted.pdfSpace, "pdf-user");
  assert.ok(converted.calibration.transform);
  const after = pxToReal(converted.calibration.transform, 300 / scale, 300 / scale);
  assert.ok(Math.abs(after.offset - before.offset) < 1e-6);
  assert.ok(Math.abs(after.elevation - before.elevation) < 1e-6);
  assert.deepEqual(converted.existing, station.existing);
});

test("pdf user migration does not scale a station twice", async () => {
  const station = createStation("11+00");
  assert.ok(station);
  station.pageNumber = 1;
  station.calibration = applyCalibration([
    { px: 10, py: 10, offset: 0, elevation: 100 },
    { px: 20, py: 10, offset: 10, elevation: 100 },
    { px: 10, py: 0, offset: 0, elevation: 110 },
  ]);
  const doc = {
    numPages: 1,
    async getPage() {
      return { getViewport: () => ({ width: 200, height: 100 }) };
    },
  };
  const once = await migrateStationsToPdfUser(doc, [{ ...station, pdfSpace: "legacy-raster" }]);
  const twice = await migrateStationsToPdfUser(doc, once);
  assert.equal(twice[0]?.calibration.points[1]?.px, once[0]?.calibration.points[1]?.px);
});

test("plan adoption scales legacy pixels once and keeps a pdf-user plan", () => {
  const alignment = emptyAlignment();
  alignment.points = [{ x: 40, y: 80 }];
  alignment.markers = [{ id: "m", label: "10+00", stationFt: 1000, distancePx: 40, stationId: null }];
  const first = adoptPdfPlanSpace({
    planSpace: null,
    alignment,
    georef: null,
    userWidth: 612,
    userHeight: 792,
  });
  assert.equal(first.changed, true);
  assert.equal(first.alignment.points[0]?.x, 10);
  assert.equal(first.alignment.markers[0]?.distancePx, 10);
  const second = adoptPdfPlanSpace({
    planSpace: first.planSpace,
    alignment: first.alignment,
    georef: first.georef,
    userWidth: 612,
    userHeight: 792,
  });
  assert.equal(second.changed, false);
  assert.equal(second.alignment.points[0]?.x, 10);
});

test("known-distance scale is feet per pixel and does not invent an origin", () => {
  const hundred = knownDistanceScale({ ax: 0, ay: 0, bx: 100, by: 0, distanceFt: 100, pageNumber: 1 });
  const twoHundred = knownDistanceScale({ ax: 0, ay: 0, bx: 100, by: 0, distanceFt: 200, pageNumber: 1 });
  assert.equal(hundred, 1);
  assert.equal(twoHundred, 2);
  assert.equal(knownDistanceScale({ ax: 1, ay: 1, bx: 1, by: 1, distanceFt: 10, pageNumber: null }), null);
  const transform = { ox: 5, oy: 9, sx: 1, sy: -1 };
  assert.equal(knownDistanceAgrees({ ax: 0, ay: 0, bx: 100, by: 0, distanceFt: 100, pageNumber: 1 }, transform), true);
  assert.equal(knownDistanceAgrees({ ax: 0, ay: 0, bx: 100, by: 0, distanceFt: 200, pageNumber: 1 }, transform), false);
  assert.deepEqual(transform, { ox: 5, oy: 9, sx: 1, sy: -1 });
});

test("display scale is quantized and capped", () => {
  assert.equal(displayRenderScale(612, 792, 1.2, 2), 2);
  assert.equal(displayRenderScale(612, 792, 8, 2), 8);
  const capped = displayRenderScale(20000, 1000, 8, 2);
  assert.ok(capped <= 8192 / 20000 + 1e-6);
});
