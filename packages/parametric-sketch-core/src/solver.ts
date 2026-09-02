import { evaluateSketchExpression } from "./expression.js";
import type {
  CircleGeometry,
  DimensionMeasurement,
  GeometryReference,
  LineGeometry,
  ParametricSketchDocument,
  ParametricSketchSolver,
  SketchConstraint,
  SketchDiagnostic,
  SketchDimension,
  SketchDofState,
  SketchGeometry,
  SketchSolveRequest,
  SketchSolveResult,
  Vec2
} from "./types.js";
import { constraintReferences, dimensionReferences, validateParametricSketch } from "./validation.js";

const DEFAULT_TOLERANCE_MM = 1e-7;
const DEFAULT_MAX_PASSES = 8;

export const analyticSketchSolver: ParametricSketchSolver = {
  identity: { name: "ps3d-analytic-sketch", version: "0.1.0", deterministic: true },
  solve: solveAnalyticSketch
};

/**
 * Small exact-analytic backend for the common line/circle subset. This is an
 * orchestration-safe baseline, not a claim of general nonlinear convergence.
 * Every unsupported relation is returned explicitly instead of being guessed.
 */
export function solveAnalyticSketch(request: SketchSolveRequest): SketchSolveResult {
  const validation = validateParametricSketch(request.document);
  if (!validation.valid) return failedResult(request.document, validation.diagnostics);

  const tolerance = request.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  const maxPasses = Math.max(1, Math.min(request.maxPasses ?? DEFAULT_MAX_PASSES, 32));
  let document = cloneDocument(request.document);
  const diagnostics: SketchDiagnostic[] = [...validation.diagnostics];
  const appliedConstraints = new Set<string>();
  const appliedDimensions = new Set<string>();
  const fixed = collectFixedReferences(document.constraints, document.geometry);

  if (request.mode === "drag" && request.dragTarget !== undefined) {
    const drag = setReferencedPoint(document, request.dragTarget.reference, request.dragTarget.positionMm, fixed);
    document = drag.document;
    if (drag.diagnostic !== undefined) diagnostics.push(drag.diagnostic);
  }

  if (request.mode === "validate") {
    for (const constraint of [...document.constraints].filter((candidate) => !candidate.suppressed).sort(byId)) {
      const support = analyticConstraintSupport(document, constraint);
      if (support !== undefined) {
        addUniqueDiagnostic(diagnostics, support);
        continue;
      }
      const probe = applyConstraint(document, constraint, fixed, tolerance);
      if (probe.diagnostic !== undefined) addUniqueDiagnostic(diagnostics, probe.diagnostic);
      else if (probe.changed) {
        addUniqueDiagnostic(diagnostics, diagnostic(
          "CONSTRAINT_CONFLICT",
          "error",
          `Constraint '${constraint.id}' is not satisfied by the stored geometry.`,
          [constraint.id],
          "Regenerate the sketch or repair the constraint before treating this revision as valid."
        ));
      }
    }
  } else {
    const constraints = [...document.constraints].filter((constraint) => !constraint.suppressed).sort(byId);
    const dimensions = [...document.dimensions].filter((dimension) => !dimension.suppressed).sort(byId);
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let changed = false;
      for (const constraint of constraints) {
        const result = applyConstraint(document, constraint, fixed, tolerance);
        document = result.document;
        changed ||= result.changed;
        if (result.applied) appliedConstraints.add(constraint.id);
        if (result.diagnostic !== undefined) addUniqueDiagnostic(diagnostics, result.diagnostic);
      }
      for (const dimension of dimensions) {
        if (dimension.mode !== "driving") continue;
        const result = applyDrivingDimension(document, dimension, fixed, tolerance);
        document = result.document;
        changed ||= result.changed;
        if (result.applied) appliedDimensions.add(dimension.id);
        if (result.diagnostic !== undefined) addUniqueDiagnostic(diagnostics, result.diagnostic);
      }
      if (!changed) break;
      if (pass === maxPasses - 1) {
        addUniqueDiagnostic(diagnostics, {
          code: "SOLVER_DID_NOT_CONVERGE",
          severity: "error",
          message: `The analytic solver exceeded ${maxPasses} deterministic passes.`,
          relatedIds: [document.id],
          recovery: "Remove cyclic relations or delegate the sketch to a nonlinear solver backend.",
          unsupported: false
        });
      }
    }
  }

  const postValidation = validateParametricSketch(document);
  if (!postValidation.valid) {
    for (const candidate of postValidation.diagnostics) addUniqueDiagnostic(diagnostics, candidate);
    document = cloneDocument(request.document);
    appliedConstraints.clear();
    appliedDimensions.clear();
  }

  const measurements = measureDimensions(document, diagnostics);
  verifyDrivingDimensions(document, measurements, diagnostics, tolerance);
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error" && !diagnostic.unsupported);
  const hasUnsupported = diagnostics.some((diagnostic) => diagnostic.unsupported);
  const hasConflict = diagnostics.some((diagnostic) => diagnostic.code === "CONSTRAINT_CONFLICT" || diagnostic.code === "DIMENSION_CONFLICT" || diagnostic.code === "DRAG_CONFLICT");
  const hasNonConflictError = diagnostics.some((diagnostic) => diagnostic.severity === "error" && !diagnostic.unsupported && diagnostic.code !== "CONSTRAINT_CONFLICT" && diagnostic.code !== "DIMENSION_CONFLICT" && diagnostic.code !== "DRAG_CONFLICT");
  const dofConstraintIds = request.mode === "validate" ? supportedConstraintIds(document) : appliedConstraints;
  const dofDimensionIds = request.mode === "validate" ? supportedDrivingDimensionIds(document) : appliedDimensions;
  const dof = estimateDegreesOfFreedom(document, dofConstraintIds, dofDimensionIds, hasNonConflictError, hasConflict);
  const nextDocument: ParametricSketchDocument = {
    ...document,
    revision: request.mode === "validate" || request.mode === "drag" || documentsEqual(document, request.document)
      ? request.document.revision
      : request.document.revision + 1
  };
  return {
    status: hasError ? "failed" : hasUnsupported ? "partial" : "solved",
    document: nextDocument,
    diagnostics,
    dof,
    measurements,
    appliedConstraintIds: [...appliedConstraints].sort(),
    appliedDimensionIds: [...appliedDimensions].sort(),
    deterministicFingerprint: fingerprint(nextDocument)
  };
}

