import type { GeometryReference, ParametricSketchDocument, SketchConstraint, SketchDimension } from "./types.js";

/**
 * Which rectangles keep their orientation by themselves (second re-audit: solver R2-8 and UX R2-6).
 *
 * A rectangle drawn axis-aligned stays axis-aligned unless something in the sketch turns it, exactly as a four-line rectangle with
 * Horizontal and Vertical on its sides does. Counting its turn as a free degree of freedom made every Rectangle-tool rectangle read
 * "underconstrained" even with a width, a height and a pinned corner, and letting the turn move a hair under a drag skewed it by
 * thousandths of a degree. So a rectangle whose turn is a multiple of 90 degrees and that is pinned at one place (a corner or the
 * centre on a point, the origin or a curve) holds that turn, unless a relation or a dimension speaks about its direction
 * (Horizontal, Vertical, Parallel, Perpendicular, Collinear, Tangent, Symmetric, Refraction, an angle). A rectangle pinned at two
 * places has its turn set by them, and one pinned nowhere is still a free entity with the classic five degrees of freedom.
 */

const ORIENTATION_KINDS: ReadonlySet<SketchConstraint["kind"]> = new Set(["horizontal", "vertical", "parallel", "perpendicular", "collinear", "tangent", "symmetric", "refraction"]);
const PINNING_KINDS: ReadonlySet<SketchConstraint["kind"]> = new Set(["coincident", "midpoint", "on-curve", "fix"]);

function referencesOf(constraint: SketchConstraint): readonly GeometryReference[] {
  switch (constraint.kind) {
    case "fix": return [constraint.target];
    case "horizontal":
    case "vertical": return [constraint.line];
    case "midpoint": return [constraint.point, constraint.line];
    case "on-curve": return [constraint.point, constraint.curve];
    case "symmetric": return [constraint.first, constraint.second, constraint.axis];
    case "refraction": return [constraint.incident, constraint.refracted, constraint.boundary];
    default: return [constraint.first, constraint.second];
  }
}

function dimensionReferences(dimension: SketchDimension): readonly GeometryReference[] {
  switch (dimension.kind) {
    case "point-line-distance": return [dimension.point, dimension.line];
    case "line-line-distance": return [dimension.first, dimension.second];
    case "angle": return [dimension.first, dimension.second];
    case "linear": return [dimension.first, dimension.second];
    default: return [dimension.target];
  }
}

export function heldRectangleIds(document: ParametricSketchDocument): readonly string[] {
  const candidates = document.geometry.filter((geometry) => geometry.kind === "rectangle" && geometry.source?.associative !== true && geometry.suppressed !== true
    && Math.abs(Math.sin(2 * geometry.rotationRad)) < 1e-9);
  if (candidates.length === 0) return [];
  const free = new Set(candidates.map((geometry) => geometry.id));
  const pins = new Map<string, number>();
  for (const constraint of document.constraints) {
    if (constraint.suppressed) continue;
    for (const reference of referencesOf(constraint)) {
      if (!free.has(reference.entityId)) continue;
      if (ORIENTATION_KINDS.has(constraint.kind)) free.delete(reference.entityId);
      else if (PINNING_KINDS.has(constraint.kind)) pins.set(reference.entityId, (pins.get(reference.entityId) ?? 0) + 1);
    }
  }
  for (const dimension of document.dimensions) {
    if (dimension.suppressed || dimension.mode !== "driving") continue;
    if (dimension.kind === "angle") for (const reference of dimensionReferences(dimension)) free.delete(reference.entityId);
  }
  return candidates.map((geometry) => geometry.id).filter((id) => free.has(id) && (pins.get(id) ?? 0) === 1);
}
