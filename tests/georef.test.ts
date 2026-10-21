import assert from "node:assert/strict";
import { test } from "node:test";
import { CRS_OPTIONS, findCrs, projectedToWgs84, unitToFeet, unitToMeters, wgs84ToProjected } from "../lib/corridor/georef/crs";
import { defaultGeoref, normalizeGeoref, type CompleteControlPoint, type Georef } from "../lib/corridor/georef/model";
import { haversineMeters, resolveGeoreference } from "../lib/corridor/georef/pipeline";
import { applyTransform, fitTransform, type PlanTransform } from "../lib/corridor/georef/transform";
import { normalizeGprcRecord } from "../lib/corridor/storage";

const West = findCrs("EPSG:2240")!;
const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

// Ground truth: scale s units/px, image +x is rotated `deg` counter-clockwise from east, image y is down.
function truth(s: number, deg: number, tx: number, ty: number): PlanTransform {
  const a = (deg * Math.PI) / 180;
  return { method: "similarity", m11: s * Math.cos(a), m12: s * Math.sin(a), m21: s * Math.sin(a), m22: -s * Math.cos(a), tx, ty };
}
function pt(id: string, px: number, py: number, t: PlanTransform, noise: [number, number] = [0, 0], check = false): CompleteControlPoint {
  const at = applyTransform(t, px, py);
  return { id, name: id, px, py, easting: at.easting + noise[0], northing: at.northing + noise[1], ...(check ? { check: true } : {}) };
}
const opts = { units: "ft-us" as const, method: "similarity" as const };

// ---- CRS -------------------------------------------------------------------------------------------

