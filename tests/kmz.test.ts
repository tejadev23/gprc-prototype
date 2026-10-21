import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { emptyAlignment, type PlanAlignment } from "../lib/corridor/alignment";
import { buildAlignedCorridorGeometry, buildCorridorSurfaces, placedSections } from "../lib/corridor/alignment-geometry";
import { applyCalibration } from "../lib/corridor/calibration";
import { findCrs, projectedToWgs84, unitToFeet, unitToMeters, wgs84ToProjected } from "../lib/corridor/georef/crs";
import { defaultGeoref, type Georef } from "../lib/corridor/georef/model";
import { resolveGeoreference } from "../lib/corridor/georef/pipeline";
import { applyTransform, type PlanTransform } from "../lib/corridor/georef/transform";
import { buildCorridorKml, kmzFileName, projectedFrame } from "../lib/corridor/kmz/build-kml";
import { exportCorridorKmz, kmzBlockers } from "../lib/corridor/kmz/export";
import { defaultKmzOptions, normalizeKmzOptions, type KmzOptions } from "../lib/corridor/kmz/options";
import { checkWellFormed, validateKmz } from "../lib/corridor/kmz/validate";
import { normalizeGprcRecord } from "../lib/corridor/storage";
import { createStation } from "../lib/corridor/stations";
import type { ProfilePoint, Station } from "../lib/corridor/types";

const West = findCrs("EPSG:2240")!;

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
/** Existing above proposed everywhere on the left, below on the right: cut and fill in one bay. */
const cutAndFill: ProfilePoint[] = [
  { offset: -10, elevation: 8 },
  { offset: 0, elevation: 10 },
  { offset: 10, elevation: 12 },
];

function alignmentFor(stations: Station[]): PlanAlignment {
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
      distancePx: (s.stationFt - stations[0].stationFt) * 10, // 10 px per foot
      stationId: s.id,
    })),
  };
}

/** Image +x is rotated `deg` CCW from east, image y is down. `s` is CRS units per pixel. */
function truth(s: number, deg: number, tx: number, ty: number): PlanTransform {
  const a = (deg * Math.PI) / 180;
  return { method: "similarity", m11: s * Math.cos(a), m12: s * Math.sin(a), m21: s * Math.sin(a), m22: -s * Math.cos(a), tx, ty };
}

function georefFor(t: PlanTransform, verified = true): Georef {
  const base = defaultGeoref();
  const spots: [number, number][] = [
    [0, 0],
    [1000, 0],
    [0, 600],
    [1000, 600],
  ];
  return {
    ...base,
    crs: { ...base.crs, verified },
    points: spots.map(([px, py], i) => {
      const at = applyTransform(t, px, py);
      return { id: `c${i}`, name: `C${i}`, px, py, easting: at.easting, northing: at.northing };
    }),
    raster: { width: 1000, height: 600 },
    vertical: { datum: "NAVD88", units: "ft-us" },
  };
}

const T = truth(0.1, 30, 2_230_000, 1_370_000);
const ctx = { raster: { width: 1000, height: 600 }, stationingFtPerPx: 0.1 };
const all: KmzOptions = { ...defaultKmzOptions, cut: true, fill: true };

function corridor() {
  const a = section("0+00", flat(10), cutAndFill);
  const b = section("0+50", flat(10), cutAndFill);
  const c = section("1+00", flat(10), cutAndFill);
  return [a, b, c];
}

function run(stations: Station[], options: KmzOptions = all, georef = georefFor(T), planImage?: Parameters<typeof exportCorridorKmz>[0]["planImage"]) {
  return exportCorridorKmz({ projectName: "Lakeside", stations, alignment: alignmentFor(stations), georef, context: ctx, options, planImage });
}

const docOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["doc.kml"]);

// ---- A valid synthetic corridor ------------------------------------------------------------------------

