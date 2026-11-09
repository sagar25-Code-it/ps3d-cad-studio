import type { Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { DEFAULT_RELATION_HINTS, inferSketchPoint, type InferenceGuide, type InferenceResult } from "./inference.js";
import type { SketchTool } from "./index.js";

/**
 * Snapping aids on top of cursor inference: polar tracking (angle snapping from the last placed point), an ortho lock, the
 * hold-key overrides (hold Ctrl to switch snapping off, hold Shift to constrain) and the choice of which tools get which
 * kind of help from their last point.
 *
 * Pure: the canvas hands in the pointer, the sketch and the settings, and gets back the point to use plus the guides and the
 * inference that tell the auto-constraint code which relations the point earns (a polar snap at 0 / 90 / 180 / 270 degrees is
 * reported as a horizontal or vertical guide from the anchor, so a line drawn that way is also made Horizontal or Vertical).
 */
export interface SnapAssistSettings {
  /** Cursor inference on or off (the palette's Snap switch). */
  readonly snap: boolean;
  /** Snap increment in millimetres; undefined follows the visible grid. */
  readonly snapStepMm: number | undefined;
  readonly polar: boolean;
  /** Polar tracking increment in degrees (15 and 45 are the usual ones). */
  readonly polarIncrementDeg: number;
  /** Lock the next point to the horizontal or vertical through the last one. */
  readonly ortho: boolean;
  /** Parallel, perpendicular and collinear hints for the line being drawn, and the relations they earn. */
  readonly relationHints: boolean;
  /** The line being drawn also snaps to the length of a nearby line and is made Equal to it. Off by default: see DEFAULT_RELATION_HINTS. */
  readonly equalHint: boolean;
}

export const DEFAULT_SNAP_ASSIST: SnapAssistSettings = { snap: true, snapStepMm: undefined, polar: false, polarIncrementDeg: 45, ortho: false, relationHints: true, equalHint: false };

/** The increments the palette offers. Any value from 1 to 90 degrees is accepted when loaded from settings. */
export const POLAR_INCREMENT_CHOICES: readonly number[] = [5, 10, 15, 22.5, 30, 45, 90];

/** The snap steps the palette offers besides "follow the grid", in millimetres. */
export const SNAP_STEP_CHOICES: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25];

export function sanitizePolarIncrement(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SNAP_ASSIST.polarIncrementDeg;
  return Math.min(90, Math.max(1, number));
}

export function sanitizeSnapStep(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.001 && value <= 1000 ? value : undefined;
}

/** Reads saved settings (anything unexpected falls back to the defaults). */
export function snapAssistFromJson(value: unknown): SnapAssistSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SNAP_ASSIST;
  const record = value as Record<string, unknown>;
  return {
    snap: typeof record["snap"] === "boolean" ? record["snap"] : DEFAULT_SNAP_ASSIST.snap,
    snapStepMm: sanitizeSnapStep(record["snapStepMm"]),
    polar: record["polar"] === true,
    polarIncrementDeg: sanitizePolarIncrement(record["polarIncrementDeg"]),
    ortho: record["ortho"] === true,
    relationHints: typeof record["relationHints"] === "boolean" ? record["relationHints"] : DEFAULT_SNAP_ASSIST.relationHints,
    equalHint: record["equalHint"] === true
  };
}

export interface SnapModifiers {
  /** Ctrl (or Cmd) held: snapping, polar tracking and the ortho toggle are all off for as long as it is held. */
  readonly ctrl: boolean;
  /** Shift held: constrain to horizontal / vertical (a square for the rectangle tools). */
  readonly shift: boolean;
}

export const NO_MODIFIERS: SnapModifiers = { ctrl: false, shift: false };

/** What a tool does with the last point it placed: perpendicular / tangent hints and alignment, or alignment only. */
export function anchorUseFor(tool: SketchTool): "full" | "align" {
  return tool === "line" || tool === "spline" || tool === "spline-control" || tool === "profile" ? "full" : "align";
}

/** The point polar tracking, ortho and the alignment guides are measured from: the last point the active tool placed. */
export function anchorFor(tool: SketchTool, pending: readonly Vec2[]): Vec2 | undefined {
  if (tool === "select" || tool === "text" || tool === "block" || tool === "blend") return undefined;
  return pending.at(-1);
}

const SQUARE_TOOLS: ReadonlySet<SketchTool> = new Set<SketchTool>(["rectangle", "rectangle-center", "rectangle-rounded"]);

