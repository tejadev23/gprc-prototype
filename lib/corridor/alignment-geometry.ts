import { pointOnPolyline, referenceScale, rightVector, type AlignmentMarker, type PlanAlignment, type PlanPoint } from "./alignment";
import { pushQuad, type CorridorGeometry, type LineGeometry, type MeshGeometry } from "./corridor-geometry";
import { elevationAt, sortByOffset } from "./profile";
import { isSectionReady } from "./stations";
import type { ProfilePoint, Station } from "./types";

const EMPTY_LINE = new Float32Array();

/**
 * Where a point of a cross-section goes. `point` is on the traced mainline (plan pixels) and `tangent` is
 * the direction of travel there. `offsetFt` is feet right of the mainline (negative is left) and
 * `elevation` is the sheet's elevation. The 3D viewer and the KMZ export both build their surfaces
 * through this one interface, so they cannot disagree about the corridor's shape.
 */
export type SurfaceFrame = {
  place(point: PlanPoint, tangent: PlanPoint, offsetFt: number, elevation: number): [number, number, number];
};

export type PlacedSection = {
  marker: AlignmentMarker;
  station: Station;
  sample: { point: PlanPoint; tangent: PlanPoint };
};

/**
 * Stations linked to a marker, in order along the mainline, once two markers have set the scale.
 * Nothing is placed before that, and a marker with no station record is skipped.
 */
export function placedSections(stations: readonly Station[], alignment: PlanAlignment): PlacedSection[] {
  const scale = referenceScale(alignment.markers);
  if (alignment.points.length < 2 || scale == null || !(scale > 0)) return [];
  const byId = new Map(stations.map((station) => [station.id, station]));
  return alignment.markers
    .flatMap((marker) => {
      const station = marker.stationId ? byId.get(marker.stationId) : undefined;
      const sample = station ? pointOnPolyline(alignment.points, marker.distancePx) : null;
      return station && sample ? [{ marker, station, sample }] : [];
    })
    .sort((a, b) => a.marker.distancePx - b.marker.distancePx);
}

export type SurfaceBay = { from: PlacedSection; to: PlacedSection; drawn: boolean };

/**
 * Section lines, existing/proposed ribbons and cut/fill prisms along the mainline, in the given frame.
 * A bay between two neighbouring markers is drawn only when both ends are finished sections. A marker
 * with no finished section leaves a gap, and no surface is invented across it.
 */
export function buildCorridorSurfaces(
  placed: readonly PlacedSection[],
  points: readonly PlanPoint[],
  frame: SurfaceFrame,
): { lines: LineGeometry[]; ribbons: MeshGeometry[]; prisms: MeshGeometry[]; bays: SurfaceBay[] } {
  const lines: LineGeometry[] = [];
  const ribbons: MeshGeometry[] = [];
  const prisms: MeshGeometry[] = [];
  const bays: SurfaceBay[] = [];
  for (const row of placed) {
    const existing = sortByOffset(row.station.existing);
    const proposed = sortByOffset(row.station.proposed);
    if (existing.length >= 2) lines.push(sectionLine("existing", row.station.id, existing, row.sample, frame));
    if (proposed.length >= 2) lines.push(sectionLine("proposed", row.station.id, proposed, row.sample, frame));
  }
  for (let i = 0; i < placed.length - 1; i++) {
    const a = placed[i];
    const b = placed[i + 1];
    // A station marker with no finished section opens a gap. Do not invent a surface across it.
    const drawn = isSectionReady(a.station) && isSectionReady(b.station);
    bays.push({ from: a, to: b, drawn });
    if (!drawn) continue;
    const existing = sweepRibbon(
      sortByOffset(a.station.existing),
      sortByOffset(b.station.existing),
      points,
      a.marker.distancePx,
      b.marker.distancePx,
      frame,
      "existing",
    );
    const proposed = sweepRibbon(
      sortByOffset(a.station.proposed),
      sortByOffset(b.station.proposed),
      points,
      a.marker.distancePx,
      b.marker.distancePx,
      frame,
      "proposed",
    );
    if (existing) ribbons.push(existing);
    if (proposed) ribbons.push(proposed);
    prisms.push(
      ...sweepCutFill(
        sortByOffset(a.station.existing),
        sortByOffset(a.station.proposed),
        sortByOffset(b.station.existing),
        sortByOffset(b.station.proposed),
        points,
        a.marker.distancePx,
        b.marker.distancePx,
        frame,
      ),
    );
  }
  return { lines, ribbons, prisms, bays };
}

/**
 * GPRC scene. X/Z follow the traced plan at one scale. Y is elevation in feet.
 * Cross-sections are omitted until two markers establish that scale.
 * Cut and fill prisms are drawn between neighbouring finished sections only, as a picture of the
 * volume. The numbers stay on station-number length in volumes.ts and are not computed here.
 */