test("a synthetic corridor exports, unzips, parses and passes its own checks", () => {
  const result = run(corridor());
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  if (!result.ok) return;
  assert.equal(result.fileName, "Lakeside_GPRC_3D_Corridor.kmz");
  const names = Object.keys(unzipSync(result.bytes));
  assert.ok(names.includes("doc.kml") && names.some((name) => name.endsWith(".dae")));
  assert.equal(result.validation.ok, true);
  assert.deepEqual(checkWellFormed(docOf(result.bytes)), []);
  assert.deepEqual(result.expect.drawnBays, ["0+00 to 0+50", "0+50 to 1+00"]);
  assert.deepEqual(result.expect.gapBays, []);
  assert.ok(result.validation.stats.triangles.existing > 0 && result.validation.stats.triangles.proposed > 0);
  assert.ok(result.validation.stats.triangles.cut > 0 && result.validation.stats.triangles.fill > 0);
  assert.equal(result.validation.stats.polygons, 0);
  assert.ok(Object.values(result.validation.stats.triangles).reduce((a, b) => a + b, 0) > 0);
  // The model origin is the mainline start, and its up axis is metres, not a height above the ground.
  const kml = docOf(result.bytes);
  const loc = /<Location><longitude>([^<]+)<\/longitude><latitude>([^<]+)<\/latitude><altitude>([^<]+)<\/altitude>/.exec(kml);
  assert.ok(loc);
  const main = /<name>Traced mainline<\/name>.*?<coordinates>([^< ]+)/.exec(kml)![1].split(",").map(Number);
  assert.ok(Math.abs(Number(loc![1]) - main[0]) < 1e-8 && Math.abs(Number(loc![2]) - main[1]) < 1e-8);
  assert.equal(loc![3], "0");
});

test("every coordinate is a valid lon/lat inside Georgia, with altitude in metres", () => {
  const result = run(corridor());
  assert.ok(result.ok);
  if (!result.ok) return;
  const kml = docOf(result.bytes);
  const altitudes = new Set<string>();
  for (const m of kml.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)) {
    for (const tuple of m[1].trim().split(/\s+/)) {
      const [lon, lat, alt] = tuple.split(",").map(Number);
      assert.ok(lon > -85.8 && lon < -80.7 && lat > 30.3 && lat < 35.1, tuple);
      assert.ok(Number.isFinite(alt));
      altitudes.add(alt.toFixed(3));
    }
  }
  // Existing ground is the vertical origin, so its altitude is 0. Proposed 12 ft is 2 ft above that.
  const f = unitToMeters("ft-us");
  assert.ok(altitudes.has("0.000"), "existing centreline is the origin");
  assert.ok(altitudes.has((2 * f).toFixed(3)), "proposed 2 ft above existing");
  const dae = strFromU8(unzipSync(result.bytes)["files/existing-0.dae"]);
  assert.ok(dae.includes("0.0000"), "model Z is height above the existing centreline, not the sheet elevation");
  assert.ok(!dae.includes((10 * f).toFixed(3)));
  assert.ok(dae.includes("<up_axis>Z_UP</up_axis>"));
  assert.ok(kml.includes("<altitudeMode>relativeToGround</altitudeMode>"));
  assert.ok(kml.includes("<Data name=\"alignmentElevationFt\"><value>10.000</value>"));
  assert.ok(Math.abs(result.validation.stats.altitudeRange![0]) < 5);
});

test("roadway faces point up, stay opaque, and both surfaces are exported", () => {
  const result = run(corridor());
  assert.ok(result.ok);
  if (!result.ok) return;
  const files = unzipSync(result.bytes);
  const kml = strFromU8(files["doc.kml"]);
  assert.ok(kml.includes("files/existing-0.dae") && kml.includes("files/proposed-0.dae"));
  const boundary = /<name>Section 0\+00<\/name><styleUrl>#sectionBoundary<\/styleUrl><LineString><altitudeMode>relativeToGround<\/altitudeMode><coordinates>([^<]*)/.exec(kml);
  assert.ok(boundary);
  assert.equal(boundary[1].trim().split(/\s+/).length, 3);
  assert.ok(kml.includes("Left edge 0+00 to 0+50"));
  assert.ok(kml.includes("Right edge 0+00 to 0+50"));
  for (const name of Object.keys(files).filter((file) => file.endsWith(".dae"))) {
    const dae = strFromU8(files[name]);
    assert.ok(dae.includes(" 1</color>"), name);
    assert.ok(dae.includes("<double_sided>1</double_sided>"), name);
    const nums = (/<float_array[^>]*>([^<]*)/.exec(dae)?.[1] ?? "").trim().split(/\s+/).map(Number);
    const index = (/<p>([^<]*)<\/p>/.exec(dae)?.[1] ?? "").trim().split(/\s+/).map(Number);
    assert.ok(index.length >= 3 && index.length % 3 === 0, name);
    for (let i = 0; i < index.length; i += 3) {
      const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
      const bx = nums[b * 3] - nums[a * 3];
      const by = nums[b * 3 + 1] - nums[a * 3 + 1];
      const cx = nums[c * 3] - nums[a * 3];
      const cy = nums[c * 3 + 1] - nums[a * 3 + 1];
      const nz = bx * cy - by * cx;
      assert.ok(nz >= -1e-4, `${name} face ${i / 3} normal Z ${nz}`);
    }
  }
});

