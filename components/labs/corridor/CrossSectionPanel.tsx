"use client";

import { useEffect, useRef, useState } from "react";
import { CalibrationPanel } from "@/components/labs/corridor/CalibrationPanel";
import { computeAreas } from "@/lib/corridor/areas";
import { hitCalibrationGroup, pxToReal, realToPx, translateGroup, type CalibrationMove } from "@/lib/corridor/calibration";
import { marksMatchRenderedPage } from "@/lib/corridor/page-ref";
import { displayProfile, nearestSegment } from "@/lib/corridor/profile";
import { framePoints, sectionPixels } from "@/lib/corridor/section-sync";
import { isCalibrated } from "@/lib/corridor/stations";
import type { CalibPoint, ProfilePoint, Station, TraceMode } from "@/lib/corridor/types";
import { canvasBox, clientToCanvasCss } from "@/lib/corridor/viewer";
import { displayRenderScale, legacyRasterScale } from "@/lib/corridor/pdf-space";
import { cssToImage, fitView, pan, zoomAt } from "@/lib/tracing/coords";
import type { ViewState } from "@/lib/tracing/types";
import { cn } from "@/lib/utils";

type Raster = {
  url: string;
  width: number;
  height: number;
  page: number;
  userWidth?: number;
  userHeight?: number;
  renderScale?: number;
};

type Props = {
  raster: Raster | null;
  loading: boolean;
  pdfName: string | null;
  pageNumber: number;
  numPages: number;
  error: string | null;
  station: Station | null;
  mode: TraceMode;
  pickIdx: number | null;
  snap: boolean;
  onLoadFile: (file: File) => void;
  onPage: (page: number) => void;
  onMode: (mode: TraceMode) => void;
  onSnap: (snap: boolean) => void;
  onPick: (px: number, py: number) => void;
  onUndo: () => void;
  onChangePoint: (index: number, patch: Partial<CalibPoint>) => void;
  onRepick: (index: number) => void;
  onClearPoint: (index: number) => void;
  onReset: () => void;
  move: CalibrationMove | null;
  canReuse: boolean;
  onStartMove: () => void;
  onMoveDelta: (dx: number, dy: number) => void;
  onConfirmMove: () => void;
  onCancelMove: () => void;
  /** The page on screen is not the page this station was marked on. */
  pageMismatch?: { stationName: string; stationPage: number; viewPage: number } | null;
  onGoToStationPage?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  spacePan?: boolean;
  insertKey?: "existing" | "proposed";
  onInsert?: (key: "existing" | "proposed", segmentIndex: number, offset: number, elevation: number) => void;
  onSelectPoint?: (point: { key: "existing" | "proposed"; offset: number; elevation: number } | null) => void;
  selectedPoint?: { key: "existing" | "proposed"; offset: number; elevation: number } | null;
  undoCount?: number;
  onDisplayScale?: (scale: number) => void;
};

