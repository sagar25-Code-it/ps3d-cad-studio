import { defaultAnchors, defaultPreserve } from "./default-anchors.js";
import {
  buildSolverModel,
  directPointVariables,
  entityVariableCount,
  getReferencedPoint,
  measureDimensionValue,
  pinPointEquation,
  resolveDimensionTarget,
  wrapPi,
  writeEntityValues,
  type Equation,
  type SolverModel
} from "./equation-model.js";
import { solveModel, type ResidualReport } from "./lm-solver.js";
import { analyzeRank, describeSets, joinNames } from "./rank-analysis.js";
import type {
  DimensionMeasurement,
  ParametricSketchDocument,
  ParametricSketchSolver,
  SketchDiagnostic,
  SketchDimension,
  SketchDofState,
  SketchGeometry,
  SketchRelationSet,
  SketchSolveRequest,
  SolveAnchor,
  SketchSolveResult
} from "./types.js";
import { validateParametricSketch } from "./validation.js";

export { getReferencedPoint };

const DEFAULT_TOLERANCE_MM = 1e-7;
const COLLAPSE_MM = 0.01;

export const analyticSketchSolver: ParametricSketchSolver = {
  identity: { name: "ps3d-simultaneous-sketch", version: "0.2.0", deterministic: true },
  solve: solveAnalyticSketch
};

/**
 * Simultaneous nonlinear solver for the sketch document. Every active constraint and driving dimension becomes residual
 * equations over all the unknowns at once (see equation-model.ts); a damped Gauss-Newton iteration finds the nearest geometry
 * for which they all hold, so closed loops, interacting relations and long chains solve in one go and the result does not
 * depend on the order the relations were added. Fixed geometry is never an unknown. The degrees of freedom are the rank
 * deficiency of the relations' Jacobian, and relations that overlap or contradict are reported by name.
 *
 * `validate` leaves the geometry alone and reports which relations the stored geometry violates; `regenerate` solves;
 * `drag` pins one point at the pointer and solves the rest around it.
 */
