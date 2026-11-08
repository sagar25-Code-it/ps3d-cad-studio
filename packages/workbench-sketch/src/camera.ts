import type { Vec2 } from "../../workbench-core/src/index.js";

/**
 * Pure camera maths for the 2D sketch canvas.
 *
 * The camera is a centre point (sketch millimetres, y up) and the visible width in millimetres. The visible height
 * follows from the canvas aspect ratio, so a resize never distorts geometry. SVG y runs downwards, so view boxes use -y.
 */
export interface SketchCamera {
  readonly centerMm: Vec2;
  readonly widthMm: number;
}

export interface SketchExtents {
  readonly min: Vec2;
  readonly max: Vec2;
}

export interface SketchViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const MIN_VIEW_WIDTH_MM = 0.25;
export const MAX_VIEW_WIDTH_MM = 200_000;
export const DEFAULT_CAMERA: SketchCamera = { centerMm: [0, 0], widthMm: 120 };

function clampWidth(widthMm: number): number {
  // NaN compares false with everything, so it used to pass straight through the clamp and poison the camera.
  if (Number.isNaN(widthMm)) return DEFAULT_CAMERA.widthMm;
  return Math.min(MAX_VIEW_WIDTH_MM, Math.max(MIN_VIEW_WIDTH_MM, widthMm));
}

const finite = (value: number): boolean => Number.isFinite(value);
const finitePoint = (point: Vec2): boolean => finite(point[0]) && finite(point[1]);
const finiteExtents = (extents: SketchExtents): boolean => finitePoint(extents.min) && finitePoint(extents.max);

/** A camera that shows `extents` with a margin, never tighter than 10 mm across. */
export function fitCamera(extents: SketchExtents | undefined, aspect: number, margin = 0.14): SketchCamera {
  if (extents === undefined || !finiteExtents(extents)) return DEFAULT_CAMERA;
  const safeAspect = aspect > 0.05 ? aspect : 1.6;
  const width = Math.max(extents.max[0] - extents.min[0], 1e-6);
  const height = Math.max(extents.max[1] - extents.min[1], 1e-6);
  const needed = Math.max(width, height * safeAspect, 10 / (1 + 2 * margin));
  return {
    centerMm: [(extents.min[0] + extents.max[0]) / 2, (extents.min[1] + extents.max[1]) / 2],
    widthMm: clampWidth(needed * (1 + 2 * margin))
  };
}

