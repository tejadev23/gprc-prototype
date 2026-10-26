/**
 * Client-side PDF → raster. Used only by the lab import workflow.
 * Renders one page at a time; no vector/CAD extraction.
 *
 * pdf.js is loaded only in the browser (dynamic import) so Next SSR
 * does not pull the Node-incompatible main build.
 */
import { DISPLAY_MAX_SIDE, legacyRasterScale } from "@/lib/corridor/pdf-space";
import type { PDFDocumentProxy } from "pdfjs-dist";

export type PdfPageRaster = {
  objectUrl: string;
  /** Bitmap size. Larger than the page when `renderScale` > 1. */
  width: number;
  height: number;
  /** pdf.js viewport at scale 1. Traces and calibration use this space. */
  userWidth: number;
  userHeight: number;
  renderScale: number;
};

let workerReady = false;

async function pdfjs() {
  const mod = await import("pdfjs-dist");
  if (!workerReady && typeof window !== "undefined") {
    mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    workerReady = true;
  }
  return mod;
}

export async function openPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const { getDocument } = await pdfjs();
  const task = getDocument({
    data: new Uint8Array(data),
    disableRange: true,
    disableStream: true,
  });
  return task.promise;
}

export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  options?: number | { maxSide?: number; scale?: number },
): Promise<PdfPageRaster> {
  await pdfjs();
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const userWidth = base.width;
  const userHeight = base.height;
  const longest = Math.max(userWidth, userHeight, 1);
  let scale: number;
  if (typeof options === "number") {
    scale = Math.min(options / longest, 4);
  } else if (options?.scale != null) {
    const cap = DISPLAY_MAX_SIDE / longest;
    scale = Math.min(Math.max(options.scale, 0.25), cap, 8);
  } else {
    scale = legacyRasterScale(userWidth, userHeight);
  }
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const objectUrl = await canvasToObjectUrl(canvas);
  return { objectUrl, width: canvas.width, height: canvas.height, userWidth, userHeight, renderScale: scale };
}

function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode page raster"));
          return;
        }
        resolve(URL.createObjectURL(blob));
      },
      "image/png",
    );
  });
}