interface ApplyResult {
  readonly document: ParametricSketchDocument;
  readonly changed: boolean;
  readonly applied: boolean;
  readonly diagnostic?: SketchDiagnostic;
}

function applyConstraint(
  document: ParametricSketchDocument,
  constraint: SketchConstraint,
  fixed: ReadonlySet<string>,
  tolerance: number
): ApplyResult {
  if (constraint.kind === "fix") return { document, changed: false, applied: true };
  if (constraint.kind === "tangent" || constraint.kind === "symmetric") {
    return unsupported(document, "UNSUPPORTED_CONSTRAINT", `The analytic backend does not solve ${constraint.kind} constraints.`, [constraint.id], "Use a nonlinear solver backend; the constraint remains preserved in the document.");
  }
  if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
    const line = findLine(document, constraint.line.entityId);
    if (line === undefined) return invalidReference(document, constraint.id, "The orientation constraint requires a line.");
    const startFixed = isFixed(fixed, line.id, "start");
    const endFixed = isFixed(fixed, line.id, "end");
    const delta = constraint.kind === "horizontal" ? line.end[1] - line.start[1] : line.end[0] - line.start[0];
    if (Math.abs(delta) <= tolerance) return { document, changed: false, applied: true };
    if (startFixed && endFixed) return conflict(document, constraint.id, "Both line endpoints are fixed and violate the orientation constraint.");
    const next = constraint.kind === "horizontal"
      ? endFixed ? replaceLine(document, line.id, [line.start[0], line.end[1]], line.end) : replaceLine(document, line.id, line.start, [line.end[0], line.start[1]])
      : endFixed ? replaceLine(document, line.id, [line.end[0], line.start[1]], line.end) : replaceLine(document, line.id, line.start, [line.start[0], line.end[1]]);
    return { document: next, changed: true, applied: true };
  }
  if (constraint.kind === "coincident") {
    if (getReferencedPoint(document, constraint.first) === undefined || getReferencedPoint(document, constraint.second) === undefined) {
      return unsupported(
        document,
        "UNSUPPORTED_CONSTRAINT",
        "The analytic backend solves point-to-point coincidence only; point-on-curve coincidence needs nonlinear curve evaluation.",
        [constraint.id],
        "Use a nonlinear solver backend; the preserved coincidence constraint is not approximated."
      );
    }
    if (
      constraint.first.entityId === constraint.second.entityId
      && constraint.first.selector !== constraint.second.selector
      && distance(getReferencedPoint(document, constraint.first)!, getReferencedPoint(document, constraint.second)!) > tolerance
    ) {
      return conflict(document, constraint.id, "Coinciding two distinct defining points of one entity would collapse or corrupt that entity.");
    }
    return makePointsCoincident(document, constraint.first, constraint.second, fixed, tolerance, constraint.id);
  }
  if (constraint.kind === "concentric") {
    const first = centerReference(constraint.first);
    const second = centerReference(constraint.second);
    if (first === undefined || second === undefined) return invalidReference(document, constraint.id, "Concentric requires two circle or arc centers.");
    return makePointsCoincident(document, first, second, fixed, tolerance, constraint.id);
  }
  if (constraint.kind === "midpoint") {
    const line = findLine(document, constraint.line.entityId);
    if (line === undefined) return invalidReference(document, constraint.id, "Midpoint requires a point and a line.");
    return moveReference(document, constraint.point, midpoint(line.start, line.end), fixed, tolerance, constraint.id);
  }
  if (constraint.kind === "equal") return applyEqual(document, constraint, fixed, tolerance);
  if (constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "collinear") {
    return applyLineRelation(document, constraint, fixed, tolerance);
  }
  return unsupported(document, "UNSUPPORTED_CONSTRAINT", "This constraint kind is not implemented by the analytic backend.", [document.id], "Use a solver backend that declares support for this relation.");
}

function applyEqual(
  document: ParametricSketchDocument,
  constraint: Extract<SketchConstraint, { kind: "equal" }>,
  fixed: ReadonlySet<string>,
  tolerance: number
): ApplyResult {
  const first = findGeometry(document, constraint.first.entityId);
  const second = findGeometry(document, constraint.second.entityId);
  if (first?.kind === "line" && second?.kind === "line") {
    const firstLength = distance(first.start, first.end);
    const secondLength = distance(second.start, second.end);
    if (Math.abs(firstLength - secondLength) <= tolerance) return { document, changed: false, applied: true };
    if (lineFullyFixed(fixed, first) && lineFullyFixed(fixed, second)) return conflict(document, constraint.id, "Both unequal lines are fixed.");
    if (!lineFullyFixed(fixed, second)) return resizeLine(document, second, firstLength, fixed, constraint.id, tolerance);
    return resizeLine(document, first, secondLength, fixed, constraint.id, tolerance);
  }
  if (isRadialGeometry(first) && isRadialGeometry(second)) {
    if (Math.abs(first.radiusMm - second.radiusMm) <= tolerance) return { document, changed: false, applied: true };
    if (isFixed(fixed, first.id, "radius") && isFixed(fixed, second.id, "radius")) return conflict(document, constraint.id, "Both unequal circle radii are fixed.");
    const target = isFixed(fixed, second.id, "radius") ? second.radiusMm : first.radiusMm;
    const id = isFixed(fixed, second.id, "radius") ? first.id : second.id;
    return { document: replaceRadius(document, id, target), changed: true, applied: true };
  }
  return invalidReference(document, constraint.id, "Equal currently requires two lines or two circles of the same kind.");
}

