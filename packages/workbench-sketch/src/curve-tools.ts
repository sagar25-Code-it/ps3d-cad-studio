import type { SketchEntity, Vec2, WorkbenchResult } from "../../workbench-core/src/index.js";
import { buildBlendCurve } from "./blend-profile.js";
import { buildCenterline, buildCenterpointArcSlot, buildMidpointLine, buildParallelogram, buildRoundedRectangle, buildThreePointArcSlot } from "./basic-curve-shapes.js";
import { buildEllipticalArc } from "./ellipse-arc.js";
import { buildTangentCircleThree, buildTangentCircleTwo } from "./tangent-circles.js";
import { buildConicByRho, buildConicFromFivePoints, buildControlPointSpline, buildHyperbola, buildParabola } from "./conic-curves.js";
import { sketchPointsProblem } from "./entity-limits.js";
import { badShape, type ShapeIds, type SketchShape } from "./curve-math.js";
import { insertSketchBlock, type SketchBlock } from "./sketch-blocks.js";
import { buildSketchText } from "./stroke-text.js";

/**
 * The extra curve tools: where they are registered (ids, labels, how many clicks each takes) and the one function that
 * turns a set of clicks into entities and relations. The sketch canvas only needs this file; each tool's geometry
 * lives in its own module and is tested on its own.
 */
export type FixedCurveToolId =
  | "line-midpoint"
  | "centerline"
  | "parallelogram"
  | "rectangle-rounded"
  | "slot-arc-three-point"
  | "slot-arc-center"
  | "parabola"
  | "hyperbola"
  | "conic"
  | "conic-five"
  | "ellipse-arc"
  | "circle-tangent-3"
  | "circle-tangent-2"
  | "blend"
  | "text"
  | "block";

/** Tools whose number of clicks is not fixed: the user keeps clicking and finishes with Enter (spline) or by closing (profile). */
export type OpenCurveToolId = "spline-control" | "profile";

export type CurveToolId = FixedCurveToolId | OpenCurveToolId;

const FIXED_POINTS: Readonly<Record<FixedCurveToolId, number>> = {
  "line-midpoint": 2,
  centerline: 2,
  parallelogram: 3,
  "rectangle-rounded": 2,
  "slot-arc-three-point": 4,
  "slot-arc-center": 4,
  parabola: 3,
  hyperbola: 3,
  conic: 3,
  "conic-five": 5,
  "ellipse-arc": 5,
  "circle-tangent-3": 3,
  "circle-tangent-2": 2,
  blend: 2,
  text: 1,
  block: 1
};

export const CURVE_TOOL_LABELS: Readonly<Record<CurveToolId, string>> = {
  "line-midpoint": "Midpoint line",
  centerline: "Centerline",
  parallelogram: "Parallelogram",
  "rectangle-rounded": "Rounded rectangle",
  "slot-arc-three-point": "3-point arc slot",
  "slot-arc-center": "Centerpoint arc slot",
  "spline-control": "Control-point spline",
  parabola: "Parabola",
  hyperbola: "Hyperbola",
  conic: "Conic (rho)",
  "conic-five": "Conic (5 points)",
  "ellipse-arc": "Elliptical arc",
  "circle-tangent-3": "3-tangent circle",
  "circle-tangent-2": "2-tangent circle",
  blend: "Blend curve",
  profile: "Profile",
  text: "Text",
  block: "Insert block"
};

/** What to click, in order, for each tool: shown in the status line as the clicks come in. */
export const CURVE_TOOL_PROMPTS: Readonly<Record<CurveToolId, readonly string[]>> = {
  "line-midpoint": ["centre", "one end"],
  centerline: ["a point on the line", "a point that gives its direction"],
  parallelogram: ["first corner", "second corner", "third corner"],
  "rectangle-rounded": ["first corner", "opposite corner"],
  "slot-arc-three-point": ["start of the centreline arc", "a point on the arc", "end of the arc", "a point for the half-width"],
  "slot-arc-center": ["bend centre", "start of the centreline arc", "direction of the arc end", "a point for the half-width"],
  "spline-control": ["control point (click the first one again or press Enter to finish)"],
  parabola: ["start", "end", "the point where the end tangents meet"],
  hyperbola: ["centre", "vertex", "a point on the branch"],
  conic: ["start", "end", "the point where the end tangents meet"],
  "conic-five": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "ellipse-arc": ["centre of the ellipse", "end of the major axis", "a point that sets the minor radius", "where the arc starts", "where the arc ends (counter-clockwise from the start)"],
  "circle-tangent-3": ["near the first curve", "near the second curve", "near the third curve"],
  "circle-tangent-2": ["near the first curve", "near the second curve (the radius is in the Sketch palette)"],
  blend: ["near the first curve end", "near the second curve end"],
  profile: ["start", "next point (click the start again to close)"],
  text: ["where the text starts"],
  block: ["where the middle of the block goes"]
};

export function isCurveTool(tool: string): tool is CurveToolId {
  return Object.hasOwn(CURVE_TOOL_LABELS, tool);
}

export function isFixedCurveTool(tool: string): tool is FixedCurveToolId {
  return Object.hasOwn(FIXED_POINTS, tool);
}

export function isOpenCurveTool(tool: string): tool is OpenCurveToolId {
  return tool === "spline-control" || tool === "profile";
}