/**
 * The clicks for which a direction from the last placed point means something, so the ortho lock and Shift constrain may act on them:
 * the end of a line (every segment), the second click of the tools whose first two clicks set an axis or an edge (a slot's two centres,
 * an ellipse's major axis, a rectangle's corner, a polygon's corner, a centerpoint arc's start). The later clicks set a width, a minor
 * axis, a sweep or a radius, where "level or plumb with the last point" would make the shape impossible (a slot of no width) or wrong
 * (a 90 degree arc that can only be 45 degrees).
 */
const DIRECTION_LOCK: Readonly<Partial<Record<SketchTool, "every" | "second">>> = {
  // Tools whose last click is the one that has an anchor, or where every click is a direction from the one before.
  line: "every", profile: "every", "line-midpoint": "every", centerline: "every", polygon: "every",
  rectangle: "every", "rectangle-center": "every", "rectangle-rounded": "every",
  // Tools with a third click that is a width, a minor axis, a sweep or a depth.
  parallelogram: "second", "rectangle-three-point": "second", slot: "second", "slot-straight": "second", ellipse: "second", "arc-center": "second"
};

/** Whether ortho and Shift act on the next click of the tool, given how many points it has already placed (when that is not known, only on the tools where every click is a direction). */
export function directionLockApplies(tool: SketchTool, placedCount: number | undefined): boolean {
  const rule = DIRECTION_LOCK[tool];
  if (rule === undefined) return false;
  return rule === "every" || placedCount === 1;
}

const DEGREES = 180 / Math.PI;

function clean(value: number): number {
  if (Math.abs(value) > 1e6) return value;
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

function axisGuide(from: Vec2, to: Vec2, horizontal: boolean): InferenceGuide {
  return { kind: horizontal ? "horizontal" : "vertical", from, to };
}

export interface AssistedInferenceInput {
  readonly tool: SketchTool;
  readonly pointer: Vec2;
  readonly sketch: WorkbenchSketch;
  readonly toleranceMm: number;
  /** The visible grid step, used when the settings do not name a snap step. */
  readonly gridMm: number | undefined;
  readonly anchor?: Vec2 | undefined;
  /** How many points the tool has placed so far; the ortho lock and Shift constrain act only on the clicks where a direction means something. */
  readonly placedCount?: number | undefined;
  readonly settings: SnapAssistSettings;
  readonly modifiers?: SnapModifiers;
  readonly excludeEntityIds?: readonly string[];
}

/** Snap results that are named points or curves: polar tracking never overrides these. */
const STRONG: ReadonlySet<string> = new Set(["endpoint", "center", "origin", "midpoint", "quadrant", "intersection", "perpendicular", "tangent", "on-curve", "parallel", "equal", "collinear"]);

/** Constrains `pointer` to the axis through `anchor` that it is closest to, or to a square about it. */
function constrain(tool: SketchTool, anchor: Vec2, pointer: Vec2): { readonly point: Vec2; readonly guide?: InferenceGuide; readonly kind: "horizontal" | "vertical" | "square" } {
  const dx = pointer[0] - anchor[0];
  const dy = pointer[1] - anchor[1];
  if (SQUARE_TOOLS.has(tool)) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return { point: [anchor[0] + (dx < 0 ? -size : size), anchor[1] + (dy < 0 ? -size : size)], kind: "square" };
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    const point: Vec2 = [pointer[0], anchor[1]];
    return { point, guide: axisGuide(anchor, point, true), kind: "horizontal" };
  }
  const point: Vec2 = [anchor[0], pointer[1]];
  return { point, guide: axisGuide(anchor, point, false), kind: "vertical" };
}

/**
 * The snapped point for the pointer with every aid applied, in this order: Ctrl held switches inference and polar off; the
 * normal inference runs (named points and curves, alignment, grid at the chosen snap step); Shift or the ortho lock then
 * forces the horizontal / vertical (or a square) through the last placed point; otherwise polar tracking pulls a free or
 * grid-snapped point onto the nearest multiple of the polar increment when the pointer is within reach of that ray.
 */
