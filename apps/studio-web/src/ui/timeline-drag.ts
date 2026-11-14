/**
 * HS-03: dragging a step along the timeline strip. The strip clips its content and scrolls sideways, so a step is dragged with the
 * pointer inside it (no popover, nothing positioned outside the strip) and the place it would land in is shown on the strip itself.
 * The rules here are pure so they are tested without a window.
 */

/** How far the pointer has to travel before a press on a step becomes a drag; a smaller move is still a click. */
export const DRAG_START_PX = 6;

/** How close to either end of the strip the pointer has to be before the strip scrolls under it, and how far it scrolls per move. */
export const EDGE_SCROLL_ZONE_PX = 28;
export const EDGE_SCROLL_STEP_PX = 14;

/**
 * The place (final index) a dragged step lands in: the number of the other steps whose centre lies left of the pointer. `centers` are
 * the centres of the other steps in timeline order, the dragged one left out.
 */
export function dropIndexFor(centers: readonly number[], x: number): number {
  let count = 0;
  for (const center of centers) if (center < x) count += 1;
  return count;
}

/** How far to scroll the strip while dragging near its edges: negative scrolls left, positive right, zero not at all. */
export function edgeScroll(trackLeft: number, trackRight: number, x: number): number {
  if (x < trackLeft + EDGE_SCROLL_ZONE_PX) return -EDGE_SCROLL_STEP_PX;
  if (x > trackRight - EDGE_SCROLL_ZONE_PX) return EDGE_SCROLL_STEP_PX;
  return 0;
}

/** Whether a press that has moved by `dx` pixels has become a drag. */
export function dragHasStarted(dx: number): boolean {
  return Math.abs(dx) >= DRAG_START_PX;
}

/** The final index a keyboard move (Alt with the left or right arrow) goes to, or undefined at either end of the timeline. */
export function keyboardMoveTarget(fromIndex: number, count: number, direction: "left" | "right"): number | undefined {
  const to = direction === "left" ? fromIndex - 1 : fromIndex + 1;
  return to < 0 || to >= count ? undefined : to;
}

/**
 * Where a key press moves the rollback marker: the arrow keys one step, Home to the start and End to after the last step. The marker
 * sits in slot `index` of `count` steps (slots 0 to count). Undefined for another key or at either end, where nothing moves.
 */
export function markerKeyTarget(key: string, index: number, count: number): number | undefined {
  const to = key === "ArrowLeft" ? index - 1 : key === "ArrowRight" ? index + 1 : key === "Home" ? 0 : key === "End" ? count : undefined;
  return to === undefined || to < 0 || to > count || to === index ? undefined : to;
}
