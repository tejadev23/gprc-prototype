import type { PlanAlignment } from "../alignment";
import { placedSections } from "../alignment-geometry";
import type { Georef } from "../georef/model";
import { resolveGeoreference, type ResolveContext } from "../georef/pipeline";
import type { Station } from "../types";
import { strToU8 } from "fflate";
import { buildCorridorKml, kmzFileName, type KmlExpectation, type KmzOptions } from "./build-kml";
import { packKmz } from "./pack";
import { validateKmz, type KmzValidation } from "./validate";

export type PlanImageFile = { bytes: Uint8Array; mime: string; width: number; height: number };

export type KmzExportInput = {
  projectName: string;
  stations: readonly Station[];
  alignment: PlanAlignment;
  georef: Georef;
  context: ResolveContext;
  options: KmzOptions;
  planImage?: PlanImageFile | null;
};

export type KmzExportResult =
  | { ok: true; bytes: Uint8Array; fileName: string; expect: KmlExpectation; validation: KmzValidation; warnings: string[] }
  | { ok: false; errors: string[] };

/** Why the export is unavailable, in plain words. Empty means it can run. */
export function kmzBlockers(input: Omit<KmzExportInput, "options" | "planImage">): string[] {
  const blockers: string[] = [];
  if (input.alignment.points.length < 2) blockers.push("Trace the mainline on the plan first.");
  if (placedSections(input.stations, input.alignment).length === 0) {
    blockers.push("Place at least one station on the mainline (it needs two markers to set the scale).");
  }
  const resolved = resolveGeoreference(input.georef, input.context);
  if (!resolved.ok) blockers.push(resolved.reason);
  else blockers.push(...resolved.blockers);
  return blockers;
}

/** Build, pack and validate. Nothing is returned for download unless validation passes. */
export function exportCorridorKmz(input: KmzExportInput): KmzExportResult {
  const blockers = kmzBlockers(input);
  if (blockers.length > 0) return { ok: false, errors: blockers };
  const resolved = resolveGeoreference(input.georef, input.context);
  if (!resolved.ok) return { ok: false, errors: [resolved.reason] };

  const files: Record<string, Uint8Array> = {};
  let planImage: { href: string; width: number; height: number } | null = null;
  if (input.options.planOverlay) {
    const image = input.planImage;
    if (!image) return { ok: false, errors: ["The plan image is not available to embed. Turn the plan overlay off or reload the plan."] };
    const ext = image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : null;
    if (!ext) return { ok: false, errors: [`The plan overlay needs a PNG or JPEG image, not ${image.mime || "an unknown type"}.`] };
    planImage = { href: `files/plan.${ext}`, width: image.width, height: image.height };
    files[planImage.href] = image.bytes;
  }

  const built = buildCorridorKml({
    projectName: input.projectName,
    stations: input.stations,
    alignment: input.alignment,
    georef: input.georef,
    georeference: resolved.georeference,
    options: input.options,
    planImage,
  });
  if (!built.ok) return { ok: false, errors: [built.error] };
  for (const [path, text] of Object.entries(built.files)) files[path] = strToU8(text);

  const bytes = packKmz(built.kml, files);
  const validation = validateKmz(bytes, built.expect, resolved.georeference.crs);
  if (!validation.ok) return { ok: false, errors: ["The file failed its own checks and was not saved.", ...validation.errors] };
  return {
    ok: true,
    bytes,
    fileName: kmzFileName(input.projectName),
    expect: built.expect,
    validation,
    warnings: [...resolved.warnings.map((w) => w.message), ...validation.warnings],
  };
}