function applyLineRelation(
  document: ParametricSketchDocument,
  constraint: Extract<SketchConstraint, { kind: "parallel" | "perpendicular" | "collinear" }>,
  fixed: ReadonlySet<string>,
  tolerance: number
): ApplyResult {
  const first = findLine(document, constraint.first.entityId);
  const second = findLine(document, constraint.second.entityId);
  if (first === undefined || second === undefined) return invalidReference(document, constraint.id, `${constraint.kind} requires two lines.`);
  if (lineFullyFixed(fixed, second)) {
    if (lineFullyFixed(fixed, first)) return conflict(document, constraint.id, `Both lines are fixed and violate ${constraint.kind}.`);
    return orientLineFromReference(document, first, second, constraint.kind, fixed, tolerance, constraint.id, true);
  }
  return orientLineFromReference(document, second, first, constraint.kind, fixed, tolerance, constraint.id, false);
}

function orientLineFromReference(
  document: ParametricSketchDocument,
  moving: LineGeometry,
  reference: LineGeometry,
  relation: "parallel" | "perpendicular" | "collinear",
  fixed: ReadonlySet<string>,
  tolerance: number,
  ownerId: string,
  reverse: boolean
): ApplyResult {
  const referenceDirection = normalized(subtract(reference.end, reference.start));
  if (referenceDirection === undefined) return invalidReference(document, ownerId, "The reference line is degenerate.");
  const direction: Vec2 = relation === "perpendicular" ? [-referenceDirection[1], referenceDirection[0]] : referenceDirection;
  const length = distance(moving.start, moving.end);
  let start = moving.start;
  let end: Vec2 = [start[0] + direction[0] * length, start[1] + direction[1] * length];
  if (relation === "collinear") {
    const projected = projectPointOnLine(start, reference.start, reference.end);
    start = projected;
    end = [start[0] + direction[0] * length, start[1] + direction[1] * length];
  }
  if (isFixed(fixed, moving.id, "end")) {
    end = moving.end;
    start = [end[0] - direction[0] * length, end[1] - direction[1] * length];
  }
  if (isFixed(fixed, moving.id, "start") && isFixed(fixed, moving.id, "end")) return conflict(document, ownerId, "The moving line is fully fixed.");
  const changed = distance(start, moving.start) > tolerance || distance(end, moving.end) > tolerance;
  return { document: changed ? replaceLine(document, moving.id, start, end) : document, changed, applied: true };
}

