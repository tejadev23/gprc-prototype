import { realToPx } from "./calibration";
import { resolveStationPage } from "./page-ref";
import { fitView } from "@/lib/tracing/coords";
import type { ViewState } from "@/lib/tracing/types";
import type { Station } from "./types";

export type StationIdentity = Pick<Station, "id" | "name" | "pageNumber">;

/**
 * The selected station decides which PDF page is shown.
 * A station with no page yet leaves the viewer where it is. An invalid page does not move.
 */
export function viewForStation(station: StationIdentity, numPages: number | null, currentPage: number): { page: number; notice: string | null } {
  const resolved = resolveStationPage(station, numPages);
  if (resolved.ok) return { page: resolved.page, notice: null };
  if (resolved.reason === "no-page") return { page: currentPage, notice: null };
  return { page: currentPage, notice: resolved.message };
}

/** Look up by stable id. Names and sidebar order are not identities. */
export function stationById<T extends { id: string }>(stations: readonly T[], id: string | null): T | null {
  if (!id) return null;
  return stations.find((station) => station.id === id) ?? null;
}

/**
 * A finished raster may be shown only for the page that was requested and is still current.
 * A slower render for a station the user already left must not land.
 */
export function acceptPageRaster(requestedPage: number, currentPage: number): boolean {
  return requestedPage === currentPage;
}

/** Next and previous stay inside the document and do not rewrite any station. */
export function turnPage(current: number, delta: number, numPages: number): number {
  if (numPages < 1) return current;
  return Math.min(numPages, Math.max(1, current + delta));
}

/** Calibration clicks and traced grade breaks, in the page's pixel space. */
export function sectionPixels(station: Pick<Station, "calibration" | "existing" | "proposed">): { x: number; y: number }[] {
  const pixels: { x: number; y: number }[] = [];
  for (const point of station.calibration.points) {
    if (point.px != null && point.py != null) pixels.push({ x: point.px, y: point.py });
  }
  const transform = station.calibration.transform;
  if (!transform) return pixels;
  for (const point of [...station.existing, ...station.proposed]) {
    const raw = realToPx(transform, point.offset, point.elevation);
    pixels.push({ x: raw.px, y: raw.py });
  }
  return pixels;
}

/**
 * Fit the canvas to one station's marks. A page can hold several cross-sections;
 * the station's own pixels are what pick its diagram out of that page.
 */
export function framePoints(canvasW: number, canvasH: number, points: readonly { x: number; y: number }[], pad = 36): ViewState | null {
  if (points.length === 0 || canvasW < 8 || canvasH < 8) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const width = Math.max(maxX - minX, 80);
  const height = Math.max(maxY - minY, 80);
  const boxW = width + pad * 2;
  const boxH = height + pad * 2;
  const fitted = fitView(canvasW, canvasH, boxW, boxH, 0);
  const left = (minX + maxX) / 2 - width / 2 - pad;
  const top = (minY + maxY) / 2 - height / 2 - pad;
  return {
    scale: fitted.scale,
    originX: fitted.originX - left * fitted.scale,
    originY: fitted.originY - top * fitted.scale,
  };
}
