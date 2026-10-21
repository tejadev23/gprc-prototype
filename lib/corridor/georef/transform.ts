import { unitToFeet, type CrsUnits } from "./crs";
import { isComplete, type CompleteControlPoint, type ControlPoint, type GeorefMethod } from "./model";

/**
 * Plan raster pixels to projected plan coordinates:
 *
 *   easting  = m11 * x + m12 * y + tx
 *   northing = m21 * x + m22 * y + ty
 *
 * x is raster pixel right, y is raster pixel DOWN, so northing runs against y. The similarity fit has
 * that flip built in (rotation, one uniform scale, translation). The affine fit is free to shear and to
 * scale each axis separately, which is why it is never the default.
 */
export type PlanTransform = {
  method: GeorefMethod;
  m11: number;
  m12: number;
  m21: number;
  m22: number;
  tx: number;
  ty: number;
};

export function applyTransform(t: PlanTransform, px: number, py: number): { easting: number; northing: number } {
  return { easting: t.m11 * px + t.m12 * py + t.tx, northing: t.m21 * px + t.m22 * py + t.ty };
}

export type WarnLevel = "error" | "warn" | "info";
export type FitWarning = { level: WarnLevel; code: string; message: string; pointId?: string };

export type PointResidual = {
  id: string;
  name?: string;
  check: boolean;
  /** Distance between where the fit puts the pixel and the coordinates entered, in CRS units. */
  residualUnits: number;
  residualFt: number;
  residualPx: number;
  /** Same distance with this point left out of the fit. Null when too few points remain. */
  leaveOneOutFt: number | null;
  outlier: boolean;
};

/** Plain-language band for the worst residual. It says how well the points agree, not how accurate the plan is. */
export type FitQuality = "unvalidated" | "consistent" | "fair" | "poor";

export type FitReport = {
  method: GeorefMethod;
  controlCount: number;
  checkCount: number;
  /** CRS units per raster pixel. */
  scaleUnitsPerPx: number;
  scaleFtPerPx: number;
  /** Angle of the image +x axis, counter-clockwise from east. */
  rotationDeg: number;
  /** Ratio of the two axis scales. 1 for a similarity fit. */
  axisRatio: number;
  residuals: PointResidual[];
  rmsFt: number | null;
  maxFt: number | null;
  rmsPx: number | null;
  maxPx: number | null;
  checkMaxFt: number | null;
  checkMaxPx: number | null;
  quality: FitQuality;
  warnings: FitWarning[];
};

export type FitResult =
  | { ok: true; transform: PlanTransform; report: FitReport }
  | { ok: false; reason: string; warnings: FitWarning[] };

export type FitOptions = {
  units: CrsUnits;
  method: GeorefMethod;
  /** Plan raster size, to judge how much of the sheet the points cover. */
  raster?: { width: number; height: number } | null;
  /** Feet per pixel implied by the traced stationing, to cross-check the fit's scale. */
  stationingFtPerPx?: number | null;
};

export const MIN_AFFINE_POINTS = 4;
/** Longest side of the control points' pixel footprint, as a share of the raster, below which we warn. */
const MIN_SPAN_SHARE = 0.25;
/** Width over length of the point cloud below which the points are treated as in a line. */
const COLLINEAR_ASPECT = 0.05;
const COINCIDENT_PX = 1;
const SCALE_TOLERANCE = 0.03;
const CONSISTENT_PX = 3;
const FAIR_PX = 8;