function applyDrivingDimension(
  document: ParametricSketchDocument,
  dimension: SketchDimension,
  fixed: ReadonlySet<string>,
  tolerance: number
): ApplyResult {
  const resolved = resolveDimensionTarget(document, dimension);
  if (resolved.diagnostic !== undefined) return { document, changed: false, applied: false, diagnostic: resolved.diagnostic };
  const target = resolved.value!;
  if (dimension.kind === "length") {
    const line = findLine(document, dimension.target.entityId);
    if (line === undefined) return invalidDimension(document, dimension.id, "Length requires a line.");
    if (target <= 0) return dimensionConflict(document, dimension.id, "A line length must be positive.");
    return resizeLine(document, line, target, fixed, dimension.id, tolerance);
  }
  if (dimension.kind === "radius" || dimension.kind === "diameter") {
    const geometry = findGeometry(document, dimension.target.entityId);
    if (geometry?.kind !== "circle" && geometry?.kind !== "arc") return invalidDimension(document, dimension.id, `${dimension.kind} requires a circle or arc.`);
    const radius = dimension.kind === "diameter" ? target / 2 : target;
    if (radius <= 0) return dimensionConflict(document, dimension.id, "A radius must be positive.");
    if (isFixed(fixed, geometry.id, "radius") && Math.abs(geometry.radiusMm - radius) > tolerance) return dimensionConflict(document, dimension.id, "The radius is fixed at another value.");
    const changed = Math.abs(geometry.radiusMm - radius) > tolerance;
    return { document: changed ? replaceRadius(document, geometry.id, radius) : document, changed, applied: true };
  }
  if (dimension.kind === "linear") {
    const first = getReferencedPoint(document, dimension.first);
    const second = getReferencedPoint(document, dimension.second);
    if (first === undefined || second === undefined) return invalidDimension(document, dimension.id, "Linear dimensions require two point references.");
    const magnitude = Math.abs(target);
    const firstFixed = isReferenceFixed(fixed, dimension.first);
    const secondFixed = isReferenceFixed(fixed, dimension.second);
    if (firstFixed && secondFixed) return dimensionConflict(document, dimension.id, "Both dimension references are fixed at another separation.");
    const horizontalSign = second[0] < first[0] ? -1 : 1;
    const verticalSign = second[1] < first[1] ? -1 : 1;
    const alignedDirection = normalized(subtract(second, first)) ?? [1, 0];
    if (!secondFixed) {
      const next: Vec2 = dimension.orientation === "horizontal"
        ? [first[0] + horizontalSign * magnitude, second[1]]
        : dimension.orientation === "vertical"
          ? [second[0], first[1] + verticalSign * magnitude]
          : [first[0] + alignedDirection[0] * magnitude, first[1] + alignedDirection[1] * magnitude];
      return moveReference(document, dimension.second, next, fixed, tolerance, dimension.id, "DIMENSION_CONFLICT");
    }
    const next: Vec2 = dimension.orientation === "horizontal"
      ? [second[0] - horizontalSign * magnitude, first[1]]
      : dimension.orientation === "vertical"
        ? [first[0], second[1] - verticalSign * magnitude]
        : [second[0] - alignedDirection[0] * magnitude, second[1] - alignedDirection[1] * magnitude];
    return moveReference(document, dimension.first, next, fixed, tolerance, dimension.id, "DIMENSION_CONFLICT");
  }
  if (dimension.kind === "coordinate-x" || dimension.kind === "coordinate-y") {
    const point = getReferencedPoint(document, dimension.target);
    if (point === undefined) return invalidDimension(document, dimension.id, "Coordinate dimensions require a point reference.");
    const next: Vec2 = dimension.kind === "coordinate-x" ? [target, point[1]] : [point[0], target];
    return moveReference(document, dimension.target, next, fixed, tolerance, dimension.id, "DIMENSION_CONFLICT");
  }
  if (dimension.kind === "angle") {
    const first = findLine(document, dimension.first.entityId);
    const second = findLine(document, dimension.second.entityId);
    if (first === undefined || second === undefined) return invalidDimension(document, dimension.id, "Angular dimensions require two lines.");
    if (lineFullyFixed(fixed, second)) return dimensionConflict(document, dimension.id, "The second line is fixed and cannot satisfy the angle.");
    const base = Math.atan2(first.end[1] - first.start[1], first.end[0] - first.start[0]);
    const length = distance(second.start, second.end);
    const direction: Vec2 = [Math.cos(base + normalizeAngle(target)), Math.sin(base + normalizeAngle(target))];
    const startReference: GeometryReference = { entityId: second.id, selector: "start" };
    const endReference: GeometryReference = { entityId: second.id, selector: "end" };
    if (isReferenceFixed(fixed, endReference)) {
      const nextStart: Vec2 = [second.end[0] - direction[0] * length, second.end[1] - direction[1] * length];
      return moveReference(document, startReference, nextStart, fixed, tolerance, dimension.id, "DIMENSION_CONFLICT");
    }
    const nextEnd: Vec2 = [second.start[0] + direction[0] * length, second.start[1] + direction[1] * length];
    return moveReference(document, endReference, nextEnd, fixed, tolerance, dimension.id, "DIMENSION_CONFLICT");
  }
  return unsupported(document, "UNSUPPORTED_DIMENSION", "This driving dimension is not implemented by the analytic backend.", [document.id], "Use a backend that declares support for this dimension.");
}

function makePointsCoincident(
  document: ParametricSketchDocument,
  firstReference: GeometryReference,
  secondReference: GeometryReference,
  fixed: ReadonlySet<string>,
  tolerance: number,
  ownerId: string
): ApplyResult {
  const first = getReferencedPoint(document, firstReference);
  const second = getReferencedPoint(document, secondReference);
  if (first === undefined || second === undefined) return invalidReference(document, ownerId, "Coincident requires two point-like references.");
  if (distance(first, second) <= tolerance) return { document, changed: false, applied: true };
  const firstFixed = isReferenceFixed(fixed, firstReference);
  const secondFixed = isReferenceFixed(fixed, secondReference);
  if (firstFixed && secondFixed) return conflict(document, ownerId, "Both separated points are fixed.");
  return secondFixed
    ? moveReference(document, firstReference, second, fixed, tolerance, ownerId)
    : moveReference(document, secondReference, first, fixed, tolerance, ownerId);
}

function moveReference(
  document: ParametricSketchDocument,
  reference: GeometryReference,
  target: Vec2,
  fixed: ReadonlySet<string>,
  tolerance: number,
  ownerId: string,
  conflictCode: "CONSTRAINT_CONFLICT" | "DIMENSION_CONFLICT" = "CONSTRAINT_CONFLICT"
): ApplyResult {
  const current = getReferencedPoint(document, reference);
  if (current === undefined) return invalidReference(document, ownerId, "The relation requires a writable point reference.");
  if (distance(current, target) <= tolerance) return { document, changed: false, applied: true };
  if (isReferenceFixed(fixed, reference)) {
    return {
      document,
      changed: false,
      applied: false,
      diagnostic: diagnostic(conflictCode, "error", "A fixed point cannot move to satisfy the relation.", [ownerId, reference.entityId], "Remove the fixed constraint or change the requested value.")
    };
  }
  const moved = setReferencedPoint(document, reference, target, fixed);
  return moved.diagnostic === undefined
    ? { document: moved.document, changed: true, applied: true }
    : { document, changed: false, applied: false, diagnostic: moved.diagnostic };
}

