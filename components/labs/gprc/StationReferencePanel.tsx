"use client";

import { useState } from "react";
import { chainageDistance, type PlanAlignment } from "@/lib/corridor/alignment";
import type { StationRow } from "@/lib/corridor/station-status";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onToggle: () => void;
  rows: readonly StationRow[];
  alignment: PlanAlignment;
  activeId: string | null;
  onSelect: (row: StationRow) => void;
  onOpen: (row: StationRow) => void;
  /** Returns an error message, or null when the station was placed. */
  onPlace: (row: StationRow) => string | null;
};

const COLUMNS = ["Record", "Cal", "EG", "PG", "Mainline", "3D"] as const;

/**
 * Every station record and every mainline marker on one sheet, in engineering order.
 * Derived from the live records. It never invents a position: a station can only be placed
 * between two markers that already bracket its station value.
 */
export function StationReferencePanel({ open, onToggle, rows, alignment, activeId, onSelect, onOpen, onPlace }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ready = rows.filter((row) => row.ready3d).length;

  return (
    <div className="max-h-[34%] min-h-0 shrink-0 overflow-hidden border-t border-white/[0.06] bg-[#101214]" data-station-reference="">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-muted hover:text-foreground"
        aria-expanded={open}
      >
        <span className="font-medium uppercase tracking-[0.14em]">Stations</span>
        <span>
          {rows.length} listed · {ready} ready for 3D
        </span>
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="max-h-[calc(100%-1.75rem)] overflow-auto px-2 pb-1.5">
          {rows.length === 0 ? (
            <p className="py-1 text-[11px] text-muted">No stations yet. Add one under Cross-sections, or place markers on the mainline.</p>
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-0.5 pr-2 font-normal">Station</th>
                  {COLUMNS.map((column) => (
                    <th key={column} className="px-1 py-0.5 text-center font-normal">
                      {column}
                    </th>
                  ))}
                  <th className="py-0.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const selected = row.stationId != null && row.stationId === activeId;
                  const canPlace = row.hasRecord && !row.onMainline && !("error" in chainageDistance(alignment.markers, row.stationFt));
                  return (
                    <tr
                      key={row.id}
                      data-row-kind={row.kind}
                      className={cn("border-t border-white/[0.04]", selected && "bg-white/[0.06]", !row.hasRecord && "text-muted")}
                    >
                      <td className="py-0.5 pr-2">
                        <button
                          type="button"
                          disabled={!row.hasRecord}
                          onClick={() => onSelect(row)}
                          className={cn("font-mono", selected ? "text-accent" : "hover:text-accent", !row.hasRecord && "cursor-default")}
                        >
                          {row.name}
                        </button>
                        {row.kind === "unplaced" && <span className="ml-1 text-[10px] text-amber-200">unplaced</span>}
                        {row.kind === "no-section" && <span className="ml-1 text-[10px] text-muted">no section</span>}
                      </td>
                      <Cell on={row.hasRecord} />
                      <Cell on={row.calibrated} />
                      <Cell on={row.existingTraced} />
                      <Cell on={row.proposedTraced} />
                      <Cell on={row.onMainline} />
                      <Cell on={row.ready3d} strong />
                      <td className="whitespace-nowrap py-0.5 text-right">
                        {errors[row.id] && <span className="mr-1 text-[10px] text-amber-200">{errors[row.id]}</span>}
                        {!row.onMainline && row.hasRecord && (
                          <button
                            type="button"
                            disabled={!canPlace}
                            title={canPlace ? "Place on the mainline at this station" : "Needs a marker before and after this station on the mainline"}
                            onClick={() => {
                              const message = onPlace(row);
                              setErrors((current) => {
                                const next = { ...current };
                                if (message) next[row.id] = message;
                                else delete next[row.id];
                                return next;
                              });
                            }}
                            className="mr-1 rounded bg-white/10 px-1.5 py-0.5 disabled:opacity-40"
                          >
                            Place
                          </button>
                        )}
                        <button type="button" onClick={() => onOpen(row)} className="rounded bg-white/10 px-1.5 py-0.5">
                          {row.hasRecord ? "Open" : "Create"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ on, strong = false }: { on: boolean; strong?: boolean }) {
  return (
    <td className={cn("px-1 py-0.5 text-center", on ? (strong ? "text-fill" : "text-foreground") : "text-muted/60")}>{on ? "✓" : "○"}</td>
  );
}
