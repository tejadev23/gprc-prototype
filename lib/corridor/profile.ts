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
