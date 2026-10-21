import { referenceScale, type AlignmentMarker, type PlanAlignment } from "./alignment";
import { isCalibrated, isSectionReady, sortStationsByChainage, stationsMatch } from "./stations";
import type { Station } from "./types";

export type StationRowKind =
  /** Section is ready and sits on a scaled mainline. */
  | "ready"
  /** A section record with no marker on the mainline. */
  | "unplaced"
  /** A marker whose station has no section record. */
  | "no-section"
  /** Record and marker both exist, but the section or the mainline scale is not finished. */
  | "incomplete";

export type StationRow = {
  /** Stable row id: the station id, or the marker id when there is no record. */
  id: string;
  name: string;
  stationFt: number;
  stationId: string | null;
  markerId: string | null;
  hasRecord: boolean;
  calibrated: boolean;
  existingTraced: boolean;
  proposedTraced: boolean;
  onMainline: boolean;
  ready3d: boolean;
  kind: StationRowKind;
};

/**
 * One row per station record and per marker, joined by station feet or by the marker's stored id.
 * Derived on demand from the live records, so it cannot drift from them. Sorted in engineering order.
 */
export function buildStationRows(stations: readonly Station[], alignment: PlanAlignment): StationRow[] {
  const scaled = alignment.points.length >= 2 && referenceScale(alignment.markers) != null;
  const used = new Set<string>();
  const rows: StationRow[] = [];

  for (const marker of alignment.markers) {
    const station = findStation(stations, marker, used);
    if (station) used.add(station.id);
    rows.push(makeRow(station, marker, scaled));
  }
  for (const station of stations) {
    if (!used.has(station.id)) rows.push(makeRow(station, null, scaled));
  }
  return sortStationsByChainage(rows);
}

function findStation(stations: readonly Station[], marker: AlignmentMarker, used: Set<string>): Station | undefined {
  const linked = marker.stationId ? stations.find((station) => station.id === marker.stationId) : undefined;
  if (linked && !used.has(linked.id)) return linked;
  return stations.find((station) => !used.has(station.id) && stationsMatch(station.stationFt, marker.stationFt));
}

function makeRow(station: Station | null | undefined, marker: AlignmentMarker | null, scaled: boolean): StationRow {
  const hasRecord = station != null;
  const calibrated = isCalibrated(station);
  const existingTraced = (station?.existing.length ?? 0) >= 2;
  const proposedTraced = (station?.proposed.length ?? 0) >= 2;
  const onMainline = marker != null;
  const ready3d = station != null && marker != null && scaled && isSectionReady(station);
  const kind: StationRowKind = !hasRecord ? "no-section" : !onMainline ? "unplaced" : ready3d ? "ready" : "incomplete";
  return {
    id: station ? `s:${station.id}` : `m:${marker?.id}`,
    name: station?.name ?? marker?.label ?? "",
    stationFt: station?.stationFt ?? marker?.stationFt ?? NaN,
    stationId: station?.id ?? null,
    markerId: marker?.id ?? null,
    hasRecord,
    calibrated,
    existingTraced,
    proposedTraced,
    onMainline,
    ready3d,
    kind,
  };
}

/**
 * Markers whose station link is missing or stale are re-pointed at the record with the same station
 * feet. Nothing else changes, and a record is never claimed by two markers. Returns the same object
 * when no link needs repair, so it is cheap to call on every render.
 */
export function relinkMarkers(alignment: PlanAlignment, stations: readonly Station[]): PlanAlignment {
  const byId = new Set(stations.map((station) => station.id));
  const taken = new Set(alignment.markers.flatMap((marker) => (marker.stationId && byId.has(marker.stationId) ? [marker.stationId] : [])));
  let changed = false;
  const markers = alignment.markers.map((marker) => {
    if (marker.stationId && byId.has(marker.stationId)) return marker;
    const match = stations.find((station) => !taken.has(station.id) && stationsMatch(station.stationFt, marker.stationFt));
    if (!match) return marker;
    taken.add(match.id);
    changed = true;
    return { ...marker, stationId: match.id };
  });
  return changed ? { ...alignment, markers } : alignment;
}