export function assistedInference(input: AssistedInferenceInput): InferenceResult {
  const modifiers = input.modifiers ?? NO_MODIFIERS;
  const { settings, pointer, anchor, tool } = input;
  const raw: InferenceResult = { point: pointer, snapped: false, guides: [] };
  const gridMm = settings.snapStepMm ?? input.gridMm;
  const inferring = settings.snap && !modifiers.ctrl;
  const base: InferenceResult = inferring
    ? inferSketchPoint(pointer, input.sketch, {
        toleranceMm: input.toleranceMm,
        ...(gridMm === undefined ? {} : { gridMm }),
        ...(anchor === undefined ? {} : { anchor, anchorUse: anchorUseFor(tool) }),
        ...(anchor !== undefined && anchorUseFor(tool) === "full" ? { relations: { ...(settings.relationHints ? DEFAULT_RELATION_HINTS : {}), ...(settings.equalHint ? { equal: true } : {}) } } : {}),
        ...(input.excludeEntityIds === undefined ? {} : { excludeEntityIds: input.excludeEntityIds })
      })
    : raw;
  if (anchor === undefined) return base;

  // The sticky ortho lock is for drawing directions: it must not turn every rectangle into a square. Only Shift (asked for on the spot) squares one.
  const orthoLocks = settings.ortho && !modifiers.ctrl && !SQUARE_TOOLS.has(tool);
  const forcing = directionLockApplies(tool, input.placedCount) && (modifiers.shift || orthoLocks);
  if (forcing) {
    const locked = constrain(tool, anchor, pointer);
    const label = locked.kind === "square" ? "Square" : modifiers.shift ? "Constrained" : "Ortho";
    if (locked.kind === "square") return { point: [clean(locked.point[0]), clean(locked.point[1])], snapped: true, guides: [], note: label };
    // Keep a named point or a grid node that already lies on the locked axis; otherwise the locked pointer position stands.
    const onAxis = (point: Vec2): boolean => locked.kind === "horizontal" ? Math.abs(point[1] - anchor[1]) < 1e-9 : Math.abs(point[0] - anchor[0]) < 1e-9;
    const step = gridMm;
    let point = locked.point;
    if (base.primary !== undefined && onAxis(base.point) && base.primary.kind !== "horizontal" && base.primary.kind !== "vertical") point = base.point;
    else if (step !== undefined && inferring) {
      const along = locked.kind === "horizontal" ? point[0] - anchor[0] : point[1] - anchor[1];
      const rounded = Math.round(along / step) * step;
      if (Math.abs(rounded - along) <= input.toleranceMm) point = locked.kind === "horizontal" ? [anchor[0] + rounded, anchor[1]] : [anchor[0], anchor[1] + rounded];
    }
    point = [clean(point[0]), clean(point[1])];
    const guide: InferenceGuide = axisGuide(anchor, point, locked.kind === "horizontal");
    return {
      point,
      snapped: true,
      primary: { kind: locked.kind === "horizontal" ? "horizontal" : "vertical", point, distanceMm: Math.hypot(point[0] - pointer[0], point[1] - pointer[1]) },
      guides: [guide],
      note: label
    };
  }

  // Polar tracking only helps a point that nothing more specific has claimed.
  if (settings.polar && !modifiers.ctrl && !(base.primary !== undefined && STRONG.has(base.primary.kind))) {
    const dx = pointer[0] - anchor[0];
    const dy = pointer[1] - anchor[1];
    const radius = Math.hypot(dx, dy);
    if (radius < input.toleranceMm * 2) return base;
    const increment = sanitizePolarIncrement(settings.polarIncrementDeg);
    const theta = Math.atan2(dy, dx) * DEGREES;
    const nearest = Math.round(theta / increment) * increment;
    const phi = (nearest * Math.PI) / 180;
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);
    const along = dx * ux + dy * uy;
    const across = Math.abs(-dx * uy + dy * ux);
    if (across > input.toleranceMm || along <= 0) return base;
    let length = along;
    if (inferring && gridMm !== undefined) {
      const rounded = Math.round(along / gridMm) * gridMm;
      if (rounded > 0 && Math.abs(rounded - along) <= input.toleranceMm) length = rounded;
    }
    const exact = ((Math.round(nearest) % 360) + 360) % 360;
    const axis = Math.abs(nearest - Math.round(nearest)) < 1e-9 && exact % 90 === 0;
    const point: Vec2 = axis
      ? [clean(anchor[0] + (exact === 0 ? length : exact === 180 ? -length : 0)), clean(anchor[1] + (exact === 90 ? length : exact === 270 ? -length : 0))]
      : [clean(anchor[0] + length * ux), clean(anchor[1] + length * uy)];
    if (axis) {
      const horizontal = exact === 0 || exact === 180;
      return { point, snapped: true, primary: { kind: horizontal ? "horizontal" : "vertical", point, distanceMm: across }, guides: [axisGuide(anchor, point, horizontal)], note: `Polar ${exact}°` };
    }
    const normalised = ((nearest % 360) + 360) % 360;
    return { point, snapped: true, primary: { kind: "polar", point, distanceMm: across }, guides: [{ kind: "polar", from: anchor, to: point }], note: `Polar ${Number(normalised.toFixed(2))}°` };
  }
  return base;
}