/** Meridian arc length on GRS80, standard series. Independent of proj4. */
function meridianArc(phiDeg: number): number {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = 2 * f - f * f;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const phi = (phiDeg * Math.PI) / 180;
  return (
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

test("Georgia West origin: 84°10'W, 30°N is 700 000 m / 0", () => {
  const p = wgs84ToProjected(findCrs("EPSG:26967")!, -84 - 10 / 60, 30);
  close(p.easting, 700000, 0.001);
  close(p.northing, 0, 0.001);
});

test("northing on the central meridian follows k0 times the independent meridian arc", () => {
  for (const [code, lon] of [["EPSG:26967", -84 - 10 / 60], ["EPSG:26966", -82 - 10 / 60]] as const) {
    for (const lat of [31, 32.5, 34.9]) {
      const p = wgs84ToProjected(findCrs(code)!, lon, lat);
      const expected = 0.9999 * (meridianArc(lat) - meridianArc(30));
      close(p.northing, expected, 0.01, `${code} ${lat}`);
    }
  }
});

test("US survey feet and metres describe the same ground point", () => {
  const m = findCrs("EPSG:26967")!;
  const ft = West;
  const metersPerFt = unitToMeters("ft-us");
  close(metersPerFt, 0.3048006096, 1e-9);
  close(unitToFeet("m"), 3.280839895, 1e-8);
  for (const [e, n] of [[765264.8, 370336.2], [700000, 100000], [640000, 20000]]) {
    const a = projectedToWgs84(m, e, n);
    const b = projectedToWgs84(ft, e / metersPerFt, n / metersPerFt);
    close(a.lon, b.lon, 1e-9);
    close(a.lat, b.lat, 1e-9);
  }
});

test("projected -> WGS84 -> projected round trips in every supported CRS", () => {
  for (const crs of CRS_OPTIONS) {
    const lon = crs.code.includes("East") || crs.code === "EPSG:2239" || crs.code === "EPSG:26966" ? -82.3 : -83.8;
    const there = wgs84ToProjected(crs, lon, 33.2);
    const back = projectedToWgs84(crs, there.easting, there.northing);
    close(back.lon, lon, 1e-9);
    close(back.lat, 33.2, 1e-9);
  }
});

test("the Georgia West sample from a plan sheet lands inside Georgia", () => {
  const p = projectedToWgs84(West, 2510642.3191, 1215053.7945);
  assert.ok(p.lat > 33 && p.lat < 33.7 && p.lon > -83.8 && p.lon < -83.1, `${p.lat}, ${p.lon}`);
});

test("initial CRS is Georgia West ftUS and is not treated as verified", () => {
  const g = defaultGeoref();
  assert.equal(g.crs.code, "EPSG:2240");
  assert.equal(g.crs.units, "ft-us");
  assert.equal(g.crs.verified, false);
  assert.equal(findCrs("EPSG:2240")!.name, "NAD83 / Georgia West (ftUS)");
});

// ---- fit -------------------------------------------------------------------------------------------

test("two points recover a known similarity exactly, with the image y flip", () => {
  const t = truth(2.5, 30, 2500000, 1200000);
  const fit = fitTransform([pt("A", 100, 200, t), pt("B", 900, 150, t)], opts);
  assert.ok(fit.ok);
  if (!fit.ok) return;
  for (const [x, y] of [[0, 0], [500, 500], [1234, 77]]) {
    const want = applyTransform(t, x, y);
    const got = applyTransform(fit.transform, x, y);
    close(got.easting, want.easting, 1e-6);
    close(got.northing, want.northing, 1e-6);
  }
  close(fit.report.scaleUnitsPerPx, 2.5, 1e-9);
  close(fit.report.rotationDeg, 30, 1e-9);
  assert.equal(fit.report.quality, "unvalidated");
  assert.ok(fit.report.warnings.some((w) => w.code === "exact-fit"));
  // Unrotated case: moving right in the image moves east, moving down moves south.
  const flat = fitTransform([pt("A", 0, 0, truth(1, 0, 10, 20)), pt("B", 100, 0, truth(1, 0, 10, 20))], opts);
  assert.ok(flat.ok);
  if (flat.ok) {
    assert.ok(applyTransform(flat.transform, 0, 100).northing < applyTransform(flat.transform, 0, 0).northing);
    assert.ok(applyTransform(flat.transform, 100, 0).easting > applyTransform(flat.transform, 0, 0).easting);
  }
});

test("noisy 4-point fit: residuals sum to zero, rms is as reported, and no nudge improves it", () => {
  const t = truth(2, -15, 2400000, 1100000);
  const noise: [number, number][] = [[1.5, -0.5], [-1, 1.2], [0.4, 0.9], [-0.8, -1.4]];
  const pts = [pt("A", 50, 80, t, noise[0]), pt("B", 950, 120, t, noise[1]), pt("C", 940, 600, t, noise[2]), pt("D", 70, 640, t, noise[3])];
  const fit = fitTransform(pts, opts);
  assert.ok(fit.ok);
  if (!fit.ok) return;
  const sse = (m: PlanTransform) =>
    pts.reduce((sum, p) => {
      const at = applyTransform(m, p.px, p.py);
      return sum + (at.easting - p.easting) ** 2 + (at.northing - p.northing) ** 2;
    }, 0);
  const best = sse(fit.transform);
  let sumE = 0;
  let sumN = 0;
  for (const p of pts) {
    const at = applyTransform(fit.transform, p.px, p.py);
    sumE += at.easting - p.easting;
    sumN += at.northing - p.northing;
  }
  close(sumE, 0, 1e-6);
  close(sumN, 0, 1e-6);
  const unitsToFt = unitToFeet("ft-us");
  close(fit.report.rmsFt!, Math.sqrt((best / pts.length)) * unitsToFt, 1e-9);
  const m = fit.transform;
  const tweaks: Partial<PlanTransform>[] = [{ tx: 0.05 }, { ty: -0.05 }, { m11: 1e-5, m22: -1e-5 }, { m12: 1e-5, m21: 1e-5 }, { m11: -1e-5, m22: 1e-5 }];
  for (const tweak of tweaks) {
    const nudged = { ...m, ...Object.fromEntries(Object.entries(tweak).map(([k, v]) => [k, (m as unknown as Record<string, number>)[k] + (v as number)])) } as PlanTransform;
    assert.ok(sse(nudged) >= best - 1e-9, `tweak ${JSON.stringify(tweak)} improved the fit`);
  }
  assert.equal(fit.report.quality, "consistent");
});

test("insufficient and coincident points are refused with a reason", () => {
  const t = truth(1, 0, 0, 0);
  const none = fitTransform([pt("A", 1, 1, t)], opts);
  assert.equal(none.ok, false);
  assert.ok(!none.ok && none.warnings.some((w) => w.code === "insufficient"));
  const same = fitTransform([pt("A", 10, 10, t), pt("B", 10.2, 10.1, t)], opts);
  assert.equal(same.ok, false);
  assert.ok(!same.ok && same.warnings.some((w) => w.code === "coincident"));
});

test("collinear points are flagged; affine refuses them", () => {
  const t = truth(2, 10, 1000, 2000);
  const line = [pt("A", 0, 0, t), pt("B", 500, 100, t), pt("C", 1000, 200, t), pt("D", 1500, 300, t)];
  const sim = fitTransform(line, opts);
  assert.ok(sim.ok && sim.report.warnings.some((w) => w.code === "collinear"));
  const aff = fitTransform(line, { ...opts, method: "affine" });
  assert.equal(aff.ok, false);
  assert.ok(!aff.ok && aff.warnings.some((w) => w.code === "collinear"));
});

test("affine is not available below four control points", () => {
  const t = truth(2, 10, 1000, 2000);
  const three = fitTransform([pt("A", 0, 0, t), pt("B", 800, 20, t), pt("C", 300, 600, t)], { ...opts, method: "affine" });
  assert.equal(three.ok, false);
  assert.ok(!three.ok && three.warnings.some((w) => w.code === "affine-needs-four"));
});

test("affine recovers a sheared plan that a similarity fit cannot, and warns about distortion first", () => {
  const shear: PlanTransform = { method: "affine", m11: 2, m12: 0.08, m21: 0.02, m22: -2.1, tx: 5000, ty: 7000 };
  const pts = [pt("A", 0, 0, shear), pt("B", 1000, 0, shear), pt("C", 1000, 700, shear), pt("D", 0, 700, shear), pt("E", 500, 350, shear)];
  const aff = fitTransform(pts, { ...opts, method: "affine" });
  assert.ok(aff.ok);
  if (aff.ok) {
    assert.ok(aff.report.maxFt! < 1e-6);
    const got = applyTransform(aff.transform, 321, 123);
    const want = applyTransform(shear, 321, 123);
    close(got.easting, want.easting, 1e-6);
    close(got.northing, want.northing, 1e-6);
    assert.ok(aff.report.warnings.some((w) => w.code === "affine-anisotropy"), "affine always explains what it did to the scale");
  }
  const sim = fitTransform(pts, opts);
  assert.ok(sim.ok);
  if (sim.ok) {
    assert.ok(sim.report.maxFt! > 5);
    assert.ok(sim.report.warnings.some((w) => w.code === "possible-distortion"));
  }
});

test("an outlier is named, and the others are left alone", () => {
  const t = truth(2, 12, 2500000, 1200000);
  const pts = [
    pt("A", 100, 100, t),
    pt("B", 900, 140, t),
    pt("C", 880, 640, t),
    pt("D", 120, 600, t),
    pt("E", 500, 360, t, [60, -40]),
    pt("F", 300, 80, t),
  ];
  const fit = fitTransform(pts, opts);
  assert.ok(fit.ok);
  if (!fit.ok) return;
  const flagged = fit.report.residuals.filter((r) => r.outlier).map((r) => r.id);
  assert.deepEqual(flagged, ["E"]);
  assert.ok(fit.report.warnings.some((w) => w.code === "outlier" && w.pointId === "E"));
});

test("check points are validated against the fit but never change it", () => {
  const t = truth(2, 5, 2500000, 1200000);
  const base = [pt("A", 100, 100, t), pt("B", 900, 140, t), pt("C", 500, 600, t)];
  const withoutCheck = fitTransform(base, opts);
  const withCheck = fitTransform([...base, pt("X", 700, 300, t, [4, 3], true)], opts);
  assert.ok(withoutCheck.ok && withCheck.ok);
  if (!withoutCheck.ok || !withCheck.ok) return;
  assert.deepEqual(withCheck.transform, withoutCheck.transform);
  close(withCheck.report.checkMaxFt!, 5 * unitToFeet("ft-us"), 1e-6);
  assert.equal(withCheck.report.controlCount, 3);
  assert.equal(withCheck.report.checkCount, 1);
  assert.notEqual(withCheck.report.quality, "unvalidated");
});

test("fit scale is cross-checked against the traced stationing", () => {
  const t = truth(2, 0, 0, 0); // 2 ftUS per px
  const pts = [pt("A", 0, 0, t), pt("B", 1000, 0, t)];
  const ft = unitToFeet("ft-us") * 2;
  const bad = fitTransform(pts, { ...opts, stationingFtPerPx: ft * 0.9 });
  assert.ok(bad.ok && bad.report.warnings.some((w) => w.code === "scale-vs-stationing"));
  const fine = fitTransform(pts, { ...opts, stationingFtPerPx: ft * 1.01 });
  assert.ok(fine.ok && !fine.report.warnings.some((w) => w.code === "scale-vs-stationing"));
});

test("points that cover little of the plan are called out", () => {
  const t = truth(2, 0, 0, 0);
  const near = fitTransform([pt("A", 0, 0, t), pt("B", 200, 0, t)], { ...opts, raster: { width: 10000, height: 3000 } });
  assert.ok(near.ok && near.report.warnings.some((w) => w.code === "poor-spread"));
});

// ---- pipeline --------------------------------------------------------------------------------------

function georefFrom(lonlat: [number, number][], pixels: [number, number][], patch: Partial<Georef> = {}): Georef {
  const g = defaultGeoref();
  g.crs.verified = true;
  g.points = lonlat.map(([lon, lat], i) => {
    const p = wgs84ToProjected(West, lon, lat);
    return { id: `P${i}`, name: `P${i}`, px: pixels[i][0], py: pixels[i][1], easting: p.easting, northing: p.northing };
  });
  return { ...g, ...patch };
}

test("pixel -> projected -> lon/lat reproduces the geographic points the control came from", () => {
  const known: [number, number][] = [[-83.50, 33.30], [-83.44, 33.34], [-83.47, 33.31]];
  // Pixel layout consistent with a north-up plan at 2 ftUS/px
  const en = known.map(([lon, lat]) => wgs84ToProjected(West, lon, lat));
  const px = en.map((p) => [(p.easting - en[0].easting) / 2, -(p.northing - en[0].northing) / 2] as [number, number]);
  const result = resolveGeoreference(georefFrom(known, px), { raster: null });
  assert.ok(result.ok);
  if (!result.ok) return;
  known.forEach(([lon, lat], i) => {
    const got = result.georeference.pixelToLonLat(px[i][0], px[i][1]);
    close(got.lon, lon, 1e-8);
    close(got.lat, lat, 1e-8);
    close(result.checks[i].groundErrorM, 0, 1e-3);
  });
  assert.deepEqual(result.blockers, []);
});

test("an unverified CRS blocks export but not inspection", () => {
  const known: [number, number][] = [[-83.50, 33.30], [-83.44, 33.34]];
  const en = known.map(([lon, lat]) => wgs84ToProjected(West, lon, lat));
  const px = en.map((p) => [(p.easting - en[0].easting) / 2, -(p.northing - en[0].northing) / 2] as [number, number]);
  const g = georefFrom(known, px);
  g.crs.verified = false;
  const result = resolveGeoreference(g);
  assert.ok(result.ok && result.blockers.some((b) => b.includes("Confirm")));
});

test("wrong units or zone put points outside the CRS area and say so", () => {
  const g = defaultGeoref();
  g.crs.verified = true;
  // metre values typed into a ftUS CRS
  g.points = [
    { id: "a", px: 0, py: 0, easting: 765264.8, northing: 370336.2 },
    { id: "b", px: 1000, py: 0, easting: 765864.8, northing: 370336.2 },
  ];
  const r = resolveGeoreference(g);
  assert.ok(r.ok && r.warnings.some((w) => w.code === "outside-crs-area"));
});

test("a replaced plan raster invalidates the stored control points", () => {
  const g = defaultGeoref();
  g.crs.verified = true;
  g.raster = { width: 4000, height: 1000 };
  const t = truth(2, 0, 2500000, 1200000);
  g.points = [pt("a", 0, 0, t), pt("b", 1000, 0, t)];
  const r = resolveGeoreference(g, { raster: { width: 5000, height: 1000 } });
  assert.ok(r.ok && r.blockers.some((b) => b.includes("plan image changed")));
});

test("an unsupported CRS code is reported, not guessed", () => {
  const g = defaultGeoref();
  g.crs = { code: "EPSG:99999", units: "m", verified: true };
  const r = resolveGeoreference(g);
  assert.equal(r.ok, false);
});

test("haversine sanity: one degree of latitude is about 111 km", () => {
  close(haversineMeters({ lon: 0, lat: 0 }, { lon: 0, lat: 1 }), 111195, 50);
});

// ---- persistence -----------------------------------------------------------------------------------

test("records saved before georeferencing still load, with no georef", () => {
  const old = normalizeGprcRecord({ planFileName: "plan.png", pane: "sections" });
  assert.equal(old.georef, null);
  assert.equal(old.planFileName, "plan.png");
  assert.equal(normalizeGprcRecord(null).georef, null);
});

test("stored georef keeps its inputs, drops bad points, and never stores derived values", () => {
  const raw = {
    crs: { code: "EPSG:2240", units: "m", verified: true },
    points: [
      { id: "ok", name: "MH-1", px: 10, py: 20, easting: 1, northing: 2, check: true },
      { id: "bad", px: NaN, py: 1, easting: 1, northing: 1 },
      { px: 1, py: 1, easting: 1, northing: 1 },
    ],
    method: "affine",
    raster: { width: 100, height: 50 },
    vertical: { datum: "NAVD88", units: "ft-us" },
    transform: { m11: 1 },
    residuals: [1],
  };
  const g = normalizeGeoref(raw)!;
  assert.equal(g.points.length, 1);
  assert.equal(g.crs.units, "ft-us", "units follow the known CRS definition");
  assert.equal(g.method, "affine");
  assert.equal(g.vertical.datum, "NAVD88");
  assert.deepEqual(Object.keys(g).sort(), ["crs", "method", "points", "raster", "vertical"]);
  const record = normalizeGprcRecord({ georef: raw as unknown as Georef });
  assert.equal(record.georef?.points[0].name, "MH-1");
});

test("a duplicated record is independent of the original", () => {
  const record = normalizeGprcRecord({ georef: defaultGeoref() });
  const copy = structuredClone(record);
  copy.georef!.points.push({ id: "x", px: 1, py: 1, easting: 1, northing: 1 });
  assert.equal(record.georef!.points.length, 0);
});

test("a control point without coordinates is kept but left out of the fit", () => {
  const t = truth(2, 0, 2500000, 1200000);
  const pending = { id: "new", name: "CP3", px: 400, py: 300, easting: null, northing: null };
  const fit = fitTransform([pt("a", 0, 0, t), pt("b", 1000, 0, t), pending], opts);
  assert.ok(fit.ok);
  if (!fit.ok) return;
  assert.equal(fit.report.controlCount, 2);
  assert.ok(fit.report.warnings.some((w) => w.code === "incomplete-point" && w.pointId === "new"));
  const g = normalizeGeoref({ ...defaultGeoref(), points: [pending] })!;
  assert.equal(g.points.length, 1);
  assert.equal(g.points[0].easting, null);
});
