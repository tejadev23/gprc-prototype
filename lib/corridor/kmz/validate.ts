import { strFromU8, unzipSync } from "fflate";
import type { CrsDef } from "../georef/crs";
import { FOLDER_NAMES, type KmlExpectation, type SurfaceKind } from "./build-kml";

export type KmzValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    polygons: number;
    triangles: Record<SurfaceKind, number>;
    lineStrings: number;
    folders: string[];
    coordinateCount: number;
    altitudeRange: [number, number] | null;
  };
};

const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;

/**
 * Small well-formedness check: balanced, properly nested tags, quoted attributes, escaped text. It is not a
 * schema validator. The browser path also runs DOMParser, and Google Earth itself remains the final check.
 */
export function checkWellFormed(xml: string): string[] {
  const errors: string[] = [];
  const stack: string[] = [];
  let i = 0;
  let roots = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    for (let j = text.indexOf("&"); j !== -1; j = text.indexOf("&", j + 1)) {
      if (!ENTITY.test(text.slice(j))) {
        errors.push("Unescaped '&' in text.");
        return errors;
      }
    }
    if (lt === -1) break;
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      if (end === -1) return [...errors, "Unterminated processing instruction."];
      i = end + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      if (end === -1) return [...errors, "Unterminated comment."];
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      if (end === -1) return [...errors, "Unterminated CDATA."];
      i = end + 3;
    } else {
      const gt = xml.indexOf(">", lt);
      if (gt === -1) return [...errors, "Unterminated tag."];
      const body = xml.slice(lt + 1, gt);
      if (body.startsWith("/")) {
        const name = body.slice(1).trim();
        if (stack.pop() !== name) return [...errors, `Mismatched closing tag </${name}>.`];
      } else {
        const selfClosing = body.endsWith("/");
        const inner = selfClosing ? body.slice(0, -1) : body;
        const name = /^[A-Za-z_][\w:.-]*/.exec(inner)?.[0];
        if (!name) return [...errors, "Malformed tag."];
        const attrs = inner.slice(name.length).replace(/\s+[\w:.-]+="[^"<]*"/g, "").trim();
        if (attrs) return [...errors, `Malformed attributes on <${name}>.`];
        if (stack.length === 0) roots += 1;
        if (!selfClosing) stack.push(name);
      }
      i = gt + 1;
    }
  }
  if (stack.length > 0) errors.push(`Unclosed tag <${stack[stack.length - 1]}>.`);
  if (roots !== 1) errors.push(`Expected one root element, found ${roots}.`);
  return errors;
}

function allMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  return [...text.matchAll(pattern)];
}

/**
 * Validates the archive as written, against what the builder said it wrote. Everything here reads the
 * bytes back, so it catches packing mistakes as well as geometry mistakes.
 */
