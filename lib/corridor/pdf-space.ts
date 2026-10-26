import type { PlanAlignment, PlanPoint } from "./alignment";
import { applyCalibration } from "./calibration";
import type { Georef } from "./georef/model";
import type { Calibration, Station } from "./types";

/** The cap used when calibration pixels were stored in the display raster. */
export const LEGACY_RASTER_MAX_SIDE = 3200;
export const LEGACY_RASTER_MAX_SCALE = 4;
/** Display bitmaps stay under this so a zoomed page does not allocate an unbounded canvas. */
export const DISPLAY_MAX_SIDE = 8192;

export type PdfSpace = "legacy-raster" | "pdf-user";
export type PlanSpace = PdfSpace | "image";

/** Scale pdf.js applied for the old 3200px raster. Matches `renderPdfPage` before user-space coordinates. */
export function legacyRasterScale(userWidth: number, userHeight: number): number {
  const longest = Math.max(userWidth, userHeight, 1);
  return Math.min(LEGACY_RASTER_MAX_SIDE / longest, LEGACY_RASTER_MAX_SCALE);
}

const DETAIL_STEPS = [1, 1.5, 2, 3, 4, 6, 8];

/**
 * Bitmap pixels per PDF user unit for the current zoom.
 * Quantized so a wheel tick does not render a new page image.
 */
export function displayRenderScale(userWidth: number, userHeight: number, cssPerUser: number, dpr: number): number {
  const longest = Math.max(userWidth, userHeight, 1);
  const cap = DISPLAY_MAX_SIDE / longest;
  const wanted = Math.max(1, cssPerUser * Math.max(dpr, 1));
  const limit = Math.min(8, cap);
  let chosen = Math.min(1, limit);
  for (const step of DETAIL_STEPS) {
    if (step <= wanted + 1e-6 && step <= limit + 1e-6) chosen = step;
  }
  return chosen;
}

export function stationNeedsPdfUserConversion(station: Pick<Station, "pdfSpace" | "calibration">): boolean {
  if (station.pdfSpace === "pdf-user") return false;
  return station.calibration.points.some((point) => point.px != null || point.py != null);
}

/** Divide legacy raster pixels by the scale that produced them, then re-solve the same offsets and elevations. */
export function convertStationToPdfUser(station: Station, userWidth: number, userHeight: number): Station {
  if (station.pdfSpace === "pdf-user") return station;
  const scale = legacyRasterScale(userWidth, userHeight);
  const factor = scale > 0 ? 1 / scale : 1;
  const points = station.calibration.points.map((point) => ({
    ...point,
    px: point.px == null ? null : point.px * factor,
    py: point.py == null ? null : point.py * factor,
  })) as Calibration["points"];
  return { ...station, pdfSpace: "pdf-user", calibration: applyCalibration(points) };
}

export type PageSizeSource = {
  numPages: number;
  getPage(pageNumber: number): Promise<{ getViewport(opts: { scale: number }): { width: number; height: number } }>;
};

/** One-time conversion. Stations already in PDF user space are left alone. */
export async function migrateStationsToPdfUser(doc: PageSizeSource, stations: readonly Station[]): Promise<Station[]> {
  const pending = stations.filter(stationNeedsPdfUserConversion);
  if (pending.length === 0) {
    if (stations.every((station) => station.pdfSpace === "pdf-user")) return [...stations];
    return stations.map((station) => ({ ...station, pdfSpace: "pdf-user" }));
  }
  const sizes = new Map<number, { width: number; height: number }>();
  for (const station of pending) {
    const page = station.pageNumber ?? 1;
    if (sizes.has(page) || page < 1 || page > doc.numPages) continue;
    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    sizes.set(page, { width: viewport.width, height: viewport.height });
  }
  return stations.map((station) => {
    if (!stationNeedsPdfUserConversion(station)) return { ...station, pdfSpace: "pdf-user" as const };
    const size = sizes.get(station.pageNumber ?? 1);
    if (!size) return station;
    return convertStationToPdfUser(station, size.width, size.height);
  });
}

function scalePoint(point: PlanPoint, factor: number): PlanPoint {
  return { x: point.x * factor, y: point.y * factor };
}

export function scaleAlignmentToPdfUser(alignment: PlanAlignment, factor: number, userWidth: number, userHeight: number): PlanAlignment {
  return {
    points: alignment.points.map((point) => scalePoint(point, factor)),
    draft: alignment.draft.map((point) => scalePoint(point, factor)),
    rasterWidth: userWidth,
    rasterHeight: userHeight,
    markers: alignment.markers.map((marker) => ({ ...marker, distancePx: marker.distancePx * factor })),
  };
}

export function scaleGeorefToPdfUser(georef: Georef | null, factor: number, userWidth: number, userHeight: number): Georef | null {
  if (!georef) return null;
  return {
    ...georef,
    points: georef.points.map((point) => ({ ...point, px: point.px * factor, py: point.py * factor })),
    raster: { width: userWidth, height: userHeight },
  };
}

/**
 * Move plan pixels from the legacy raster into PDF user space.
 * A record already marked `pdf-user` is not scaled again.
 */
export function adoptPdfPlanSpace(input: {
  planSpace: PlanSpace | null;
  alignment: PlanAlignment;
  georef: Georef | null;
  userWidth: number;
  userHeight: number;
}): { planSpace: "pdf-user"; alignment: PlanAlignment; georef: Georef | null; changed: boolean } {
  if (input.planSpace === "pdf-user") {
    return { planSpace: "pdf-user", alignment: input.alignment, georef: input.georef, changed: false };
  }
  const factor = 1 / legacyRasterScale(input.userWidth, input.userHeight);
  return {
    planSpace: "pdf-user",
    alignment: scaleAlignmentToPdfUser(input.alignment, factor, input.userWidth, input.userHeight),
    georef: scaleGeorefToPdfUser(input.georef, factor, input.userWidth, input.userHeight),
    changed: true,
  };
}
