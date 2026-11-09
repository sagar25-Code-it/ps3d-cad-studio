import { constraintFit } from "./constraint-fit.js";
import { anchorsAfterResize, anchorsForDimension, preserveForConstraint } from "./sketch-anchors.js";
import { arcShape, dimensionTargetValue, ellipsePerimeterMm, measureDimensionConstraint } from "./sketch-measure.js";
import { solveLiveSketch, type LiveSketchSolveReport } from "./sketch-solve.js";
import { describeConstraint, entityKindOf, entityNames } from "./sketch-translate.js";
import type { SketchDimensionName, SketchEntity, SketchPointRef, WorkbenchOperation, WorkbenchProject, WorkbenchResult, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";
import { isSketchDatumEntityId, SKETCH_RELATIVE_DISTANCE_NAMES } from "./types.js";
import { failure, WORKBENCH_LIMITS } from "./validation.js";
import { MODEL_ENVELOPE } from "./envelope.js";
import { missingSketchEntityFailure } from "./finished-sketch-hint.js";

type SetDimension = Extract<WorkbenchOperation, { readonly kind: "set-sketch-dimension" }>;
type Applied = WorkbenchResult<{ readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string }>;

const MAX_ENVELOPE_MM = MODEL_ENVELOPE.maxSketchSizeMm;
const MAX_LONG_ENVELOPE_MM = MODEL_ENVELOPE.maxSketchLongMm;

function constraintKindOf(name: SketchDimensionName): WorkbenchSketchConstraint["kind"] {
  if (name === "radius" || name === "diameter" || name === "major-radius" || name === "minor-radius") return "radius";
  return name === "angle" ? "angle" : name === "arc-length" ? "arc-length" : name === "perimeter" ? "perimeter" : "distance";
}

function unitLabel(name: SketchDimensionName): string {
  return name === "angle" ? "°" : " mm";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

/** Which dimension a stored constraint is: its `dimension` field, or the default for its kind. */
export function dimensionNameOf(constraint: WorkbenchSketchConstraint, firstKind?: SketchEntity["kind"]): SketchDimensionName {
  switch (constraint.kind) {
    case "radius": return constraint.dimension === "diameter" || constraint.dimension === "major-radius" || constraint.dimension === "minor-radius" ? constraint.dimension : "radius";
    case "angle": return "angle";
    case "arc-length": return "arc-length";
    case "perimeter": return "perimeter";
    default: return constraint.dimension ?? (firstKind === "rectangle" ? "width" : constraint.entityIds.length === 2 ? "aligned" : "length");
  }
}

/** A refused edit names the dimension that was just entered, which the solver does not know is the new one, then what it cannot be met with. */
function solveFailure(report: Extract<LiveSketchSolveReport, { readonly ok: false }>, sketch?: WorkbenchSketch, dimension?: WorkbenchSketchConstraint): Applied {
  if (sketch === undefined || dimension === undefined || report.relatedIds.includes(dimension.id)) return failure("CONSTRAINT_CONFLICT", report.message, report.relatedIds, report.recovery);
  const entered = describeConstraint(dimension, entityNames(sketch));
  return failure("CONSTRAINT_CONFLICT", `${entered} cannot be met together with the sketch’s other relations. ${report.message}`, [...report.relatedIds, dimension.id], report.recovery);
}

export function solveSummary(report: Extract<LiveSketchSolveReport, { readonly ok: true }>): string {
  const parts: string[] = [];
  // A long edit moved many curves: say how many instead of listing each one.
  if (report.notes.length > 4) parts.push(`Moved ${report.movedIds.length} curves`);
  else if (report.notes.length > 0) parts.push(report.notes.join("; "));
  if (report.unsolved.length > 0) parts.push(`Recorded, not solved: ${report.unsolved.map((entry) => entry.reason).join(" ")}`);
  return parts.length === 0 ? "" : ` ${parts.join(". ")}.`;
}

/** Old-style direct resize for the dimensions that always had one (a line's length, a circle's radius or diameter, a rectangle's sides). */
export function resizeSketchEntity(entity: SketchEntity, dimension: SketchDimensionName, valueMm: number): SketchEntity | undefined {
  if (entity.kind === "line" && dimension === "length") {
    const dx = entity.end[0] - entity.start[0];
    const dy = entity.end[1] - entity.start[1];
    const current = Math.hypot(dx, dy);
    return { ...entity, end: [entity.start[0] + (dx / current) * valueMm, entity.start[1] + (dy / current) * valueMm] as const };
  }
  if (entity.kind === "circle" && dimension === "radius") return { ...entity, radiusMm: valueMm };
  if (entity.kind === "circle" && dimension === "diameter") return { ...entity, radiusMm: valueMm / 2 };
  if (entity.kind === "circle" && dimension === "perimeter") return { ...entity, radiusMm: valueMm / (2 * Math.PI) };
  if (entity.kind === "arc" && (dimension === "radius" || dimension === "diameter")) {
    const shape = arcShape(entity.start, entity.mid, entity.end);
    if (shape === undefined) return undefined;
    const scale = (dimension === "diameter" ? valueMm / 2 : valueMm) / shape.radiusMm;
    const about = (point: readonly [number, number]): readonly [number, number] => [shape.center[0] + (point[0] - shape.center[0]) * scale, shape.center[1] + (point[1] - shape.center[1]) * scale];
    return { ...entity, start: about(entity.start), mid: about(entity.mid), end: about(entity.end) };
  }
  if (entity.kind === "rectangle" && dimension === "width") return { ...entity, widthMm: valueMm };
  if (entity.kind === "rectangle" && dimension === "height") return { ...entity, heightMm: valueMm };
  return undefined;
}

/**
 * The first guess for a driving perimeter: a rectangle keeps a side that is dimensioned and gives the rest to the other side, or scales
 * uniformly when neither side is held; an ellipse scales uniformly. The solver then makes it exact and brings the neighbours along.
 */
function resizeForPerimeter(entity: SketchEntity, value: number, sketch: WorkbenchSketch): SketchEntity | undefined {
  if (entity.kind === "ellipse") {
    const scale = value / ellipsePerimeterMm(entity.majorRadiusMm, entity.minorRadiusMm);
    return { ...entity, majorRadiusMm: entity.majorRadiusMm * scale, minorRadiusMm: entity.minorRadiusMm * scale };
  }
  if (entity.kind !== "rectangle") return undefined;
  const held = (dimension: "width" | "height"): boolean => sketch.constraints.some((candidate) => candidate.kind === "distance" && candidate.driven !== true && candidate.suppressed !== true && candidate.dimension === dimension && candidate.entityIds[0] === entity.id);
  const widthHeld = held("width");
  const heightHeld = held("height");
  if (widthHeld && heightHeld) return undefined;
  const half = value / 2;
  if (widthHeld) return half - entity.widthMm > 0 ? { ...entity, heightMm: half - entity.widthMm } : undefined;
  if (heightHeld) return half - entity.heightMm > 0 ? { ...entity, widthMm: half - entity.heightMm } : undefined;
  const scale = value / (2 * (entity.widthMm + entity.heightMm));
  return { ...entity, widthMm: entity.widthMm * scale, heightMm: entity.heightMm * scale };
}

export type RedriveResult =
  | { readonly ok: true; readonly sketch: WorkbenchSketch; readonly movedIds: readonly string[]; readonly solved: Extract<LiveSketchSolveReport, { readonly ok: true }> }
  | { readonly ok: false; readonly applied: Extract<Applied, { readonly ok: false }> };

/** Whether a Fix constraint (on the whole curve or one of its points) holds any of this entity. */
function heldByFix(sketch: WorkbenchSketch, id: string): boolean {
  return sketch.constraints.some((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true && constraint.entityIds.includes(id));
}

/**
 * Brings the sketch to the value of one driving dimension and lets every relation around it follow. The dimensions that always had a
 * direct resize keep it (unless a Fix holds the curve, when the solver has to find out whether the value is reachable); everything is then
 * solved at once, the dimensioned curve keeping its place and its neighbours moving as little as they can. The `constraint` is already part
 * of `sketch.constraints` with its new value.
 */
export function redriveDimension(sketch: WorkbenchSketch, constraint: WorkbenchSketchConstraint): RedriveResult {
  const entityIds = constraint.entityIds;
  const real = entityIds.filter((id) => !isSketchDatumEntityId(id));
  const target = sketch.entities.find((entity) => entity.id === entityIds[0]);
  const name = dimensionNameOf(constraint, target?.kind);
  const value = dimensionTargetValue(constraint);
  if (value === undefined) return { ok: false, applied: failure("INVALID_OPERATION", "The dimension has no value.", [constraint.id], "Give the dimension a value.") as Extract<Applied, { readonly ok: false }> };
  // A circle or arc held tangent to something is left to the solver, which sees how it touches now (outside or inside) and keeps it that way.
  const tangent = target !== undefined && sketch.constraints.some((candidate) => candidate.kind === "tangent" && candidate.suppressed !== true && candidate.entityIds.includes(target.id));
  const resized = target !== undefined && entityIds.length === 1 && !heldByFix(sketch, target.id) && !(tangent && (target.kind === "circle" || target.kind === "arc"))
    ? (name === "perimeter" && target.kind !== "circle" ? resizeForPerimeter(target, value, sketch) : resizeSketchEntity(target, name, value))
    : undefined;
  const baseSketch: WorkbenchSketch = { ...sketch, entities: resized === undefined || target === undefined ? sketch.entities : sketch.entities.map((entity) => entity.id === target.id ? resized : entity) };
  const entityMap = new Map(baseSketch.entities.map((entity) => [entity.id, entity] as const));
  // Once the curve has its new size by direct resize it is the reference and its neighbours follow; otherwise only part of it is held.
  const anchors = resized !== undefined && target !== undefined ? anchorsAfterResize(target, entityMap, sketch.constraints) : anchorsForDimension(constraint, entityMap, sketch.constraints);
  const solved = solveLiveSketch(baseSketch, real, { anchors, preserve: preserveForConstraint(constraint, entityMap), keepChains: false });
  if (!solved.ok) return { ok: false, applied: solveFailure(solved, sketch, constraint) as Extract<Applied, { readonly ok: false }> };
  const nextSketch: WorkbenchSketch = { ...baseSketch, entities: solved.entities };
  const measured = measureDimensionConstraint(nextSketch, constraint);
  if (measured !== undefined || resized === undefined) {
    const gap = measured === undefined ? Infinity : name === "angle" ? Math.min(Math.abs(measured - value), 360 - Math.abs(measured - value)) : Math.abs(measured - value);
    if (!(gap <= 1e-6)) {
      return {
        ok: false,
        applied: failure("CONSTRAINT_CONFLICT", `Other relations hold the geometry, so the ${name} cannot reach ${formatNumber(value)}${unitLabel(name)}${measured === undefined ? "" : ` (it stays at ${formatNumber(measured)}${unitLabel(name)})`}.`, entityIds, "Relax or remove a relation that fixes the same curves, then set the dimension again.") as Extract<Applied, { readonly ok: false }>
      };
    }
  }
  return { ok: true, sketch: nextSketch, movedIds: solved.movedIds, solved };
}

/** The stored dimension constraint a set-sketch-dimension request addresses, if there is one. */
export function locateDimensionConstraint(sketch: WorkbenchSketch, request: Pick<SetDimension, "entityId" | "dimension" | "secondEntityId" | "points">): WorkbenchSketchConstraint | undefined {
  const name = request.dimension;
  const relative = (SKETCH_RELATIVE_DISTANCE_NAMES as readonly string[]).includes(name);
  const first = sketch.entities.find((entity) => entity.id === request.entityId);
  const ellipseRotation = name === "angle" && first?.kind === "ellipse" && request.secondEntityId === undefined;
  const entityIds = name === "angle" ? (ellipseRotation ? [request.entityId] : [request.entityId, request.secondEntityId ?? ""]) : relative ? [request.entityId, request.secondEntityId ?? ""] : [request.entityId];
  const kind = constraintKindOf(name);
  return sketch.constraints.find((constraint) => constraint.kind === kind
    && constraint.entityIds.length === entityIds.length
    && constraint.entityIds.every((id, index) => id === entityIds[index])
    && (kind === "distance" || kind === "radius" ? dimensionNameOf(constraint, first?.kind) === name : true)
    && (!relative || (constraint.points ?? []).join("|") === (request.points ?? []).join("|")));
}

/**
 * Sets, or makes a reference of, one dimension of the working sketch: a length, radius, diameter, width or height, an angle between
 * two lines, an arc length, a perimeter, a distance between two points (or from the origin), a point to a line or two lines, and an ellipse's
 * axes. A driving dimension moves the geometry to the value and is held by the solver from then on; a driven (reference) dimension only
 * records what to measure and never moves anything. Setting a dimension that is relaxed updates its value and keeps it relaxed.
 */
export function setSketchDimension(project: WorkbenchProject, operation: SetDimension): Applied {
  const sketch = project.sketch;
  const name = operation.dimension;
  const lookup = (id: string): SketchEntity | "datum" | undefined => (isSketchDatumEntityId(id) ? "datum" : sketch.entities.find((entity) => entity.id === id));
  const target = lookup(operation.entityId);
  if (target === undefined) return missingSketchEntityFailure(project, operation.entityId, "The sketch entity does not exist.");
  const invalid = (message: string): Applied => failure("INVALID_OPERATION", message, [], "Use an exact bounded operation schema from the capability list.");
  const driven = operation.driven === true;
  const relative = (SKETCH_RELATIVE_DISTANCE_NAMES as readonly string[]).includes(name);
  const ellipseRotation = name === "angle" && target !== "datum" && target.kind === "ellipse" && operation.secondEntityId === undefined;

  const entityIds = name === "angle" ? (ellipseRotation ? [operation.entityId] : [operation.entityId, operation.secondEntityId ?? ""]) : relative ? [operation.entityId, operation.secondEntityId ?? ""] : [operation.entityId];
  if (name === "angle" && !ellipseRotation) {
    if (operation.secondEntityId === undefined) return invalid("An angle dimension needs a second line.");
    if (lookup(operation.secondEntityId) === undefined) return failure("BROKEN_REFERENCE", "The second sketch entity does not exist.", [operation.secondEntityId], "Refresh the project and select an existing stable ID.");
    if (operation.secondEntityId === operation.entityId) return invalid("An angle needs two different lines.");
  } else if (relative) {
    if (operation.secondEntityId === undefined) return invalid(`A ${name} distance needs a second entity.`);
    if (lookup(operation.secondEntityId) === undefined) return failure("BROKEN_REFERENCE", "The second sketch entity does not exist.", [operation.secondEntityId], "Refresh the project and select an existing stable ID.");
    if (operation.secondEntityId === operation.entityId && (operation.points?.[0] === operation.points?.[1])) return invalid("A distance needs two different things to measure between.");
  } else if (operation.secondEntityId !== undefined) {
    return invalid(`${name} takes one entity.`);
  }
  if (!relative && operation.points !== undefined) return invalid(`${name} takes no point references.`);

  const kind = constraintKindOf(name);
  const entityKinds = entityIds.map((id) => entityKindOf(sketch, id));
  const fit = constraintFit(kind, entityKinds, relative ? operation.points : undefined, { driven, dimension: name });
  if (!fit.ok) return invalid(fit.reason);
  if (target !== "datum") {
    const sideMatches = kind !== "distance" || relative || (name === "length" && target.kind === "line") || ((name === "width" || name === "height") && target.kind === "rectangle");
    if (!sideMatches) return invalid(`${name} is not a supported dimension for a ${target.kind}.`);
  }

  const dimensionOf = (candidate: WorkbenchSketchConstraint): SketchDimensionName => dimensionNameOf(candidate, entityKinds[0] as SketchEntity["kind"] | undefined);
  const points = relative ? operation.points : undefined;
  const existing = sketch.constraints.find((constraint) => constraint.kind === kind
    && constraint.entityIds.length === entityIds.length
    && constraint.entityIds.every((id, index) => id === entityIds[index])
    && (kind === "distance" || kind === "radius" ? dimensionOf(constraint) === name : true)
    && (!relative || (constraint.points ?? []).join("|") === (points ?? []).join("|")));
  if (existing === undefined && sketch.constraints.length >= WORKBENCH_LIMITS.maxConstraints) {
    return failure("RESOURCE_LIMIT", "The sketch reached its constraint record limit.", [sketch.id], "Delete a constraint before adding another driving dimension.");
  }
  const suffix = relative ? `-${(points ?? []).join("-")}` : "";
  const dimensionId = existing?.id ?? `constraint:dimension-${name}-${entityIds.join("-").replaceAll(":", "-")}${suffix}`;
  const withDimension = (constraint: WorkbenchSketchConstraint): readonly WorkbenchSketchConstraint[] => existing === undefined
    ? [...sketch.constraints, constraint]
    : sketch.constraints.map((candidate) => candidate.id === existing.id ? constraint : candidate);
  const dimensionKey = kind === "distance" || kind === "radius" ? { dimension: name as NonNullable<WorkbenchSketchConstraint["dimension"]> } : {};
  const pointKey = points === undefined ? {} : { points: [...points] as readonly SketchPointRef[] };

  if (driven) {
    const reference: WorkbenchSketchConstraint = { id: dimensionId, kind, entityIds, ...dimensionKey, ...pointKey, driven: true };
    const measured = measureDimensionConstraint({ entities: sketch.entities }, reference);
    return {
      ok: true,
      value: {
        project: { ...project, sketch: { ...sketch, constraints: withDimension(reference) } },
        changedIds: [dimensionId],
        summary: `Made ${name} of ${operation.entityId} a reference dimension${measured === undefined ? "" : ` (${formatNumber(measured)}${unitLabel(name)})`}.`
      }
    };
  }

  const value = operation.valueMm;
  if (name === "angle") {
    if (!(value >= 0 && value < 360)) return failure("OUTSIDE_SUPPORTED_ENVELOPE", "An angle dimension must be at least 0° and under 360°.", [operation.entityId], "Enter an angle in degrees, counter-clockwise from the first line to the second.");
  } else {
    const limit = name === "arc-length" || name === "perimeter" || name === "diameter" ? MAX_LONG_ENVELOPE_MM : MAX_ENVELOPE_MM;
    const minimum = relative ? 0 : WORKBENCH_LIMITS.minGeometryMm;
    if (value < minimum || value > limit) {
      return failure("OUTSIDE_SUPPORTED_ENVELOPE", `The driving dimension is outside the ${relative ? "0" : "0.01"}–${limit.toLocaleString("en-US")} mm preview envelope.`, [operation.entityId], relative ? "Enter a bounded millimeter value of zero or more." : "Enter a positive bounded millimeter value.");
    }
  }
  const constraint: WorkbenchSketchConstraint = {
    id: dimensionId,
    kind,
    entityIds,
    ...dimensionKey,
    ...pointKey,
    ...(name === "angle" ? { valueDeg: value } : { valueMm: value }),
    ...(existing?.suppressed === true ? { suppressed: true as const } : {})
  };
  const constraints = withDimension(constraint);

  if (existing?.suppressed === true) {
    // A relaxed dimension keeps its value up to date but stays relaxed: nothing is enforced until it is restored.
    return {
      ok: true,
      value: {
        project: { ...project, sketch: { ...sketch, constraints } },
        changedIds: [dimensionId],
        summary: `Set ${name} of ${operation.entityId} to ${formatNumber(value)}${unitLabel(name)}. The dimension is relaxed, so the geometry did not change; restore it to enforce the value.`
      }
    };
  }

  const redriven = redriveDimension({ ...sketch, constraints }, constraint);
  if (!redriven.ok) return redriven.applied;
  const primary = target === "datum" ? undefined : target.id;
  return {
    ok: true,
    value: {
      project: { ...project, sketch: redriven.sketch },
      changedIds: [...(primary === undefined ? [] : [primary]), dimensionId, ...redriven.movedIds.filter((id) => id !== primary)],
      summary: `Set ${name} of ${operation.entityId} to ${formatNumber(value)}${unitLabel(name)}.${solveSummary(redriven.solved)}`
    }
  };
}

/**
 * The summary of a set-sketch-dimension request whose value came from an expression: the typed `valueMm` is only a placeholder there, so
 * the sentence names the evaluated value the sketch was driven to.
 */
export function restateDimensionSummary(summary: string, operation: SetDimension, evaluated: number): string {
  const typed = `${operation.dimension} of ${operation.entityId} to ${formatNumber(operation.valueMm)}${unitLabel(operation.dimension)}`;
  const actual = `${operation.dimension} of ${operation.entityId} to ${formatNumber(evaluated)}${unitLabel(operation.dimension)}`;
  if (typed === actual || !summary.includes(typed)) return summary;
  return summary.replace(typed, `${actual} (from ${operation.expression ?? "its expression"})`);
}