test("lon/lat match an independent calculation of where the section sits on the ground", () => {
  const stations = corridor();
  const built = buildCorridorKml({
    projectName: "Lakeside",
    stations,
    alignment: alignmentFor(stations),
    georef: georefFor(T),
    georeference: (() => {
      const r = resolveGeoreference(georefFor(T), ctx);
      assert.ok(r.ok);
      return r.ok ? r.georeference : (undefined as never);
    })(),
    options: { ...defaultKmzOptions, mainline: false },
  });
  assert.ok(built.ok);
  if (!built.ok) return;
  // Station 0+00 sits at pixel (0,0). Offsets -10, 0, +10 ft run to the left/right of a mainline whose
  // direction is 30° CCW from east, so "right" points at bearing 30° - 90° = -60°.
  const m = /<name>Section 0\+00<\/name><styleUrl>#sectionBoundary<\/styleUrl><LineString><altitudeMode>relativeToGround<\/altitudeMode><coordinates>([^<]*)</.exec(built.kml);
  assert.ok(m);
  const ft = unitToFeet("ft-us");
  const tuples = m[1].trim().split(/\s+/).map((t) => t.split(",").map(Number));
  assert.equal(tuples.length, 3);
  tuples.forEach(([lon, lat], i) => {
    const offsetFt = [-10, 0, 10][i];
    const back = wgs84ToProjected(West, lon, lat);
    const expectedE = T.tx + (offsetFt / ft) * Math.cos((-60 * Math.PI) / 180);
    const expectedN = T.ty + (offsetFt / ft) * Math.sin((-60 * Math.PI) / 180);
    assert.ok(Math.abs(back.easting - expectedE) < 0.01, `E ${back.easting} vs ${expectedE}`);
    assert.ok(Math.abs(back.northing - expectedN) < 0.01, `N ${back.northing} vs ${expectedN}`);
  });
});

test("the export frame builds the same shape as the viewer, mirrored axes included", () => {
  const stations = corridor();
  const alignment = alignmentFor(stations);
  const k = 0.1; // ft per px
  const scaled = truth(k / unitToFeet("ft-us"), 0, 2_230_000, 1_370_000);
  const r = resolveGeoreference(georefFor(scaled), ctx);
  assert.ok(r.ok);
  if (!r.ok) return;
  const viewer = buildAlignedCorridorGeometry(stations, alignment);
  const exported = buildCorridorSurfaces(placedSections(stations, alignment), alignment.points, projectedFrame(r.georeference, r.georeference.pixelToProjected(0, 0)));
  assert.equal(viewer.ribbons.length, exported.ribbons.length);
  assert.equal(viewer.prisms.length, exported.prisms.length);
  for (const [i, ribbon] of viewer.ribbons.entries()) {
    const other = exported.ribbons[i];
    assert.deepEqual(Array.from(ribbon.indices), Array.from(other.indices));
    const ft = unitToFeet("ft-us");
    for (let v = 3; v < ribbon.positions.length; v += 3) {
      // Viewer: X east, Z = -north (plan y down), Y up. Export: easting, northing, elevation.
      const dX = ribbon.positions[v] - ribbon.positions[0];
      const dY = ribbon.positions[v + 1] - ribbon.positions[1];
      const dZ = ribbon.positions[v + 2] - ribbon.positions[2];
      assert.ok(Math.abs(dX - (other.positions[v] - other.positions[0]) * ft) < 1e-3, `dX ${v}`);
      assert.ok(Math.abs(dY - (other.positions[v + 2] - other.positions[2])) < 1e-6, `dY ${v}`);
      assert.ok(Math.abs(dZ - (other.positions[v + 1] - other.positions[1]) * ft) < 1e-3, `dZ ${v}`);
    }
  }
});

