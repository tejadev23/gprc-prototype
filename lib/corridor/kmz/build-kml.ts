import { pointOnPolyline, polylineLength, type PlanAlignment, type PlanPoint } from "../alignment";
import { buildCorridorSurfaces, placedSections, type PlacedSection, type SurfaceFrame } from "../alignment-geometry";
import type { MeshGeometry } from "../corridor-geometry";
import { unitToFeet, unitToMeters, projectedToWgs84 } from "../georef/crs";
import { elevationAt, sortByOffset } from "../profile";
import type { Georef } from "../georef/model";
import type { Georeference } from "../georef/pipeline";
import type { Station } from "../types";
import { defaultKmzOptions, type KmzOptions } from "./options";

/**
 * Surfaces are Collada models, one per bay, not KML polygons. Google Earth draws absolute-altitude polygons
 * as if the altitude were a height above the ground, so a roadway at about 300 m was painted hundreds of
 * metres in the air and, in a tilted view, beside the mainline. A model places the same vertices in a local
 * east/north/up frame whose origin is absolute. Section lines stay KML, because a line does honour altitude.
 */

export { defaultKmzOptions, type KmzOptions };

export type KmlInput = {
  projectName: string;
  stations: readonly Station[];
  alignment: PlanAlignment;
  georef: Georef;
  georeference: Georeference;
  options: KmzOptions;
  /** Archive path and pixel size of the plan image to overlay, when the option is on. */
  planImage?: { href: string; width: number; height: number } | null;
};

export type SurfaceKind = "existing" | "proposed" | "cut" | "fill";

export type KmlExpectation = {
  /** Folder names that must be present. */
  folders: string[];
  readySections: number;
  drawnBays: string[];
  gapBays: string[];
  triangles: Record<SurfaceKind, number>;
  sectionLines: Record<"existing" | "proposed", number>;
  altitudeMode: "absolute" | "relativeToGround" | "clampToGround";
};

export type KmlBuild = { ok: true; kml: string; files: Record<string, string>; expect: KmlExpectation } | { ok: false; error: string };

export const FOLDER_NAMES = {
  existing: "Existing ground",
  proposed: "Proposed grade",
  cut: "Cut",
  fill: "Fill",
  mainline: "Mainline",
  stations: "Stations",
  overlay: "Plan image",
} as const;

/**
 * Opaque viewport hues. Transparency made Earth blend the two roadway surfaces into patches.
 * Both meshes stay in the file: where they differ in height, the higher one shows; where one is wider, the other still shows at the edge.
 */
const MODEL_COLOR: Record<SurfaceKind, string> = {
  existing: "0.490 0.827 0.988 1", // sky blue  #7dd3fc
  proposed: "0.984 0.749 0.141 1", // amber     #fbbf24
  cut: "0.973 0.443 0.443 1", //      red       #f87171
  fill: "0.290 0.871 0.502 1", //     green     #4ade80
};

export type Projected = { easting: number; northing: number };

/**
 * Maps plan geometry into projected coordinates in the project CRS, relative to `origin`. Offsets are real
 * feet on the ground, so they stay correct whatever scale the control points imply. The third value is the
 * sheet elevation, left in the sheet's own vertical units.
 *
 * The shared surface builders store positions as Float32. State-plane values near 2 000 000 ft only resolve
 * to a quarter of a foot in Float32, so the frame works in small local offsets and the origin is added back
 * in double precision when the coordinates are written.
 */