export function solveAnalyticSketch(request: SketchSolveRequest): SketchSolveResult {
  const validation = validateParametricSketch(request.document);
  if (!validation.valid) return failedResult(request.document, validation.diagnostics);

  const tolerance = request.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  const diagnostics: SketchDiagnostic[] = [...validation.diagnostics];
  const labelOf = makeLabeler(request.document, request.labels);
  const strong = request.mode === "validate" ? new Set<string>() : new Set(request.preserve ?? defaultPreserve(request.document));
  const weak = request.mode === "validate" || request.preserveWeak === undefined ? undefined : new Set(request.preserveWeak);
  const preserveOption: { readonly preserve?: ReadonlySet<string>; readonly preserveWeak?: ReadonlySet<string> } = { preserve: strong, ...(weak === undefined ? {} : { preserveWeak: weak }) };
  // Unless the caller says who stays put, the geometry a relation names first is the reference.
  const anchors = request.mode === "validate" ? [] : request.anchors ?? defaultAnchors(request.document);
  // The relations alone, with nothing preferred or pinned: what the degrees of freedom and the names of conflicts are read from.
  const relations = buildSolverModel(request.document, {});
  let model = buildSolverModel(request.document, { anchors, ...preserveOption });
  for (const candidate of model.diagnostics) addUniqueDiagnostic(diagnostics, candidate);

  let document = request.document;
  let failed = false;

  if (request.mode === "validate") {
    const seen = new Set<string>();
    const out = new Float64Array(8);
    for (const equation of model.equations) {
      if (equation.source !== "constraint" || seen.has(equation.id)) continue;
      equation.eval(model.x, out, 0);
      if (Array.from({ length: equation.size }, (_, row) => Math.abs(out[row]!)).some((value) => !(value <= tolerance))) {
        seen.add(equation.id);
        addUniqueDiagnostic(diagnostics, makeDiagnostic(
          "CONSTRAINT_CONFLICT",
          "error",
          `Constraint '${equation.id}' is not satisfied by the stored geometry.`,
          [equation.id],
          "Regenerate the sketch or repair the constraint before treating this revision as valid."
        ));
      }
    }
  } else {
    const pointer = request.mode === "drag" && request.dragTarget !== undefined ? preparePointer(model, request, diagnostics) : undefined;
    if (pointer?.blocked === true) {
      failed = true;
    } else {
      let outcome = solveModel(model, { tolerance }, pointer?.frozen);
      if (!outcome.ok && pointer === undefined && (anchors.length > 0 || strong.size > 0)) {
        // The sizes and places the hints wanted to keep cannot be kept (a Fix elsewhere, or a dimension on them): solve again with less required.
        const attempts: readonly (readonly SolveAnchor[])[] = [anchors, []];
        for (const attemptAnchors of attempts) {
          const retry = buildSolverModel(request.document, { anchors: attemptAnchors, ...(weak === undefined ? {} : { preserveWeak: weak }) });
          const second = solveModel(retry, { tolerance });
          if (second.ok) {
            model = retry;
            outcome = second;
            break;
          }
        }
      }
      if (!outcome.ok && pointer?.goal !== undefined) {
        // The pointer cannot be followed exactly (a dimension holds the line, say): take the nearest geometry the relations allow.
        if (pointer.hardPin !== undefined) model.equations.splice(model.equations.indexOf(pointer.hardPin), 1);
        model.x.set(model.x0);
        outcome = solveModel(model, { tolerance, goals: [{ equation: pointer.goal, factor: 0.3 }] });
      }
      if (!outcome.ok) {
        failed = true;
        relations.x.set(model.x);
        reportFailure(relations, outcome.failing.filter((report) => !report.equation.id.startsWith("shape:") && report.equation.id !== "drag:pointer"), labelOf, diagnostics, request.mode === "drag" ? "DRAG_CONFLICT" : undefined);
      } else {
        document = applySolution(model);
        const collapse = findCollapse(model, document, labelOf);
        if (collapse !== undefined) {
          failed = true;
          addUniqueDiagnostic(diagnostics, collapse);
          document = request.document;
        }
      }
    }
  }

  const postValidation = validateParametricSketch(document);
  if (!postValidation.valid) {
    for (const candidate of postValidation.diagnostics) addUniqueDiagnostic(diagnostics, candidate);
    document = request.document;
    failed = true;
  }

  const measurements = measureDimensions(document, diagnostics);
  if (!failed) verifyDrivingDimensions(document, relations, measurements, diagnostics, tolerance);
  const hasError = diagnostics.some((candidate) => candidate.severity === "error" && !candidate.unsupported);
  const hasUnsupported = diagnostics.some((candidate) => candidate.unsupported);
  // The analysis reads the geometry the answer will have: the solved numbers, or the stored ones when nothing was applied.
  if (document === request.document) relations.x.set(relations.x0);
  else relations.x.set(model.x);
  const rank = analyzeRank(relations, { invalid: hasError && !diagnostics.some(isConflict) });
  const sets: readonly SketchRelationSet[] = describeSets(rank.sets, labelOf);
  const dof: SketchDofState = {
    ...rank.dof,
    classification: hasError && !diagnostics.some(isConflict) ? "invalid" : rank.dof.classification === "over-constrained" || diagnostics.some(isConflict) ? "over-constrained" : rank.dof.classification,
    relationSets: sets
  };
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
    // Validation applies nothing; it only reports which relations the stored geometry violates.
    appliedConstraintIds: failed || request.mode === "validate" ? [] : [...relations.appliedConstraints].sort(),
    appliedDimensionIds: failed || request.mode === "validate" ? [] : [...relations.appliedDimensions].sort(),
    deterministicFingerprint: fingerprint(nextDocument)
  };
}

function isConflict(candidate: SketchDiagnostic): boolean {
  return candidate.code === "CONSTRAINT_CONFLICT" || candidate.code === "DIMENSION_CONFLICT" || candidate.code === "DRAG_CONFLICT";
}

