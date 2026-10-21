"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { applyCalibration, nextUnsetPixel, pxToReal, translateGroup, withPixelPick, type CalibrationMove } from "@/lib/corridor/calibration";
import { decidePick, rasterIsCurrent, resolveStationPage } from "@/lib/corridor/page-ref";
import { addProfilePoint, blankCalibPoint, createStation, reuseSource } from "@/lib/corridor/stations";
import {
  createProject,
  deleteProject,
  duplicateProject,
  getLastGprcProjectId,
  getLastProjectId,
  getProject,
  listProjects,
  saveProject,
  setLastGprcProjectId,
  type EarthworkProject,
  type LoadedProject,
  type ProjectSummary,
  type SaveState,
} from "@/lib/corridor/storage";
import type { CalibPoint, CorridorVisibility, DockTab, Station, TraceMode } from "@/lib/corridor/types";
import { openPdfDocument, renderPdfPage } from "@/lib/labs/pdf-raster";

/** `doc` and `page` say which sheet this image was rendered for, so a stale one is never shown. */
export type CorridorRaster = { url: string; width: number; height: number; doc: PDFDocumentProxy; page: number };
type PdfFile = { name: string; doc: PDFDocumentProxy; numPages: number };

export type CorridorSessionOptions = {
  /** Corridor opens the last project, or creates one. GPRC waits for an explicit choice. */
  startup?: "last-or-create" | "manual";
  /** When false, saves do not change the project the corridor lab opens next. */
  touchLast?: boolean;
};

