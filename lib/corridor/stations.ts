import type { CalibPoint, Calibration, ProfilePoint, Station } from "./types";

/** `10+50` → 1050 feet. A bare number is already feet. */
export function parseStation(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  if (s.includes("+")) {
    const [head, tail] = s.split("+");
    const hi = Number.parseFloat(head);
    const lo = Number.parseFloat(tail);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return NaN;
    return hi * 100 + lo;
  }
  return Number.parseFloat(s);
}

/** Two stations closer than this are the same station (`20+50` and `20+50.00`). */
export const STATION_MATCH_FT = 0.0005;

export function stationsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < STATION_MATCH_FT;
}

/**
 * Engineering order: ascending station feet, never string order.
 * Ties fall back to name, then id, so the result is stable. The input array is not changed.
 */
export function sortStationsByChainage<T extends { id: string; name: string; stationFt: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const aOk = Number.isFinite(a.stationFt);
    const bOk = Number.isFinite(b.stationFt);
    if (aOk !== bOk) return aOk ? -1 : 1;
    return (aOk ? a.stationFt - b.stationFt : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export function blankCalibPoint(): CalibPoint {
  return { px: null, py: null, offset: null, elevation: null };
}

export function blankCalibration(): Calibration {
  return {
    points: [blankCalibPoint(), blankCalibPoint(), blankCalibPoint()],
    transform: null,
  };
}

export function createStation(name: string): Station | null {
  const trimmed = name.trim();
  const stationFt = parseStation(trimmed);
  if (!trimmed || !Number.isFinite(stationFt)) return null;
  return {
    id: crypto.randomUUID(),
    name: trimmed,
    stationFt,
    pageNumber: null,
    calibration: blankCalibration(),
    existing: [],
    proposed: [],
    alignmentRef: { centerlineId: null },
  };
}

export function isCalibrated(station: Station | null | undefined): boolean {
  return Boolean(station?.calibration.transform);
}

function groupIsPlaced(station: Station) {
  return (
    isCalibrated(station) && station.calibration.points.every((point) => point.px != null && point.py != null)
  );
}

/** Station whose triangle can be dragged onto the active station. Same PDF page only. */
export function reuseSource(stations: readonly Station[], active: Station, pageNumber: number): Station | null {
  if (groupIsPlaced(active)) return active;
  const donors = stations.filter(
    (station) => station.id !== active.id && groupIsPlaced(station) && station.pageNumber === pageNumber,
  );
  donors.sort(
    (a, b) => Math.abs(a.stationFt - active.stationFt) - Math.abs(b.stationFt - active.stationFt) || a.name.localeCompare(b.name),
  );
  return donors[0] ?? null;
}

/** Both profiles have enough points for area, volume, and corridor geometry. */
export function isSectionReady(station: Station): boolean {
  return isCalibrated(station) && station.existing.length >= 2 && station.proposed.length >= 2;
}

/** Last click wins at the same offset. Array order stays insertion order so undo pops the last click. */
export function addProfilePoint(points: ProfilePoint[], offset: number, elevation: number): ProfilePoint[] {
  const next = points.filter((p) => Math.abs(p.offset - offset) >= 1e-6);
  next.push({ offset, elevation });
  return next;
}
