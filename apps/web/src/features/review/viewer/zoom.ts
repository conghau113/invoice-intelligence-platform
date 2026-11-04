/** Zoom as a percentage of "fit to the pane's width". Steps are fixed so zooming in then out comes back. */
export const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300] as const;
export const DEFAULT_ZOOM = 100;

/** The next step in `direction`, staying at the end of the range. A value between steps snaps to the nearest step first. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const at = ZOOM_STEPS.reduce(
    (best, z, i) => (Math.abs(z - current) < Math.abs(ZOOM_STEPS[best]! - current) ? i : best),
    0,
  );
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + direction));
  return ZOOM_STEPS[next]!;
}
