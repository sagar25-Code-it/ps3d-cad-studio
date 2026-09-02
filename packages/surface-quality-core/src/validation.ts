import type { TopologySelection, Vector3 } from "../../exact-kernel-api/src/index.js";
import type {
  SurfaceAnalysisBackendResult,
  SurfaceAnalysisRequest,
  SurfaceBoundaryCondition,
  SurfaceDiagnostic,
  SurfaceFeatureBackendResult,
  SurfaceFeatureRequest,
  SurfacePath,
  SurfaceTolerancePolicy
} from "./types.js";

export function validateSurfaceFeatureRequest(request: SurfaceFeatureRequest): readonly SurfaceDiagnostic[] {
  const diagnostics: SurfaceDiagnostic[] = [];
  validateCommon(request.featureId, request.revision, request.schemaVersion, request.tolerance, diagnostics);
  validateBoundaries(request.boundaryConditions, diagnostics);

  switch (request.operation) {
    case "surface.extrude":
      validateSelection(request.profile, ["edge", "wire", "face"], "profile", diagnostics);
      validateVector(request.direction, "direction", diagnostics);
      positiveMagnitude(request.distanceMeters, "distanceMeters", diagnostics);
      finite(request.draftAngleRadians, "draftAngleRadians", diagnostics);
      break;
    case "surface.revolve":
      validateSelection(request.profile, ["edge", "wire", "face"], "profile", diagnostics);
      validateVector(request.axis.direction, "axis.direction", diagnostics);
      validateVector(request.axis.xDirection, "axis.xDirection", diagnostics);
      finiteVector(request.axis.origin, "axis.origin", diagnostics);
      finite(request.startAngleRadians, "startAngleRadians", diagnostics);
      positiveMagnitude(request.sweepAngleRadians, "sweepAngleRadians", diagnostics);
      break;
    case "surface.sweep":
      validateSelection(request.profile, ["edge", "wire", "face"], "profile", diagnostics);
      validatePath(request.path, "path", diagnostics);
      validateRails(request.guideRails, diagnostics);
      if (request.centerline !== undefined) validatePath(request.centerline.path, "centerline.path", diagnostics);
      if (request.centerline !== undefined && request.guideRails.length > 0) {
        diagnostic(diagnostics, "AMBIGUOUS_SWEEP_GUIDANCE", "A sweep cannot specify both a centerline and guide rails in this contract.", [request.featureId], "Choose either centerline or guide-rail guidance.");
      }
      positive(request.scale, "scale", diagnostics);
      finite(request.twistAngleRadians, "twistAngleRadians", diagnostics);
      break;
    case "surface.loft": {
      if (request.sections.length < 2) {
        diagnostic(diagnostics, "LOFT_REQUIRES_SECTIONS", "A loft requires at least two ordered sections.", [request.featureId], "Add another exact profile section.");
      }
      let previous = -Infinity;
      for (const section of request.sections) {
        validateSelection(section.profile, ["edge", "wire", "face"], `section:${section.sectionId}`, diagnostics);
        finite(section.parameter, `section:${section.sectionId}.parameter`, diagnostics);
        if (section.parameter <= previous) {
          diagnostic(diagnostics, "LOFT_SECTION_ORDER", "Loft section parameters must be strictly increasing.", [section.sectionId], "Reorder sections or assign increasing parameters.");
        }
        previous = section.parameter;
      }
      validateRails(request.guideRails, diagnostics);
      if (request.centerline !== undefined) validatePath(request.centerline.path, "centerline.path", diagnostics);
      if (request.centerline !== undefined && request.guideRails.length > 0) {
        diagnostic(diagnostics, "AMBIGUOUS_LOFT_GUIDANCE", "A loft cannot specify both a centerline and guide rails in this contract.", [request.featureId], "Choose either centerline or guide-rail guidance.");
      }
      break;
    }
    case "surface.patch":
      validatePath(request.outerLoop, "outerLoop", diagnostics);
      if (!request.outerLoop.closed) {
        diagnostic(diagnostics, "PATCH_LOOP_OPEN", "The patch outer loop must be closed.", [request.outerLoop.pathId], "Provide a closed exact edge loop.");
      }
      for (const loop of request.innerLoops) {
        validatePath(loop, `innerLoop:${loop.pathId}`, diagnostics);
        if (!loop.closed) diagnostic(diagnostics, "PATCH_INNER_LOOP_OPEN", "Patch inner loops must be closed.", [loop.pathId], "Close or remove the inner loop.");
      }
      validateRails(request.internalRails, diagnostics);
      break;
    case "surface.offset":
      requireSelections(request.faces, ["face"], "faces", diagnostics);
      positiveMagnitude(request.distanceMeters, "distanceMeters", diagnostics);
      break;
    case "surface.trim":
      requireSelections(request.targetFaces, ["face"], "targetFaces", diagnostics);
      requireSelections(request.tools, ["edge", "wire", "face", "shell"], "tools", diagnostics);
      finiteVector(request.keepPoint, "keepPoint", diagnostics);
      break;
    case "surface.extend":
      requireSelections(request.boundaryEdges, ["edge", "wire"], "boundaryEdges", diagnostics);
      positive(request.distanceMeters, "distanceMeters", diagnostics);
      break;
    case "surface.stitch":
      if (request.inputs.length < 2) diagnostic(diagnostics, "STITCH_REQUIRES_INPUTS", "Stitch requires at least two exact input shapes.", [request.featureId], "Select two or more surface bodies.");
      for (const input of request.inputs) {
        if (input.shape.representation !== "exact-brep") diagnostic(diagnostics, "EXACT_SHAPE_REQUIRED", "Stitch accepts exact B-rep shapes only.", [input.shape.shapeId], "Resolve the input through the exact geometry backend.");
        if (input.transform !== undefined) finiteVectorArray(input.transform, "input.transform", diagnostics);
      }
      positive(request.sewToleranceMeters, "sewToleranceMeters", diagnostics);
      break;
    case "surface.thicken":
      requireSelections(request.faces, ["face"], "faces", diagnostics);
      finite(request.firstSideMeters, "firstSideMeters", diagnostics);
      finite(request.secondSideMeters, "secondSideMeters", diagnostics);
      if (request.firstSideMeters === 0 && request.secondSideMeters === 0) {
        diagnostic(diagnostics, "ZERO_THICKNESS", "At least one thicken side must be non-zero.", [request.featureId], "Specify a non-zero first- or second-side thickness.");
      }
      break;
  }

  return diagnostics;
}

