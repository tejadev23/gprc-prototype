/** Plan-image point. Origin is the raster top-left, +x right, +y down. */
export type PlanPoint = { x: number; y: number };

export type AlignmentMarker = {
  id: string;
  label: string;
  stationFt: number;
  /** Arc length from the start of the finished polyline, in image pixels. */
  distancePx: number;
  stationId: string | null;
};

export type PlanAlignment = {
  points: PlanPoint[];
  draft: PlanPoint[];
  rasterWidth: number | null;
  rasterHeight: number | null;
  markers: AlignmentMarker[];
};

export function emptyAlignment(): PlanAlignment {
  return { points: [], draft: [], rasterWidth: null, rasterHeight: null, markers: [] };
}

/** A segment scale this far from the median is reported and left unchanged. */
export const SCALE_TOLERANCE = 0.05;

export function polylineLength(points: readonly PlanPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

export function pointOnPolyline(
  points: readonly PlanPoint[],
  distancePx: number,
): { point: PlanPoint; tangent: PlanPoint } | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { point: points[0], tangent: { x: 1, y: 0 } };
  let remaining = Math.min(Math.max(0, distancePx), polylineLength(points));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    if (remaining <= len + 1e-6 || i === points.length - 1) {
      const t = Math.min(1, Math.max(0, remaining / len));
      const mag = len || 1;
      return {
        point: { x: a.x + dx * t, y: a.y + dy * t },
        tangent: { x: dx / mag, y: dy / mag },
      };
    }
    remaining -= len;
  }
  const last = points[points.length - 1];
  return { point: last, tangent: { x: 1, y: 0 } };
}

/** Nearest point on the polyline. `distancePx` is arc length, not the gap to the click. */
export function snapToPolyline(
  points: readonly PlanPoint[],
  x: number,
  y: number,
): { point: PlanPoint; distancePx: number; gap: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) {
    const gap = Math.hypot(points[0].x - x, points[0].y - y);
    return { point: points[0], distancePx: 0, gap };
  }
  let best: { point: PlanPoint; distancePx: number; gap: number } | null = null;
  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const gap = Math.hypot(point.x - x, point.y - y);
    if (!best || gap < best.gap) best = { point, distancePx: traveled + len * t, gap };
    traveled += len;
  }
  return best;
}

export type ScaleSegment = {
  from: AlignmentMarker;
  to: AlignmentMarker;
  feetPerPixel: number;
};

/** Consecutive markers in arc-length order whose station numbers increase. */
export function segmentScales(markers: readonly AlignmentMarker[]): ScaleSegment[] {
  const ordered = [...markers].sort((a, b) => a.distancePx - b.distancePx || a.stationFt - b.stationFt);
  const scales: ScaleSegment[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const dPx = to.distancePx - from.distancePx;
    const dSta = to.stationFt - from.stationFt;
    if (dPx > 1e-6 && dSta > 0) scales.push({ from, to, feetPerPixel: dSta / dPx });
  }
  return scales;
}

export function referenceScale(markers: readonly AlignmentMarker[]): number | null {
  const values = segmentScales(markers).map((segment) => segment.feetPerPixel);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function alignmentWarnings(markers: readonly AlignmentMarker[]): string[] {
  const warnings: string[] = [];
  const seen = new Map<number, string>();
  for (const marker of markers) {
    const key = Math.round(marker.stationFt * 1000);
    const previous = seen.get(key);
    if (previous) warnings.push(`${marker.label} repeats ${previous}.`);
    else seen.set(key, marker.label);
  }
  const ordered = [...markers].sort((a, b) => a.distancePx - b.distancePx || a.stationFt - b.stationFt);
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const dPx = to.distancePx - from.distancePx;
    const dSta = to.stationFt - from.stationFt;
    if (dPx <= 1e-6) warnings.push(`${from.label} and ${to.label} sit on the same point of the mainline.`);
    else if (dSta < 0) warnings.push(`${from.label} to ${to.label} goes backward in station number.`);
  }
  const scale = referenceScale(markers);
  if (scale != null && scale > 0) {
    for (const segment of segmentScales(markers)) {
      if (Math.abs(segment.feetPerPixel - scale) / scale > SCALE_TOLERANCE) {
        warnings.push(`${segment.from.label} to ${segment.to.label} does not match the alignment scale.`);
      }
    }
  }
  return warnings;
}

/**
 * Arc-length position of a station that falls strictly between two markers.
 * The fraction follows the polyline between those markers, including bends.
 */
export function chainageDistance(
  markers: readonly AlignmentMarker[],
  stationFt: number,
): { distancePx: number } | { error: string } {
  if (markers.length < 2) return { error: "Place at least two station markers before using a chainage." };
  if (markers.some((marker) => Math.abs(marker.stationFt - stationFt) < 1e-6)) {
    return { error: "That station is already on the mainline." };
  }
  const byStation = [...markers].sort((a, b) => a.stationFt - b.stationFt);
  let pair: [AlignmentMarker, AlignmentMarker] | null = null;
  for (let i = 0; i < byStation.length - 1; i++) {
    if (byStation[i].stationFt < stationFt && stationFt < byStation[i + 1].stationFt) {
      pair = [byStation[i], byStation[i + 1]];
      break;
    }
  }
  if (!pair) return { error: "That station is not between two markers on the mainline." };
  const [start, end] = pair;
  const span = end.stationFt - start.stationFt;
  if (!(span > 0)) return { error: "Those markers do not have an increasing station range." };
  const t = (stationFt - start.stationFt) / span;
  return { distancePx: start.distancePx + (end.distancePx - start.distancePx) * t };
}

/** Image-space right of travel, mapped into world X / Z. Positive offset uses this direction. */
export function rightVector(tangent: PlanPoint): { x: number; z: number } {
  const wx = -tangent.y;
  const wz = -tangent.x;
  const mag = Math.hypot(wx, wz) || 1;
  return { x: wx / mag, z: wz / mag };
}
