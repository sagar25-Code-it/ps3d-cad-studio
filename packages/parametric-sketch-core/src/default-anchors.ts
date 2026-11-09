import type { GeometryReference, ParametricSketchDocument, SketchConstraint, SketchDimension, SolveAnchor } from "./types.js";

/**
 * Who gives way when a relation can be met several ways and the caller did not say. The rule is the one people expect from a sketch:
 * the geometry a relation names first is the reference and the later geometry adjusts; a line turns or grows about its start, a circle
 * is resized before it is moved, a dimension keeps the curve it measures and moves what is joined to it. Without these hints the
 * solver still moves as little as possible; with them it also moves the right thing.
 *
 * Holds are listed first and releases last, so an entity that is the reference of one relation but the follower of another
 * stays free where it has to follow.
 */
/** The lines whose length must survive being turned: the second line of a parallel, perpendicular, collinear or angle relation. */
export function defaultPreserve(document: ParametricSketchDocument): readonly string[] {
  const lines = new Set(document.geometry.filter((geometry) => geometry.kind === "line").map((geometry) => geometry.id));
  const kept: string[] = [];
  for (const constraint of document.constraints) {
    if (constraint.suppressed) continue;
    if ((constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "collinear") && lines.has(constraint.second.entityId)) kept.push(constraint.second.entityId);
  }
  for (const dimension of document.dimensions) {
    if (!dimension.suppressed && dimension.mode === "driving" && dimension.kind === "angle" && lines.has(dimension.second.entityId)) kept.push(dimension.second.entityId);
  }
  // A refracted line is bent and moved to the incident line's end but keeps its length.
  for (const constraint of document.constraints) if (!constraint.suppressed && constraint.kind === "refraction" && lines.has(constraint.refracted.entityId)) kept.push(constraint.refracted.entityId);
  return [...new Set(kept)];
}