export function validateSurfaceAnalysisRequest(request: SurfaceAnalysisRequest): readonly SurfaceDiagnostic[] {
  const diagnostics: SurfaceDiagnostic[] = [];
  if (request.schemaVersion !== 1) diagnostic(diagnostics, "SCHEMA_VERSION", "Unsupported surface-quality schema version.", [request.analysisId], "Use schema version 1.");
  if (request.analysisId.trim().length === 0) diagnostic(diagnostics, "ANALYSIS_ID_REQUIRED", "Analysis ID is required.", [], "Assign a stable analysis ID.");
  if (!Number.isSafeInteger(request.revision) || request.revision < 0) diagnostic(diagnostics, "REVISION_INVALID", "Revision must be a non-negative safe integer.", [request.analysisId], "Use the exact document revision.");
  requireSelections(request.faces, ["face"], "faces", diagnostics);
  positiveInteger(request.sampling.uSamples, "sampling.uSamples", diagnostics);
  positiveInteger(request.sampling.vSamples, "sampling.vSamples", diagnostics);
  positive(request.sampling.chordToleranceMeters, "sampling.chordToleranceMeters", diagnostics);
  positive(request.sampling.angularToleranceRadians, "sampling.angularToleranceRadians", diagnostics);

  switch (request.analysis) {
    case "surface-analysis.zebra":
      validateVector(request.stripeDirection, "stripeDirection", diagnostics);
      positiveInteger(request.stripeCount, "stripeCount", diagnostics);
      finite(request.phase, "phase", diagnostics);
      break;
    case "surface-analysis.reflection-lines":
      validateVector(request.viewDirection, "viewDirection", diagnostics);
      if (request.lightDirections.length === 0) diagnostic(diagnostics, "LIGHT_DIRECTION_REQUIRED", "Reflection-line analysis requires a light direction.", [request.analysisId], "Add at least one non-zero light direction.");
      request.lightDirections.forEach((direction, index) => validateVector(direction, `lightDirections[${index}]`, diagnostics));
      positive(request.lineToleranceMeters, "lineToleranceMeters", diagnostics);
      break;
    case "surface-analysis.curvature":
      if (request.clampRangePerSquareMeter !== undefined) {
        finiteVectorArray(request.clampRangePerSquareMeter, "clampRangePerSquareMeter", diagnostics);
        if (request.clampRangePerSquareMeter[0] >= request.clampRangePerSquareMeter[1]) {
          diagnostic(diagnostics, "CURVATURE_RANGE_INVALID", "Curvature clamp minimum must be smaller than maximum.", [request.analysisId], "Correct or remove the display clamp range.");
        }
      }
      break;
    case "surface-analysis.draft":
      validateVector(request.pullDirection, "pullDirection", diagnostics);
      positive(request.requiredDraftAngleRadians, "requiredDraftAngleRadians", diagnostics);
      if (request.neutralPlane !== undefined) {
        finiteVector(request.neutralPlane.origin, "neutralPlane.origin", diagnostics);
        validateVector(request.neutralPlane.normal, "neutralPlane.normal", diagnostics);
        validateVector(request.neutralPlane.xDirection, "neutralPlane.xDirection", diagnostics);
      }
      break;
    case "surface-analysis.curvature-comb":
      requireSelections(request.curves, ["edge", "wire"], "curves", diagnostics);
      positive(request.combScaleMetersSquared, "combScaleMetersSquared", diagnostics);
      positiveInteger(request.samplesPerCurve, "samplesPerCurve", diagnostics);
      break;
  }
  return diagnostics;
}

