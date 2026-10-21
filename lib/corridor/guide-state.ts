export const GUIDE_STORAGE_KEY = "gprc-demo-guide";
export const GUIDE_STEP_COUNT = 7;

export type GuideUiState = {
  collapsed: boolean;
  x: number;
  y: number;
  step: number;
};

export function defaultGuideState(width = 1200): GuideUiState {
  return { collapsed: false, x: Math.max(8, width - 360), y: 72, step: 0 };
}

/** Reads the guide's own UI state. Bad data falls back to defaults. Project data is never stored here. */
export function parseGuideState(raw: string | null, width: number, _height: number): GuideUiState {
  const fallback = defaultGuideState(width);
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<GuideUiState>;
    const step = typeof value.step === "number" && Number.isInteger(value.step) ? value.step : fallback.step;
    return {
      collapsed: value.collapsed === true,
      x: typeof value.x === "number" && Number.isFinite(value.x) ? value.x : fallback.x,
      y: typeof value.y === "number" && Number.isFinite(value.y) ? value.y : fallback.y,
      step: Math.min(GUIDE_STEP_COUNT - 1, Math.max(0, step)),
    };
  } catch {
    return fallback;
  }
}

/** Keeps a grab point on screen when the window is smaller than the saved position. */
export function clampGuidePosition(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(8, width - 72), Math.max(8, x)),
    y: Math.min(Math.max(8, height - 48), Math.max(8, y)),
  };
}