function resizeLine(
  document: ParametricSketchDocument,
  line: LineGeometry,
  targetLength: number,
  fixed: ReadonlySet<string>,
  ownerId: string,
  tolerance: number
): ApplyResult {
  const currentLength = distance(line.start, line.end);
  if (Math.abs(currentLength - targetLength) <= tolerance) return { document, changed: false, applied: true };
  const direction = normalized(subtract(line.end, line.start));
  if (direction === undefined) return invalidDimension(document, ownerId, "A degenerate line cannot be dimensioned.");
  const startFixed = isFixed(fixed, line.id, "start");
  const endFixed = isFixed(fixed, line.id, "end");
  if (startFixed && endFixed) return dimensionConflict(document, ownerId, "Both endpoints are fixed at another length.");
  if (endFixed) {
    const start: Vec2 = [line.end[0] - direction[0] * targetLength, line.end[1] - direction[1] * targetLength];
    return { document: replaceLine(document, line.id, start, line.end), changed: true, applied: true };
  }
  const end: Vec2 = [line.start[0] + direction[0] * targetLength, line.start[1] + direction[1] * targetLength];
  return { document: replaceLine(document, line.id, line.start, end), changed: true, applied: true };
}

function measureDimensions(document: ParametricSketchDocument, diagnostics: SketchDiagnostic[]): readonly DimensionMeasurement[] {
  const measurements: DimensionMeasurement[] = [];
  for (const dimension of [...document.dimensions].filter((candidate) => !candidate.suppressed).sort(byId)) {
    const measured = measureDimension(document, dimension);
    if (measured === undefined) {
      addUniqueDiagnostic(diagnostics, diagnostic("UNSUPPORTED_DIMENSION", "warning", `The analytic backend cannot measure ${dimension.kind} '${dimension.id}'.`, [dimension.id], "Delegate this dimension to a backend that supports its geometry.", true));
      continue;
    }
    measurements.push({ dimensionId: dimension.id, value: measured, unit: dimension.unit, mode: dimension.mode });
  }
  return measurements;
}

function measureDimension(document: ParametricSketchDocument, dimension: SketchDimension): number | undefined {
  if (dimension.kind === "length") {
    const line = findLine(document, dimension.target.entityId);
    return line === undefined ? undefined : distance(line.start, line.end);
  }
  if (dimension.kind === "radius" || dimension.kind === "diameter") {
    const geometry = findGeometry(document, dimension.target.entityId);
    if (geometry?.kind !== "circle" && geometry?.kind !== "arc") return undefined;
    return dimension.kind === "diameter" ? geometry.radiusMm * 2 : geometry.radiusMm;
  }
  if (dimension.kind === "linear") {
    const first = getReferencedPoint(document, dimension.first);
    const second = getReferencedPoint(document, dimension.second);
    if (first === undefined || second === undefined) return undefined;
    return dimension.orientation === "horizontal" ? Math.abs(second[0] - first[0]) : dimension.orientation === "vertical" ? Math.abs(second[1] - first[1]) : distance(first, second);
  }
  if (dimension.kind === "coordinate-x" || dimension.kind === "coordinate-y") {
    const point = getReferencedPoint(document, dimension.target);
    return point === undefined ? undefined : dimension.kind === "coordinate-x" ? point[0] : point[1];
  }
  const first = findLine(document, dimension.first.entityId);
  const second = findLine(document, dimension.second.entityId);
  if (first === undefined || second === undefined) return undefined;
  return normalizeAngle(Math.atan2(second.end[1] - second.start[1], second.end[0] - second.start[0]) - Math.atan2(first.end[1] - first.start[1], first.end[0] - first.start[0]));
}

function verifyDrivingDimensions(
  document: ParametricSketchDocument,
  measurements: readonly DimensionMeasurement[],
  diagnostics: SketchDiagnostic[],
  tolerance: number
): void {
  for (const dimension of document.dimensions) {
    if (dimension.suppressed || dimension.mode !== "driving") continue;
    const target = resolveDimensionTarget(document, dimension);
    if (target.diagnostic !== undefined) {
      addUniqueDiagnostic(diagnostics, target.diagnostic);
      continue;
    }
    const measurement = measurements.find((candidate) => candidate.dimensionId === dimension.id);
    const unitTolerance = dimension.unit === "rad" ? 1e-9 : tolerance;
    const expected = dimension.kind === "angle" ? normalizeAngle(target.value!) : target.value!;
    if (measurement !== undefined && Math.abs(measurement.value - expected) > unitTolerance) {
      addUniqueDiagnostic(diagnostics, diagnostic("DIMENSION_CONFLICT", "error", `Dimension '${dimension.id}' evaluates to ${measurement.value} ${dimension.unit}, not ${expected} ${dimension.unit}.`, [dimension.id], "Remove a conflicting constraint or change the driving value."));
    }
  }
}

function resolveDimensionTarget(document: ParametricSketchDocument, dimension: SketchDimension): { readonly value?: number; readonly diagnostic?: SketchDiagnostic } {
  if (dimension.value.expression === undefined) return { value: dimension.value.value };
  const result = evaluateSketchExpression(dimension.value.expression, document.parameters, dimension.id);
  return result.ok ? { value: result.value! } : { diagnostic: result.diagnostic! };
}

function estimateDegreesOfFreedom(
  document: ParametricSketchDocument,
  appliedConstraints: ReadonlySet<string>,
  appliedDimensions: ReadonlySet<string>,
  invalid: boolean,
  conflicted = false
): SketchDofState {
  const freedom = new Map(document.geometry.filter((geometry) => !geometry.suppressed).map((geometry) => [geometry.id, geometry.source?.associative === true ? 0 : baseFreedom(geometry)]));
  for (const constraint of document.constraints.filter((candidate) => appliedConstraints.has(candidate.id)).sort(byId)) {
    if (constraint.kind === "fix") {
      if (constraint.target.selector === "self" || constraint.target.selector === "curve") freedom.set(constraint.target.entityId, 0);
      else reduceFreedom(freedom, [constraint.target.entityId], constraint.target.selector === "radius" ? 1 : 2);
    }
    else reduceFreedom(freedom, constraintReferences(constraint).map((reference) => reference.entityId), constraintReduction(constraint));
  }
  for (const dimension of document.dimensions.filter((candidate) => candidate.mode === "driving" && appliedDimensions.has(candidate.id)).sort(byId)) {
    reduceFreedom(freedom, dimensionReferences(dimension).map((reference) => reference.entityId), 1);
  }
  const entries = [...freedom.entries()].sort(([left], [right]) => left.localeCompare(right));
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return {
    classification: invalid ? "invalid" : conflicted ? "over-constrained" : total === 0 ? "fully-constrained" : "under-constrained",
    total: Math.max(0, total),
    byEntity: Object.fromEntries(entries.map(([id, value]) => [id, Math.max(0, value)])),
    unconstrainedEntityIds: entries.filter(([, value]) => value > 0).map(([id]) => id),
    method: "analytic-rank-estimate-v1"
  };
}

