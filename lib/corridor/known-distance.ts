import type { AxisTransform } from "./types";

/**
 * Two-point known-distance sample.
 * Coordinates are PDF user-space pixels (the same space as a three-point calibration after migration).
 * This record establishes scale only. It does not replace `AxisTransform` and is not stored on a station.
 */
export type KnownDistance = {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  distanceFt: number;
  pageNumber: number | null;
};

export function pixelDistance(sample: Pick<KnownDistance, "ax" | "ay" | "bx" | "by">): number {
  return Math.hypot(sample.bx - sample.ax, sample.by - sample.ay);
}

/** Feet per pixel. Null when the span cannot define a scale. */
export function knownDistanceScale(sample: KnownDistance): number | null {
  if (!(sample.distanceFt > 0)) return null;
  const pixels = pixelDistance(sample);
  if (!(pixels > 1e-9)) return null;
  const scale = sample.distanceFt / pixels;
  return Number.isFinite(scale) ? scale : null;
}

/**
 * `transform.sx` is pixels per foot on the offset axis.
 * A known-distance scale is feet per pixel and can only check that axis, not build a new origin.
 */
export function knownDistanceAgrees(sample: KnownDistance, transform: AxisTransform, tolerance = 0.05): boolean {
  const feetPerPixel = knownDistanceScale(sample);
  if (feetPerPixel == null || !(Math.abs(transform.sx) > 1e-9)) return false;
  const fromTransform = 1 / Math.abs(transform.sx);
  return Math.abs(feetPerPixel - fromTransform) / fromTransform <= tolerance;
}
