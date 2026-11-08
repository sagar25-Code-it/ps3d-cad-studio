import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { MAX_VIEW_WIDTH_MM, MIN_VIEW_WIDTH_MM, type ScreenInsets, type SketchCamera, type SketchExtents } from "./camera.js";
import { sketchBounds } from "./index.js";

/**
 * Zoom to a window and zoom to the selection. Both frame a rectangle of the sketch in the free part of the canvas (the part the
 * floating panels do not cover), like Fit, but allow views much tighter than Fit's 10 mm minimum so a small feature can fill the screen.
 */
export const MIN_ZOOM_WINDOW_PX = 6;

/** A camera that shows `extents` filling the free area of the canvas, `marginPx` from its edges. */
export function cameraForExtents(extents: SketchExtents, size: { readonly width: number; readonly height: number }, insets: ScreenInsets, marginPx = 32, minSpanMm = 0.5): SketchCamera {
  const freeWidth = Math.max(size.width - insets.left - insets.right, 80);
  const freeHeight = Math.max(size.height - insets.top - insets.bottom, 80);
  const spanWidth = Math.max(extents.max[0] - extents.min[0], minSpanMm);
  const spanHeight = Math.max(extents.max[1] - extents.min[1], minSpanMm);
  const wantedScale = Math.max(Math.min(Math.max(freeWidth - 2 * marginPx, 40) / spanWidth, Math.max(freeHeight - 2 * marginPx, 40) / spanHeight), 1e-9);
  const widthMm = Math.min(MAX_VIEW_WIDTH_MM, Math.max(MIN_VIEW_WIDTH_MM, Math.max(size.width, 1) / wantedScale));
  const scale = Math.max(size.width, 1) / widthMm;
  const centreX = (extents.min[0] + extents.max[0]) / 2;
  const centreY = (extents.min[1] + extents.max[1]) / 2;
  const freeCentreX = insets.left + freeWidth / 2;
  const freeCentreY = insets.top + freeHeight / 2;
  return { centerMm: [centreX - (freeCentreX - size.width / 2) / scale, centreY + (freeCentreY - size.height / 2) / scale], widthMm };
}

/** The window dragged out on the canvas as an extents rectangle, or undefined when it is too small to mean a zoom. */
export function zoomWindowExtents(startMm: Vec2, endMm: Vec2, mmPerPx: number): SketchExtents | undefined {
  const width = Math.abs(endMm[0] - startMm[0]);
  const height = Math.abs(endMm[1] - startMm[1]);
  if (width < MIN_ZOOM_WINDOW_PX * mmPerPx && height < MIN_ZOOM_WINDOW_PX * mmPerPx) return undefined;
  return { min: [Math.min(startMm[0], endMm[0]), Math.min(startMm[1], endMm[1])], max: [Math.max(startMm[0], endMm[0]), Math.max(startMm[1], endMm[1])] };
}

/** The extents of the selected curves (every point a curve passes through), or undefined when nothing is selected. */
export function selectionExtents(entities: readonly SketchEntity[], ids: readonly string[]): SketchExtents | undefined {
  const wanted = new Set(ids);
  const picked = entities.filter((entity) => wanted.has(entity.id) && entity.visible !== false);
  if (picked.length === 0) return undefined;
  const bounds = sketchBounds(picked);
  return { min: bounds.min, max: bounds.max };
}
