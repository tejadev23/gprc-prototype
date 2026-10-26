"use client";

import { CrossSectionPanel } from "@/components/labs/corridor/CrossSectionPanel";
import { StationList } from "@/components/labs/corridor/StationList";
import type { useCorridorSession } from "@/components/labs/corridor/useCorridorSession";
import type { PlanAlignment } from "@/lib/corridor/alignment";
import { reuseSource } from "@/lib/corridor/stations";
import { cn } from "@/lib/utils";

type Session = ReturnType<typeof useCorridorSession>;

export function GprcCrossSectionPane({
  session,
  alignment,
  onShowPlan,
  onAddStation,
  placedIds,
  expanded = false,
  onToggleExpand,
  spacePan = false,
}: {
  session: Session;
  alignment: PlanAlignment;
  onShowPlan: () => void;
  onAddStation: (name: string) => string | null;
  placedIds: ReadonlySet<string>;
  expanded?: boolean;
  onToggleExpand?: () => void;
  spacePan?: boolean;
}) {
  const placed = session.active != null && placedIds.has(session.active.id);
  const established = alignment.points.length >= 2 && alignment.markers.length >= 2;
  const awaitingScale = alignment.points.length >= 2 && alignment.markers.length < 2;

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:overflow-hidden",
        expanded ? "grid-cols-1" : "lg:grid-cols-[minmax(7.5rem,9.5rem)_minmax(0,1fr)]",
      )}
    >
      {!expanded && (
        <StationList
          stations={session.stations}
          activeId={session.activeId}
          sortByChainage
          placedIds={alignment.points.length >= 2 ? placedIds : undefined}
          onSelect={session.selectStation}
          onAdd={onAddStation}
          onDelete={session.deleteStation}
        />
      )}
      <section className="flex min-h-[420px] min-w-0 flex-col border-t border-white/[0.06] lg:min-h-0 lg:border-l lg:border-t-0">
        {session.active && established && !placed && (
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-2 py-1 text-[11px] text-amber-200">
            <span>
              {session.active.name} is not on the mainline yet, so it stays out of the curved 3D view. Its calibration and traces are kept.
            </span>
            <button type="button" onClick={onShowPlan} className="rounded bg-white/10 px-2 py-1 text-foreground">
              Show mainline
            </button>
          </div>
        )}
        {awaitingScale && (
          <div className="border-b border-white/[0.06] px-2 py-1 text-[11px] text-muted">
            Stationing is not established. Place at least two station markers before cross-sections are drawn on the mainline.
          </div>
        )}
        <CrossSectionPanel
          raster={session.raster}
          loading={session.pdfLoading}
          pdfName={session.pdf?.name ?? null}
          pageNumber={session.pageNumber}
          numPages={session.pdf?.numPages ?? 0}
          error={session.pdfError ?? session.pageNotice}
          pageMismatch={session.stationPageMismatch}
          onGoToStationPage={session.goToStationPage}
          station={session.active}
          mode={session.mode}
          pickIdx={session.pickIdx}
          snap={session.snap}
          onLoadFile={(file) => void session.loadPdf(file)}
          onPage={session.goPage}
          onMode={session.setTraceMode}
          onSnap={session.setSnap}
          onPick={session.onCanvasPick}
          onUndo={session.undoPoint}
          onChangePoint={session.changeCalib}
          onRepick={session.repick}
          onClearPoint={session.clearPoint}
          onReset={session.resetCalibration}
          move={session.move}
          canReuse={session.active != null && reuseSource(session.stations, session.active, session.pageNumber) != null}
          onStartMove={session.startMove}
          onMoveDelta={(dx, dy) => session.setMove((current) => (current ? { ...current, dx, dy } : current))}
          onConfirmMove={session.confirmMove}
          onCancelMove={session.cancelMove}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          spacePan={spacePan}
          insertKey={session.insertKey}
          onInsert={session.insertProfile}
          onSelectPoint={session.selectProfilePoint}
          selectedPoint={session.selectedPoint && session.selectedPoint.stationId === session.activeId ? session.selectedPoint : null}
          undoCount={session.undoCount}
          onDisplayScale={session.requestPdfDetail}
        />
      </section>
    </div>
  );
}