export function defaultAnchors(document: ParametricSketchDocument): readonly SolveAnchor[] {
  const geometryKind = new Map(document.geometry.map((geometry) => [geometry.id, geometry.kind] as const));
  const holds: SolveAnchor[] = [];
  const releases: SolveAnchor[] = [];
  // A curve that carries a driving dimension has to be free to change that size, so it is held by its anchor point only.
  const dimensioned = new Set<string>();
  for (const dimension of document.dimensions) {
    if (dimension.suppressed || dimension.mode !== "driving") continue;
    if (dimension.kind === "linear" || dimension.kind === "angle" || dimension.kind === "line-line-distance") dimensioned.add(dimension.first.entityId).add(dimension.second.entityId);
    else if (dimension.kind === "point-line-distance") dimensioned.add(dimension.point.entityId).add(dimension.line.entityId);
    else dimensioned.add(dimension.target.entityId);
  }
  const anchorPoint = (reference: GeometryReference): GeometryReference => {
    const kind = geometryKind.get(reference.entityId);
    return { entityId: reference.entityId, selector: kind === "line" || kind === "slot" ? "start" : kind === "point" ? "point" : "center" };
  };
  const self = (reference: GeometryReference): GeometryReference => (dimensioned.has(reference.entityId) && geometryKind.get(reference.entityId) !== "point" ? anchorPoint(reference) : { entityId: reference.entityId, selector: "self" });
  const hold = (reference: GeometryReference, priority: 1 | 2 = 2): void => { if (geometryKind.has(reference.entityId)) holds.push({ reference, priority }); };
  const release = (reference: GeometryReference): void => { if (geometryKind.has(reference.entityId)) releases.push({ reference, priority: 0 }); };
  const isLine = (reference: GeometryReference): boolean => geometryKind.get(reference.entityId) === "line";
  const at = (reference: GeometryReference, selector: GeometryReference["selector"]): GeometryReference => ({ entityId: reference.entityId, selector });

  const lineGeometry = (id: string): { readonly start: readonly [number, number]; readonly end: readonly [number, number] } | undefined => {
    const geometry = document.geometry.find((candidate) => candidate.id === id);
    return geometry?.kind === "line" ? geometry : undefined;
  };
  const fixedParts = new Set(document.constraints.filter((constraint) => constraint.kind === "fix" && !constraint.suppressed).map((constraint) => constraint.kind === "fix" ? `${constraint.target.entityId}:${constraint.target.selector === "curve" ? "self" : constraint.target.selector}` : ""));

  const forConstraint = (constraint: SketchConstraint): void => {
    switch (constraint.kind) {
      case "horizontal":
      case "vertical":
        hold(at(constraint.line, "start"));
        break;
      case "parallel":
      case "perpendicular":
        hold(self(constraint.first));
        hold(at(constraint.second, "start"));
        break;
      case "collinear":
        hold(self(constraint.first));
        break;
      case "coincident": {
        hold(self(constraint.first));
        hold(self(constraint.second), 1);
        release(constraint.second);
        break;
      }
      case "on-curve":
        hold(self(constraint.curve));
        hold(self(constraint.point), 1);
        release(constraint.point);
        break;
      case "concentric":
        hold(self(constraint.first));
        hold(self(constraint.second), 1);
        release(at(constraint.second, "center"));
        break;
      case "midpoint":
        hold(self(constraint.line));
        hold(self(constraint.point), 1);
        release(constraint.point);
        break;
      case "tangent": {
        const lineFirst = isLine(constraint.first) || !isLine(constraint.second);
        const reference = lineFirst ? constraint.first : constraint.second;
        const follower = lineFirst ? constraint.second : constraint.first;
        hold(self(reference));
        hold(at(follower, "center"), 1);
        break;
      }
      case "equal": {
        hold(self(constraint.first));
        if (isLine(constraint.second)) hold(at(constraint.second, "start"));
        else hold(at(constraint.second, "center"));
        break;
      }
      case "symmetric":
        hold(self(constraint.axis));
        hold(self(constraint.first));
        break;
      case "refraction":
        hold(self(constraint.incident));
        hold(self(constraint.boundary));
        break;
      case "fix":
        break;
    }
  };

  const forDimension = (dimension: SketchDimension): void => {
    switch (dimension.kind) {
      case "length":
        hold(at(dimension.target, "start"));
        break;
      case "radius":
      case "diameter":
        hold(at(dimension.target, "center"), 1);
        break;
      case "linear":
        hold(self(dimension.first));
        hold(self(dimension.second));
        release(dimension.second);
        break;
      case "angle": {
        // The first line is the reference the angle is measured from: held whole.
        hold({ entityId: dimension.first.entityId, selector: "self" });
        // The second line turns about the end it shares with the first, or about the end that is Fixed, otherwise about its start.
        const first = lineGeometry(dimension.first.entityId);
        const second = lineGeometry(dimension.second.entityId);
        if (first === undefined || second === undefined) {
          hold(at(dimension.second, "start"), 1);
          break;
        }
        const shared = (point: readonly [number, number]): boolean => [first.start, first.end].some((other) => Math.hypot(other[0] - point[0], other[1] - point[1]) <= 1e-6);
        const id = dimension.second.entityId;
        const endFixed = fixedParts.has(`${id}:end`) || fixedParts.has(`${id}:self`);
        const startFixed = fixedParts.has(`${id}:start`) || fixedParts.has(`${id}:self`);
        if (endFixed || startFixed) break;
        hold(at(dimension.second, shared(second.end) && !shared(second.start) ? "end" : "start"), 1);
        break;
      }
      case "arc-length":
        hold(at(dimension.target, "start"));
        break;
      case "point-line-distance":
        hold(self(dimension.line));
        hold(self(dimension.point), 1);
        release(dimension.point);
        break;
      case "line-line-distance":
        hold(self(dimension.first));
        break;
      case "width":
      case "height":
      case "perimeter":
        hold(at(dimension.target, "center"), 1);
        break;
      case "coordinate-x":
      case "coordinate-y":
        break;
    }
  };

  for (const constraint of document.constraints) if (!constraint.suppressed) forConstraint(constraint);
  for (const dimension of document.dimensions) if (!dimension.suppressed && dimension.mode === "driving") forDimension(dimension);
  return [...holds, ...releases];
}