function supportedConstraintIds(document: ParametricSketchDocument): ReadonlySet<string> {
  return new Set(
    document.constraints
      .filter((constraint) => !constraint.suppressed && analyticConstraintSupport(document, constraint) === undefined)
      .map((constraint) => constraint.id)
  );
}

function supportedDrivingDimensionIds(document: ParametricSketchDocument): ReadonlySet<string> {
  return new Set(
    document.dimensions
      .filter((dimension) => !dimension.suppressed && dimension.mode === "driving" && measureDimension(document, dimension) !== undefined)
      .map((dimension) => dimension.id)
  );
}

function analyticConstraintSupport(document: ParametricSketchDocument, constraint: SketchConstraint): SketchDiagnostic | undefined {
  if (constraint.kind === "tangent" || constraint.kind === "symmetric") {
    return diagnostic(
      "UNSUPPORTED_CONSTRAINT",
      "warning",
      `The analytic backend does not solve ${constraint.kind} constraints.`,
      [constraint.id],
      "Use a nonlinear solver backend; the constraint remains preserved in the document.",
      true
    );
  }
  if (constraint.kind === "coincident" && (getReferencedPoint(document, constraint.first) === undefined || getReferencedPoint(document, constraint.second) === undefined)) {
    return diagnostic(
      "UNSUPPORTED_CONSTRAINT",
      "warning",
      "The analytic backend solves point-to-point coincidence only; point-on-curve coincidence needs nonlinear curve evaluation.",
      [constraint.id],
      "Use a nonlinear solver backend; the preserved coincidence constraint is not approximated.",
      true
    );
  }
  return undefined;
}

function baseFreedom(geometry: SketchGeometry): number {
  if (geometry.kind === "point") return 2;
  if (geometry.kind === "line") return 4;
  if (geometry.kind === "circle") return 3;
  if (geometry.kind === "arc" || geometry.kind === "ellipse" || geometry.kind === "slot") return 5;
  if (geometry.kind === "polygon") return 4;
  return Math.max(0, geometry.controlPoints.length * 2);
}

function isRadialGeometry(geometry: SketchGeometry | undefined): geometry is Extract<SketchGeometry, { kind: "circle" | "arc" }> {
  return geometry?.kind === "circle" || geometry?.kind === "arc";
}

function constraintReduction(constraint: SketchConstraint): number {
  if (constraint.kind === "coincident" || constraint.kind === "concentric" || constraint.kind === "midpoint" || constraint.kind === "collinear") return 2;
  return 1;
}

function reduceFreedom(freedom: Map<string, number>, ids: readonly string[], amount: number): void {
  let remaining = amount;
  for (const id of [...new Set(ids)].sort()) {
    const current = freedom.get(id) ?? 0;
    const reduction = Math.min(current, remaining);
    freedom.set(id, current - reduction);
    remaining -= reduction;
    if (remaining === 0) break;
  }
}

function collectFixedReferences(constraints: readonly SketchConstraint[], geometry: readonly SketchGeometry[]): ReadonlySet<string> {
  const fixed = new Set<string>();
  for (const entity of geometry) {
    if (entity.source?.associative === true) fixed.add(`${entity.id}:self`);
  }
  for (const constraint of constraints) {
    if (!constraint.suppressed && constraint.kind === "fix") fixed.add(referenceKey(constraint.target));
  }
  return fixed;
}

function isReferenceFixed(fixed: ReadonlySet<string>, reference: GeometryReference): boolean {
  return isFixed(fixed, reference.entityId, reference.selector);
}

function isFixed(fixed: ReadonlySet<string>, entityId: string, selector: GeometryReference["selector"]): boolean {
  return fixed.has(`${entityId}:self`) || fixed.has(`${entityId}:${selector}`);
}

function lineFullyFixed(fixed: ReadonlySet<string>, line: LineGeometry): boolean {
  return isFixed(fixed, line.id, "self") || (isFixed(fixed, line.id, "start") && isFixed(fixed, line.id, "end"));
}

function referenceKey(reference: GeometryReference): string {
  return `${reference.entityId}:${reference.selector === "curve" ? "self" : reference.selector}`;
}

function centerReference(reference: GeometryReference): GeometryReference | undefined {
  return reference.selector === "self" || reference.selector === "curve" || reference.selector === "center"
    ? { entityId: reference.entityId, selector: "center" }
    : undefined;
}

