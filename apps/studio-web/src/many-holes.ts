import { MAX_BODY_VERTICES } from "../../../packages/workbench-core/src/index.js";
import type { SketchProfile } from "../../../packages/workbench-sketch/src/index.js";
import { profileOutlineMm } from "../../../packages/workbench-sketch/src/index.js";

/**
 * Adaptive faceting of the round holes of a plate.
 *
 * A stored solid keeps three vertices for every triangle, and a prism costs four triangles (twelve vertices) for every point of its outline
 * (two cap triangles and two wall triangles). A circle follows the sketch's chord-error rule, which is about 100 edges at every radius, so one
 * round hole costs about 1,200 vertices and a plate used to stop at about 83 holes. Past a budget the holes of a plate are given fewer edges,
 * just enough for the plate to fit, instead of being refused; only a plate whose holes cannot fit even at the coarsest faceting is refused,
 * and then with the real limit in the message.
 */

/** Vertices a plate may use before its round holes are thinned (about 250 holes at the full faceting). */
export const FACET_BUDGET_VERTICES = 300_000;
/** The fewest edges a thinned round hole keeps: 16 puts the polygon area within 2% of the circle. */
export const MIN_HOLE_FACETS = 16;
/** Vertices a prism costs per outline point (cap triangles top and bottom, two wall triangles; three vertices each). */
export const VERTICES_PER_OUTLINE_POINT = 12;

export interface HoleFacetPlan {
  /** The cap on the edges of each round hole, or undefined when every hole keeps its full faceting. */
  readonly maxFacets?: number;
  /** Said to the user when the holes were thinned. */
  readonly note?: string;
  /** Set when the plate cannot be stored even at the coarsest faceting. */
  readonly refusal?: string;
}

/** How many edges the holes of this plate get so the solid fits the storage limit; the full faceting whenever that fits. */
export function planHoleFacets(outerBoundary: SketchProfile["boundary"], holes: readonly SketchProfile[]): HoleFacetPlan {
  if (holes.length === 0) return {};
  const outerPoints = profileOutlineMm(outerBoundary).length;
  let roundPoints = 0;
  let roundCount = 0;
  let otherPoints = 0;
  for (const hole of holes) {
    const points = profileOutlineMm(hole.boundary).length;
    if (hole.boundary.kind === "circle" || hole.boundary.kind === "ellipse") { roundPoints += points; roundCount += 1; } else otherPoints += points;
  }
  const full = VERTICES_PER_OUTLINE_POINT * (outerPoints + roundPoints + otherPoints);
  if (full <= FACET_BUDGET_VERTICES) return {};
  const fixedVertices = VERTICES_PER_OUTLINE_POINT * (outerPoints + otherPoints);
  if (roundCount === 0 || fixedVertices > MAX_BODY_VERTICES) {
    return { refusal: tooMany(holes.length, full) };
  }
  const perHole = Math.floor((FACET_BUDGET_VERTICES - fixedVertices) / roundCount / VERTICES_PER_OUTLINE_POINT / 4) * 4;
  const facets = Math.max(MIN_HOLE_FACETS, perHole);
  const thinned = fixedVertices + roundCount * facets * VERTICES_PER_OUTLINE_POINT;
  if (thinned > MAX_BODY_VERTICES) return { refusal: tooMany(holes.length, thinned) };
  const average = Math.round(roundPoints / roundCount);
  return {
    maxFacets: facets,
    note: `This plate has ${holes.length} holes, more than ${FACET_BUDGET_VERTICES.toLocaleString("en-US")} stored vertices allow at full roundness, so each round hole is drawn with ${facets} edges instead of ${average}. The volume differs from the true circles by about ${(((2 * Math.PI) / facets) ** 2 / 6 * 100).toFixed(1)}% of the hole area.`
  };
}

function tooMany(holes: number, vertices: number): string {
  const perHoleMax = Math.floor(MAX_BODY_VERTICES / (MIN_HOLE_FACETS * VERTICES_PER_OUTLINE_POINT));
  return `This plate needs about ${Math.round(vertices).toLocaleString("en-US")} stored vertices for its ${holes} holes, and a solid holds at most ${MAX_BODY_VERTICES.toLocaleString("en-US")} (at best about ${perHoleMax.toLocaleString("en-US")} round holes, each drawn with ${MIN_HOLE_FACETS} edges). Use fewer holes, split the plate into two features, or make the holes with a pattern.`;
}
