import { CURVE_TOOL_PROMPTS, isFixedCurveTool } from "./curve-tools.js";
import type { SketchTool } from "./index.js";

/**
 * What each click of a multi-click tool means, so the status line can say "Next: ..." after every click. The newer curve
 * tools have their own table in curve-tools.ts; this adds the older ones (arcs, ellipse, polygon, slots, 3-point shapes).
 * Entry 0 is the meaning of the first click, entry 1 of the second, and so on.
 */
const OLDER_PROMPTS: Readonly<Partial<Record<SketchTool, readonly string[]>>> = {
  line: ["the start of the line", "the end of the line (click the first point again to close a loop)"],
  rectangle: ["the first corner", "the opposite corner"],
  "rectangle-center": ["the centre", "a corner"],
  "rectangle-three-point": ["the start of the first edge", "the other end of the first edge", "a point that gives the height"],
  circle: ["the centre", "a point on the circle (sets the radius)"],
  "circle-two-point": ["one end of the diameter", "the other end of the diameter"],
  "circle-three-point": ["a first point on the circle", "a second point on the circle", "a third point on the circle"],
  ellipse: ["the centre", "the end of the major axis", "a point that gives the minor radius"],
  arc: ["the start of the arc", "a point on the arc", "the end of the arc"],
  "arc-center": ["the centre", "the start of the arc (sets the radius)", "the end of the arc (sets the sweep)"],
  "arc-tangent": ["the start of the arc (usually the end of a curve)", "a point that gives the tangent direction", "the end of the arc"],
  polygon: ["the centre", "a corner (sets the size and the turn)"],
  slot: ["the first end centre", "the other end centre", "a point that gives the half-width"],
  "slot-straight": ["the first outer end", "the other outer end", "a point that gives the half-width"],
  spline: ["the first fit point", "the next fit point", "the next fit point (click the last point again or press Enter to finish)"],
  point: ["where the point goes"]
};

/** The meaning of the click that comes after `placedPoints` clicks, or undefined when there is no further click to explain. */
export function nextClickPrompt(tool: SketchTool, placedPoints: number): string | undefined {
  if (isFixedCurveTool(tool) || tool === "spline-control" || tool === "profile") {
    const prompts = CURVE_TOOL_PROMPTS[tool];
    return prompts[placedPoints] ?? (tool === "spline-control" || tool === "profile" ? prompts.at(-1) : undefined);
  }
  const prompts = OLDER_PROMPTS[tool];
  if (prompts === undefined) return undefined;
  // A tool that keeps taking points repeats its last prompt.
  return prompts[placedPoints] ?? (tool === "spline" ? prompts.at(-1) : undefined);
}

/** The prompt for the very first click of a tool, shown when the tool is activated. */
export function firstClickPrompt(tool: SketchTool): string | undefined {
  return nextClickPrompt(tool, 0);
}
