import { DEFAULT_CRS_CODE, findCrs, type CrsUnits } from "./crs";

/**
 * A control point ties one spot on the stitched plan image to known projected coordinates.
 * `px`/`py` are in the plan's own raster pixels (origin top-left, y down), not screen pixels, so they do
 * not move with pan, zoom, or window size. `easting`/`northing` are in the project CRS units, and stay
 * null until the user types them. A point without both is kept but takes no part in the fit.
 */
export type ControlPoint = {
  id: string;
  name?: string;
  px: number;
  py: number;
  easting: number | null;
  northing: number | null;
  /** A check point is kept out of the fit and only reported against it. */
  check?: boolean;
};

export type CompleteControlPoint = ControlPoint & { easting: number; northing: number };

export function isComplete(point: ControlPoint): point is CompleteControlPoint {
  return point.easting != null && point.northing != null && Number.isFinite(point.easting) && Number.isFinite(point.northing);
}

export type GeorefMethod = "similarity" | "affine";

/**
 * Georeferencing inputs for one GPRC project. Only inputs are stored. The transform, residuals and
 * longitude/latitude are recomputed from these every time.
 *
 * Horizontal and vertical are kept apart: `crs` and `points` are horizontal, `vertical` is metadata
 * about the elevations on the cross-section sheets and takes no part in the horizontal fit.
 */
export type Georef = {
  crs: { code: string; units: CrsUnits; verified: boolean };
  points: ControlPoint[];
  method: GeorefMethod;
  /** Raster size of the plan the points were picked on, so a replaced plan is noticed. */
  raster: { width: number; height: number } | null;
  vertical: { datum: string; units: CrsUnits };
};

export function defaultGeoref(): Georef {
  const crs = findCrs(DEFAULT_CRS_CODE);
  return {
    // Starting configuration only. The user verifies it against the plan sheet.
    crs: { code: DEFAULT_CRS_CODE, units: crs?.units ?? "ft-us", verified: false },
    points: [],
    method: "similarity",
    raster: null,
    vertical: { datum: "", units: "ft-us" },
  };
}

const UNITS: readonly CrsUnits[] = ["ft-us", "ft-intl", "m"];

function isUnits(value: unknown): value is CrsUnits {
  return typeof value === "string" && (UNITS as readonly string[]).includes(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Records saved before georeferencing existed have none. Bad entries are dropped, never repaired. */
export function normalizeGeoref(raw: unknown): Georef | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Partial<Georef>;
  const fallback = defaultGeoref();
  const code = typeof input.crs?.code === "string" && input.crs.code ? input.crs.code : fallback.crs.code;
  const known = findCrs(code);
  const units = known ? known.units : isUnits(input.crs?.units) ? input.crs.units : fallback.crs.units;
  const points = Array.isArray(input.points)
    ? input.points.flatMap((point): ControlPoint[] => {
        if (!point || typeof point.id !== "string") return [];
        if (!finite(point.px) || !finite(point.py)) return [];
        if (point.easting != null && !finite(point.easting)) return [];
        if (point.northing != null && !finite(point.northing)) return [];
        return [
          {
            id: point.id,
            ...(typeof point.name === "string" && point.name ? { name: point.name } : {}),
            px: point.px,
            py: point.py,
            easting: point.easting ?? null,
            northing: point.northing ?? null,
            ...(point.check ? { check: true } : {}),
          },
        ];
      })
    : [];
  const raster =
    input.raster && finite(input.raster.width) && finite(input.raster.height) && input.raster.width > 0 && input.raster.height > 0
      ? { width: input.raster.width, height: input.raster.height }
      : null;
  return {
    crs: { code, units, verified: input.crs?.verified === true },
    points,
    method: input.method === "affine" ? "affine" : "similarity",
    raster,
    vertical: {
      datum: typeof input.vertical?.datum === "string" ? input.vertical.datum : "",
      units: isUnits(input.vertical?.units) ? input.vertical.units : fallback.vertical.units,
    },
  };
}