/** Writes the solved numbers back into geometry, leaving every entity that did not change exactly as it was. */
function applySolution(model: SolverModel): ParametricSketchDocument {
  const geometry = model.document.geometry.map((original) => {
    const entry = model.layout.get(original.id)!;
    let changed = false;
    for (let index = 0; index < entry.count; index += 1) {
      if (model.x[entry.base + index] !== model.x0[entry.base + index]) {
        changed = true;
        break;
      }
    }
    return changed ? writeEntityValues(original, model.x, entry.base) : original;
  });
  return { ...model.document, geometry };
}

interface Pointer {
  readonly blocked: boolean;
  readonly frozen?: Uint8Array;
  /** The pointer as an equation: soft when the point is pinned directly, otherwise the hard pin that was added. */
  readonly goal?: Equation;
  readonly hardPin?: Equation;
}

/** Puts the dragged point where the pointer is and holds it there while the rest relaxes. */
function preparePointer(model: SolverModel, request: SketchSolveRequest, diagnostics: SketchDiagnostic[]): Pointer {
  const target = request.dragTarget!;
  const reference = target.reference;
  const entry = model.layout.get(reference.entityId);
  const position = target.positionMm;
  if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
    addUniqueDiagnostic(diagnostics, makeDiagnostic("INVALID_NUMBER", "error", "A point target is non-finite.", [reference.entityId], "Provide finite sketch coordinates."));
    return { blocked: true };
  }
  if (entry === undefined) {
    addUniqueDiagnostic(diagnostics, makeDiagnostic("MISSING_REFERENCE", "error", "The selected geometry no longer exists.", [reference.entityId], "Restart the drag after regenerating the sketch."));
    return { blocked: true };
  }
  const frozen = Uint8Array.from(model.frozen);
  const fixedMessage = "The selected point is fixed.";
  const fail = (message: string, recovery: string): Pointer => {
    addUniqueDiagnostic(diagnostics, makeDiagnostic("DRAG_CONFLICT", "error", message, [reference.entityId], recovery));
    return { blocked: true };
  };
  const b = entry.base;
  const g = entry.geometry;
  if ((g.kind === "line" || g.kind === "slot") && reference.selector === "midpoint") {
    if ([0, 1, 2, 3].some((index) => frozen[b + index] === 1)) return fail(`A ${g.kind} midpoint cannot move while either endpoint is fixed.`, "Release the fixed endpoint or move a free defining point.");
    const dx = position[0] - (model.x0[b]! + model.x0[b + 2]!) / 2;
    const dy = position[1] - (model.x0[b + 1]! + model.x0[b + 3]!) / 2;
    model.x[b] = model.x0[b]! + dx;
    model.x[b + 1] = model.x0[b + 1]! + dy;
    model.x[b + 2] = model.x0[b + 2]! + dx;
    model.x[b + 3] = model.x0[b + 3]! + dy;
    for (let index = 0; index < 4; index += 1) frozen[b + index] = 1;
    return { blocked: false, frozen };
  }
  const direct = directPointVariables(model, reference);
  if (direct !== undefined) {
    if (frozen[direct[0]] === 1 || frozen[direct[1]] === 1) return fail(fixedMessage, "Remove the fixed constraint before dragging.");
    model.x[direct[0]] = position[0];
    model.x[direct[1]] = position[1];
    frozen[direct[0]] = 1;
    frozen[direct[1]] = 1;
    const goal = pinPointEquation(model, "drag:pointer", reference, position);
    // If holding the point exactly is impossible the solve is retried with the point as a strong preference instead.
    return { blocked: false, frozen, ...(goal === undefined ? {} : { goal }) };
  }
  const pin = pinPointEquation(model, "drag:pointer", reference, position);
  if (pin === undefined) {
    addUniqueDiagnostic(diagnostics, makeDiagnostic("INVALID_REFERENCE", "error", "The selected reference is not a writable defining point.", [reference.entityId], "Select a point, endpoint, or center."));
    return { blocked: true };
  }
  if (pin.vars.every((variable) => frozen[variable] === 1)) return fail(fixedMessage, "Remove the fixed constraint before dragging.");
  // A derived point (an arc end, a rectangle corner) is held by a hard equation that is part of the solve.
  model.equations.push(pin);
  return { blocked: false, frozen, goal: pin, hardPin: pin };
}