export function useCorridorSession(options?: CorridorSessionOptions) {
  const startupRef = useRef(options?.startup ?? "last-or-create");
  const touchLastRef = useRef(options?.touchLast ?? true);

  const [projectName, setProjectName] = useState("");
  const [stations, setStations] = useState<Station[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<TraceMode>("calibrate");
  const [pickIdx, setPickIdx] = useState<number | null>(null);
  const [snap, setSnap] = useState(false);
  const [pdf, setPdf] = useState<PdfFile | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [raster, setRaster] = useState<CorridorRaster | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [visibility, setVisibility] = useState<CorridorVisibility>({
    existing: true,
    proposed: true,
    cut: true,
    fill: true,
  });
  const [dockTab, setDockTab] = useState<DockTab>("volume");
  const [move, setMove] = useState<CalibrationMove | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [projectReady, setProjectReady] = useState(false);
  const rasterUrl = useRef<string | null>(null);
  const pdfBlobRef = useRef<Blob | null>(null);
  const pdfDirtyRef = useRef(false);
  const skipSaveRef = useRef(true);
  const saveTimerRef = useRef<number | null>(null);
  const [createdAt, setCreatedAt] = useState(() => new Date().toISOString());
  const [seenPdf, setSeenPdf] = useState("");
  const pdfKey = pdf ? `${pdf.name}:${pageNumber}` : "";
  if (pdfKey !== seenPdf) {
    setSeenPdf(pdfKey);
    setPdfLoading(Boolean(pdf));
    setPdfError(null);
    if (!pdf) setRaster(null);
  }

  const active = stations.find((station) => station.id === activeId) ?? null;
  const rasterNow = rasterIsCurrent(raster, pdf?.doc ?? null, pageNumber) ? raster : null;
  const stationPageMismatch =
    pdf && active?.pageNumber != null && active.pageNumber !== pageNumber
      ? { stationName: active.name, stationPage: active.pageNumber, viewPage: pageNumber }
      : null;

  const snapshot = useCallback((): EarthworkProject | null => {
    if (!projectId) return null;
    return {
      id: projectId,
      name: projectName.trim() || "Untitled Earthwork Project",
      createdAt,
      updatedAt: new Date().toISOString(),
      version: 1,
      stations,
      activeStationId: activeId,
      pageNumber,
      document: { name: pdf?.name ?? null, stored: pdfBlobRef.current != null || Boolean(pdf) },
      visibility,
      dockTab,
      snap,
    };
  }, [projectId, projectName, stations, activeId, pageNumber, pdf, visibility, dockTab, snap, createdAt]);

  const snapshotRef = useRef(snapshot);
  useLayoutEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  const clearLoaded = useCallback(() => {
    skipSaveRef.current = true;
    pdfBlobRef.current = null;
    pdfDirtyRef.current = false;
    setProjectId(null);
    setProjectName("");
    setStations([]);
    setActiveId(null);
    setPageNumber(1);
    setPdf(null);
    setPdfError(null);
    setPageNotice(null);
    setMove(null);
    setPickIdx(null);
    setMode("calibrate");
  }, []);

  const applyLoaded = useCallback(async (loaded: { project: EarthworkProject; pdf: Blob | null }) => {
    skipSaveRef.current = true;
    const { project, pdf: blob } = loaded;
    setCreatedAt(project.createdAt);
    pdfBlobRef.current = blob;
    pdfDirtyRef.current = false;
    setProjectId(project.id);
    setProjectName(project.name);
    setStations(project.stations);
    setActiveId(project.activeStationId);
    setPageNotice(null);
    // Open on the active station's own page when it has one, not on whichever page was last browsed.
    const activeStation = project.stations.find((station) => station.id === project.activeStationId);
    const startPage = activeStation?.pageNumber ?? (project.pageNumber || 1);
    setPageNumber(startPage);
    setVisibility(project.visibility);
    setDockTab(project.dockTab);
    setSnap(project.snap);
    setMove(null);
    setPickIdx(null);
    if (blob) {
      const doc = await openPdfDocument(await blob.arrayBuffer());
      setPdf({ name: project.document.name ?? "document.pdf", doc, numPages: doc.numPages });
      if (!Number.isInteger(startPage) || startPage < 1 || startPage > doc.numPages) {
        setPageNumber(1);
        if (activeStation) {
          const resolved = resolveStationPage({ name: activeStation.name, pageNumber: startPage }, doc.numPages);
          if (!resolved.ok) setPageNotice(resolved.message);
        }
      }
    } else {
      setPdf(null);
      setPdfError(project.document.name ? `Reload “${project.document.name}” to see the sheet. Stations and profiles are saved.` : null);
    }
    window.setTimeout(() => {
      skipSaveRef.current = false;
    }, 0);
  }, []);

  const flushSave = useCallback(async () => {
    const current = snapshotRef.current();
    if (!current || skipSaveRef.current) return;
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveState("saving");
    const blob = pdfDirtyRef.current ? pdfBlobRef.current : undefined;
    await saveProject(current, blob, { touchLast: touchLastRef.current });
    if (blob) pdfDirtyRef.current = false;
    setSaveState("saved");
    await refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    const onConflict = (event: Event) => {
      const loaded = (event as CustomEvent<LoadedProject>).detail;
      if (loaded?.project.id === projectId) void applyLoaded(loaded);
    };
    window.addEventListener("gprc-conflict", onConflict);
    return () => window.removeEventListener("gprc-conflict", onConflict);
  }, [applyLoaded, projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (startupRef.current === "manual") {
          const lastId = await getLastGprcProjectId();
          const loaded = lastId ? await getProject(lastId) : null;
          if (cancelled) return;
          if (loaded) await applyLoaded(loaded);
          else setDrawerOpen(true);
          setProjects(await listProjects());
          setProjectReady(true);
          return;
        }
        const lastId = await getLastProjectId();
        let loaded = lastId ? await getProject(lastId) : null;
        if (!loaded) {
          const summaries = await listProjects();
          loaded = summaries[0] ? await getProject(summaries[0].id) : null;
        }
        if (!loaded) {
          const created = await createProject("Untitled Earthwork Project");
          if (cancelled) {
            await deleteProject(created.id);
            return;
          }
          loaded = { project: created, pdf: null };
        }
        if (cancelled || !loaded) return;
        await applyLoaded(loaded);
        setProjects(await listProjects());
        setProjectReady(true);
      } catch (err) {
        if (!cancelled) {
          setPdfError(err instanceof Error ? err.message : "Could not open the local project database.");
          if (startupRef.current === "manual") setProjectReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLoaded]);

  useEffect(() => {
    if (!projectReady || !projectId || skipSaveRef.current) return;
    setSaveState("unsaved");
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void flushSave().catch(() => setSaveState("unsaved"));
    }, 500);
    return () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    };
  }, [projectReady, projectId, projectName, stations, activeId, pageNumber, visibility, dockTab, snap, pdf?.name, flushSave]);

  useEffect(() => {
    const onHide = () => {
      void flushSave();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flushSave]);

  const openListedProject = async (id: string) => {
    if (id === projectId) {
      setDrawerOpen(false);
      return;
    }
    await flushSave();
    const loaded = await getProject(id);
    if (!loaded) return;
    await applyLoaded(loaded);
    if (!touchLastRef.current) await setLastGprcProjectId(id);
    setDrawerOpen(false);
  };

  const createListedProject = async (name: string) => {
    await flushSave();
    const created = await createProject(name, { touchLast: touchLastRef.current });
    if (!touchLastRef.current) await setLastGprcProjectId(created.id);
    await applyLoaded({ project: created, pdf: null });
    setProjects(await listProjects());
    setDrawerOpen(false);
  };

  const renameListedProject = async (id: string, name: string) => {
    if (id === projectId) {
      setProjectName(name);
      return;
    }
    const loaded = await getProject(id);
    if (!loaded) return;
    await saveProject({ ...loaded.project, name }, undefined, { touchLast: touchLastRef.current });
    setProjects(await listProjects());
  };

  const deleteListedProject = async (id: string) => {
    await deleteProject(id);
    const remaining = await listProjects();
    setProjects(remaining);
    if (id !== projectId) return;
    if (remaining[0]) {
      const loaded = await getProject(remaining[0].id);
      if (loaded) {
        await applyLoaded(loaded);
        if (!touchLastRef.current) await setLastGprcProjectId(loaded.project.id);
      }
      return;
    }
    if (!touchLastRef.current) {
      clearLoaded();
      setDrawerOpen(true);
      return;
    }
    const created = await createProject("Untitled Earthwork Project");
    await applyLoaded({ project: created, pdf: null });
    setProjects(await listProjects());
  };

  const duplicateListedProject = async (id: string) => {
    await flushSave();
    const copy = await duplicateProject(id);
    if (!copy) return null;
    const loaded = await getProject(copy.id);
    if (!loaded) return null;
    await applyLoaded(loaded);
    if (touchLastRef.current) await saveProject(loaded.project, undefined, { touchLast: true });
    else await setLastGprcProjectId(copy.id);
    setProjects(await listProjects());
    setDrawerOpen(false);
    return copy;
  };

  const patchStation = useCallback((id: string, update: (station: Station) => Station) => {
    setStations((list) => list.map((station) => (station.id === id ? update(station) : station)));
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.pointerLockElement) return;
      setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  useEffect(() => {
    return () => {
      if (rasterUrl.current) URL.revokeObjectURL(rasterUrl.current);
    };
  }, []);

  useEffect(() => {
    if (!pdf) {
      if (rasterUrl.current) URL.revokeObjectURL(rasterUrl.current);
      rasterUrl.current = null;
      return;
    }
    let cancelled = false;
    renderPdfPage(pdf.doc, pageNumber)
      .then((page) => {
        if (cancelled) {
          URL.revokeObjectURL(page.objectUrl);
          return;
        }
        if (rasterUrl.current) URL.revokeObjectURL(rasterUrl.current);
        rasterUrl.current = page.objectUrl;
        setRaster({ url: page.objectUrl, width: page.width, height: page.height, doc: pdf.doc, page: pageNumber });
      })
      .catch((err: unknown) => {
        if (!cancelled) setPdfError(err instanceof Error ? err.message : "Could not render this PDF page.");
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  const loadPdf = async (file: File) => {
    setPdfError(null);
    setPdfLoading(true);
    try {
      const bytes = await file.arrayBuffer();
      pdfBlobRef.current = new Blob([bytes], { type: "application/pdf" });
      pdfDirtyRef.current = true;
      const doc = await openPdfDocument(await pdfBlobRef.current.arrayBuffer());
      setPdf({ name: file.name, doc, numPages: doc.numPages });
      setPageNumber(1);
      setMove((current) => (current && current.pageNumber !== 1 ? null : current));
      if (activeId) {
        patchStation(activeId, (station) => (station.pageNumber == null ? { ...station, pageNumber: 1 } : station));
      }
    } catch (err: unknown) {
      setPdfError(err instanceof Error ? err.message : "Could not open that PDF.");
      setPdfLoading(false);
    }
  };

  const selectStation = (id: string) => {
    const station = stations.find((item) => item.id === id);
    if (!station) return;
    setActiveId(id);
    // Show the station's own page. Selecting never writes a page into the station.
    const resolved = resolveStationPage(station, pdf?.numPages ?? null);
    let nextPage = pageNumber;
    if (resolved.ok) {
      nextPage = resolved.page;
      setPageNumber(resolved.page);
      setPageNotice(null);
    } else {
      setPageNotice(resolved.reason === "no-page" ? null : resolved.message);
    }
    setMove((current) => (current && (current.stationId !== id || current.pageNumber !== nextPage) ? null : current));
    if (station.calibration.transform) {
      setMode((current) => (current === "existing" || current === "proposed" ? current : "existing"));
      setPickIdx(null);
    } else {
      setMode("calibrate");
      setPickIdx(nextUnsetPixel(station.calibration.points) ?? 0);
    }
  };

  const addStation = (name: string) => {
    const station = createStation(name);
    if (!station) return "Enter a station such as 10+50.";
    if (pdf) station.pageNumber = pageNumber;
    insertStation(station);
    return null;
  };

  const insertStation = (station: Station) => {
    setStations((list) => [...list, station]);
    setActiveId(station.id);
    setMode("calibrate");
    setPickIdx(0);
  };

  const deleteStation = (id: string) => {
    setStations((list) => list.filter((station) => station.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setPickIdx(null);
    }
    setMove((current) => (current?.stationId === id ? null : current));
  };

  const goPage = (next: number) => {
    if (!pdf) return;
    const clamped = Math.min(pdf.numPages, Math.max(1, next));
    setPageNumber(clamped);
    setMove((current) => (current && current.pageNumber !== clamped ? null : current));
    setPageNotice(null);
  };

  const goToStationPage = () => {
    if (!pdf || active?.pageNumber == null) return;
    goPage(active.pageNumber);
  };

  const onCanvasPick = (px: number, py: number) => {
    if (!active) return;
    const decision = decidePick(active, pageNumber);
    if (!decision.allow) {
      setPageNotice(decision.message);
      return;
    }
    setPageNotice(null);
    // Marks are only written where the user clicked, so that is the page the station belongs to.
    const stamp = (station: Station): Station => (decision.assignPage ? { ...station, pageNumber } : station);
    if (mode === "calibrate") {
      if (pickIdx == null) return;
      const points = withPixelPick(active.calibration.points, pickIdx, px, py);
      const calibration = applyCalibration(points);
      patchStation(active.id, (station) => stamp({ ...station, calibration }));
      if (calibration.transform) {
        setMode("existing");
        setPickIdx(null);
      } else {
        setPickIdx(nextUnsetPixel(points));
      }
      return;
    }
    if (!active.calibration.transform) return;
    let { offset, elevation } = pxToReal(active.calibration.transform, px, py);
    if (snap) {
      offset = Math.round(offset);
      elevation = Math.round(elevation);
    }
    const key = mode;
    patchStation(active.id, (station) =>
      stamp({
        ...station,
        [key]: addProfilePoint(station[key], offset, elevation),
      }),
    );
  };

  const changeCalib = (index: number, patch: Partial<CalibPoint>) => {
    if (!active) return;
    const points = active.calibration.points.map((point, pointIndex) =>
      pointIndex === index ? { ...point, ...patch } : point,
    ) as Station["calibration"]["points"];
    patchStation(active.id, (station) => ({ ...station, calibration: applyCalibration(points) }));
  };

  const repick = (index: number) => {
    if (!active) return;
    if (mode === "calibrate" && pickIdx === index) {
      setPickIdx(null);
      return;
    }
    setMode("calibrate");
    setPickIdx(index);
  };

  const clearPoint = (index: number) => {
    if (!active) return;
    const points = active.calibration.points.map((point, pointIndex) =>
      pointIndex === index ? blankCalibPoint() : { ...point },
    ) as Station["calibration"]["points"];
    patchStation(active.id, (station) => ({ ...station, calibration: applyCalibration(points) }));
    setMode("calibrate");
    setPickIdx(index);
  };

  const startMove = () => {
    if (!active || move) return;
    const decision = decidePick(active, pageNumber);
    if (!decision.allow) {
      setPageNotice(decision.message);
      return;
    }
    const source = reuseSource(stations, active, pageNumber);
    if (!source) return;
    setMove({
      stationId: active.id,
      pageNumber,
      origin: source.calibration.points.map((point) => ({ ...point })) as Station["calibration"]["points"],
      dx: 0,
      dy: 0,
    });
    setPickIdx(null);
  };

  const confirmMove = () => {
    if (!move || move.stationId !== activeId) return;
    const points = translateGroup(move.origin, move.dx, move.dy);
    const movePage = move.pageNumber;
    patchStation(move.stationId, (station) => ({ ...station, calibration: applyCalibration(points), pageNumber: movePage }));
    setMove(null);
    setMode("existing");
    setPickIdx(null);
  };

  const cancelMove = () => setMove(null);

  const resetCalibration = () => {
    if (!active) return;
    setMove(null);
    patchStation(active.id, (station) => ({
      ...station,
      calibration: applyCalibration([blankCalibPoint(), blankCalibPoint(), blankCalibPoint()]),
    }));
    setMode("calibrate");
    setPickIdx(0);
  };

  const undoPoint = () => {
    if (!active || (mode !== "existing" && mode !== "proposed")) return;
    const key = mode;
    patchStation(active.id, (station) => ({ ...station, [key]: station[key].slice(0, -1) }));
  };

  const setTraceMode = (next: TraceMode) => {
    if (!active) return;
    if ((next === "existing" || next === "proposed") && !active.calibration.transform) return;
    setMode(next);
    if (next === "calibrate") setPickIdx(nextUnsetPixel(active.calibration.points));
    else setPickIdx(null);
  };

  return {
    projectName,
    setProjectName,
    stations,
    activeId,
    active,
    mode,
    pickIdx,
    snap,
    setSnap,
    pdf,
    pageNumber,
    raster: rasterNow,
    pdfLoading,
    pdfError,
    pageNotice,
    /** Set when the sheet on screen is not the page the active station was marked on. */
    stationPageMismatch,
    fullscreen,
    setFullscreen,
    visibility,
    setVisibility,
    dockTab,
    setDockTab,
    move,
    setMove,
    projectId,
    projects,
    drawerOpen,
    setDrawerOpen,
    saveState,
    projectReady,
    openListedProject,
    createListedProject,
    renameListedProject,
    deleteListedProject,
    duplicateListedProject,
    loadPdf,
    selectStation,
    addStation,
    insertStation,
    deleteStation,
    goPage,
    goToStationPage,
    onCanvasPick,
    changeCalib,
    repick,
    clearPoint,
    startMove,
    confirmMove,
    cancelMove,
    resetCalibration,
    undoPoint,
    setTraceMode,
  };
}

export function saveLabel(state: SaveState) {
  if (state === "saving") return "Saving…";
  if (state === "unsaved") return "Unsaved changes";
  return "Saved";
}
