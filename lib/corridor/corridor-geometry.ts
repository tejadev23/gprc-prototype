import { elevationAt, sortByOffset } from "./profile";
import { isSectionReady } from "./stations";
import type { ProfilePoint, Station } from "./types";

export type MeshKind = "existing" | "proposed" | "cut" | "fill";

export type LineGeometry = {
  kind: "existing" | "proposed";
  stationId: string;
  positions: Float32Array;
};

export type MeshGeometry = {
  kind: MeshKind;
  positions: Float32Array;
  indices: Uint32Array;
};

export type StationLabel = {
  stationId: string;
  name: string;
  position: [number, number, number];
  /** Set by the GPRC alignment scene when this station has no finished cross-section. */
  missing?: boolean;
};

export type CorridorGeometry = {
  lines: LineGeometry[];
  ribbons: MeshGeometry[];
  prisms: MeshGeometry[];
  labels: StationLabel[];
  center: [number, number, number];
  span: number;
};

const EMPTY: CorridorGeometry = {
  lines: [],
  ribbons: [],
  prisms: [],
  labels: [],
  center: [0, 0, 0],
  span: 80,
};

/**
 * X = offset, Y = elevation above a base, Z = station feet from the first station.
 * One ready station draws profile lines. Two or more also connect ribbons and cut/fill prisms.
 */
export function buildCorridorGeometry(stations: readonly Station[]): CorridorGeometry {
  const ready = stations.filter(isSectionReady).sort((a, b) => a.stationFt - b.stationFt || a.name.localeCompare(b.name));
  if (ready.length === 0) return EMPTY;

  let offMin = Infinity;
  let offMax = -Infinity;
  let elvMin = Infinity;
  let elvMax = -Infinity;
  let staMin = Infinity;
  let staMax = -Infinity;
  for (const station of ready) {
    staMin = Math.min(staMin, station.stationFt);
    staMax = Math.max(staMax, station.stationFt);
    for (const point of [...station.existing, ...station.proposed]) {
      offMin = Math.min(offMin, point.offset);
      offMax = Math.max(offMax, point.offset);
      elvMin = Math.min(elvMin, point.elevation);
      elvMax = Math.max(elvMax, point.elevation);
    }
  }

  const xOff = -offMin;
  const baseElev = Math.floor(elvMin / 10) * 10 - 5;
  const world = (offset: number, elevation: number, stationFt: number): [number, number, number] => [
    xOff + offset,
    elevation - baseElev,
    stationFt - staMin,
  ];

  const lines: LineGeometry[] = [];
  const ribbons: MeshGeometry[] = [];
  const prisms: MeshGeometry[] = [];
  const labels: StationLabel[] = [];

  const profiles = ready.map((station) => ({
    station,
    existing: sortByOffset(station.existing),
    proposed: sortByOffset(station.proposed),
  }));

  for (const row of profiles) {
    lines.push(lineOf("existing", row.station.id, row.existing, row.station.stationFt, world));
    lines.push(lineOf("proposed", row.station.id, row.proposed, row.station.stationFt, world));
    const [, , z] = world(0, 0, row.station.stationFt);
    labels.push({
      stationId: row.station.id,
      name: row.station.name,
      position: [xOff, elvMax - baseElev + 12, z],
    });
  }

  for (let i = 0; i < profiles.length - 1; i++) {
    const a = profiles[i];
    const b = profiles[i + 1];
    const za = a.station.stationFt - staMin;
    const zb = b.station.stationFt - staMin;
    const existingRibbon = ribbon(a.existing, b.existing, za, zb, baseElev, xOff, "existing");
    const proposedRibbon = ribbon(a.proposed, b.proposed, za, zb, baseElev, xOff, "proposed");
    if (existingRibbon) ribbons.push(existingRibbon);
    if (proposedRibbon) ribbons.push(proposedRibbon);
    prisms.push(...cutFillPrism(a.existing, a.proposed, b.existing, b.proposed, za, zb, baseElev, xOff));
  }

  const width = Math.max(offMax - offMin, 1);
  const length = Math.max(staMax - staMin, 20);
  const height = Math.max(elvMax - elvMin, 10);
  return {
    lines,
    ribbons,
    prisms,
    labels,
    center: [xOff + (offMin + offMax) / 2, (elvMin + elvMax) / 2 - baseElev, (staMax - staMin) / 2],
    span: Math.max(width, length, height, 40),
  };
}