// ---------------------------------------------------------------------------------------------------------------------
// Failure reports
// ---------------------------------------------------------------------------------------------------------------------

function reportFailure(
  model: SolverModel,
  failing: readonly ResidualReport[],
  labelOf: (id: string) => string,
  diagnostics: SketchDiagnostic[],
  forcedCode: SketchDiagnostic["code"] | undefined
): void {
  const analysis = analyzeRank(model);
  const conflicts = analysis.sets.filter((set) => set.kind === "conflicting");
  const failingIds = new Set(failing.map((report) => report.equation.id));
  // Prefer the dependency sets that contain a relation that is actually violated.
  const relevant = conflicts.filter((set) => set.ids.some((id) => failingIds.has(id)));
  const chosen = (relevant.length > 0 ? relevant : conflicts).slice(0, 3);
  if (chosen.length > 0) {
    for (const set of chosen) {
      const labels = set.ids.map(labelOf);
      addUniqueDiagnostic(diagnostics, makeDiagnostic(
        forcedCode ?? (set.ids.every((id) => model.document.dimensions.some((dimension) => dimension.id === id)) ? "DIMENSION_CONFLICT" : "CONSTRAINT_CONFLICT"),
        "error",
        `These relations contradict each other and cannot all hold: ${joinNames(labels)}.`,
        set.ids,
        "Remove or relax one of the listed relations, then try again."
      ));
    }
    return;
  }
  const ids = [...new Set(failing.map((report) => report.equation.id))].slice(0, 6);
  const labels = ids.map(labelOf);
  addUniqueDiagnostic(diagnostics, makeDiagnostic(
    forcedCode ?? "CONSTRAINT_CONFLICT",
    "error",
    ids.length === 0 ? "The sketch relations could not be solved together." : `These relations cannot all be satisfied together: ${joinNames(labels)}${failingIds.size > ids.length ? ` and ${failingIds.size - ids.length} more` : ""}.`,
    ids,
    "Remove or relax one of the listed relations, or change a dimension, then try again."
  ));
}

/** A solution that squashes a curve to nothing is not a solution; name the relations acting on it. */
function findCollapse(model: SolverModel, solved: ParametricSketchDocument, labelOf: (id: string) => string): SketchDiagnostic | undefined {
  for (const geometry of solved.geometry) {
    const before = model.layout.get(geometry.id)!.geometry;
    if (geometry === before || geometry.suppressed) continue;
    const reason = collapseReason(geometry);
    if (reason === undefined || collapseReason(before) !== undefined) continue;
    const acting = [...new Set(model.equations.filter((equation) => equation.entities.includes(geometry.id)).map((equation) => equation.id))].sort();
    const ids = [geometry.id, ...acting];
    return makeDiagnostic(
      "CONSTRAINT_CONFLICT",
      "error",
      `${labelOf(geometry.id)} would ${reason}. The relations acting on it contradict each other: ${joinNames(acting.slice(0, 6).map(labelOf))}${acting.length > 6 ? ` and ${acting.length - 6} more` : ""}.`,
      ids,
      "Remove or relax one of the listed relations."
    );
  }
  return undefined;
}

