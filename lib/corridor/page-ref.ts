import type { Station } from "./types";

type PageStation = Pick<Station, "name" | "pageNumber">;

export type PageResolution =
  | { ok: true; page: number }
  | { ok: false; reason: "no-page" | "no-pdf" | "invalid"; message: string };

/**
 * Which PDF page a station refers to. Pages are 1-based, as stored.
 * A station with no page is not an error: the viewer stays where it is.
 */
export function resolveStationPage(station: PageStation, numPages: number | null): PageResolution {
  const page = station.pageNumber;
  if (page == null) {
    return { ok: false, reason: "no-page", message: `${station.name} has no PDF page yet. Trace or calibrate it on the page you want.` };
  }
  if (!numPages || numPages < 1) {
    return { ok: false, reason: "no-pdf", message: `${station.name} is on page ${page}. Load the cross-section PDF to see it.` };
  }
  if (!Number.isInteger(page) || page < 1 || page > numPages) {
    return {
      ok: false,
      reason: "invalid",
      message: `${station.name} points to page ${page}, but this PDF has ${numPages} ${numPages === 1 ? "page" : "pages"}.`,
    };
  }
  return { ok: true, page };
}

/** Pixel marks live in one page's image space, so they only make sense on that page. */
export function stationHasPixelData(station: Pick<Station, "calibration" | "existing" | "proposed">): boolean {
  return (
    station.existing.length > 0 ||
    station.proposed.length > 0 ||
    station.calibration.points.some((point) => point.px != null || point.py != null)
  );
}

export type PickDecision =
  | { allow: true; assignPage: boolean }
  | { allow: false; message: string };

/**
 * A click on the sheet writes pixels. Allow it on the station's own page, and let it claim the page
 * when the station has none. Refuse it on another page once the station holds marks, because those
 * marks would then be read against the wrong image.
 */
export function decidePick(
  station: Pick<Station, "name" | "pageNumber" | "calibration" | "existing" | "proposed">,
  viewPage: number,
): PickDecision {
  if (station.pageNumber == null) return { allow: true, assignPage: true };
  if (station.pageNumber === viewPage) return { allow: true, assignPage: false };
  if (!stationHasPixelData(station)) return { allow: true, assignPage: true };
  return {
    allow: false,
    message: `${station.name} is marked on page ${station.pageNumber}. Go to that page to edit it.`,
  };
}

/**
 * Calibration and traces are stored in one page's pixel space. Draw them only on the image of that page.
 * A station that has no page yet may draw on the page that is actually showing. A missing image draws nothing,
 * so a station selected while the next page is still rendering cannot land on the previous page.
 */
export function marksMatchRenderedPage(stationPage: number | null, renderedPage: number | null): boolean {
  if (renderedPage == null) return false;
  if (stationPage == null) return true;
  return stationPage === renderedPage;
}

/** A raster only belongs to the document and page it was rendered for. */
export function rasterIsCurrent(
  raster: { doc: unknown; page: number } | null,
  doc: unknown | null,
  page: number,
): boolean {
  return raster != null && doc != null && raster.doc === doc && raster.page === page;
}