export function validateFeatureBackendResult(
  result: SurfaceFeatureBackendResult,
  request: SurfaceFeatureRequest,
  requestDigest: string
): readonly SurfaceDiagnostic[] {
  const diagnostics: SurfaceDiagnostic[] = [];
  if (result.requestDigest !== requestDigest) diagnostic(diagnostics, "STALE_BACKEND_RESULT", "Backend result does not match the canonical request digest.", [request.featureId], "Discard the result and recompute the current request.");
  if (result.operation !== request.operation) diagnostic(diagnostics, "BACKEND_KIND_MISMATCH", "Backend returned a different surface operation kind.", [request.featureId], "Correct the backend operation dispatch.");
  if (result.evaluatedFromExactGeometry !== true) diagnostic(diagnostics, "EXACT_PROVENANCE_REQUIRED", "Backend did not assert exact-geometry provenance.", [request.featureId], "Use a qualified exact surface backend.");
  for (const output of result.outputs) {
    if (output.representation !== "exact-brep") diagnostic(diagnostics, "EXACT_OUTPUT_REQUIRED", "Surface feature output is not exact B-rep geometry.", [output.shapeId], "Reject mesh-only output and run an exact backend.");
  }
  const nonFinite = findNonFinitePath(result);
  if (nonFinite !== undefined) diagnostic(diagnostics, "NON_FINITE_BACKEND_RESULT", `Backend result contains a non-finite number at '${nonFinite}'.`, [request.featureId], "Fix the backend evaluator and recompute.");
  return diagnostics;
}

export function validateAnalysisBackendResult(
  result: SurfaceAnalysisBackendResult,
  request: SurfaceAnalysisRequest,
  requestDigest: string
): readonly SurfaceDiagnostic[] {
  const diagnostics: SurfaceDiagnostic[] = [];
  if (result.requestDigest !== requestDigest) diagnostic(diagnostics, "STALE_BACKEND_RESULT", "Backend analysis does not match the canonical request digest.", [request.analysisId], "Discard the result and recompute the current request.");
  if (result.analysis !== request.analysis || result.payload.analysis !== request.analysis) diagnostic(diagnostics, "BACKEND_KIND_MISMATCH", "Backend returned a different analysis kind.", [request.analysisId], "Correct the backend analysis dispatch.");
  if (result.evaluatedFromExactGeometry !== true) diagnostic(diagnostics, "EXACT_PROVENANCE_REQUIRED", "Backend did not assert exact-surface provenance.", [request.analysisId], "Use a qualified exact surface backend.");
  const nonFinite = findNonFinitePath(result);
  if (nonFinite !== undefined) diagnostic(diagnostics, "NON_FINITE_BACKEND_RESULT", `Backend analysis contains a non-finite number at '${nonFinite}'.`, [request.analysisId], "Fix the backend evaluator and recompute.");
  return diagnostics;
}