export function validateKmz(bytes: Uint8Array, expect: KmlExpectation, crs: CrsDef): KmzValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: KmzValidation["stats"] = {
    polygons: 0,
    triangles: { existing: 0, proposed: 0, cut: 0, fill: 0 },
    lineStrings: 0,
    folders: [],
    coordinateCount: 0,
    altitudeRange: null,
  };
  const result = () => ({ ok: errors.length === 0, errors, warnings, stats });

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    errors.push("The archive is not a readable zip file.");
    return result();
  }
  const docBytes = files["doc.kml"];
  if (!docBytes) {
    errors.push("doc.kml is missing from the archive root.");
    return result();
  }
  const kml = strFromU8(docBytes);

  errors.push(...checkWellFormed(kml));
  if (errors.length > 0) return result();
  if (!/<kml[\s>]/.test(kml) || !kml.includes('xmlns="http://www.opengis.net/kml/2.2"')) {
    errors.push("The root element is not a KML 2.2 <kml>.");
  }

  // Anything the KML points at, the plan image or a model, has to be in the archive.
  for (const match of allMatches(kml, /<href>([^<]+)<\/href>/g)) {
    const href = match[1];
    if (!files[href]) errors.push(`The KML points at ${href}, which is not in the archive.`);
  }

  // Folders.
  stats.folders = allMatches(kml, /<Folder><name>([^<]*)<\/name>/g).map((m) => m[1]);
  for (const name of expect.folders) {
    if (!stats.folders.includes(name)) errors.push(`Folder "${name}" is missing.`);
  }
  for (const name of stats.folders) {
    if (!expect.folders.includes(name)) errors.push(`Unexpected folder "${name}".`);
  }

  // Surfaces: triangle counts per folder, bay names, no bridging across gaps.
  const folderBody = (name: string) => {
    const start = kml.indexOf(`<Folder><name>${name}</name>`);
    if (start === -1) return "";
    return kml.slice(start, kml.indexOf("</Folder>", start));
  };
  const surfaceFolders: [SurfaceKind, string][] = [
    ["existing", FOLDER_NAMES.existing],
    ["proposed", FOLDER_NAMES.proposed],
    ["cut", FOLDER_NAMES.cut],
    ["fill", FOLDER_NAMES.fill],
  ];
  const kindOf = (name: string) => name.split(" ")[0];
  for (const [kind, folder] of surfaceFolders) {
    const body = folderBody(folder);
    if (!body) continue;
    const bays = allMatches(body, /<Placemark><name>([^<]*)<\/name><Model><altitudeMode>([^<]*)<\/altitudeMode>.*?<href>([^<]+)<\/href>/g);
    for (const [, name, mode, href] of bays) {
      if (mode !== expect.altitudeMode) errors.push(`"${name}" uses altitude mode ${mode}, expected ${expect.altitudeMode}.`);
      const bay = name.slice(kindOf(name).length + 1);
      if (expect.gapBays.includes(bay)) errors.push(`"${name}" bridges a gap that has no finished sections.`);
      if (!expect.drawnBays.includes(bay)) errors.push(`"${name}" is not a bay the builder reported as drawn.`);
      const dae = files[href] ? strFromU8(files[href]) : "";
      const listed = Number(/<triangles count="(\d+)"/.exec(dae)?.[1] ?? "0");
      const written = allMatches(dae, /<p>([^<]*)<\/p>/g).reduce((sum, m) => sum + m[1].trim().split(/\s+/).filter(Boolean).length / 3, 0);
      if (!dae || listed !== written) errors.push(`${href} does not contain the triangles it declares.`);
      stats.triangles[kind] += written;
      const up = dae.includes("<up_axis>Z_UP</up_axis>");
      if (dae && !up) errors.push(`${href} is not Z up, so Google Earth would lay the corridor on its side.`);
    }
    if (stats.triangles[kind] !== expect.triangles[kind]) {
      errors.push(`${folder}: found ${stats.triangles[kind]} triangles, expected ${expect.triangles[kind]}.`);
    }
    const lineCount = allMatches(body, /<styleUrl>#(?:existing|proposed)Line<\/styleUrl>/g).length;
    if (kind === "existing" || kind === "proposed") {
      if (lineCount !== expect.sectionLines[kind]) {
        errors.push(`${folder}: found ${lineCount} section lines, expected ${expect.sectionLines[kind]}.`);
      }
    }
  }
  stats.polygons = allMatches(kml, /<Polygon>/g).length;
  stats.lineStrings = allMatches(kml, /<LineString>/g).length;

  // Separate, distinct colours for existing and proposed, read back from the models.
  const modelColor = (folder: string) => {
    const href = new RegExp(`<Folder><name>${folder}</name>.*?<href>([^<]+)</href>`).exec(kml)?.[1];
    const dae = href && files[href] ? strFromU8(files[href]) : "";
    return /<diffuse><color>([^<]+)<\/color>/.exec(dae)?.[1];
  };
  if (expect.folders.includes(FOLDER_NAMES.existing) && expect.folders.includes(FOLDER_NAMES.proposed)) {
    const existingColor = modelColor(FOLDER_NAMES.existing);
    const proposedColor = modelColor(FOLDER_NAMES.proposed);
    if (!existingColor || !proposedColor) errors.push("Existing and proposed styles are missing.");
    else if (existingColor === proposedColor) errors.push("Existing and proposed surfaces share one colour.");
  }

  // Altitude mode on every geometry.
  const modes = allMatches(kml, /<altitudeMode>([^<]*)<\/altitudeMode>/g).map((m) => m[1]);
  for (const mode of modes) {
    if (mode !== expect.altitudeMode && mode !== "clampToGround") errors.push(`Unexpected altitude mode "${mode}".`);
  }
  if (modes.length === 0) errors.push("No altitude mode is stated.");
  const modelModes = allMatches(kml, /<Model><altitudeMode>([^<]*)<\/altitudeMode>/g);
  if (modelModes.length === 0) errors.push("The corridor has no 3D model.");
  if (modelModes.some((m) => m[1] !== expect.altitudeMode)) errors.push("Model altitude mode differs from the chosen mode.");

  // Coordinates: finite lon/lat/alt triples, inside the CRS area of use.
  let min = Infinity;
  let max = -Infinity;
  let outside = 0;
  for (const match of allMatches(kml, /<coordinates>([^<]*)<\/coordinates>/g)) {
    const tuples = match[1].trim().split(/\s+/).filter(Boolean);
    for (const tuple of tuples) {
      const parts = tuple.split(",").map(Number);
      stats.coordinateCount += 1;
      if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) {
        errors.push(`Bad coordinate "${tuple}".`);
        break;
      }
      const [lon, lat, altitude] = parts;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        errors.push(`Coordinate outside the valid longitude/latitude range: ${tuple}.`);
        break;
      }
      const b = crs.bounds;
      if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) outside += 1;
      if (parts.length >= 3 && altitude !== undefined) {
        min = Math.min(min, altitude);
        max = Math.max(max, altitude);
      }
    }
  }
  if (outside > 0) warnings.push(`${outside} coordinates fall outside the area of use of ${crs.code}.`);
  // Model vertices are metres up. They are the surface altitudes; the KML lines are only the profiles.
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.endsWith(".dae")) continue;
    const dae = strFromU8(bytes);
    const flat = /<float_array[^>]*>([^<]*)<\/float_array>/.exec(dae)?.[1] ?? "";
    const nums = flat.trim().split(/\s+/).filter(Boolean).map(Number);
    for (let i = 2; i < nums.length; i += 3) {
      if (!Number.isFinite(nums[i])) errors.push(`${path} has a vertex that is not a number.`);
      else {
        min = Math.min(min, nums[i]);
        max = Math.max(max, nums[i]);
      }
    }
  }
  if (Number.isFinite(min)) stats.altitudeRange = [min, max];
  if (stats.coordinateCount === 0) errors.push("The file contains no coordinates.");

  // Metadata agrees with the builder.
  const ready = /<Data name="readySections"><value>(\d+)<\/value>/.exec(kml)?.[1];
  if (ready === undefined || Number(ready) !== expect.readySections) errors.push("readySections metadata is missing or wrong.");
  if (expect.gapBays.length > 0 && !kml.includes("No surface is drawn between")) {
    errors.push("Gaps exist but the description does not say so.");
  }
  return result();
}