export function CrossSectionPanel({
  raster,
  loading,
  pdfName,
  pageNumber,
  numPages,
  error,
  station,
  mode,
  pickIdx,
  snap,
  onLoadFile,
  onPage,
  onMode,
  onSnap,
  onPick,
  onUndo,
  onChangePoint,
  onRepick,
  onClearPoint,
  onReset,
  move,
  canReuse,
  onStartMove,
  onMoveDelta,
  onConfirmMove,
  onCancelMove,
  pageMismatch = null,
  onGoToStationPage,
  expanded = false,
  onToggleExpand,
  spacePan = false,
  insertKey = "existing",
  onInsert,
  onSelectPoint,
  selectedPoint = null,
  undoCount = 0,
  onDisplayScale,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<ViewState | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const userView = useRef(false);
  const dragRef = useRef<{ x: number; y: number; panning: boolean; moved: boolean } | null>(null);
  const groupDragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const moveOverlayRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  /** Page number of `image`. Null while the next page is loading, so the previous image is not reused. */
  const [imagePage, setImagePage] = useState<number | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const viewMode = useRef<"section" | "page" | "user">("page");
  const seenStationId = useRef<string | null | undefined>(undefined);
  const [view, setView] = useState<ViewState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [panTool, setPanTool] = useState(false);
  const spaceKey = raster ? `${raster.page}:${raster.userWidth ?? raster.width}x${raster.userHeight ?? raster.height}` : "";
  const [seenSpace, setSeenSpace] = useState(spaceKey);
  if (spaceKey !== seenSpace) {
    setSeenSpace(spaceKey);
    if (viewMode.current !== "user") viewMode.current = "page";
    userView.current = viewMode.current === "user";
    if (viewMode.current !== "user") {
      setView(null);
    }
    setImage(null);
    setImagePage(null);
    setImageUrl(null);
  }
  if (seenStationId.current !== station?.id) {
    seenStationId.current = station?.id ?? null;
    viewMode.current = station ? "section" : "page";
    userView.current = false;
  }

  const coordW = raster?.userWidth ?? image?.naturalWidth ?? 0;
  const coordH = raster?.userHeight ?? image?.naturalHeight ?? 0;

  viewRef.current = view;
  imageRef.current = image;
  const coordRef = useRef({ w: 0, h: 0 });
  coordRef.current = { w: coordW, h: coordH };

  useEffect(() => {
    const node = moveOverlayRef.current;
    if (!node) return;
    const onDismiss = () => onCancelMove();
    node.addEventListener("gprc-dismiss", onDismiss);
    return () => node.removeEventListener("gprc-dismiss", onDismiss);
  }, [onCancelMove, move]);

  useEffect(() => {
    if (!raster) {
      setImage(null);
      setImagePage(null);
      setImageUrl(null);
      return;
    }
    const page = raster.page;
    const url = raster.url;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setImage(img);
      setImagePage(page);
      setImageUrl(url);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [raster]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      setSize({ w: canvas.clientWidth, h: canvas.clientHeight });
    });
    observer.observe(canvas);
    setSize({ w: canvas.clientWidth, h: canvas.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (viewMode.current !== "page") return;
    if (!image || size.w < 8 || size.h < 8 || coordW < 1 || coordH < 1) return;
    userView.current = false;
    setView(fitView(size.w, size.h, coordW, coordH));
  }, [image, size, coordW, coordH]);

  const stationId = station?.id ?? null;
  useEffect(() => {
    if (viewMode.current !== "section" || !station) return;
    if (size.w < 8 || size.h < 8 || coordW < 1 || coordH < 1) return;
    if (station.pageNumber != null && raster && raster.page !== station.pageNumber) return;
    const framed = framePoints(size.w, size.h, sectionPixels(station));
    if (!framed) {
      viewMode.current = "page";
      userView.current = false;
      setView(fitView(size.w, size.h, coordW, coordH));
      return;
    }
    userView.current = true;
    setView(framed);
  }, [stationId, raster, size, coordW, coordH]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current;
      const img = imageRef.current;
      if (!current || !img) return;
      event.preventDefault();
      userView.current = true;
      viewMode.current = "user";
      const css = clientToCanvasCss(event.clientX, event.clientY, canvasBox(canvas));
      const space = coordRef.current;
      const min = fitView(canvas.clientWidth, canvas.clientHeight, space.w || img.naturalWidth, space.h || img.naturalHeight).scale * 0.5;
      setView(zoomAt(current, css, event.deltaY > 0 ? 0.9 : 1.1, min, 16));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#121417";
    ctx.fillRect(0, 0, cssW, cssH);

    // The image must be the page this raster was rendered for. A stale image from the previous page is not drawn.
    const imageIsThisPage =
      raster != null && image != null && view != null && imagePage === raster.page && imageUrl === raster.url;
    if (!imageIsThisPage || !image || !view) {
      ctx.fillStyle = "#8a8f98";
      ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(loading || raster ? "Rendering page…" : "Load a cross-section PDF", cssW / 2, cssH / 2);
      return;
    }

    const renderScale = raster.renderScale ?? 1;
    ctx.imageSmoothingEnabled = renderScale / Math.max(view.scale, 1e-6) < 1;
    const drawW = (raster.userWidth ?? image.naturalWidth) * view.scale;
    const drawH = (raster.userHeight ?? image.naturalHeight) * view.scale;
    ctx.drawImage(image, view.originX, view.originY, drawW, drawH);
    const toCss = (px: number, py: number) => ({
      x: view.originX + px * view.scale,
      y: view.originY + py * view.scale,
    });
    const transform = station?.calibration.transform;
    const movingGroup = move != null && station != null && move.stationId === station.id;
    const groupPoints = movingGroup ? translateGroup(move.origin, move.dx, move.dy) : station?.calibration.points;
    // A reuse drag has to stay visible on the page it is being placed onto.
    if (movingGroup && groupPoints) drawCalibrationGroup(ctx, groupPoints, toCss, true, null);
    const showMarks = marksMatchRenderedPage(station?.pageNumber ?? null, raster.page);
    if (!showMarks) return;
    if (transform && station) {
      const selectedExisting = selectedPoint?.key === "existing" ? selectedPoint : undefined;
      const selectedProposed = selectedPoint?.key === "proposed" ? selectedPoint : undefined;
      const activeExisting = mode === "existing" ? station.existing[station.existing.length - 1] : undefined;
      const activeProposed = mode === "proposed" ? station.proposed[station.proposed.length - 1] : undefined;
      strokeProfile(ctx, displayProfile(station.existing), "#7dd3fc", true, transform, toCss, activeExisting, selectedExisting);
      strokeProfile(ctx, displayProfile(station.proposed), "#fbbf24", false, transform, toCss, activeProposed, selectedProposed);
    }
    if (!movingGroup && groupPoints) drawCalibrationGroup(ctx, groupPoints, toCss, false, mode === "calibrate" ? pickIdx : null);
  }, [raster, image, imagePage, imageUrl, view, station, mode, pickIdx, loading, size, move, selectedPoint]);

  useEffect(() => {
    const userWidth = raster?.userWidth;
    const userHeight = raster?.userHeight;
    const renderScale = raster?.renderScale;
    if (!onDisplayScale || !view || !userWidth || !userHeight || renderScale == null) return;
    const scale = view.scale;
    const handle = window.setTimeout(() => {
      const next = Math.max(displayRenderScale(userWidth, userHeight, scale, window.devicePixelRatio || 1), legacyRasterScale(userWidth, userHeight));
      if (Math.abs(next - renderScale) > 0.05) onDisplayScale(next);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [onDisplayScale, view, raster]);

  const calibrated = isCalibrated(station);
  const moving = move != null && station != null && move.stationId === station.id;
  const areas = computeAreas(station);
  const canUndo =
    undoCount > 0 ||
    (mode === "existing" && (station?.existing.length ?? 0) > 0) ||
    (mode === "proposed" && (station?.proposed.length ?? 0) > 0) ||
    (mode === "insert" && (station?.[insertKey].length ?? 0) > 0);
  let readout = "—";
  if (cursor && station?.calibration.transform) {
    let { offset, elevation } = pxToReal(station.calibration.transform, cursor.x, cursor.y);
    if (snap) {
      offset = Math.round(offset);
      elevation = Math.round(elevation);
    }
    readout = `${offset.toFixed(2)}  ${elevation.toFixed(2)}`;
  }

  const fit = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    userView.current = false;
    viewMode.current = "page";
    const space = coordRef.current;
    setView(fitView(canvas.clientWidth, canvas.clientHeight, space.w || img.naturalWidth, space.h || img.naturalHeight));
  };

  const pointerCss = (event: { clientX: number; clientY: number }, canvas: HTMLCanvasElement) =>
    clientToCanvasCss(event.clientX, event.clientY, canvasBox(canvas));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-2 py-1">
        <button type="button" onClick={() => fileRef.current?.click()} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          PDF
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onLoadFile(file);
          }}
        />
        <div className="flex items-center gap-1 text-[11px]">
          <button type="button" disabled={!pdfName || pageNumber <= 1} onClick={() => onPage(pageNumber - 1)} className="rounded bg-white/10 px-1.5 py-1 disabled:opacity-40">
            ‹
          </button>
          <span className="font-mono text-muted" title={pdfName ?? undefined}>
            {pdfName ? `${pageNumber}/${numPages}` : "—"}
          </span>
          <button type="button" disabled={!pdfName || pageNumber >= numPages} onClick={() => onPage(pageNumber + 1)} className="rounded bg-white/10 px-1.5 py-1 disabled:opacity-40">
            ›
          </button>
        </div>
        <button type="button" onClick={fit} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          Fit
        </button>
        <button
          type="button"
          aria-pressed={panTool}
          onClick={() => setPanTool((current) => !current)}
          className={cn("rounded px-2 py-1 text-[11px]", panTool ? "bg-accent text-black" : "bg-white/10")}
        >
          Pan
        </button>
        {onToggleExpand && (
          <button type="button" onClick={onToggleExpand} className="rounded bg-white/10 px-2 py-1 text-[11px]">
            {expanded ? "Exit" : "Expand"}
          </button>
        )}
        <ModeButton active={mode === "existing"} disabled={!calibrated} onClick={() => onMode("existing")}>
          Existing
        </ModeButton>
        <ModeButton active={mode === "proposed"} disabled={!calibrated} onClick={() => onMode("proposed")}>
          Proposed
        </ModeButton>
        <ModeButton
          active={mode === "insert"}
          disabled={!calibrated || ((station?.existing.length ?? 0) < 2 && (station?.proposed.length ?? 0) < 2)}
          onClick={() => onMode(mode === "insert" ? insertKey : "insert")}
        >
          Insert
        </ModeButton>
        <button type="button" disabled={!canUndo} onClick={onUndo} className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40">
          Undo
        </button>
        <label className="flex items-center gap-1 px-1 text-[11px] text-muted" title="Move the point to the nearest whole foot">
          <input type="checkbox" checked={snap} onChange={(event) => onSnap(event.target.checked)} />
          Snap
        </label>
        <span className={cn("text-[11px]", calibrated ? "text-fill" : "text-muted")}>
          {calibrated ? "Calibration ✓" : "Calibration ○"}
        </span>
        <button type="button" disabled={!station} onClick={() => onMode("calibrate")} className="rounded bg-white/10 px-2 py-1 text-[11px] disabled:opacity-40">
          Recalibrate
        </button>
        <button
          type="button"
          disabled={!canReuse}
          onClick={onStartMove}
          title={canReuse ? "Drag a calibration here. Same scale only — Recalibrate if this sheet’s scale differs." : "Calibrate a station first"}
          className={cn("rounded px-2 py-1 text-[11px] disabled:opacity-40", moving ? "bg-accent text-black" : "bg-white/10")}
        >
          Reuse
        </button>
        <span className="ml-auto font-mono text-[11px] text-foreground" data-active-station={station?.id ?? ""}>
          {station?.name ?? "No station"}
        </span>
        <span className="font-mono text-[11px] text-cut">Cut {areas ? areas.cut.toFixed(1) : "—"}</span>
        <span className="font-mono text-[11px] text-fill">Fill {areas ? areas.fill.toFixed(1) : "—"}</span>
        <span className="font-mono text-[11px] text-muted">{cursor ? readout : ""}</span>
      </div>
      {error && <div className="truncate px-2 py-0.5 text-[11px] text-amber-200">{error}</div>}
      {pageMismatch && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-0.5 text-[11px] text-amber-200" data-page-mismatch="">
          <span>
            {pageMismatch.stationName} is marked on page {pageMismatch.stationPage}. This is page {pageMismatch.viewPage}.
          </span>
          {onGoToStationPage && (
            <button type="button" onClick={onGoToStationPage} className="rounded bg-white/10 px-1.5 py-0.5 text-foreground">
              Go to page {pageMismatch.stationPage}
            </button>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1" data-section-station={station?.id ?? ""} data-section-page={raster?.page ?? ""}>
        <canvas
          ref={canvasRef}
          className={cn("h-full w-full touch-none", grabbing || panTool || spacePan ? (grabbing ? "cursor-grabbing" : "cursor-grab") : "cursor-crosshair")}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            const box = canvasBox(event.currentTarget);
            const css = clientToCanvasCss(event.clientX, event.clientY, box);
            const current = viewRef.current;
            const panning = event.button === 1 || event.button === 2 || event.altKey || event.shiftKey || panTool || spacePan;
            if (!panning && moving && move && current) {
              const img = cssToImage(css, current);
              const preview = translateGroup(move.origin, move.dx, move.dy);
              if (hitCalibrationGroup(img.x, img.y, preview, 18 / current.scale)) {
                groupDragRef.current = { x: img.x, y: img.y, dx: move.dx, dy: move.dy };
                setGrabbing(true);
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Capture keeps the drag alive if the pointer leaves the canvas.
                }
                return;
              }
            }
            dragRef.current = {
              x: css.x,
              y: css.y,
              panning,
              moved: false,
            };
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // Capture is only a convenience for panning.
            }
          }}
          onPointerMove={(event) => {
            const current = viewRef.current;
            const css = pointerCss(event, event.currentTarget);
            if (current) setCursor(cssToImage(css, current));
            const groupDrag = groupDragRef.current;
            if (groupDrag && current) {
              const img = cssToImage(css, current);
              onMoveDelta(groupDrag.dx + (img.x - groupDrag.x), groupDrag.dy + (img.y - groupDrag.y));
              return;
            }
            const drag = dragRef.current;
            if (!drag?.panning || !current) return;
            const dx = css.x - drag.x;
            const dy = css.y - drag.y;
            if (Math.hypot(dx, dy) > 2) {
              drag.moved = true;
              viewMode.current = "user";
            }
            drag.x = css.x;
            drag.y = css.y;
            userView.current = true;
            viewMode.current = "user";
            setView(pan(current, dx, dy));
          }}
          onPointerUp={(event) => {
            if (groupDragRef.current) {
              groupDragRef.current = null;
              setGrabbing(false);
              return;
            }
            const drag = dragRef.current;
            dragRef.current = null;
            if (!drag || drag.panning || drag.moved || moving || panTool || spacePan) return;
            const css = pointerCss(event, event.currentTarget);
            if (Math.hypot(css.x - drag.x, css.y - drag.y) > 4) return;
            const current = viewRef.current;
            if (!current) return;
            const img = cssToImage(css, current);
            if ((mode === "existing" || mode === "proposed") && station?.calibration.transform && onSelectPoint) {
              const sorted = displayProfile(station[mode]);
              let nearest: ProfilePoint | null = null;
              let nearestDist = 10;
              for (const point of sorted) {
                const raw = realToPx(station.calibration.transform, point.offset, point.elevation);
                const at = { x: current.originX + raw.px * current.scale, y: current.originY + raw.py * current.scale };
                const dist = Math.hypot(at.x - css.x, at.y - css.y);
                if (dist <= nearestDist) {
                  nearest = point;
                  nearestDist = dist;
                }
              }
              if (nearest) {
                onSelectPoint({ key: mode, offset: nearest.offset, elevation: nearest.elevation });
                return;
              }
            }
            if (mode === "insert" && station?.calibration.transform && onInsert) {
              const key = insertKey;
              const sorted = displayProfile(station[key]);
              const pixels = sorted.map((point) => {
                const raw = realToPx(station.calibration.transform!, point.offset, point.elevation);
                return { x: raw.px, y: raw.py };
              });
              const hit = nearestSegment(pixels, img.x, img.y, 14 / Math.max(current.scale, 1e-6));
              if (!hit || hit.t <= 1e-3 || hit.t >= 1 - 1e-3) return;
              let real = pxToReal(station.calibration.transform, hit.x, hit.y);
              if (snap) {
                const snapped = { offset: Math.round(real.offset), elevation: Math.round(real.elevation) };
                const start = sorted[hit.index];
                const end = sorted[hit.index + 1];
                const min = Math.min(start.offset, end.offset);
                const max = Math.max(start.offset, end.offset);
                if (snapped.offset > min && snapped.offset < max) real = snapped;
              }
              onInsert(key, hit.index, real.offset, real.elevation);
              return;
            }
            onPick(img.x, img.y);
          }}
          onPointerLeave={() => setCursor(null)}
        />
        {moving && (
          <div
            ref={moveOverlayRef}
            data-overlay="move"
            className="absolute left-2 top-2 z-10 max-w-sm rounded-md border border-[#7f1d1d]/60 bg-[#101214]/95 px-3 py-2 shadow-lg"
          >
            <div className="text-[11px] font-medium tracking-wide text-[#fecaca]">Move calibration</div>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              Drag the triangle onto this cross-section. Offset and elevation stay the same. Recalibrate if the sheet scale differs.
            </p>
            <div className="mt-2 flex gap-1.5">
              <button type="button" onClick={onConfirmMove} className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-black">
                Confirm
              </button>
              <button type="button" onClick={onCancelMove} className="rounded bg-white/10 px-2 py-1 text-[11px]">
                Cancel
              </button>
            </div>
          </div>
        )}
        {mode === "calibrate" && !moving && (
          <div className="absolute inset-x-2 bottom-2 z-10 max-h-[46%] overflow-auto rounded-md border border-white/10 bg-[#101214]/95 shadow-lg">
            <CalibrationPanel
              station={station}
              mode={mode}
              pickIdx={pickIdx}
              onChangePoint={onChangePoint}
              onRepick={onRepick}
              onClearPoint={onClearPoint}
              onReset={onReset}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function drawCalibrationGroup(
  ctx: CanvasRenderingContext2D,
  points: Station["calibration"]["points"],
  toCss: (px: number, py: number) => { x: number; y: number },
  moving: boolean,
  pickIdx: number | null,
) {
  const placed = points.flatMap((point, index) =>
    point.px == null || point.py == null ? [] : [{ index, css: toCss(point.px, point.py) }],
  );
  if (placed.length === 3) {
    ctx.beginPath();
    ctx.moveTo(placed[0].css.x, placed[0].css.y);
    ctx.lineTo(placed[1].css.x, placed[1].css.y);
    ctx.lineTo(placed[2].css.x, placed[2].css.y);
    ctx.closePath();
    if (moving) {
      ctx.fillStyle = "rgba(127, 29, 29, 0.16)";
      ctx.fill();
    }
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = moving ? 2 : 1.25;
    ctx.setLineDash(moving ? [] : [4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const point of placed) {
    const hot = moving || pickIdx === point.index;
    ctx.beginPath();
    ctx.arc(point.css.x, point.css.y, hot ? 7 : 5, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff7ed";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#7f1d1d";
    ctx.beginPath();
    ctx.arc(point.css.x, point.css.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 11px ui-monospace, monospace";
    ctx.fillStyle = "#7f1d1d";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`P${point.index + 1}`, point.css.x + 10, point.css.y - 8);
  }
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn("rounded px-2 py-1 text-[11px] disabled:opacity-40", active ? "bg-accent text-black" : "bg-white/10")}
    >
      {children}
    </button>
  );
}

function strokeProfile(
  ctx: CanvasRenderingContext2D,
  points: ProfilePoint[],
  color: string,
  dashed: boolean,
  transform: NonNullable<Station["calibration"]["transform"]>,
  toCss: (px: number, py: number) => { x: number; y: number },
  active?: ProfilePoint,
  selected?: { offset: number; elevation: number },
) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  points.forEach((point, index) => {
    const raw = realToPx(transform, point.offset, point.elevation);
    const css = toCss(raw.px, raw.py);
    if (index === 0) ctx.moveTo(css.x, css.y);
    else ctx.lineTo(css.x, css.y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dashed ? [5, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const point of points) {
    const raw = realToPx(transform, point.offset, point.elevation);
    const css = toCss(raw.px, raw.py);
    const hot =
      point === active ||
      (selected != null && Math.abs(point.offset - selected.offset) < 1e-6 && Math.abs(point.elevation - selected.elevation) < 1e-6);
    ctx.beginPath();
    ctx.arc(css.x, css.y, hot ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (hot) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
}
