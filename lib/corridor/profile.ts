import type { ProfilePoint } from "./types";

export function sortByOffset(points: readonly ProfilePoint[]): ProfilePoint[] {
  return [...points].sort((a, b) => a.offset - b.offset || a.elevation - b.elevation);
}

/**
 * Polyline used for drawing. Every clicked grade break is kept.
 * A later resampler can wrap this without changing the stored points.
 */
export function displayProfile(points: readonly ProfilePoint[]): ProfilePoint[] {
  return sortByOffset(points);
}

export type SegmentHit = {
  /** Index of the segment start in the polyline the caller passed. */
  index: number;
  /** 0 at the start vertex, 1 at the end vertex. */
  t: number;
  x: number;
  y: number;
  distance: number;
};

/** Closest point on a polyline segment, in the same units as `points`. */
export function nearestSegment(
  points: readonly { x: number; y: number }[],
  x: number,
  y: number,
  maxDistance: number,
): SegmentHit | null {
  let best: SegmentHit | null = null;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) continue;
    const t = Math.min(1, Math.max(0, ((x - a.x) * abx + (y - a.y) * aby) / len2));
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const distance = Math.hypot(x - px, y - py);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) best = { index, t, x: px, y: py, distance };
  }
  return best;
}

/**
 * Insert `point` into the offset-sorted polyline, between `segmentIndex` and the next vertex.
 * Existing coordinates are copied unchanged. The stored order becomes that sorted order.
 */
export function insertOnDisplaySegment(points: readonly ProfilePoint[], segmentIndex: number, point: ProfilePoint): ProfilePoint[] {
  const sorted = sortByOffset(points);
  if (segmentIndex < 0 || segmentIndex >= sorted.length - 1) return sorted;
  const next = sorted.slice();
  next.splice(segmentIndex + 1, 0, point);
  return next;
}

/** Linear elevation at an offset. Clamps outside the profile, matching the reference prototype. */
export function elevationAt(sorted: readonly ProfilePoint[], offset: number): number {
  if (sorted.length === 0) return 0;
  if (offset <= sorted[0].offset) return sorted[0].elevation;
  const last = sorted[sorted.length - 1];
  if (offset >= last.offset) return last.elevation;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const dx = b.offset - a.offset;
    if (Math.abs(dx) < 1e-9) continue;
    if (offset >= a.offset && offset <= b.offset) {
      const t = (offset - a.offset) / dx;
      return a.elevation + t * (b.elevation - a.elevation);
    }
  }
  return last.elevation;
}