export function getReferencedPoint(document: ParametricSketchDocument, reference: GeometryReference): Vec2 | undefined {
  const geometry = findGeometry(document, reference.entityId);
  if (geometry === undefined) return undefined;
  if (geometry.kind === "point" && (reference.selector === "point" || reference.selector === "self")) return geometry.point;
  if (geometry.kind === "line") {
    if (reference.selector === "start") return geometry.start;
    if (reference.selector === "end") return geometry.end;
    if (reference.selector === "midpoint") return midpoint(geometry.start, geometry.end);
  }
  if ((geometry.kind === "circle" || geometry.kind === "arc" || geometry.kind === "ellipse" || geometry.kind === "polygon") && reference.selector === "center") return geometry.center;
  if (geometry.kind === "slot") {
    if (reference.selector === "start") return geometry.startCenter;
    if (reference.selector === "end") return geometry.endCenter;
    if (reference.selector === "midpoint") return midpoint(geometry.startCenter, geometry.endCenter);
  }
  return undefined;
}

function setReferencedPoint(
  document: ParametricSketchDocument,
  reference: GeometryReference,
  point: Vec2,
  fixed: ReadonlySet<string>
): { readonly document: ParametricSketchDocument; readonly diagnostic?: SketchDiagnostic } {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    return { document, diagnostic: diagnostic("INVALID_NUMBER", "error", "A point target is non-finite.", [reference.entityId], "Provide finite sketch coordinates.") };
  }
  if (isReferenceFixed(fixed, reference)) {
    return { document, diagnostic: diagnostic("DRAG_CONFLICT", "error", "The selected point is fixed.", [reference.entityId], "Remove the fixed constraint before dragging.") };
  }
  const geometry = findGeometry(document, reference.entityId);
  if (geometry === undefined) return { document, diagnostic: diagnostic("MISSING_REFERENCE", "error", "The selected geometry no longer exists.", [reference.entityId], "Restart the drag after regenerating the sketch.") };
  let replacement: SketchGeometry | undefined;
  if (geometry.kind === "point" && (reference.selector === "self" || reference.selector === "point")) replacement = { ...geometry, point };
  else if (geometry.kind === "line" && reference.selector === "start") replacement = { ...geometry, start: point };
  else if (geometry.kind === "line" && reference.selector === "end") replacement = { ...geometry, end: point };
  else if (geometry.kind === "line" && reference.selector === "midpoint") {
    if (isFixed(fixed, geometry.id, "start") || isFixed(fixed, geometry.id, "end")) {
      return { document, diagnostic: diagnostic("DRAG_CONFLICT", "error", "A line midpoint cannot move while either endpoint is fixed.", [reference.entityId], "Release the fixed endpoint or move a free defining point.") };
    }
    const current = midpoint(geometry.start, geometry.end);
    const delta: Vec2 = [point[0] - current[0], point[1] - current[1]];
    replacement = {
      ...geometry,
      start: [geometry.start[0] + delta[0], geometry.start[1] + delta[1]],
      end: [geometry.end[0] + delta[0], geometry.end[1] + delta[1]]
    };
  }
  else if (geometry.kind === "circle" && reference.selector === "center") replacement = { ...geometry, center: point };
  else if (geometry.kind === "arc" && reference.selector === "center") replacement = { ...geometry, center: point };
  else if (geometry.kind === "ellipse" && reference.selector === "center") replacement = { ...geometry, center: point };
  else if (geometry.kind === "polygon" && reference.selector === "center") replacement = { ...geometry, center: point };
  else if (geometry.kind === "slot" && reference.selector === "start") replacement = { ...geometry, startCenter: point };
  else if (geometry.kind === "slot" && reference.selector === "end") replacement = { ...geometry, endCenter: point };
  else if (geometry.kind === "slot" && reference.selector === "midpoint") {
    if (isFixed(fixed, geometry.id, "start") || isFixed(fixed, geometry.id, "end")) {
      return { document, diagnostic: diagnostic("DRAG_CONFLICT", "error", "A slot midpoint cannot move while either center endpoint is fixed.", [reference.entityId], "Release the fixed endpoint or move a free defining point.") };
    }
    const current = midpoint(geometry.startCenter, geometry.endCenter);
    const delta: Vec2 = [point[0] - current[0], point[1] - current[1]];
    replacement = {
      ...geometry,
      startCenter: [geometry.startCenter[0] + delta[0], geometry.startCenter[1] + delta[1]],
      endCenter: [geometry.endCenter[0] + delta[0], geometry.endCenter[1] + delta[1]]
    };
  }
  if (replacement === undefined) {
    return { document, diagnostic: diagnostic("INVALID_REFERENCE", "error", "The selected reference is not a writable defining point.", [reference.entityId], "Select a point, endpoint, or center.") };
  }
  return { document: replaceGeometry(document, replacement) };
}

function findGeometry(document: ParametricSketchDocument, id: string): SketchGeometry | undefined {
  return document.geometry.find((geometry) => geometry.id === id);
}

function findLine(document: ParametricSketchDocument, id: string): LineGeometry | undefined {
  const geometry = findGeometry(document, id);
  return geometry?.kind === "line" ? geometry : undefined;
}

function replaceLine(document: ParametricSketchDocument, id: string, start: Vec2, end: Vec2): ParametricSketchDocument {
  const line = findLine(document, id);
  return line === undefined ? document : replaceGeometry(document, { ...line, start, end });
}

function replaceRadius(document: ParametricSketchDocument, id: string, radiusMm: number): ParametricSketchDocument {
  const geometry = findGeometry(document, id);
  if (geometry?.kind !== "circle" && geometry?.kind !== "arc") return document;
  return replaceGeometry(document, { ...geometry, radiusMm });
}

function replaceGeometry(document: ParametricSketchDocument, replacement: SketchGeometry): ParametricSketchDocument {
  return { ...document, geometry: document.geometry.map((geometry) => geometry.id === replacement.id ? replacement : geometry) };
}

