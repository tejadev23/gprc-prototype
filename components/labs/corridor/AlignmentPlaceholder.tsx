"use client";

import type { Station } from "@/lib/corridor/types";

export function AlignmentPlaceholder({ stations }: { stations: Station[] }) {
  return (
    <div className="max-w-3xl space-y-2 text-[12px] leading-snug text-muted">
      <p className="text-foreground">Alignment is not linked yet.</p>
      <p>
        Later, station and offset will pass through the project centerline to northing and easting, then to northing,
        easting, and elevation. This lab keeps <span className="font-mono text-foreground">alignmentRef.centerlineId</span>{" "}
        empty so that link can be added without changing the station profiles.
      </p>
      {stations.length > 0 && (
        <ul className="space-y-1 font-mono text-[11px]">
          {stations.map((station) => (
            <li key={station.id}>
              {station.name} · {station.stationFt.toFixed(2)} ft · centerline not linked
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