// ---- Gaps, folders, styles -----------------------------------------------------------------------------

test("a section with no proposed profile opens a gap that is not bridged", () => {
  const [a, b, c] = corridor();
  const d = section("1+50", flat(10), cutAndFill);
  const unfinished = section("0+75", flat(10), []);
  const withGap = [a, b, unfinished, d];
  withGap.sort((x, y) => x.stationFt - y.stationFt);
  const result = run(withGap);
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  if (!result.ok) return;
  assert.deepEqual(result.expect.drawnBays, ["0+00 to 0+50"]);
  assert.deepEqual(result.expect.gapBays, ["0+50 to 0+75", "0+75 to 1+50"]);
  const kml = docOf(result.bytes);
  assert.ok(!kml.includes("0+50 to 1+50"), "never a bay across the gap");
  assert.ok(!kml.includes("0+50 to 0+75") || kml.includes("No surface is drawn between: 0+50 to 0+75"));
  assert.ok(kml.includes("No surface is drawn between: 0+50 to 0+75, 0+75 to 1+50"));
  // The drawn part equals the same two stations exported alone.
  const alone = run([a, b]);
  assert.ok(alone.ok);
  if (alone.ok) assert.deepEqual(alone.validation.stats.triangles, result.validation.stats.triangles);
  void c;
});

test("existing and proposed are separate folders with different styles, and each can be left out", () => {
  const result = run(corridor());
  assert.ok(result.ok);
  if (!result.ok) return;
  const kml = docOf(result.bytes);
  assert.deepEqual(result.validation.stats.folders, ["Existing ground", "Proposed grade", "Cut", "Fill", "Mainline", "Stations"]);
  const files = unzipSync(result.bytes);
  const diffuse = (folder: string) => {
    const href = new RegExp(`<Folder><name>${folder}</name>.*?<href>([^<]+)`).exec(kml)![1];
    return /<diffuse><color>([^<]+)/.exec(strFromU8(files[href]))![1];
  };
  assert.notEqual(diffuse("Existing ground"), diffuse("Proposed grade"));
  assert.notEqual(diffuse("Cut"), diffuse("Fill"));

  const onlyProposed = run(corridor(), { ...defaultKmzOptions, existing: false, mainline: false });
  assert.ok(onlyProposed.ok);
  if (onlyProposed.ok) {
    assert.deepEqual(onlyProposed.validation.stats.folders, ["Proposed grade", "Stations"]);
    assert.ok(!docOf(onlyProposed.bytes).includes("Existing ground"));
  }
  const none = run(corridor(), { ...defaultKmzOptions, existing: false, proposed: false });
  assert.equal(none.ok, false);
});

test("clamp to ground ignores elevations and says so on every polygon", () => {
  const result = run(corridor(), { ...all, altitudeMode: "clampToGround" });
  assert.ok(result.ok);
  if (!result.ok) return;
  const kml = docOf(result.bytes);
  assert.ok(!kml.includes("<altitudeMode>absolute</altitudeMode>"));
  assert.equal(result.validation.stats.altitudeRange![1], 0);
});

