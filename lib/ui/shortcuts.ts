export type ShortcutContext = {
  editable: boolean;
  drawerOpen: boolean;
  overlayOpen: boolean;
  insertActive: boolean;
  moveActive: boolean;
  expanded: boolean;
  fullscreen: boolean;
  pointerLocked: boolean;
  /** 3D free roam is on and the 2D workspace is not covering it. */
  roaming: boolean;
  mod: boolean;
  alt: boolean;
};

export type ShortcutCommand =
  | "native"
  | "close-drawer"
  | "dismiss-overlay"
  | "cancel-insert"
  | "cancel-move"
  | "exit-expanded"
  | "exit-fullscreen"
  | "undo"
  | "delete"
  | "space-pan"
  | "ignore";

/**
 * One priority order for lab shortcuts.
 * Escape dismisses the topmost layer before it leaves a workspace.
 * Delete and undo stay out of text fields. Enter is left to the focused form.
 */
export function resolveShortcut(key: string, ctx: ShortcutContext): ShortcutCommand {
  if (key === "Escape") {
    if (ctx.pointerLocked) return "ignore";
    if (ctx.drawerOpen) return "close-drawer";
    if (ctx.overlayOpen) return "dismiss-overlay";
    if (ctx.insertActive) return "cancel-insert";
    if (ctx.moveActive) return "cancel-move";
    if (ctx.expanded) return "exit-expanded";
    if (ctx.fullscreen) return "exit-fullscreen";
    return "ignore";
  }
  if (ctx.editable) return "native";
  if ((key === "z" || key === "Z") && ctx.mod && !ctx.alt) return "undo";
  if (key === "Delete" || key === "Backspace") return "delete";
  if (key === " " || key === "Spacebar") return ctx.roaming && !ctx.expanded ? "native" : "space-pan";
  return "ignore";
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  if (element.isContentEditable) return true;
  if (typeof element.closest === "function" && element.closest("input, textarea, select, [contenteditable='true']")) return true;
  const tag = element.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
