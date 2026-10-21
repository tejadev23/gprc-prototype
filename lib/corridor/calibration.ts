import type { AxisTransform, CalibPoint, Calibration } from "./types";

function pairScale(
  points: readonly CalibPoint[],
  axis: "offset" | "elevation",
  pixel: "px" | "py",
): { scale: number; origin: number } | null {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i][axis];
      const b = points[j][axis];
      const pa = points[i][pixel];
      const pb = points[j][pixel];
      if (a == null || b == null || pa == null || pb == null) continue;
      if (Math.abs(a - b) <= 1e-6) continue;
      const scale = (pb - pa) / (b - a);
      if (!Number.isFinite(scale) || scale === 0) continue;
      return { scale, origin: pa - a * scale };
    }
  }
  return null;
}

/** Solve an axis-aligned pixel ↔ offset/elevation transform. Null when the three points do not span both axes. */
export function solveTransform(points: readonly CalibPoint[]): AxisTransform | null {
  if (points.length < 3) return null;
  const sample = points.slice(0, 3);
  if (sample.some((p) => p.px == null || p.py == null || p.offset == null || p.elevation == null)) return null;
  const horizontal = pairScale(sample, "offset", "px");
  const vertical = pairScale(sample, "elevation", "py");
  if (!horizontal || !vertical) return null;
  return { ox: horizontal.origin, oy: vertical.origin, sx: horizontal.scale, sy: vertical.scale };
}

export function pxToReal(transform: AxisTransform, px: number, py: number): { offset: number; elevation: number } {
  return {
    offset: (px - transform.ox) / transform.sx,
    elevation: (py - transform.oy) / transform.sy,
  };
}

export function realToPx(transform: AxisTransform, offset: number, elevation: number): { px: number; py: number } {
  return {
    px: transform.ox + offset * transform.sx,
    py: transform.oy + elevation * transform.sy,
  };
}

export function applyCalibration(points: Calibration["points"]): Calibration {
  return { points, transform: solveTransform(points) };
}

/**
 * Store a canvas click on one calibration point.
 * Empty neighbors get the same defaults as the reference prototype:
 * point 1 assumes offset 0, point 2 copies elevation, point 3 copies offset.
 */
export function withPixelPick(
  points: Calibration["points"],
  index: number,
  px: number,
  py: number,
): Calibration["points"] {
  const next = points.map((p) => ({ ...p })) as Calibration["points"];
  const point = next[index];
  point.px = px;
  point.py = py;
  if (point.offset === null && point.elevation === null) {
    const others = next.filter((q, i) => i !== index && q.offset !== null && q.elevation !== null);
    if (index === 0 || others.length === 0) point.offset = 0;
    else if (index === 1) point.elevation = others[0].elevation;
    else point.offset = others[0].offset;
  }
  return next;
}

export function nextUnsetPixel(points: readonly CalibPoint[]): number | null {
  const idx = points.findIndex((p) => p.px == null);
  return idx >= 0 ? idx : null;
}

/** Preview of a rigid move. Offset and elevation stay on each point. */
export type CalibrationMove = {
  stationId: string;
  pageNumber: number;
  origin: Calibration["points"];
  dx: number;
  dy: number;
};

export function translateGroup(points: Calibration["points"], dx: number, dy: number): Calibration["points"] {
  return points.map((point) => ({
    ...point,
    px: point.px == null ? null : point.px + dx,
    py: point.py == null ? null : point.py + dy,
  })) as Calibration["points"];
}

/** True when the pointer is on a vertex, an edge, or inside the calibration triangle. */
export function hitCalibrationGroup(x: number, y: number, points: Calibration["points"], radius: number): boolean {
  const placed = points.filter((point): point is CalibPoint & { px: number; py: number } => point.px != null && point.py != null);
  if (placed.length < 3) return false;
  const [a, b, c] = placed;
  for (const point of placed) {
    if ((point.px - x) ** 2 + (point.py - y) ** 2 <= radius * radius) return true;
  }
  if (distanceToSegment(x, y, a.px, a.py, b.px, b.py) <= radius) return true;
  if (distanceToSegment(x, y, b.px, b.py, c.px, c.py) <= radius) return true;
  if (distanceToSegment(x, y, c.px, c.py, a.px, a.py) <= radius) return true;
  return pointInTriangle(x, y, a.px, a.py, b.px, b.py, c.px, c.py);
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
) {
  const d1 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d2 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const d3 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
