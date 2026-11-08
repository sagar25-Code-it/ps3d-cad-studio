import type { Vec2, WorkbenchResult } from "../../workbench-core/src/index.js";
import { POLYGON_MODES, buildEdgePolygon, buildPolygon, type PolygonMode } from "./regular-polygon.js";
import type { ShapeIds, SketchShape } from "./shapes.js";

/** How the Polygon tool reads its two clicks, in the words the palette shows. */
export const POLYGON_MODE_LABELS: Readonly<Record<PolygonMode, string>> = {
  inscribed: "Inscribed (centre, corner)",
  circumscribed: "Circumscribed (centre, side)",
  edge: "Edge (side ends)"
};

/** The click prompts of the Polygon tool in each mode. */
export const POLYGON_MODE_PROMPTS: Readonly<Record<PolygonMode, readonly [string, string]>> = {
  inscribed: ["Click the polygon's centre", "Click a corner: it sets the corner radius and the turn"],
  circumscribed: ["Click the polygon's centre", "Click the middle of a side: it sets the apothem and the turn"],
  edge: ["Click one end of the first side", "Click the other end: the polygon grows on the left"]
};

export function parsePolygonMode(text: string): PolygonMode {
  return (POLYGON_MODES as readonly string[]).includes(text) ? (text as PolygonMode) : "inscribed";
}

/** Builds the polygon the palette's mode asks for from the two clicked points. */
export function buildPolygonByMode(first: Vec2, second: Vec2, sides: number, mode: PolygonMode, ids: ShapeIds): WorkbenchResult<SketchShape> {
  return mode === "edge" ? buildEdgePolygon(first, second, sides, ids) : buildPolygon(first, second, sides, ids, mode);
}