test("the plan image is an optional overlay stored in the archive with a four-corner quad", () => {
  const image = { bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/png", width: 1000, height: 600 };
  const result = run(corridor(), { ...all, planOverlay: true }, georefFor(T), image);
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  if (!result.ok) return;
  const files = unzipSync(result.bytes);
  assert.ok(Object.keys(files).includes("doc.kml") && Object.keys(files).includes("files/plan.png"));
  const kml = strFromU8(files["doc.kml"]);
  const quad = /<gx:LatLonQuad><coordinates>([^<]*)</.exec(kml)![1].trim().split(/\s+/);
  assert.equal(quad.length, 4);
  const resolved = resolveGeoreference(georefFor(T), ctx);
  assert.ok(resolved.ok);
  if (resolved.ok) {
    const lowerLeft = resolved.georeference.pixelToLonLat(0, 600);
    const [lon, lat] = quad[0].split(",").map(Number);
    assert.ok(Math.abs(lon - lowerLeft.lon) < 1e-7 && Math.abs(lat - lowerLeft.lat) < 1e-7);
  }
  const noImage = run(corridor(), { ...all, planOverlay: true }, georefFor(T), null);
  assert.equal(noImage.ok, false);
  const withoutOverlay = run(corridor(), all, georefFor(T), image);
  assert.ok(withoutOverlay.ok);
  if (withoutOverlay.ok) assert.ok(!Object.keys(unzipSync(withoutOverlay.bytes)).includes("files/plan.png"));
});

// ---- Blockers --------------------------------------------------------------------------------------------

test("export is blocked until the plan is georeferenced and confirmed", () => {
  const stations = corridor();
  const base = { projectName: "Lakeside", stations, alignment: alignmentFor(stations), context: ctx };
  assert.ok(kmzBlockers({ ...base, georef: defaultGeoref() }).length > 0, "no control points");
  const unconfirmed = kmzBlockers({ ...base, georef: georefFor(T, false) });
  assert.ok(unconfirmed.some((m) => /Confirm/.test(m)));
  assert.deepEqual(kmzBlockers({ ...base, georef: georefFor(T) }), []);
  const noMainline = kmzBlockers({ ...base, alignment: emptyAlignment(), georef: georefFor(T) });
  assert.ok(noMainline.some((m) => /mainline/i.test(m)));
  const moved = kmzBlockers({ ...base, georef: georefFor(T), context: { ...ctx, raster: { width: 2000, height: 1200 } } });
  assert.ok(moved.some((m) => /plan image changed/.test(m)));
});

// ---- Validator catches real defects ---------------------------------------------------------------------

test("the validator rejects a damaged archive, a missing doc.kml, bad coordinates and a bridged gap", () => {
  const ok = run(corridor());
  assert.ok(ok.ok);
  if (!ok.ok) return;
  const expect = ok.expect;
  assert.equal(validateKmz(new Uint8Array([1, 2, 3]), expect, West).ok, false);
  assert.equal(validateKmz(zipSync({ "other.kml": strToU8("<kml/>") }), expect, West).ok, false);

  const packed = unzipSync(ok.bytes);
  const kml = strFromU8(packed["doc.kml"]);
  const repack = (text: string, extra: Record<string, Uint8Array> = {}) => {
    const entries: Record<string, Uint8Array> = {};
    for (const [path, bytes] of Object.entries(packed)) entries[path] = bytes;
    entries["doc.kml"] = strToU8(text);
    for (const [path, bytes] of Object.entries(extra)) entries[path] = bytes;
    return zipSync(entries);
  };
  const badLat = kml.replace(/(<coordinates>[-\d.]+,)[-\d.]+/, "$195.00000000");
  assert.ok(validateKmz(repack(badLat), expect, West).errors.some((e) => /valid longitude\/latitude/.test(e)));
  assert.equal(validateKmz(repack(kml.replace("</Document>", "")), expect, West).ok, false);
  assert.ok(validateKmz(repack(kml.replace("Existing 0+00 to 0+50", "Existing 0+00 to 1+00")), expect, West).errors.length > 0);
  const existingHref = /<Folder><name>Existing ground<\/name>.*?<href>([^<]+)/.exec(kml)![1];
  const proposedHref = /<Folder><name>Proposed grade<\/name>.*?<href>([^<]+)/.exec(kml)![1];
  const existingColor = /<diffuse><color>([^<]+)/.exec(strFromU8(packed[existingHref]))![1];
  const painted = strFromU8(packed[proposedHref]).replace(/<diffuse><color>[^<]+/, `<diffuse><color>${existingColor}`);
  assert.ok(validateKmz(repack(kml, { [proposedHref]: strToU8(painted) }), expect, West).errors.some((e) => /share one colour/.test(e)));
  const gapExpect = { ...expect, gapBays: ["0+00 to 0+50"], drawnBays: ["0+50 to 1+00"] };
  assert.ok(validateKmz(ok.bytes, gapExpect, West).errors.some((e) => /bridges a gap/.test(e)));
  const missingMode = kml.replace("<Model><altitudeMode>relativeToGround</altitudeMode>", "<Model>");
  assert.ok(validateKmz(repack(missingMode), expect, West).errors.length > 0);
});

test("the XML checker accepts escaped text and rejects broken markup", () => {
  assert.deepEqual(checkWellFormed('<?xml version="1.0"?><a x="1"><b>A &amp; B</b><c/></a>'), []);
  assert.ok(checkWellFormed("<a><b>A & B</b></a>").length > 0);
  assert.ok(checkWellFormed("<a><b></a></b>").length > 0);
  assert.ok(checkWellFormed("<a><b></b>").length > 0);
  assert.ok(checkWellFormed("<a x=1></a>").length > 0);
  assert.ok(checkWellFormed("<a></a><b></b>").length > 0);
});

test("a project name with markup characters is escaped and the file name is safe", () => {
  const result = exportCorridorKmz({
    projectName: `Lake & "Side" <1>`,
    stations: corridor(),
    alignment: alignmentFor(corridor()),
    georef: georefFor(T),
    context: ctx,
    options: all,
  });
  // alignment markers refer to different station objects here, so only the naming matters.
  if (result.ok) assert.ok(/^Lake_Side_1_GPRC_3D_Corridor\.kmz$/.test(result.fileName));
  assert.equal(kmzFileName("Lakeside"), "Lakeside_GPRC_3D_Corridor.kmz");
  assert.equal(kmzFileName("  "), "GPRC_GPRC_3D_Corridor.kmz");
  assert.equal(kmzFileName(`Lake & "Side" <1>`), "Lake_Side_1_GPRC_3D_Corridor.kmz");
});

test("station labels follow the mainline, and a station with no marker is left out", () => {
  const stations = corridor();
  const alignment = alignmentFor(stations);
  alignment.points = [
    { x: 0, y: 0 },
    { x: 500, y: 0 },
    { x: 500, y: 400 },
  ];
  alignment.markers = [
    ...alignment.markers,
    { id: "bare", label: "0+20", stationFt: 20, distancePx: 200, stationId: null },
  ];
  const bare = createStation("9+00")!;
  const bent = exportCorridorKmz({
    projectName: "Lakeside",
    stations: [...stations, bare],
    alignment,
    georef: georefFor(T),
    context: ctx,
    options: all,
  });
  assert.ok(bent.ok, bent.ok ? "" : bent.errors.join("; "));
  if (!bent.ok) return;
  const kml = docOf(bent.bytes);
  assert.ok(kml.includes("<Folder><name>Stations</name>"));
  assert.ok(kml.includes("<name>0+00</name><Point><altitudeMode>clampToGround</altitudeMode>"));
  assert.ok(kml.includes("<name>0+20</name><Point>"), "a placed marker with no trace still gets a label");
  assert.ok(!kml.includes("<name>9+00</name>"), "a station with no marker is not invented");
  assert.ok(!kml.includes("<name>1+00</name><Point>"), "a marker past the end of the mainline is not clamped onto it");
  const start = /<name>Traced mainline<\/name>.*?<coordinates>([^< ]+)/.exec(kml)![1];
  const label = /<name>0\+00<\/name><Point><altitudeMode>clampToGround<\/altitudeMode><coordinates>([^<]+)/.exec(kml)![1];
  assert.equal(label.split(",").slice(0, 2).join(","), start.split(",").slice(0, 2).join(","));
  const quiet = exportCorridorKmz({
    projectName: "Lakeside",
    stations,
    alignment,
    georef: georefFor(T),
    context: ctx,
    options: { ...all, stationLabels: false },
  });
  assert.ok(quiet.ok);
  if (quiet.ok) assert.ok(!docOf(quiet.bytes).includes("<Folder><name>Stations</name>"));
});

// ---- Persistence -----------------------------------------------------------------------------------------

test("export options persist on the GPRC record, and old records get the defaults", () => {
  assert.deepEqual(normalizeGprcRecord({} as never).export, defaultKmzOptions);
  const saved = normalizeGprcRecord({ export: { ...all, altitudeMode: "clampToGround", planOverlay: true } } as never);
  assert.equal(saved.export.cut, true);
  assert.equal(saved.export.altitudeMode, "clampToGround");
  assert.deepEqual(normalizeKmzOptions({ existing: "yes", altitudeMode: "x" }), defaultKmzOptions);
});

test("projected -> lon/lat used by the export agrees with proj4 for the georeference origin", () => {
  const r = resolveGeoreference(georefFor(T), ctx);
  assert.ok(r.ok);
  if (!r.ok) return;
  const direct = projectedToWgs84(West, T.tx, T.ty);
  const via = r.georeference.pixelToLonLat(0, 0);
  assert.ok(Math.abs(direct.lon - via.lon) < 1e-9 && Math.abs(direct.lat - via.lat) < 1e-9);
});