export function fitTransform(inputPoints: readonly ControlPoint[], options: FitOptions): FitResult {
  const warnings: FitWarning[] = [];
  const unfinished = inputPoints.filter((point) => !isComplete(point));
  const allPoints = inputPoints.filter(isComplete);
  for (const point of unfinished) {
    warnings.push({
      level: "info",
      code: "incomplete-point",
      pointId: point.id,
      message: `${point.name || "A control point"} has no easting and northing yet, so it is left out.`,
    });
  }
  const control = allPoints.filter((point) => !point.check);
  const checks = allPoints.filter((point) => point.check);
  const method = options.method;

  if (control.length < 2) {
    warnings.push({ level: "error", code: "insufficient", message: "Add at least two control points with known coordinates." });
    return { ok: false, reason: "At least two control points are needed.", warnings };
  }
  if (method === "affine" && control.length < MIN_AFFINE_POINTS) {
    warnings.push({
      level: "error",
      code: "affine-needs-four",
      message: `An affine fit needs at least ${MIN_AFFINE_POINTS} control points, so it can be checked. Use the similarity fit or add points.`,
    });
    return { ok: false, reason: `Affine needs ${MIN_AFFINE_POINTS} or more control points.`, warnings };
  }

  const shape = pointShape(control);
  if (shape.minGapPx < COINCIDENT_PX) {
    warnings.push({ level: "error", code: "coincident", message: "Two control points sit on the same spot of the plan." });
    return { ok: false, reason: "Two control points coincide on the plan.", warnings };
  }
  if (control.length >= 3 && shape.aspect < COLLINEAR_ASPECT) {
    warnings.push({
      level: method === "affine" ? "error" : "warn",
      code: "collinear",
      message:
        method === "affine"
          ? "The control points lie almost in a straight line, so an affine fit cannot tell shear from rotation. Add a point well off to one side."
          : "The control points lie almost in a straight line. Scale and rotation are fixed by their spacing, but a small pixel error at one end turns into a rotation of the whole corridor, and nothing cross-checks the plan sideways. Add a point off to one side if you can.",
    });
    if (method === "affine") return { ok: false, reason: "Control points are collinear.", warnings };
  }

  const transform = method === "affine" ? solveAffine(control) : solveSimilarity(control);
  if (!transform) {
    warnings.push({ level: "error", code: "singular", message: "The control points do not determine a transform." });
    return { ok: false, reason: "The control points do not determine a transform.", warnings };
  }

  const ftPerUnit = unitToFeet(options.units);
  const scaleUnitsPerPx = Math.sqrt(Math.abs(transform.m11 * transform.m22 - transform.m12 * transform.m21));
  const scaleFtPerPx = scaleUnitsPerPx * ftPerUnit;
  const rotationDeg = (Math.atan2(transform.m21, transform.m11) * 180) / Math.PI;
  const sx = Math.hypot(transform.m11, transform.m21);
  const sy = Math.hypot(transform.m12, transform.m22);
  const axisRatio = Math.min(sx, sy) > 0 ? Math.max(sx, sy) / Math.min(sx, sy) : Infinity;

  const residualOf = (t: PlanTransform, point: CompleteControlPoint) => {
    const at = applyTransform(t, point.px, point.py);
    return Math.hypot(at.easting - point.easting, at.northing - point.northing);
  };
  const minRemaining = method === "affine" ? MIN_AFFINE_POINTS : 2;
  const residuals: PointResidual[] = allPoints.map((point) => {
    const units = residualOf(transform, point);
    let leaveOneOutFt: number | null = null;
    if (!point.check && control.length - 1 >= minRemaining) {
      const rest = control.filter((item) => item.id !== point.id);
      const t = method === "affine" ? solveAffine(rest) : solveSimilarity(rest);
      if (t) leaveOneOutFt = residualOf(t, point) * ftPerUnit;
    }
    return {
      id: point.id,
      name: point.name,
      check: point.check === true,
      residualUnits: units,
      residualFt: units * ftPerUnit,
      residualPx: scaleUnitsPerPx > 0 ? units / scaleUnitsPerPx : Infinity,
      leaveOneOutFt,
      outlier: false,
    };
  });

  // An outlier stands out when the fit without it is far better than with it. Needs enough points to tell.
  const looValues = residuals.flatMap((row) => (row.leaveOneOutFt == null ? [] : [row.leaveOneOutFt]));
  if (control.length >= 4 && looValues.length >= 4) {
    const threshold = Math.max(3 * median(looValues), 3 * CONSISTENT_PX * scaleFtPerPx);
    for (const row of residuals) {
      if (row.leaveOneOutFt != null && row.leaveOneOutFt > threshold) {
        row.outlier = true;
        warnings.push({
          level: "warn",
          code: "outlier",
          pointId: row.id,
          message: `${row.name || "A control point"} sits ${row.leaveOneOutFt.toFixed(1)} ft from where the other points put it. Recheck its pixel position and coordinates.`,
        });
      }
    }
  }

  const used = residuals.filter((row) => !row.check);
  const checkRows = residuals.filter((row) => row.check);
  const rmsFt = used.length > 0 ? Math.sqrt(used.reduce((sum, row) => sum + row.residualFt ** 2, 0) / used.length) : null;
  const maxFt = used.length > 0 ? Math.max(...used.map((row) => row.residualFt)) : null;
  const rmsPx = used.length > 0 ? Math.sqrt(used.reduce((sum, row) => sum + row.residualPx ** 2, 0) / used.length) : null;
  const maxPx = used.length > 0 ? Math.max(...used.map((row) => row.residualPx)) : null;
  const checkMaxFt = checkRows.length > 0 ? Math.max(...checkRows.map((row) => row.residualFt)) : null;
  const checkMaxPx = checkRows.length > 0 ? Math.max(...checkRows.map((row) => row.residualPx)) : null;

  if (control.length === 2 && checks.length === 0) {
    warnings.push({
      level: "info",
      code: "exact-fit",
      message: "Two points fit exactly, so there is no residual to check. Add a third point or a check point to validate the placement.",
    });
  }
  if (options.raster) {
    const spanShare = shape.extentPx / Math.max(options.raster.width, options.raster.height, 1);
    if (spanShare < MIN_SPAN_SHARE) {
      warnings.push({
        level: "warn",
        code: "poor-spread",
        message: `The control points cover only ${(spanShare * 100).toFixed(0)}% of the plan's longest side. Errors grow away from them. Spread points along the whole corridor.`,
      });
    }
  }
  const stationing = options.stationingFtPerPx;
  if (stationing != null && stationing > 0 && scaleFtPerPx > 0) {
    const gap = Math.abs(scaleFtPerPx - stationing) / stationing;
    if (gap > SCALE_TOLERANCE) {
      warnings.push({
        level: "warn",
        code: "scale-vs-stationing",
        message: `The control points imply ${scaleFtPerPx.toFixed(4)} ft per pixel, but the traced stationing implies ${stationing.toFixed(4)} (${(gap * 100).toFixed(1)}% apart). One of them is off.`,
      });
    }
  }
  if (method === "affine" && axisRatio > 1.01) {
    warnings.push({
      level: "warn",
      code: "affine-anisotropy",
      message: `The affine fit scales one axis ${((axisRatio - 1) * 100).toFixed(1)}% more than the other. That can hide a bad control point as easily as it can fix a stretched plan.`,
    });
  }
  if (method === "similarity" && control.length >= MIN_AFFINE_POINTS) {
    const affine = solveAffine(control);
    if (affine) {
      const affineRms = rmsOf(control, affine, ftPerUnit);
      const similarityRms = rmsFt ?? 0;
      if (similarityRms > 2 * scaleFtPerPx && similarityRms > 3 * affineRms) {
        warnings.push({
          level: "warn",
          code: "possible-distortion",
          message:
            "A shear/stretch model fits these points much better than a uniform one. The stitched plan may be distorted. Review the points before switching to affine.",
        });
      }
    }
  }

  const worstPx = Math.max(maxPx ?? 0, checkMaxPx ?? 0);
  const quality: FitQuality =
    control.length === 2 && checks.length === 0
      ? "unvalidated"
      : worstPx <= CONSISTENT_PX
        ? "consistent"
        : worstPx <= FAIR_PX
          ? "fair"
          : "poor";
  if (quality === "poor") {
    warnings.push({
      level: "warn",
      code: "poor-fit",
      message: `The worst point is ${worstPx.toFixed(1)} px from where the fit puts it. Check the coordinates, the units and the CRS.`,
    });
  }

  return {
    ok: true,
    transform,
    report: {
      method,
      controlCount: control.length,
      checkCount: checks.length,
      scaleUnitsPerPx,
      scaleFtPerPx,
      rotationDeg,
      axisRatio,
      residuals,
      rmsFt,
      maxFt,
      rmsPx,
      maxPx,
      checkMaxFt,
      checkMaxPx,
      quality,
      warnings,
    },
  };
}