function cloneDocument(document: ParametricSketchDocument): ParametricSketchDocument {
  return {
    ...document,
    plane: {
      ...document.plane,
      originMm: [...document.plane.originMm],
      xAxis: [...document.plane.xAxis],
      yAxis: [...document.plane.yAxis],
      normal: [...document.plane.normal]
    },
    parameters: { ...document.parameters },
    geometry: document.geometry.map(cloneGeometry),
    constraints: document.constraints.map((constraint) => ({ ...constraint })),
    dimensions: document.dimensions.map((dimension) => ({ ...dimension, value: { ...dimension.value } }))
  };
}

function cloneGeometry(geometry: SketchGeometry): SketchGeometry {
  if (geometry.kind === "point") return { ...geometry, point: [...geometry.point] };
  if (geometry.kind === "line") return { ...geometry, start: [...geometry.start], end: [...geometry.end] };
  if (geometry.kind === "circle" || geometry.kind === "arc" || geometry.kind === "ellipse" || geometry.kind === "polygon") {
    if (geometry.kind === "ellipse") return { ...geometry, center: [...geometry.center], majorAxis: [...geometry.majorAxis] };
    if (geometry.kind === "polygon") return { ...geometry, center: [...geometry.center], vertex: [...geometry.vertex] };
    return { ...geometry, center: [...geometry.center] };
  }
  if (geometry.kind === "spline") return { ...geometry, controlPoints: geometry.controlPoints.map((point) => [...point]), knots: [...geometry.knots] };
  return { ...geometry, startCenter: [...geometry.startCenter], endCenter: [...geometry.endCenter] };
}

function failedResult(document: ParametricSketchDocument, diagnostics: readonly SketchDiagnostic[]): SketchSolveResult {
  const dof = estimateDegreesOfFreedom(document, new Set(), new Set(), true);
  return {
    status: "failed",
    document,
    diagnostics,
    dof,
    measurements: [],
    appliedConstraintIds: [],
    appliedDimensionIds: [],
    deterministicFingerprint: fingerprint(document)
  };
}

function unsupported(
  document: ParametricSketchDocument,
  code: "UNSUPPORTED_CONSTRAINT" | "UNSUPPORTED_DIMENSION",
  message: string,
  relatedIds: readonly string[],
  recovery: string
): ApplyResult {
  return { document, changed: false, applied: false, diagnostic: diagnostic(code, "warning", message, relatedIds, recovery, true) };
}

function invalidReference(document: ParametricSketchDocument, ownerId: string, message: string): ApplyResult {
  return { document, changed: false, applied: false, diagnostic: diagnostic("INVALID_REFERENCE", "error", message, [ownerId], "Repair the relation's geometry references.") };
}

function invalidDimension(document: ParametricSketchDocument, ownerId: string, message: string): ApplyResult {
  return { document, changed: false, applied: false, diagnostic: diagnostic("INVALID_REFERENCE", "error", message, [ownerId], "Select compatible geometry for the dimension.") };
}

function conflict(document: ParametricSketchDocument, ownerId: string, message: string): ApplyResult {
  return { document, changed: false, applied: false, diagnostic: diagnostic("CONSTRAINT_CONFLICT", "error", message, [ownerId], "Suppress or remove one conflicting constraint.") };
}

function dimensionConflict(document: ParametricSketchDocument, ownerId: string, message: string): ApplyResult {
  return { document, changed: false, applied: false, diagnostic: diagnostic("DIMENSION_CONFLICT", "error", message, [ownerId], "Change the driving dimension or release fixed geometry.") };
}

function diagnostic(
  code: SketchDiagnostic["code"],
  severity: SketchDiagnostic["severity"],
  message: string,
  relatedIds: readonly string[],
  recovery: string,
  unsupported = false
): SketchDiagnostic {
  return { code, severity, message, relatedIds, recovery, unsupported };
}

function addUniqueDiagnostic(diagnostics: SketchDiagnostic[], candidate: SketchDiagnostic): void {
  const key = `${candidate.code}:${candidate.relatedIds.join("|")}:${candidate.message}`;
  if (!diagnostics.some((existing) => `${existing.code}:${existing.relatedIds.join("|")}:${existing.message}` === key)) diagnostics.push(candidate);
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function midpoint(first: Vec2, second: Vec2): Vec2 {
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
}

function subtract(first: Vec2, second: Vec2): Vec2 {
  return [first[0] - second[0], first[1] - second[1]];
}

function normalized(vector: Vec2): Vec2 | undefined {
  const length = Math.hypot(vector[0], vector[1]);
  return length <= 1e-12 ? undefined : [vector[0] / length, vector[1] / length];
}

function distance(first: Vec2, second: Vec2): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1]);
}

function projectPointOnLine(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const vector = subtract(end, start);
  const denominator = vector[0] ** 2 + vector[1] ** 2;
  if (denominator <= 1e-18) return start;
  const offset = subtract(point, start);
  const parameter = (offset[0] * vector[0] + offset[1] * vector[1]) / denominator;
  return [start[0] + parameter * vector[0], start[1] + parameter * vector[1]];
}

function normalizeAngle(angle: number): number {
  let normalizedAngle = angle;
  while (normalizedAngle <= -Math.PI) normalizedAngle += Math.PI * 2;
  while (normalizedAngle > Math.PI) normalizedAngle -= Math.PI * 2;
  return normalizedAngle;
}

function documentsEqual(left: ParametricSketchDocument, right: ParametricSketchDocument): boolean {
  return canonicalJson({ ...left, revision: 0 }) === canonicalJson({ ...right, revision: 0 });
}

function fingerprint(document: ParametricSketchDocument): string {
  const value = canonicalJson(document);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
