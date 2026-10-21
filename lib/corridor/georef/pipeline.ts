import { findCrs, insideBounds, isValidLonLat, projectedToWgs84, unitLabel, type CrsDef, type LonLat } from "./crs";
import { isComplete, type Georef } from "./model";
import { applyTransform, fitTransform, type FitReport, type FitWarning, type PlanTransform } from "./transform";

/**
 * plan raster pixel -> projected plan coordinates (CRS units) -> WGS84 longitude/latitude.
 * Horizontal only. Elevations are carried separately and never pass through here.
 */
export type Georeference = {
  crs: CrsDef;
  transform: PlanTransform;
  report: FitReport;
  pixelToProjected: (px: number, py: number) => { easting: number; northing: number };
  pixelToLonLat: (px: number, py: number) => LonLat;
};

export type PointCheck = {
  id: string;
  name?: string;
  check: boolean;
  known: LonLat;
  fitted: LonLat;
  /** Ground distance between where the point was entered and where the fit places its pixel. */
  groundErrorM: number;
};

export type ResolveContext = {
  raster?: { width: number; height: number } | null;
  stationingFtPerPx?: number | null;
};

export type ResolveResult =
  | { ok: true; georeference: Georeference; warnings: FitWarning[]; checks: PointCheck[]; blockers: string[] }
  | { ok: false; reason: string; warnings: FitWarning[] };

export function resolveGeoreference(georef: Georef, context: ResolveContext = {}): ResolveResult {
  const crs = findCrs(georef.crs.code);
  if (!crs) {
    return { ok: false, reason: `${georef.crs.code} is not a supported coordinate system here.`, warnings: [] };
  }
  const raster = context.raster ?? georef.raster;
  const fit = fitTransform(georef.points, {
    units: crs.units,
    method: georef.method,
    raster,
    stationingFtPerPx: context.stationingFtPerPx,
  });
  if (!fit.ok) return { ok: false, reason: fit.reason, warnings: fit.warnings };

  const warnings = [...fit.report.warnings];
  const blockers: string[] = [];
  const { transform, report } = fit;
  const pixelToProjected = (px: number, py: number) => applyTransform(transform, px, py);
  const pixelToLonLat = (px: number, py: number) => {
    const at = pixelToProjected(px, py);
    return projectedToWgs84(crs, at.easting, at.northing);
  };

  if (!georef.crs.verified) {
    blockers.push(`Confirm that ${crs.name} is the coordinate system of the plan sheet.`);
    warnings.push({ level: "warn", code: "crs-unverified", message: `${crs.name} has not been confirmed for this plan yet.` });
  }
  if (georef.raster && context.raster && (georef.raster.width !== context.raster.width || georef.raster.height !== context.raster.height)) {
    blockers.push("The plan image changed since the control points were picked.");
    warnings.push({
      level: "error",
      code: "raster-changed",
      message: `The control points were picked on a ${georef.raster.width}×${georef.raster.height} px plan, but the plan is now ${context.raster.width}×${context.raster.height} px.`,
    });
  }

  const checks: PointCheck[] = [];
  for (const point of georef.points.filter(isComplete)) {
    const known = projectedToWgs84(crs, point.easting, point.northing);
    const fitted = pixelToLonLat(point.px, point.py);
    if (!isValidLonLat(known) || !isValidLonLat(fitted)) {
      blockers.push(`${point.name || "A control point"} does not convert to a valid longitude/latitude.`);
      warnings.push({ level: "error", code: "invalid-lonlat", pointId: point.id, message: `${point.name || "A control point"} does not convert to a valid longitude/latitude. Check its coordinates and units.` });
      continue;
    }
    if (!insideBounds(crs, known)) {
      warnings.push({
        level: "warn",
        code: "outside-crs-area",
        pointId: point.id,
        message: `${point.name || "A control point"} lands at ${known.lat.toFixed(4)}°, ${known.lon.toFixed(4)}°, outside the area of ${crs.name}. Check the zone and the units (${unitLabel(crs.units)}).`,
      });
    }
    checks.push({ id: point.id, name: point.name, check: point.check === true, known, fitted, groundErrorM: haversineMeters(known, fitted) });
  }
  if (raster) {
    for (const [px, py] of [[0, 0], [raster.width, 0], [0, raster.height], [raster.width, raster.height]] as const) {
      if (!isValidLonLat(pixelToLonLat(px, py))) {
        blockers.push("The plan's corners do not convert to valid longitude/latitude.");
        break;
      }
    }
  }
  if (report.quality === "poor") blockers.push("The control points disagree too much. Fix the worst point first.");
  if (warnings.some((w) => w.level === "error")) blockers.push("Resolve the control-point errors above.");

  return {
    ok: true,
    georeference: { crs, transform, report, pixelToProjected, pixelToLonLat },
    warnings,
    checks,
    blockers: [...new Set(blockers)],
  };
}

/** Great-circle distance on the WGS84 mean radius. Plenty for comparing two points metres apart. */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