export function projectedFrame(georeference: Georeference, origin: Projected = { easting: 0, northing: 0 }): SurfaceFrame {
  const feetPerUnit = unitToFeet(georeference.crs.units);
  const t = georeference.transform;
  return {
    place(point, tangent, offsetFt, elevation) {
      const at = georeference.pixelToProjected(point.x, point.y);
      const dE = t.m11 * tangent.x + t.m12 * tangent.y;
      const dN = t.m21 * tangent.x + t.m22 * tangent.y;
      const length = Math.hypot(dE, dN) || 1;
      const offset = offsetFt / feetPerUnit;
      // Right of the direction of travel, in east/north: (dN, -dE).
      return [at.easting - origin.easting + (dN / length) * offset, at.northing - origin.northing - (dE / length) * offset, elevation];
    },
  };
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function kmzFileName(projectName: string): string {
  const base = projectName.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base || "GPRC"}_GPRC_3D_Corridor.kmz`;
}

export function buildCorridorKml(input: KmlInput): KmlBuild {
  const { alignment, georeference, georef, options } = input;
  const crs = georeference.crs;
  const placed = placedSections(input.stations, alignment);
  if (placed.length === 0) {
    return { ok: false, error: "No cross-sections sit on the mainline yet. Place station markers on a scaled mainline first." };
  }
  const first = alignment.points[0];
  const origin = first ? georeference.pixelToProjected(first.x, first.y) : { easting: 0, northing: 0 };
  const frame = projectedFrame(georeference, origin);
  const clamp = options.altitudeMode === "clampToGround";
  const metersPerVertical = unitToMeters(georef.vertical.units);
  // Google Earth adds a model's Z to the ground even when the mode says absolute, so a roadway at
  // 1,070 ft was drawn 1,070 ft above the road. Z is the height above the existing-ground centreline.
  // The sheet value of that centreline is recorded, not added again.
  const baseFt = alignmentElevationFt(placed);
  const geometryMode = clamp ? "clampToGround" : "relativeToGround";
  /** Takes offsets from `origin`, in CRS units, and an elevation in sheet units. */
  const coordinate = (local: [number, number, number]): string => {
    const { lon, lat } = projectedToWgs84(crs, origin.easting + local[0], origin.northing + local[1]);
    const altitude = clamp ? 0 : (local[2] - baseFt) * metersPerVertical;
    return `${lon.toFixed(8)},${lat.toFixed(8)},${altitude.toFixed(3)}`;
  };
  const alt = `<altitudeMode>${geometryMode}</altitudeMode>`;

  const kinds = (["existing", "proposed", "cut", "fill"] as const).filter((kind) => options[kind]);
  const triangles: Record<SurfaceKind, number> = { existing: 0, proposed: 0, cut: 0, fill: 0 };
  const surfaceXml: Record<SurfaceKind, string[]> = { existing: [], proposed: [], cut: [], fill: [] };
  const files: Record<string, string> = {};
  const edgeXml: string[] = [];
  const drawnBays: string[] = [];
  const gapBays: string[] = [];
  const bayName = (from: PlacedSection, to: PlacedSection) => `${from.marker.label} to ${to.marker.label}`;
  const metersPerHorizontal = unitToMeters(crs.units);
  const originLonLat = projectedToWgs84(crs, origin.easting, origin.northing);
  const modelAt = `<Location><longitude>${originLonLat.lon.toFixed(8)}</longitude><latitude>${originLonLat.lat.toFixed(8)}</latitude><altitude>0</altitude></Location>`;

  for (let i = 0; i < placed.length - 1; i++) {
    const a = placed[i];
    const b = placed[i + 1];
    const name = bayName(a, b);
    const bay = buildCorridorSurfaces([a, b], alignment.points, frame);
    if (!bay.bays[0].drawn) {
      gapBays.push(name);
      continue;
    }
    drawnBays.push(name);
    const meshes: Record<SurfaceKind, MeshGeometry[]> = {
      existing: bay.ribbons.filter((mesh) => mesh.kind === "existing"),
      proposed: bay.ribbons.filter((mesh) => mesh.kind === "proposed"),
      cut: bay.prisms.filter((mesh) => mesh.kind === "cut"),
      fill: bay.prisms.filter((mesh) => mesh.kind === "fill"),
    };
    for (const kind of kinds) {
      for (const mesh of meshes[kind]) {
        const model = meshModel(mesh, MODEL_COLOR[kind], metersPerHorizontal, metersPerVertical, baseFt, clamp);
        if (model.count === 0) continue;
        const href = `files/${kind}-${triangles[kind]}.dae`;
        triangles[kind] += model.count;
        files[href] = model.dae;
        surfaceXml[kind].push(
          `<Placemark><name>${escapeXml(`${label(kind)} ${name}`)}</name><Model><altitudeMode>${geometryMode}</altitudeMode><gx:altitudeMode>${geometryMode}</gx:altitudeMode>${modelAt}<Link><href>${href}</href></Link></Model></Placemark>`,
        );
      }
    }
    if (options.sectionLines) {
      const ribbon = meshes.proposed[0] ?? meshes.existing[0];
      const kind = meshes.proposed[0] ? "proposed" : "existing";
      if (ribbon) {
        const stride = uniqueOffsets(kind === "proposed" ? a.station.proposed : a.station.existing, kind === "proposed" ? b.station.proposed : b.station.existing);
        for (const [column, side] of [
          [0, "Left"],
          [stride - 1, "Right"],
        ] as const) {
          const columnLine = edgeColumn(ribbon, stride, column);
          if (columnLine.length < 2) continue;
          edgeXml.push(
            `<Placemark><name>${escapeXml(`${side} edge ${name}`)}</name><styleUrl>#corridorEdge</styleUrl><LineString>${alt}<coordinates>${columnLine.map((point) => coordinate(point)).join(" ")}</coordinates></LineString></Placemark>`,
          );
        }
      }
    }
  }

  const chosenSurfaces = kinds.filter((kind) => surfaceXml[kind].length > 0);
  if (chosenSurfaces.length === 0) {
    const asked = kinds.length === 0 ? "Choose at least one surface to export." : "";
    return {
      ok: false,
      error:
        asked ||
        "There is no surface to export. It takes two neighbouring finished sections (existing and proposed, two or more points each), and a gap is never bridged.",
    };
  }

  const sectionLines: Record<"existing" | "proposed", number> = { existing: 0, proposed: 0 };
  const boundaryXml: string[] = [];
  if (options.sectionLines) {
    const lines = buildCorridorSurfaces(placed, alignment.points, frame).lines;
    const labelById = new Map(placed.map((row) => [row.station.id, row.marker.label]));
    const chosen = new Map<string, (typeof lines)[number]>();
    for (const line of lines) {
      if (line.kind === "proposed") chosen.set(line.stationId, line);
    }
    for (const line of lines) {
      if (line.kind === "existing" && !chosen.has(line.stationId)) chosen.set(line.stationId, line);
    }
    for (const line of chosen.values()) {
      const coords: string[] = [];
      for (let v = 0; v < line.positions.length; v += 3) {
        coords.push(coordinate([line.positions[v], line.positions[v + 1], line.positions[v + 2]]));
      }
      if (coords.length < 2) continue;
      boundaryXml.push(
        `<Placemark><name>${escapeXml(`Section ${labelById.get(line.stationId) ?? ""}`.trim())}</name><styleUrl>#sectionBoundary</styleUrl><LineString>${alt}<coordinates>${coords.join(" ")}</coordinates></LineString></Placemark>`,
      );
    }
  }

  const folders: string[] = [];
  const folderXml: string[] = [];
  for (const kind of kinds) {
    if (surfaceXml[kind].length === 0) continue;
    const name = FOLDER_NAMES[kind];
    folders.push(name);
    folderXml.push(`<Folder><name>${name}</name>${surfaceXml[kind].join("")}</Folder>`);
  }
  const guide = [...boundaryXml, ...edgeXml];
  if (guide.length > 0) {
    const host = folderXml.findIndex((xml) => xml.startsWith(`<Folder><name>${FOLDER_NAMES.proposed}</name>`) || xml.startsWith(`<Folder><name>${FOLDER_NAMES.existing}</name>`));
    const block = guide.join("");
    if (host >= 0) folderXml[host] = folderXml[host].replace("</Folder>", `${block}</Folder>`);
    else {
      folders.push("Section lines");
      folderXml.push(`<Folder><name>Section lines</name>${block}</Folder>`);
    }
  }
  if (options.mainline) {
    const coords = alignment.points.map((point) => {
      const at = georeference.pixelToProjected(point.x, point.y);
      return coordinate([at.easting - origin.easting, at.northing - origin.northing, 0]);
    });
    folders.push(FOLDER_NAMES.mainline);
    folderXml.push(
      `<Folder><name>${FOLDER_NAMES.mainline}</name><Placemark><name>Traced mainline</name><styleUrl>#mainline</styleUrl><LineString><altitudeMode>clampToGround</altitudeMode><tessellate>1</tessellate><coordinates>${coords.join(" ")}</coordinates></LineString></Placemark></Folder>`,
    );
  }
  if (options.stationLabels && alignment.points.length >= 2) {
    const length = polylineLength(alignment.points);
    const placemarks: string[] = [];
    for (const marker of alignment.markers) {
      if (marker.distancePx < -1e-6 || marker.distancePx > length + 1e-6) continue;
      const sample = pointOnPolyline(alignment.points, marker.distancePx);
      if (!sample) continue;
      const at = georeference.pixelToProjected(sample.point.x, sample.point.y);
      const { lon, lat } = projectedToWgs84(crs, at.easting, at.northing);
      placemarks.push(
        `<Placemark><name>${escapeXml(marker.label)}</name><Point><altitudeMode>clampToGround</altitudeMode><coordinates>${lon.toFixed(8)},${lat.toFixed(8)},0</coordinates></Point></Placemark>`,
      );
    }
    if (placemarks.length > 0) {
      folders.push(FOLDER_NAMES.stations);
      folderXml.push(`<Folder><name>${FOLDER_NAMES.stations}</name>${placemarks.join("")}</Folder>`);
    }
  }
  if (options.planOverlay && input.planImage) {
    const { href, width, height } = input.planImage;
    const corner = (p: PlanPoint) => {
      const { lon, lat } = georeference.pixelToLonLat(p.x, p.y);
      return `${lon.toFixed(8)},${lat.toFixed(8)}`;
    };
    // gx:LatLonQuad runs counter-clockwise from the image's lower-left corner.
    const quad = [corner({ x: 0, y: height }), corner({ x: width, y: height }), corner({ x: width, y: 0 }), corner({ x: 0, y: 0 })].join(" ");
    folders.push(FOLDER_NAMES.overlay);
    folderXml.push(
      `<Folder><name>${FOLDER_NAMES.overlay}</name><GroundOverlay><name>Stitched plan</name><drawOrder>0</drawOrder><Icon><href>${escapeXml(href)}</href></Icon><gx:LatLonQuad><coordinates>${quad}</coordinates></gx:LatLonQuad></GroundOverlay></Folder>`,
    );
  }

  const readySections = placed.filter((row) => row.station.existing.length >= 2 && row.station.proposed.length >= 2).length;
  const report = georeference.report;
  const meta: [string, string][] = [
    ["horizontalCrs", `${crs.code} ${crs.name}`],
    ["crsConfirmedByUser", String(georef.crs.verified)],
    ["fitMethod", report.method],
    ["controlPoints", String(report.controlCount)],
    ["fitQuality", report.quality],
    ["verticalDatum", georef.vertical.datum || "not stated"],
    ["verticalUnits", georef.vertical.units],
    ["altitudeMode", geometryMode],
    ["alignmentElevationFt", clamp ? "" : baseFt.toFixed(3)],
    ["readySections", String(readySections)],
    ["drawnBays", String(drawnBays.length)],
    ["gapBays", gapBays.join("; ")],
  ];
  const description = [
    `Reconstructed from traced cross-section profiles placed on the stitched plan mainline in ${crs.name}.`,
    clamp
      ? "Surfaces are draped on the terrain, so elevations are ignored."
      : `The roadway is placed on the Google Earth ground. Heights in the model are measured from the existing-ground centreline, which is ${baseFt.toFixed(1)} ${georef.vertical.units} on the sheet (${(baseFt * metersPerVertical).toFixed(1)} m). Zero is that centreline on the terrain, not a surveyed height above sea level. A ditch below that line stays below it. The sheet elevation is not added on top of the terrain.`,
    gapBays.length > 0 ? `No surface is drawn between: ${gapBays.join(", ")}. Those sections are missing or unfinished.` : "",
    "Positions are only as good as the control points and the plan. This file is not a survey.",
  ]
    .filter(Boolean)
    .join(" ");

  const lineStyles =
    `<Style id="sectionBoundary"><LineStyle><color>ff1a1a1a</color><width>2</width></LineStyle></Style>` +
    `<Style id="corridorEdge"><LineStyle><color>ff333333</color><width>1.5</width></LineStyle></Style>` +
    `<Style id="mainline"><LineStyle><color>ff1d1d7f</color><width>3</width></LineStyle></Style>`;

  const kml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>` +
    `<name>${escapeXml(`${input.projectName || "GPRC"} 3D corridor`)}</name>` +
    `<description>${escapeXml(description)}</description>` +
    lineStyles +
    `<ExtendedData>${meta.map(([key, value]) => `<Data name="${key}"><value>${escapeXml(value)}</value></Data>`).join("")}</ExtendedData>` +
    folderXml.join("") +
    `</Document></kml>\n`;

  return {
    ok: true,
    kml,
    files,
    expect: { folders, readySections, drawnBays, gapBays, triangles, sectionLines, altitudeMode: geometryMode },
  };
}

function label(kind: SurfaceKind | "existing" | "proposed"): string {
  return kind === "existing" ? "Existing" : kind === "proposed" ? "Proposed" : kind === "cut" ? "Cut" : "Fill";
}

/** Existing-ground elevation at the alignment, from the first finished section. */
function alignmentElevationFt(placed: readonly PlacedSection[]): number {
  for (const row of placed) {
    if (row.station.existing.length >= 2) return elevationAt(sortByOffset(row.station.existing), 0);
  }
  for (const row of placed) {
    if (row.station.proposed.length >= 2) return elevationAt(sortByOffset(row.station.proposed), 0);
  }
  return 0;
}

function meshModel(
  mesh: MeshGeometry,
  color: string,
  metersPerHorizontal: number,
  metersPerVertical: number,
  baseFt: number,
  clamp: boolean,
): { dae: string; count: number } {
  const seen = new Map<number, number>();
  const floats: number[] = [];
  const at = (index: number) => {
    let mapped = seen.get(index);
    if (mapped === undefined) {
      mapped = floats.length / 3;
      seen.set(index, mapped);
      floats.push(
        mesh.positions[index * 3] * metersPerHorizontal,
        mesh.positions[index * 3 + 1] * metersPerHorizontal,
        clamp ? 0 : (mesh.positions[index * 3 + 2] - baseFt) * metersPerVertical,
      );
    }
    return mapped;
  };
  const indices: number[] = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = at(mesh.indices[i]);
    const b = at(mesh.indices[i + 1]);
    const c = at(mesh.indices[i + 2]);
    const same = (p: number, q: number) => floats[p * 3] === floats[q * 3] && floats[p * 3 + 1] === floats[q * 3 + 1] && floats[p * 3 + 2] === floats[q * 3 + 2];
    if (same(a, b) || same(b, c) || same(a, c)) continue;
    // X is east, Y is north, Z is up. The ribbon builder's winding points down, so flip those faces.
    // A wall is nearly vertical (normal Z about 0) and is kept either way. Nothing valid is dropped.
    const [i0, i1, i2] = faceUp(floats, a, b, c);
    indices.push(i0, i1, i2);
  }
  const count = indices.length / 3;
  const flat = floats.map((n) => n.toFixed(4)).join(" ");
  const dae =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">` +
    `<asset><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>` +
    `<library_effects><effect id="effect"><profile_COMMON><technique sid="common"><lambert><diffuse><color>${color}</color></diffuse></lambert></technique>` +
    `<extra><technique profile="GOOGLEEARTH"><double_sided>1</double_sided></technique></extra></profile_COMMON></effect></library_effects>` +
    `<library_materials><material id="material"><instance_effect url="#effect"/></material></library_materials>` +
    `<library_geometries><geometry id="mesh"><mesh>` +
    `<source id="pos"><float_array id="pos-array" count="${floats.length}">${flat}</float_array>` +
    `<technique_common><accessor source="#pos-array" count="${floats.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>` +
    `<vertices id="verts"><input semantic="POSITION" source="#pos"/></vertices>` +
    `<triangles count="${count}" material="mat"><input semantic="VERTEX" source="#verts" offset="0"/><p>${indices.join(" ")}</p></triangles>` +
    `</mesh></geometry></library_geometries>` +
    `<library_visual_scenes><visual_scene id="scene"><node><instance_geometry url="#mesh"><bind_material><technique_common><instance_material symbol="mat" target="#material"/></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes>` +
    `<scene><instance_visual_scene url="#scene"/></scene></COLLADA>`;
  return { dae, count };
}

/** Unique offsets, matching the ribbon builder, so an edge column lines up with the mesh. */
function uniqueOffsets(a: { offset: number }[], b: { offset: number }[]): number {
  return new Set([...a, ...b].map((point) => point.offset)).size;
}

function edgeColumn(mesh: MeshGeometry, stride: number, column: number): [number, number, number][] {
  if (stride < 1 || column < 0 || column >= stride) return [];
  const count = mesh.positions.length / 3;
  if (count % stride !== 0) return [];
  const samples = count / stride;
  const line: [number, number, number][] = [];
  for (let sample = 0; sample < samples; sample++) {
    const index = (sample * stride + column) * 3;
    line.push([mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]]);
  }
  return line;
}

/** Flip a downward face. X east, Y north, Z up, so a negative Z normal looks at the ground. */
function faceUp(floats: number[], a: number, b: number, c: number): [number, number, number] {
  const ax = floats[a * 3];
  const ay = floats[a * 3 + 1];
  const bx = floats[b * 3] - ax;
  const by = floats[b * 3 + 1] - ay;
  const cx = floats[c * 3] - ax;
  const cy = floats[c * 3 + 1] - ay;
  const nz = bx * cy - by * cx;
  return nz < 0 ? [a, c, b] : [a, b, c];
}
