"use client";

import { useState } from "react";
import { isCalibrated, isSectionReady, sortStationsByChainage } from "@/lib/corridor/stations";
import type { Station } from "@/lib/corridor/types";
import { cn } from "@/lib/utils";

type Props = {
  stations: Station[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string) => string | null;
  onDelete: (id: string) => void;
  /** Engineering order (ascending station feet). The straight corridor lab keeps insertion order. */
  sortByChainage?: boolean;
  /** When given, stations outside the set are tagged as not on the mainline. */
  placedIds?: ReadonlySet<string>;
};

export function StationList({ stations, activeId, onSelect, onAdd, onDelete, sortByChainage = false, placedIds }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = stations.find((station) => station.id === activeId) ?? null;
  const ordered = sortByChainage ? sortStationsByChainage(stations) : stations;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-[#101214]">
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">Stations</div>
      <ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-1">
        {stations.length === 0 && <li className="px-1.5 py-2 text-[11px] leading-snug text-muted">Add 10+00, 10+50…</li>}
        {ordered.map((station) => {
          const selected = station.id === activeId;
          return (
            <li key={station.id} className="flex items-center">
              <button
                type="button"
                onClick={() => onSelect(station.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left",
                  selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                )}
              >
                <span className={cn("truncate font-mono text-[12px]", selected ? "text-accent" : "text-foreground")}>
                  {station.name}
                </span>
                {placedIds && !placedIds.has(station.id) && (
                  <span className="text-[10px] text-muted" title="Not on the mainline yet" data-unplaced="">
                    off
                  </span>
                )}
                <span className={cn("ml-auto text-[11px]", glyphClass(station))}>{glyph(station)}</span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(station.id)}
                className="rounded px-1 text-[11px] text-muted hover:text-cut"
                aria-label={`Delete ${station.name}`}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {active && (
        <div className="space-y-0.5 border-t border-white/[0.06] px-2 py-1.5 text-[10px] text-muted">
          <div className="font-mono text-foreground">{active.stationFt.toFixed(2)} ft</div>
          <div>
            Cal {isCalibrated(active) ? "✓" : "○"} · EG {active.existing.length >= 2 ? "✓" : "○"} · PG{" "}
            {active.proposed.length >= 2 ? "✓" : "○"}
          </div>
          <div>{active.pageNumber ? `Page ${active.pageNumber}` : "No page"}</div>
        </div>
      )}
      <form
        className="border-t border-white/[0.06] p-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const message = onAdd(name);
          if (message) {
            setError(message);
            return;
          }
          setName("");
          setError(null);
        }}
      >
        <div className="flex gap-1">
          <input
            id="new-station"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="10+00"
            aria-label="New station"
            className="min-w-0 flex-1 rounded border border-white/10 bg-transparent px-1.5 py-1 font-mono text-[12px] outline-none focus:border-accent"
          />
          <button type="submit" className="rounded bg-accent px-1.5 py-1 text-[11px] font-medium text-black">
            +
          </button>
        </div>
        {error && <p className="mt-1 text-[10px] text-amber-200">{error}</p>}
      </form>
    </aside>
  );
}

function glyph(station: Station) {
  if (isSectionReady(station)) return "✓";
  if (isCalibrated(station) || station.existing.length > 0 || station.proposed.length > 0) return "!";
  return "○";
}

function glyphClass(station: Station) {
  if (isSectionReady(station)) return "text-fill";
  if (isCalibrated(station) || station.existing.length > 0 || station.proposed.length > 0) return "text-amber-200";
  return "text-muted/70";
}