export interface ScreenInsets {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const EMPTY_SKETCH_EXTENTS: SketchExtents = { min: [-50, -35], max: [50, 35] };

/**
 * A camera that shows `extents` inside the part of the canvas that is not covered by floating panels (`insets` are the
 * pixels hidden on each side). The drawing is centred in that free area and kept `marginPx` away from its edges, so a
 * fitted sketch never sits underneath the palette or the navigation bars. An empty sketch frames the origin.
 */
export function fitCameraToViewport(extents: SketchExtents | undefined, size: { readonly width: number; readonly height: number }, insets: ScreenInsets, marginPx = 36): SketchCamera {
  const target = extents !== undefined && finiteExtents(extents) ? extents : EMPTY_SKETCH_EXTENTS;
  const freeWidth = Math.max(size.width - insets.left - insets.right, 80);
  const freeHeight = Math.max(size.height - insets.top - insets.bottom, 80);
  const spanWidth = Math.max(target.max[0] - target.min[0], 10);
  const spanHeight = Math.max(target.max[1] - target.min[1], 10);
  const wantedScale = Math.max(Math.min((freeWidth - 2 * marginPx) / spanWidth, (freeHeight - 2 * marginPx) / spanHeight), 1e-6);
  const widthMm = clampWidth(Math.max(size.width, 1) / wantedScale);
  const scale = Math.max(size.width, 1) / widthMm;
  const centreX = (target.min[0] + target.max[0]) / 2;
  const centreY = (target.min[1] + target.max[1]) / 2;
  const freeCentreX = insets.left + freeWidth / 2;
  const freeCentreY = insets.top + freeHeight / 2;
  return {
    centerMm: [centreX - (freeCentreX - size.width / 2) / scale, centreY + (freeCentreY - size.height / 2) / scale],
    widthMm
  };
}

export function cameraViewBox(camera: SketchCamera, aspect: number): SketchViewBox {
  const safeAspect = aspect > 0.05 ? aspect : 1.6;
  const height = camera.widthMm / safeAspect;
  return { x: camera.centerMm[0] - camera.widthMm / 2, y: -(camera.centerMm[1] + height / 2), width: camera.widthMm, height };
}

/** Millimetres covered by one screen pixel; glyphs, handles and hit areas are sized with this. */
export function mmPerPixel(camera: SketchCamera, viewportWidthPx: number): number {
  return camera.widthMm / Math.max(viewportWidthPx, 1);
}

/** Zooms about `anchorMm`, which stays under the same screen point. A factor above 1 zooms out. */
export function zoomCamera(camera: SketchCamera, anchorMm: Vec2, factor: number): SketchCamera {
  // A zoom that is not a number (or has no anchor) leaves the camera where it is rather than turning it into NaN.
  if (!finite(factor) || factor <= 0 || !finitePoint(anchorMm)) return camera;
  const widthMm = clampWidth(camera.widthMm * factor);
  const ratio = widthMm / camera.widthMm;
  return {
    centerMm: [anchorMm[0] + (camera.centerMm[0] - anchorMm[0]) * ratio, anchorMm[1] + (camera.centerMm[1] - anchorMm[1]) * ratio],
    widthMm
  };
}

/** Moves the camera so the scene follows a pointer drag of (dxPx, dyPx) screen pixels. */
export function panCamera(camera: SketchCamera, dxPx: number, dyPx: number, viewportWidthPx: number): SketchCamera {
  if (!finite(dxPx) || !finite(dyPx) || !finite(viewportWidthPx)) return camera;
  const scale = mmPerPixel(camera, viewportWidthPx);
  return { centerMm: [camera.centerMm[0] - dxPx * scale, camera.centerMm[1] + dyPx * scale], widthMm: camera.widthMm };
}

/** Converts a client-space point to sketch millimetres (y up). */
export function screenToSketch(clientX: number, clientY: number, rect: ScreenRect, camera: SketchCamera): Vec2 {
  const box = cameraViewBox(camera, rect.width / Math.max(rect.height, 1));
  const x = box.x + ((clientX - rect.left) / Math.max(rect.width, 1)) * box.width;
  const svgY = box.y + ((clientY - rect.top) / Math.max(rect.height, 1)) * box.height;
  return [x, -svgY];
}

/** Converts sketch millimetres to a client-space point. */
export function sketchToScreen(point: Vec2, rect: ScreenRect, camera: SketchCamera): Vec2 {
  const box = cameraViewBox(camera, rect.width / Math.max(rect.height, 1));
  return [rect.left + ((point[0] - box.x) / box.width) * rect.width, rect.top + ((-point[1] - box.y) / box.height) * rect.height];
}

/**
 * Minor and major grid spacing in millimetres. The minor step keeps lines at least `minPixels` apart on screen, so the grid
 * thins out as you zoom out and refines as you zoom in. A base grid of 1, 2 or 5 (times a power of ten) gives the familiar
 * decimal 1-2-5 ladder with a major line at the next power of ten; any other base keeps its own proportions with a major
 * line every fifth minor line.
 */
export function gridSteps(baseMm: number, mmPerPx: number, minPixels = 14): { readonly minorMm: number; readonly majorMm: number } {
  const base = baseMm > 0 ? baseMm : 1;
  const wanted = Math.max(minPixels * mmPerPx, 1e-9);
  const baseMantissa = base / 10 ** Math.floor(Math.log10(base) + 1e-12);
  const decimalLadder = [1, 2, 5].some((mantissa) => Math.abs(baseMantissa - mantissa) < 1e-9);
  const anchor = decimalLadder ? 1 : base;
  const decade = 10 ** Math.floor(Math.log10(wanted / anchor));
  let minor = anchor * decade;
  for (const multiple of [1, 2, 5, 10]) {
    minor = anchor * decade * multiple;
    if (minor >= wanted * (1 - 1e-12)) break;
  }
  if (!decimalLadder) return { minorMm: minor, majorMm: minor * 5 };
  const exponent = Math.floor(Math.log10(minor) + 1e-12);
  const mantissa = minor / 10 ** exponent;
  return { minorMm: minor, majorMm: Math.abs(mantissa - 1) < 1e-9 ? minor * 10 : 10 ** (exponent + 1) };
}