export function buildAlignedCorridorGeometry(stations: readonly Station[], alignment: PlanAlignment): CorridorGeometry & {
  centerline: Float32Array;
} {
  const points = alignment.points;
  if (points.length < 2) {
    return { lines: [], ribbons: [], prisms: [], labels: [], center: [0, 0, 0], span: 80, centerline: EMPTY_LINE };
  }

  const scale = referenceScale(alignment.markers);
  const established = scale != null && scale > 0;
  const k = established ? scale : 1;
  const origin = points[0];
  const byId = new Map(stations.map((station) => [station.id, station]));
  const linked = established
    ? alignment.markers.flatMap((marker) => {
        const station = marker.stationId ? byId.get(marker.stationId) : undefined;
        return station ? [{ marker, station }] : [];
      })
    : [];

  let elvMin = Infinity;
  let elvMax = -Infinity;
  for (const row of linked) {
    for (const point of [...row.station.existing, ...row.station.proposed]) {
      elvMin = Math.min(elvMin, point.elevation);
      elvMax = Math.max(elvMax, point.elevation);
    }
  }
  const baseElev = Number.isFinite(elvMin) ? Math.floor(elvMin / 10) * 10 - 5 : 0;
  const elevationSamples = linked
    .flatMap((row) => {
      const elevation = centerElevation(row.station);
      return elevation == null ? [] : [{ distancePx: row.marker.distancePx, elevation }];
    })
    .sort((a, b) => a.distancePx - b.distancePx);

  const centerline = new Float32Array(points.length * 3);
  let traveled = 0;
  points.forEach((point, index) => {
    if (index > 0) {
      traveled += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    }
    const [x, y, z] = planToWorld(point, origin, k, elevationOnAlignment(elevationSamples, traveled), baseElev);
    centerline[index * 3] = x;
    centerline[index * 3 + 1] = y;
    centerline[index * 3 + 2] = z;
  });

  const labels: CorridorGeometry["labels"] = [];
  const placed = placedSections(stations, alignment);
  const frame: SurfaceFrame = {
    place(point, tangent, offsetFt, elevation) {
      const [x, y, z] = planToWorld(point, origin, k, elevation, baseElev);
      const right = rightVector(tangent);
      return [x + right.x * offsetFt, y, z + right.z * offsetFt];
    },
  };
  const { lines, ribbons, prisms } = buildCorridorSurfaces(placed, points, frame);

  for (const row of placed) {
    const missing = !isSectionReady(row.station);
    const center = centerElevation(row.station) ?? elevationOnAlignment(elevationSamples, row.marker.distancePx);
    const [x, y, z] = planToWorld(row.sample.point, origin, k, center, baseElev);
    labels.push({
      stationId: row.station.id,
      name: row.marker.label,
      position: [x, y + 8, z],
      missing,
    });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const include = (x: number, y: number, z: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  for (let i = 0; i < centerline.length; i += 3) include(centerline[i], centerline[i + 1], centerline[i + 2]);
  for (const line of lines) {
    for (let i = 0; i < line.positions.length; i += 3) include(line.positions[i], line.positions[i + 1], line.positions[i + 2]);
  }
  const width = Math.max(maxX - minX, 1);
  const depth = Math.max(maxZ - minZ, 1);
  const height = Math.max(maxY - minY, 1);
  return {
    lines,
    ribbons,
    prisms,
    labels,
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    span: Math.max(width, depth, height, 40),
    centerline,
  };
}

/**
 * Cut where existing is above proposed, fill where it is below, swept along the mainline.
 * Same rule as the straight corridor: classify each cell by its average height difference.
 */
export function sweepCutFill(
  exA: ProfilePoint[],
  prA: ProfilePoint[],
  exB: ProfilePoint[],
  prB: ProfilePoint[],
  points: readonly PlanPoint[],
  distanceA: number,
  distanceB: number,
  frame: SurfaceFrame,
): MeshGeometry[] {
  if (exA.length < 2 || prA.length < 2 || exB.length < 2 || prB.length < 2) return [];
  const xL = Math.max(prA[0].offset, prB[0].offset);
  const xR = Math.min(prA[prA.length - 1].offset, prB[prB.length - 1].offset);
  if (xR <= xL) return [];
  const xs = [
    ...new Set([xL, xR, ...[...exA, ...prA, ...exB, ...prB].map((p) => p.offset).filter((x) => x >= xL && x <= xR)]),
  ].sort((a, b) => a - b);

  const steps = 12;
  type Sample = { point: PlanPoint; tangent: PlanPoint; t: number };
  const samples: Sample[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const sample = pointOnPolyline(points, distanceA + (distanceB - distanceA) * t);
    if (sample) samples.push({ point: sample.point, tangent: sample.tangent, t });
  }
  if (samples.length < 2) return [];

  const ex = (x: number, t: number) => (1 - t) * elevationAt(exA, x) + t * elevationAt(exB, x);
  const pr = (x: number, t: number) => (1 - t) * elevationAt(prA, x) + t * elevationAt(prB, x);
  const place = (sample: Sample, offset: number, elevation: number) => frame.place(sample.point, sample.tangent, offset, elevation);

  const cutV: number[] = [];
  const cutI: number[] = [];
  const fillV: number[] = [];
  const fillI: number[] = [];
  for (let s = 0; s < samples.length - 1; s++) {
    const s0 = samples[s];
    const s1 = samples[s + 1];
    for (let i = 0; i < xs.length - 1; i++) {
      const x1 = xs[i];
      const x2 = xs[i + 1];
      const avgDh =
        (ex(x1, s0.t) - pr(x1, s0.t) + (ex(x2, s0.t) - pr(x2, s0.t)) + (ex(x1, s1.t) - pr(x1, s1.t)) + (ex(x2, s1.t) - pr(x2, s1.t))) / 4;
      if (Math.abs(avgDh) < 0.01) continue;
      const v = avgDh > 0 ? cutV : fillV;
      const idx = avgDh > 0 ? cutI : fillI;
      const top = [place(s0, x1, ex(x1, s0.t)), place(s0, x2, ex(x2, s0.t)), place(s1, x2, ex(x2, s1.t)), place(s1, x1, ex(x1, s1.t))];
      const bot = [place(s0, x1, pr(x1, s0.t)), place(s0, x2, pr(x2, s0.t)), place(s1, x2, pr(x2, s1.t)), place(s1, x1, pr(x1, s1.t))];
      // The ribbons already draw the existing and proposed surfaces. These walls are only the cut or fill between them.
      pushQuad(v, idx, top[0], bot[0], bot[1], top[1]);
      pushQuad(v, idx, top[3], top[2], bot[2], bot[3]);
      pushQuad(v, idx, top[0], top[3], bot[3], bot[0]);
      pushQuad(v, idx, top[1], bot[1], bot[2], top[2]);
    }
  }
  const meshes: MeshGeometry[] = [];
  if (cutV.length > 0) meshes.push({ kind: "cut", positions: Float32Array.from(cutV), indices: Uint32Array.from(cutI) });
  if (fillV.length > 0) meshes.push({ kind: "fill", positions: Float32Array.from(fillV), indices: Uint32Array.from(fillI) });
  return meshes;
}

function centerElevation(station: Station): number | null {
  if (station.existing.length > 0) return elevationAt(sortByOffset(station.existing), 0);
  if (station.proposed.length > 0) return elevationAt(sortByOffset(station.proposed), 0);
  return null;
}

/** Hold the nearest traced elevation outside the samples, and follow arc length between them. */
function elevationOnAlignment(samples: { distancePx: number; elevation: number }[], distancePx: number): number {
  if (samples.length === 0) return 0;
  if (distancePx <= samples[0].distancePx) return samples[0].elevation;
  const last = samples[samples.length - 1];
  if (distancePx >= last.distancePx) return last.elevation;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (distancePx < a.distancePx || distancePx > b.distancePx) continue;
    const span = b.distancePx - a.distancePx;
    const t = span < 1e-9 ? 0 : (distancePx - a.distancePx) / span;
    return a.elevation + (b.elevation - a.elevation) * t;
  }
  return last.elevation;
}

function planToWorld(point: PlanPoint, origin: PlanPoint, k: number, elevation: number, baseElev: number): [number, number, number] {
  return [(point.x - origin.x) * k, elevation - baseElev, -(point.y - origin.y) * k];
}

function sectionLine(
  kind: "existing" | "proposed",
  stationId: string,
  profile: ProfilePoint[],
  sample: { point: PlanPoint; tangent: PlanPoint },
  frame: SurfaceFrame,
): LineGeometry {
  const positions = new Float32Array(profile.length * 3);
  profile.forEach((point, index) => {
    const [x, y, z] = frame.place(sample.point, sample.tangent, point.offset, point.elevation);
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
  });
  return { kind, stationId, positions };
}

function sweepRibbon(
  profA: ProfilePoint[],
  profB: ProfilePoint[],
  points: readonly PlanPoint[],
  distanceA: number,
  distanceB: number,
  frame: SurfaceFrame,
  kind: "existing" | "proposed",
): MeshGeometry | null {
  if (profA.length < 2 || profB.length < 2) return null;
  const offsets = [...new Set([...profA.map((point) => point.offset), ...profB.map((point) => point.offset)])].sort((a, b) => a - b);
  if (offsets.length < 2) return null;
  const steps = 12;
  const samples = [];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const sample = pointOnPolyline(points, distanceA + (distanceB - distanceA) * t);
    if (sample) samples.push({ ...sample, t });
  }
  if (samples.length < 2) return null;
  const verts: number[] = [];
  const indices: number[] = [];
  for (const sample of samples) {
    for (const offset of offsets) {
      const elevation = (1 - sample.t) * elevationAt(profA, offset) + sample.t * elevationAt(profB, offset);
      verts.push(...frame.place(sample.point, sample.tangent, offset, elevation));
    }
  }
  const stride = offsets.length;
  for (let step = 0; step < samples.length - 1; step++) {
    for (let column = 0; column < stride - 1; column++) {
      const a = step * stride + column;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { kind, positions: Float32Array.from(verts), indices: Uint32Array.from(indices) };
}