function collapseReason(geometry: SketchGeometry): string | undefined {
  switch (geometry.kind) {
    case "line": return Math.hypot(geometry.end[0] - geometry.start[0], geometry.end[1] - geometry.start[1]) <= COLLAPSE_MM ? "collapse to a point" : undefined;
    case "circle": return geometry.radiusMm <= COLLAPSE_MM ? "shrink to nothing" : undefined;
    case "arc": return geometry.radiusMm <= COLLAPSE_MM ? "shrink to nothing" : undefined;
    case "rectangle": return geometry.widthMm <= COLLAPSE_MM || geometry.heightMm <= COLLAPSE_MM ? "collapse to a line" : undefined;
    case "ellipse":
      if (geometry.minorToMajorRatio > 1 + 1e-9) return "get a minor radius larger than its major radius";
      return Math.hypot(geometry.majorAxis[0], geometry.majorAxis[1]) <= COLLAPSE_MM || geometry.minorToMajorRatio <= 1e-9 ? "collapse to a line" : undefined;
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------------------------------------

function measureDimensions(document: ParametricSketchDocument, diagnostics: SketchDiagnostic[]): readonly DimensionMeasurement[] {
  const measurements: DimensionMeasurement[] = [];
  for (const dimension of [...document.dimensions].filter((candidate) => !candidate.suppressed).sort(byId)) {
    const measured = measureDimensionValue(document, dimension);
    if (measured === undefined) {
      addUniqueDiagnostic(diagnostics, makeDiagnostic("UNSUPPORTED_DIMENSION", "warning", `The solver cannot measure ${dimension.kind} '${dimension.id}'.`, [dimension.id], "Delegate this dimension to a backend that supports its geometry.", true));
      continue;
    }
    measurements.push({ dimensionId: dimension.id, value: measured, unit: dimension.unit, mode: dimension.mode });
  }
  return measurements;
}

function verifyDrivingDimensions(
  document: ParametricSketchDocument,
  model: SolverModel,
  measurements: readonly DimensionMeasurement[],
  diagnostics: SketchDiagnostic[],
  tolerance: number
): void {
  for (const dimension of document.dimensions) {
    if (dimension.suppressed || dimension.mode !== "driving" || !model.appliedDimensions.has(dimension.id)) continue;
    const measurement = measurements.find((candidate) => candidate.dimensionId === dimension.id);
    const target = resolveDimensionTarget(document, dimension);
    if (measurement === undefined || target === undefined) continue;
    const expected = dimension.kind === "linear" || dimension.kind === "point-line-distance" || dimension.kind === "line-line-distance" ? Math.abs(target) : dimension.kind === "diameter" ? target : target;
    const unitTolerance = dimension.unit === "rad" ? 1e-9 : tolerance;
    const gap = dimension.kind === "angle" ? Math.abs(wrapPi(measurement.value - expected)) : Math.abs(measurement.value - expected);
    if (gap > unitTolerance) {
      addUniqueDiagnostic(diagnostics, makeDiagnostic("DIMENSION_CONFLICT", "error", `Dimension '${dimension.id}' evaluates to ${measurement.value} ${dimension.unit}, not ${expected} ${dimension.unit}.`, [dimension.id], "Remove a conflicting constraint or change the driving value."));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------

function makeLabeler(document: ParametricSketchDocument, labels: Readonly<Record<string, string>> | undefined): (id: string) => string {
  return (id: string): string => {
    const given = labels?.[id];
    if (given !== undefined) return given;
    const constraint = document.constraints.find((candidate) => candidate.id === id);
    if (constraint !== undefined) return `${constraint.kind} constraint '${id}'`;
    const dimension = document.dimensions.find((candidate) => candidate.id === id);
    if (dimension !== undefined) return `${dimension.kind} dimension '${id}'`;
    return id;
  };
}

function failedResult(document: ParametricSketchDocument, diagnostics: readonly SketchDiagnostic[]): SketchSolveResult {
  const dof: SketchDofState = {
    classification: "invalid",
    total: 0,
    byEntity: Object.fromEntries(document.geometry.filter((geometry) => !geometry.suppressed).map((geometry) => [geometry.id, entityVariableCount(geometry)])),
    unconstrainedEntityIds: [],
    method: "jacobian-rank-v2"
  };
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

function makeDiagnostic(
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