export function hasErrors(diagnostics: readonly SurfaceDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

function validateCommon(id: string, revision: number, schemaVersion: number, tolerance: SurfaceTolerancePolicy, diagnostics: SurfaceDiagnostic[]): void {
  if (schemaVersion !== 1) diagnostic(diagnostics, "SCHEMA_VERSION", "Unsupported surface-quality schema version.", [id], "Use schema version 1.");
  if (id.trim().length === 0) diagnostic(diagnostics, "FEATURE_ID_REQUIRED", "Feature ID is required.", [], "Assign a stable feature ID.");
  if (!Number.isSafeInteger(revision) || revision < 0) diagnostic(diagnostics, "REVISION_INVALID", "Revision must be a non-negative safe integer.", [id], "Use the exact document revision.");
  validateTolerance(tolerance, "tolerance", diagnostics);
}

function validateBoundaries(boundaries: readonly SurfaceBoundaryCondition[], diagnostics: SurfaceDiagnostic[]): void {
  const ids = new Set<string>();
  for (const boundary of boundaries) {
    if (ids.has(boundary.boundaryId)) diagnostic(diagnostics, "BOUNDARY_ID_DUPLICATE", "Boundary-condition IDs must be unique.", [boundary.boundaryId], "Assign a unique stable boundary ID.");
    ids.add(boundary.boundaryId);
    validateSelection(boundary.boundary, ["edge", "wire"], `boundary:${boundary.boundaryId}`, diagnostics);
    validateTolerance(boundary.tolerance, `boundary:${boundary.boundaryId}.tolerance`, diagnostics);
    if (!Number.isFinite(boundary.influence) || boundary.influence < 0 || boundary.influence > 1) diagnostic(diagnostics, "BOUNDARY_INFLUENCE_INVALID", "Boundary influence must be in the inclusive range 0..1.", [boundary.boundaryId], "Set an influence between 0 and 1.");
    if (boundary.goal !== "G0" && boundary.referenceSurface === undefined) {
      diagnostic(diagnostics, "CONTINUITY_REFERENCE_REQUIRED", `${boundary.goal} continuity requires an exact reference surface.`, [boundary.boundaryId], "Select the adjacent reference face.");
    }
    if (boundary.referenceSurface !== undefined) validateSelection(boundary.referenceSurface, ["face"], `boundary:${boundary.boundaryId}.referenceSurface`, diagnostics);
    if (boundary.goal === "G1" && boundary.tolerance.angularRadians <= 0) diagnostic(diagnostics, "G1_ANGLE_TOLERANCE", "G1 continuity requires a positive angular tolerance.", [boundary.boundaryId], "Specify a positive angular tolerance.");
    if (boundary.goal === "G2" && boundary.tolerance.curvaturePerMeter <= 0) diagnostic(diagnostics, "G2_CURVATURE_TOLERANCE", "G2 continuity requires a positive curvature tolerance.", [boundary.boundaryId], "Specify a positive curvature tolerance.");
  }
}

function validateTolerance(tolerance: SurfaceTolerancePolicy, label: string, diagnostics: SurfaceDiagnostic[]): void {
  positive(tolerance.positionalMeters, `${label}.positionalMeters`, diagnostics);
  positive(tolerance.angularRadians, `${label}.angularRadians`, diagnostics);
  positive(tolerance.curvaturePerMeter, `${label}.curvaturePerMeter`, diagnostics);
  positive(tolerance.parameterTolerance, `${label}.parameterTolerance`, diagnostics);
}

function validateRails(rails: readonly { readonly railId: string; readonly path: SurfacePath; readonly sectionParameters: readonly number[] }[], diagnostics: SurfaceDiagnostic[]): void {
  const ids = new Set<string>();
  for (const rail of rails) {
    if (ids.has(rail.railId)) diagnostic(diagnostics, "RAIL_ID_DUPLICATE", "Guide-rail IDs must be unique.", [rail.railId], "Assign a unique stable rail ID.");
    ids.add(rail.railId);
    validatePath(rail.path, `rail:${rail.railId}`, diagnostics);
    rail.sectionParameters.forEach((parameter, index) => finite(parameter, `rail:${rail.railId}.sectionParameters[${index}]`, diagnostics));
  }
}

function validatePath(path: SurfacePath, label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (path.pathId.trim().length === 0) diagnostic(diagnostics, "PATH_ID_REQUIRED", "Surface path ID is required.", [], "Assign a stable path ID.");
  requireSelections(path.segments, ["edge", "wire"], label, diagnostics);
}

function requireSelections(selections: readonly TopologySelection[], kinds: readonly string[], label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (selections.length === 0) diagnostic(diagnostics, "SELECTION_REQUIRED", `${label} requires at least one exact topology selection.`, [], "Select exact referenced topology.");
  selections.forEach((selection, index) => validateSelection(selection, kinds, `${label}[${index}]`, diagnostics));
}

function validateSelection(selection: TopologySelection, kinds: readonly string[], label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (selection.shape.representation !== "exact-brep") diagnostic(diagnostics, "EXACT_SELECTION_REQUIRED", `${label} must reference exact B-rep geometry.`, [selection.reference.semanticId], "Resolve the selection through the exact geometry backend.");
  if (!kinds.includes(selection.reference.expectedKind)) diagnostic(diagnostics, "TOPOLOGY_KIND_INVALID", `${label} expects ${kinds.join("/")} topology, received ${selection.reference.expectedKind}.`, [selection.reference.semanticId], "Select compatible exact topology.");
  if (selection.reference.key.trim().length === 0 || selection.reference.lineageDigest.trim().length === 0) diagnostic(diagnostics, "STABLE_REFERENCE_REQUIRED", `${label} must carry a stable topology key and lineage digest.`, [selection.reference.semanticId], "Resolve a stable topology reference before evaluation.");
}

function finite(value: number, label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (!Number.isFinite(value)) diagnostic(diagnostics, "NUMBER_INVALID", `${label} must be finite.`, [], "Provide a finite numeric value.");
}

function positive(value: number, label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (!Number.isFinite(value) || value <= 0) diagnostic(diagnostics, "NUMBER_NOT_POSITIVE", `${label} must be finite and positive.`, [], "Provide a value greater than zero.");
}

function positiveMagnitude(value: number, label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (!Number.isFinite(value) || value === 0) diagnostic(diagnostics, "NUMBER_ZERO", `${label} must be finite and non-zero.`, [], "Provide a positive or negative non-zero value.");
}

function positiveInteger(value: number, label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (!Number.isSafeInteger(value) || value <= 0) diagnostic(diagnostics, "INTEGER_NOT_POSITIVE", `${label} must be a positive safe integer.`, [], "Provide a positive integer.");
}

function finiteVector(vector: readonly number[], label: string, diagnostics: SurfaceDiagnostic[]): void {
  if (vector.some((value) => !Number.isFinite(value))) diagnostic(diagnostics, "VECTOR_INVALID", `${label} must contain finite values.`, [], "Provide a finite vector.");
}

function finiteVectorArray(vector: readonly number[], label: string, diagnostics: SurfaceDiagnostic[]): void {
  finiteVector(vector, label, diagnostics);
}

function validateVector(vector: Vector3, label: string, diagnostics: SurfaceDiagnostic[]): void {
  finiteVector(vector, label, diagnostics);
  const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) diagnostic(diagnostics, "VECTOR_ZERO", `${label} must be non-zero.`, [], "Provide a non-zero direction vector.");
}

function findNonFinitePath(value: unknown, path = "$", seen = new Set<object>()): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? undefined : path;
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const found = findNonFinitePath(value[index], `${path}[${index}]`, seen);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const found = findNonFinitePath(child, `${path}.${key}`, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function diagnostic(
  diagnostics: SurfaceDiagnostic[],
  code: string,
  message: string,
  relatedIds: readonly string[],
  recovery: string
): void {
  diagnostics.push({ code, severity: "error", message, relatedIds, recovery });
}