/**
 * How many clicks a curve tool takes. An open tool (control-point spline, profile) reports the fewest it needs; the
 * canvas keeps taking points until the user finishes it.
 */
export function curveToolRequiredPoints(tool: string): number | undefined {
  if (isFixedCurveTool(tool)) return FIXED_POINTS[tool];
  if (tool === "spline-control") return 3;
  if (tool === "profile") return 2;
  return undefined;
}

/** The numbers a curve tool reads from the Sketch palette besides its clicks. */
export interface CurveToolOptions {
  /** Rounded rectangle corner radius; also the radius of a 2-tangent circle. */
  readonly cornerRadiusMm: number;
  /** Conic (rho) shoulder ratio, 0.02 to 0.98. */
  readonly rho: number;
  /** Blend curve tension, 0.2 to 3. */
  readonly blendTension: number;
  /** Sketch text. */
  readonly text: string;
  readonly textHeightMm: number;
  readonly textRotationDeg: number;
  /** Sketch text layout beyond size and angle; absent means the defaults (normal width, normal spacing, left aligned, profile geometry). */
  readonly textLayout?: { readonly widthFactor: number; readonly spacing: number; readonly align: "left" | "center" | "right"; readonly construction: boolean };
  /** How far a centerline reaches on each side of its first point. */
  readonly centerlineReachMm: number;
  /** The existing curves, so a blend can find the ends that were clicked. */
  readonly entities: readonly SketchEntity[];
  /** How close a blend click has to be to a curve end. */
  readonly pickReachMm: number;
  /** Control-point spline: keep the control polygon as construction lines. */
  readonly keepControlPolygon: boolean;
  /** Insert block: the saved block to drop, and how it is turned and scaled on the way in. */
  readonly block: SketchBlock | undefined;
  readonly blockRotationDeg: number;
  readonly blockScale: number;
}

export const DEFAULT_CURVE_TOOL_OPTIONS: CurveToolOptions = {
  cornerRadiusMm: 5,
  rho: 0.5,
  blendTension: 1,
  text: "TEXT",
  textHeightMm: 10,
  textRotationDeg: 0,
  centerlineReachMm: 1000,
  entities: [],
  pickReachMm: 3,
  keepControlPolygon: false,
  block: undefined,
  blockRotationDeg: 0,
  blockScale: 1
};

/** Builds the entities and relations a fixed-count curve tool places from its clicks. */
export function buildCurveTool(tool: FixedCurveToolId, points: readonly Vec2[], options: CurveToolOptions, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const p = (index: number): Vec2 => points[index]!;
  if (points.length !== FIXED_POINTS[tool]) {
    return { ok: false, diagnostics: [{ code: "INVALID_OPERATION", message: `${CURVE_TOOL_LABELS[tool]} takes ${FIXED_POINTS[tool]} points.`, relatedIds: [], recovery: "Place the remaining points or press Esc to cancel." }] };
  }
  // Every curve tool refuses a click that is not a finite number or lies beyond the sketch limit, with the limit named (the single-curve builders already did).
  const unusable = sketchPointsProblem(points);
  if (unusable !== undefined) return badShape(unusable);
  if (!Number.isFinite(options.cornerRadiusMm) || !Number.isFinite(options.rho) || !Number.isFinite(options.blendTension) || !Number.isFinite(options.centerlineReachMm)) return badShape("A tool setting in the Sketch palette is not a finite number.", "Type the setting again.");
  switch (tool) {
    case "line-midpoint": return buildMidpointLine(p(0), p(1), ids);
    case "centerline": return buildCenterline(p(0), p(1), options.centerlineReachMm, ids);
    case "parallelogram": return buildParallelogram(p(0), p(1), p(2), ids);
    case "rectangle-rounded": return buildRoundedRectangle(p(0), p(1), options.cornerRadiusMm, ids);
    case "slot-arc-three-point": return buildThreePointArcSlot(p(0), p(1), p(2), p(3), ids);
    case "slot-arc-center": return buildCenterpointArcSlot(p(0), p(1), p(2), p(3), ids);
    case "parabola": return buildParabola(p(0), p(1), p(2), ids);
    case "hyperbola": return buildHyperbola(p(0), p(1), p(2), ids);
    case "conic": return buildConicByRho(p(0), p(1), p(2), options.rho, ids);
    case "conic-five": return buildConicFromFivePoints(points, ids);
    case "ellipse-arc": return buildEllipticalArc(p(0), p(1), p(2), p(3), p(4), ids);
    case "circle-tangent-3": return buildTangentCircleThree(options.entities, points, options.pickReachMm, ids);
    case "circle-tangent-2": return buildTangentCircleTwo(options.entities, points, options.cornerRadiusMm, options.pickReachMm, ids);
    case "blend": return buildBlendCurve(options.entities, p(0), p(1), options.blendTension, options.pickReachMm, ids);
    case "block": return options.block === undefined ? badShape("There is no block to insert: select curves, save them as a block, then choose it in the Sketch palette.", "Save a block first.") : insertSketchBlock(options.block, p(0), { rotationDeg: options.blockRotationDeg, scale: options.blockScale }, ids);
    case "text": return buildSketchText(p(0), options.text, { heightMm: options.textHeightMm, rotationDeg: options.textRotationDeg, ...(options.textLayout ?? {}) }, ids);
  }
}

export { buildControlPointSpline };
