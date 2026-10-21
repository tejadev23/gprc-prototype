/**
 * Session-only imported test sheets for the tracing and layer labs.
 * Not persisted. Not part of the CV / tracing algorithms.
 */

export type SheetSource = "builtin" | "imported";

export type ImportedSheet = {
  id: string;
  label: string;
  fileName: string;
  kind: "image" | "pdf-page";
  /** 1-based page index when kind is pdf-page. */
  pageNumber?: number;
  pageCount?: number;
  pdfDocId?: string;
  /** Blob URL of the raster (images immediately; PDF pages after lazy render). */
  objectUrl?: string;
  rasterWidth?: number;
  rasterHeight?: number;
};

export type ResolvedLabSheet = {
  id: string;
  label: string;
  notes: string;
  group: SheetSource;
  fileName: string;
  kind: "builtin" | "image" | "pdf-page";
  pageNumber?: number;
  pageCount?: number;
  /** Raster URL ready for <img src>. Null until a PDF page is rendered. */
  src: string | null;
  rasterWidth?: number;
  rasterHeight?: number;
};

export type ImportSessionState = {
  source: SheetSource;
  selectedId: string;
  imported: ImportedSheet[];
  busy: boolean;
  message: string | null;
};

/** Display raster cap for PDF page renders (evidence pipeline still downsamples). */
export const IMPORT_RASTER_MAX_SIDE = 3200;
