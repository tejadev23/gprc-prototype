export type NavMode = "orbit" | "roam";

/**
 * Free Roam is a toggle. Choosing it while it is already on returns to orbit
 * and frames the corridor. Choosing the mode that is already active otherwise does nothing.
 */
export function nextNavMode(current: NavMode, requested: NavMode): { mode: NavMode; frame: boolean } {
  if (requested === "roam" && current === "roam") return { mode: "orbit", frame: true };
  if (requested === current) return { mode: current, frame: false };
  return { mode: requested, frame: false };
}