function lineOf(
  kind: "existing" | "proposed",
  stationId: string,
  points: ProfilePoint[],
  stationFt: number,
  world: (offset: number, elevation: number, stationFt: number) => [number, number, number],
): LineGeometry {
  const positions = new Float32Array(points.length * 3);
  points.forEach((point, index) => {
    const [x, y, z] = world(point.offset, point.elevation, stationFt);
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
  });
  return { kind, stationId, positions };
}

function ribbon(
  profA: ProfilePoint[],
  profB: ProfilePoint[],
  za: number,
  zb: number,
  baseElev: number,
  xOff: number,
  kind: "existing" | "proposed",
): MeshGeometry | null {
  if (profA.length < 2 || profB.length < 2) return null;
  const xs = [...new Set([...profA.map((p) => p.offset), ...profB.map((p) => p.offset)])].sort((a, b) => a - b);
  if (xs.length < 2) return null;
  const verts: number[] = [];
  const indices: number[] = [];
  for (const x of xs) {
    verts.push(xOff + x, elevationAt(profA, x) - baseElev, za);
    verts.push(xOff + x, elevationAt(profB, x) - baseElev, zb);
  }
  for (let i = 0; i < xs.length - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { kind, positions: Float32Array.from(verts), indices: Uint32Array.from(indices) };
}

function cutFillPrism(
  exA: ProfilePoint[],
  prA: ProfilePoint[],
  exB: ProfilePoint[],
  prB: ProfilePoint[],
  za: number,
  zb: number,
  baseElev: number,
  xOff: number,
): MeshGeometry[] {
  const xL = Math.max(prA[0].offset, prB[0].offset);
  const xR = Math.min(prA[prA.length - 1].offset, prB[prB.length - 1].offset);
  if (xR <= xL) return [];

  const xs = [
    ...new Set([
      xL,
      xR,
      ...[...exA, ...prA, ...exB, ...prB].map((p) => p.offset).filter((x) => x >= xL && x <= xR),
    ]),
  ].sort((a, b) => a - b);

  const cutV: number[] = [];
  const cutI: number[] = [];
  const fillV: number[] = [];
  const fillI: number[] = [];

  for (let i = 0; i < xs.length - 1; i++) {
    const x1 = xs[i];
    const x2 = xs[i + 1];
    const a1 = { ex: elevationAt(exA, x1), pr: elevationAt(prA, x1) };
    const a2 = { ex: elevationAt(exA, x2), pr: elevationAt(prA, x2) };
    const b1 = { ex: elevationAt(exB, x1), pr: elevationAt(prB, x1) };
    const b2 = { ex: elevationAt(exB, x2), pr: elevationAt(prB, x2) };
    const avgDh = (a1.ex - a1.pr + (a2.ex - a2.pr) + (b1.ex - b1.pr) + (b2.ex - b2.pr)) / 4;
    if (Math.abs(avgDh) < 0.01) continue;
    const targetV = avgDh > 0 ? cutV : fillV;
    const targetI = avgDh > 0 ? cutI : fillI;
    const top = [
      [xOff + x1, a1.ex - baseElev, za],
      [xOff + x2, a2.ex - baseElev, za],
      [xOff + x2, b2.ex - baseElev, zb],
      [xOff + x1, b1.ex - baseElev, zb],
    ];
    const bot = [
      [xOff + x1, a1.pr - baseElev, za],
      [xOff + x2, a2.pr - baseElev, za],
      [xOff + x2, b2.pr - baseElev, zb],
      [xOff + x1, b1.pr - baseElev, zb],
    ];
    pushQuad(targetV, targetI, top[0], top[1], top[2], top[3]);
    pushQuad(targetV, targetI, bot[0], bot[3], bot[2], bot[1]);
    pushQuad(targetV, targetI, top[0], bot[0], bot[1], top[1]);
    pushQuad(targetV, targetI, top[3], top[2], bot[2], bot[3]);
    pushQuad(targetV, targetI, top[0], top[3], bot[3], bot[0]);
    pushQuad(targetV, targetI, top[1], bot[1], bot[2], top[2]);
  }

  const meshes: MeshGeometry[] = [];
  if (cutV.length > 0) meshes.push({ kind: "cut", positions: Float32Array.from(cutV), indices: Uint32Array.from(cutI) });
  if (fillV.length > 0) meshes.push({ kind: "fill", positions: Float32Array.from(fillV), indices: Uint32Array.from(fillI) });
  return meshes;
}

export function pushQuad(verts: number[], indices: number[], p1: number[], p2: number[], p3: number[], p4: number[]) {
  const base = verts.length / 3;
  verts.push(...p1, ...p2, ...p3, ...p4);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