function rmsOf(points: readonly CompleteControlPoint[], t: PlanTransform, ftPerUnit: number): number {
  const sum = points.reduce((total, point) => {
    const at = applyTransform(t, point.px, point.py);
    return total + (Math.hypot(at.easting - point.easting, at.northing - point.northing) * ftPerUnit) ** 2;
  }, 0);
  return Math.sqrt(sum / Math.max(points.length, 1));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Uniform scale, rotation and translation with the y flip. Least squares over all points, and exact for
 * two. Works with complex numbers: z = x - i*y (pixel, y up), w = easting + i*northing, w = q*z + t.
 */
function solveSimilarity(points: readonly CompleteControlPoint[]): PlanTransform | null {
  const mx = mean(points.map((p) => p.px));
  const my = mean(points.map((p) => p.py));
  const me = mean(points.map((p) => p.easting));
  const mn = mean(points.map((p) => p.northing));
  let num = 0;
  let numI = 0;
  let den = 0;
  for (const p of points) {
    const u = p.px - mx;
    const v = -(p.py - my);
    const e = p.easting - me;
    const n = p.northing - mn;
    num += u * e + v * n; // Re( conj(z) * w )
    numI += u * n - v * e; // Im( conj(z) * w )
    den += u * u + v * v;
  }
  if (den < 1e-12) return null;
  const qa = num / den;
  const qb = numI / den;
  if (!Number.isFinite(qa) || !Number.isFinite(qb) || Math.hypot(qa, qb) < 1e-15) return null;
  return {
    method: "similarity",
    m11: qa,
    m12: qb,
    m21: qb,
    m22: -qa,
    tx: me - (qa * mx + qb * my),
    ty: mn - (qb * mx - qa * my),
  };
}

/** Independent linear map per axis, least squares over all points. */
function solveAffine(points: readonly CompleteControlPoint[]): PlanTransform | null {
  const mx = mean(points.map((p) => p.px));
  const my = mean(points.map((p) => p.py));
  const me = mean(points.map((p) => p.easting));
  const mn = mean(points.map((p) => p.northing));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxe = 0;
  let sye = 0;
  let sxn = 0;
  let syn = 0;
  for (const p of points) {
    const x = p.px - mx;
    const y = p.py - my;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxe += x * (p.easting - me);
    sye += y * (p.easting - me);
    sxn += x * (p.northing - mn);
    syn += y * (p.northing - mn);
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9 * Math.max(sxx * syy, 1)) return null;
  const m11 = (sxe * syy - sye * sxy) / det;
  const m12 = (sye * sxx - sxe * sxy) / det;
  const m21 = (sxn * syy - syn * sxy) / det;
  const m22 = (syn * sxx - sxn * sxy) / det;
  return { method: "affine", m11, m12, m21, m22, tx: me - (m11 * mx + m12 * my), ty: mn - (m21 * mx + m22 * my) };
}

/** Footprint of the control points in pixels: closest pair, aspect of the cloud, and longest side. */
function pointShape(points: readonly ControlPoint[]): { minGapPx: number; aspect: number; extentPx: number } {
  let minGapPx = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      minGapPx = Math.min(minGapPx, Math.hypot(points[i].px - points[j].px, points[i].py - points[j].py));
    }
  }
  const mx = mean(points.map((p) => p.px));
  const my = mean(points.map((p) => p.py));
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (const p of points) {
    cxx += (p.px - mx) ** 2;
    cxy += (p.px - mx) * (p.py - my);
    cyy += (p.py - my) ** 2;
  }
  const tr = cxx + cyy;
  const disc = Math.sqrt(Math.max(0, ((cxx - cyy) / 2) ** 2 + cxy ** 2));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const aspect = l1 > 0 ? Math.sqrt(l2 / l1) : 0;
  const xs = points.map((p) => p.px);
  const ys = points.map((p) => p.py);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return { minGapPx, aspect, extentPx: extent };
}
