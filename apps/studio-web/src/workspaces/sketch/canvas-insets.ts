import type { ScreenInsets } from "../../../../../packages/workbench-sketch/src/camera.js";

/** A floating panel's rectangle in canvas pixels (relative to the canvas's own top-left corner). */
export interface OverlayBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The least share of the canvas, per direction, that Fit always keeps free whatever the panels cover. */
const MIN_FREE_SHARE = 0.4;

/**
 * The pixels at each side of the sketch canvas that floating panels (palette, navigation bars, status strip) cover, so Fit can frame
 * the sketch in the part that stays visible.
 *
 * Each panel is charged to ONE edge: the edge where reserving it costs the smallest share of the canvas. A bar along the bottom costs
 * a thin strip of height there and far more as a side panel, so it is a bottom inset whatever the window width; a tall palette at the
 * right costs a narrow strip of width. The earlier rule ("wider than half the canvas is a bar, anything else is a side panel") turned
 * the 500 px navigation bar into a right-hand panel on wide windows and pushed the fitted sketch to the left edge.
 *
 * A panel that lies outside the canvas (a palette docked beside it) costs nothing. Together the insets never take more than 60 % of
 * either direction, so a crowded canvas still shows the sketch at a usable size.
 */
export function insetsForOverlays(size: { readonly width: number; readonly height: number }, boxes: readonly OverlayBox[]): ScreenInsets {
  const { width, height } = size;
  if (!(width > 0) || !(height > 0)) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  for (const box of boxes) {
    if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) continue;
    // Only the part of the panel that is over the canvas matters.
    const boxLeft = Math.max(0, Math.min(width, box.left));
    const boxRight = Math.max(0, Math.min(width, box.right));
    const boxTop = Math.max(0, Math.min(height, box.top));
    const boxBottom = Math.max(0, Math.min(height, box.bottom));
    if (boxRight - boxLeft <= 0 || boxBottom - boxTop <= 0) continue;
    const candidates = [
      { edge: "left" as const, pixels: boxRight, share: boxRight / width },
      { edge: "right" as const, pixels: width - boxLeft, share: (width - boxLeft) / width },
      { edge: "top" as const, pixels: boxBottom, share: boxBottom / height },
      { edge: "bottom" as const, pixels: height - boxTop, share: (height - boxTop) / height }
    ];
    let best = candidates[0]!;
    for (const candidate of candidates) if (candidate.share < best.share) best = candidate;
    if (best.edge === "left") left = Math.max(left, best.pixels);
    else if (best.edge === "right") right = Math.max(right, best.pixels);
    else if (best.edge === "top") top = Math.max(top, best.pixels);
    else bottom = Math.max(bottom, best.pixels);
  }
  // Never let the panels squeeze the sketch into a sliver: scale the pair of insets down so enough of the canvas stays free.
  const limitWidth = width * (1 - MIN_FREE_SHARE);
  if (left + right > limitWidth) {
    const scale = limitWidth / (left + right);
    left *= scale;
    right *= scale;
  }
  const limitHeight = height * (1 - MIN_FREE_SHARE);
  if (top + bottom > limitHeight) {
    const scale = limitHeight / (top + bottom);
    top *= scale;
    bottom *= scale;
  }
  return { left, top, right, bottom };
}
