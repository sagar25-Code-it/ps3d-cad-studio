import { constraintFit } from "./constraint-fit.js";
import { arcShape, measureDimensionConstraint } from "./sketch-measure.js";
import { solveLiveSketch, type LiveSketchSolveReport } from "./sketch-solve.js";
import type { SketchDimensionName, SketchEntity, WorkbenchOperation, WorkbenchProject, WorkbenchResult, WorkbenchSketchConstraint } from "./types.js";
import { failure, WORKBENCH_LIMITS } from "./validation.js";

type SetDimension = Extract<WorkbenchOperation, { readonly kind: "set-sketch-dimension" }>;
type Applied = WorkbenchResult<{ readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string }>;

const MAX_ENVELOPE_MM = 10_000;
const MAX_LONG_ENVELOPE_MM = 20_000;

function constraintKindOf(name: SketchDimensionName): WorkbenchSketchConstraint["kind"] {
  return name === "radius" ? "radius" : name === "angle" ? "angle" : name === "arc-length" ? "arc-length" : name === "perimeter" ? "perimeter" : "distance";
}

function unitLabel(name: SketchDimensionName): string {
  return name === "angle" ? "°" : " mm";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function solveFailure(report: Extract<LiveSketchSolveReport, { readonly ok: false }>): Applied {
  return failure("CONSTRAINT_CONFLICT", report.message, report.relatedIds, report.recovery);
}

function solveSummary(report: Extract<LiveSketchSolveReport, { readonly ok: true }>): string {
  const parts: string[] = [];
  if (report.notes.length > 0) parts.push(report.notes.join("; "));
  if (report.unsolved.length > 0) parts.push(`Recorded, not solved: ${report.unsolved.map((entry) => entry.reason).join(" ")}`);
  return parts.length === 0 ? "" : ` ${parts.join(". ")}.`;
}

/** Old-style direct resize for the dimensions that always had one (a line's length, a circle's radius, a rectangle's sides). */
function resizeDirect(entity: SketchEntity, dimension: SketchDimensionName, valueMm: number): SketchEntity | undefined {
  if (entity.kind === "line" && dimension === "length") {
    const dx = entity.end[0] - entity.start[0];
    const dy = entity.end[1] - entity.start[1];
    const current = Math.hypot(dx, dy);
    return { ...entity, end: [entity.start[0] + (dx / current) * valueMm, entity.start[1] + (dy / current) * valueMm] as const };
  }
  if (entity.kind === "circle" && dimension === "radius") return { ...entity, radiusMm: valueMm };
  if (entity.kind === "circle" && dimension === "perimeter") return { ...entity, radiusMm: valueMm / (2 * Math.PI) };
  if (entity.kind === "arc" && dimension === "radius") {
    const shape = arcShape(entity.start, entity.mid, entity.end);
    if (shape === undefined) return undefined;
    const scale = valueMm / shape.radiusMm;
    const about = (point: readonly [number, number]): readonly [number, number] => [shape.center[0] + (point[0] - shape.center[0]) * scale, shape.center[1] + (point[1] - shape.center[1]) * scale];
    return { ...entity, start: about(entity.start), mid: about(entity.mid), end: about(entity.end) };
  }
  if (entity.kind === "rectangle" && dimension === "width") return { ...entity, widthMm: valueMm };
  if (entity.kind === "rectangle" && dimension === "height") return { ...entity, heightMm: valueMm };
  return undefined;
}

/**
 * Sets, or makes a reference of, one dimension of the working sketch: a length, radius, width or height, and now an angle between
 * two lines, an arc length and a perimeter. A driving dimension moves the geometry to the value and is held by the solver from
 * then on; a driven (reference) dimension only records what to measure and never moves anything.
 */
export function setSketchDimension(project: WorkbenchProject, operation: SetDimension): Applied {
  const sketch = project.sketch;
  const name = operation.dimension;
  const target = sketch.entities.find((entity) => entity.id === operation.entityId);
  if (target === undefined) return failure("BROKEN_REFERENCE", "The sketch entity does not exist.", [operation.entityId], "Refresh the project and select an existing stable ID.");
  const invalid = (message: string): Applied => failure("INVALID_OPERATION", message, [], "Use an exact bounded operation schema from the capability list.");
  const driven = operation.driven === true;

  const entityIds = name === "angle" ? [operation.entityId, operation.secondEntityId ?? ""] : [operation.entityId];
  if (name === "angle") {
    if (operation.secondEntityId === undefined) return invalid("An angle dimension needs a second line.");
    if (!sketch.entities.some((entity) => entity.id === operation.secondEntityId)) return failure("BROKEN_REFERENCE", "The second sketch entity does not exist.", [operation.secondEntityId], "Refresh the project and select an existing stable ID.");
    if (operation.secondEntityId === operation.entityId) return invalid("An angle needs two different lines.");
  } else if (operation.secondEntityId !== undefined) {
    return invalid(`${name} takes one entity.`);
  }

  const kind = constraintKindOf(name);
  const entityKinds = entityIds.map((id) => sketch.entities.find((entity) => entity.id === id)?.kind);
  const fit = constraintFit(kind, entityKinds, undefined, { driven });
  if (!fit.ok) return invalid(fit.reason);
  const sideMatches = kind !== "distance"
    || (name === "length" && target.kind === "line")
    || ((name === "width" || name === "height") && target.kind === "rectangle");
  if (!sideMatches) return invalid(`${name} is not a supported dimension for a ${target.kind}.`);

  const existing = sketch.constraints.find((constraint) => constraint.kind === kind
    && constraint.entityIds.length === entityIds.length
    && constraint.entityIds.every((id, index) => id === entityIds[index])
    && (kind === "distance" ? constraint.dimension === name : true));
  if (existing === undefined && sketch.constraints.length >= WORKBENCH_LIMITS.maxConstraints) {
    return failure("RESOURCE_LIMIT", "The sketch reached its constraint record limit.", [sketch.id], "Delete a constraint before adding another driving dimension.");
  }
  const dimensionId = existing?.id ?? `constraint:dimension-${name}-${entityIds.join("-").replaceAll(":", "-")}`;
  const withDimension = (constraint: WorkbenchSketchConstraint): readonly WorkbenchSketchConstraint[] => existing === undefined
    ? [...sketch.constraints, constraint]
    : sketch.constraints.map((candidate) => candidate.id === existing.id ? constraint : candidate);
  const dimensionKey = kind === "distance" || kind === "radius" ? { dimension: name as "length" | "width" | "height" | "radius" } : {};

  if (driven) {
    const reference: WorkbenchSketchConstraint = { id: dimensionId, kind, entityIds, ...dimensionKey, driven: true };
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
    const limit = name === "arc-length" || name === "perimeter" ? MAX_LONG_ENVELOPE_MM : MAX_ENVELOPE_MM;
    if (value < WORKBENCH_LIMITS.minGeometryMm || value > limit) {
      return failure("OUTSIDE_SUPPORTED_ENVELOPE", `The driving dimension is outside the 0.01–${limit.toLocaleString("en-US")} mm preview envelope.`, [operation.entityId], "Enter a positive bounded millimeter value.");
    }
  }
  const constraint: WorkbenchSketchConstraint = {
    id: dimensionId,
    kind,
    entityIds,
    ...dimensionKey,
    ...(name === "angle" ? { valueDeg: value } : { valueMm: value })
  };
  const constraints = withDimension(constraint);

  // The dimensions that always had a direct resize keep it, then the relations touching the entity are re-enforced.
  const resized = resizeDirect(target, name, value);
  const baseSketch = { ...sketch, constraints, entities: resized === undefined ? sketch.entities : sketch.entities.map((entity) => entity.id === target.id ? resized : entity) };
  const solved = solveLiveSketch(baseSketch, entityIds);
  if (!solved.ok) return solveFailure(solved);
  const nextSketch = { ...baseSketch, entities: solved.entities };

  if (resized === undefined) {
    // Nothing was resized directly, so the solver has to have brought the geometry to the value; check rather than assume.
    const measured = measureDimensionConstraint(nextSketch, constraint);
    const gap = measured === undefined ? Infinity : name === "angle" ? Math.min(Math.abs(measured - value), 360 - Math.abs(measured - value)) : Math.abs(measured - value);
    if (!(gap <= 1e-6)) {
      return failure("CONSTRAINT_CONFLICT", `Other relations hold the geometry, so the ${name} cannot reach ${formatNumber(value)}${unitLabel(name)}${measured === undefined ? "" : ` (it stays at ${formatNumber(measured)}${unitLabel(name)})`}.`, entityIds, "Relax or remove a relation that fixes the same curves, then set the dimension again.");
    }
  }
  return {
    ok: true,
    value: {
      project: { ...project, sketch: nextSketch },
      changedIds: [target.id, dimensionId, ...solved.movedIds.filter((id) => id !== target.id)],
      summary: `Set ${name} of ${operation.entityId} to ${formatNumber(value)}${unitLabel(name)}.${solveSummary(solved)}`
    }
  };
}
