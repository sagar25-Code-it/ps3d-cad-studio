import { evaluateSketchExpression } from "./expression.js";
import type {
  GeometryReference,
  ParametricSketchDocument,
  SketchConstraint,
  SketchDiagnostic,
  SketchDimension,
  SketchGeometry
} from "./types.js";

export interface SketchValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly SketchDiagnostic[];
}

export function validateParametricSketch(document: ParametricSketchDocument): SketchValidationResult {
  const diagnostics: SketchDiagnostic[] = [];
  if (document.schemaVersion !== "1.0") diagnostics.push(error("INVALID_REFERENCE", `Unsupported sketch schema version '${String(document.schemaVersion)}'.`, [document.id], "Migrate the sketch document to schema version 1.0."));
  if (document.id.trim().length === 0) diagnostics.push(error("INVALID_REFERENCE", "The sketch document ID is empty.", [document.id], "Assign a stable non-empty sketch ID."));
  if (!Number.isInteger(document.revision) || document.revision < 0) diagnostics.push(error("INVALID_NUMBER", "The sketch revision is not a non-negative integer.", [document.id], "Use a monotonic non-negative integer revision."));
  validatePlane(document, diagnostics);
  const ids = new Set<string>();
  for (const record of [...document.geometry, ...document.constraints, ...document.dimensions]) {
    if (record.id.trim().length === 0) diagnostics.push(error("INVALID_REFERENCE", "A sketch record has an empty stable ID.", [document.id], "Assign a stable non-empty ID before persistence."));
    if (ids.has(record.id)) diagnostics.push(error("DUPLICATE_ID", `ID '${record.id}' is not unique.`, [record.id], "Generate a stable unique ID for every sketch record."));
    ids.add(record.id);
  }

  const geometryById = new Map(document.geometry.map((geometry) => [geometry.id, geometry]));
  for (const geometry of document.geometry) validateGeometry(geometry, diagnostics);
  for (const constraint of document.constraints) {
    for (const reference of constraintReferences(constraint)) validateReference(reference, geometryById, diagnostics, constraint.id);
    validateConstraintCompatibility(constraint, geometryById, diagnostics);
  }
  for (const dimension of document.dimensions) {
    for (const reference of dimensionReferences(dimension)) validateReference(reference, geometryById, diagnostics, dimension.id);
    validateDimensionCompatibility(dimension, geometryById, diagnostics);
    if (!Number.isFinite(dimension.value.value)) {
      diagnostics.push(error("INVALID_NUMBER", "The dimension literal is not finite.", [dimension.id], "Enter a finite dimension value."));
    }
    if (dimension.value.expression !== undefined) {
      const result = evaluateSketchExpression(dimension.value.expression, document.parameters, dimension.id);
      if (!result.ok && result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
    }
  }
  for (const [name, value] of Object.entries(document.parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !Number.isFinite(value)) {
      diagnostics.push(error("INVALID_NUMBER", `Parameter '${name}' has an invalid name or value.`, [document.id], "Use an identifier name and a finite scalar value."));
    }
  }
  return { valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"), diagnostics };
}

function validatePlane(document: ParametricSketchDocument, diagnostics: SketchDiagnostic[]): void {
  const plane = document.plane;
  const kinds: readonly string[] = ["principal", "datum", "planar-face"];
  if (!kinds.includes(plane.kind) || plane.referenceId.trim().length === 0) {
    diagnostics.push(error(
      "INVALID_REFERENCE",
      "The sketch plane kind or reference identity is invalid.",
      [document.id],
      "Use a principal, datum, or planar-face plane with a stable non-empty reference ID."
    ));
  }
  const vectors = [plane.originMm, plane.xAxis, plane.yAxis, plane.normal] as const;
  if (vectors.some((vector) => vector.length !== 3 || vector.some((value) => !Number.isFinite(value)))) {
    diagnostics.push(error(
      "INVALID_NUMBER",
      "The sketch plane contains an invalid 3D vector.",
      [document.id, plane.referenceId],
      "Store finite three-component origin, axis, and normal vectors."
    ));
    return;
  }
  const tolerance = 1e-6;
  const unit = (vector: readonly number[]): boolean => Math.abs(Math.hypot(...vector) - 1) <= tolerance;
  const dot = (left: readonly number[], right: readonly number[]): number => left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
  const cross = (left: readonly number[], right: readonly number[]): readonly [number, number, number] => [
    left[1]! * right[2]! - left[2]! * right[1]!,
    left[2]! * right[0]! - left[0]! * right[2]!,
    left[0]! * right[1]! - left[1]! * right[0]!
  ];
  const orthonormal = unit(plane.xAxis) && unit(plane.yAxis) && unit(plane.normal)
    && Math.abs(dot(plane.xAxis, plane.yAxis)) <= tolerance
    && Math.abs(dot(plane.xAxis, plane.normal)) <= tolerance
    && Math.abs(dot(plane.yAxis, plane.normal)) <= tolerance
    && dot(cross(plane.xAxis, plane.yAxis), plane.normal) >= 1 - tolerance;
  if (!orthonormal) {
    diagnostics.push(error(
      "INVALID_REFERENCE",
      "The sketch plane axes are not a right-handed orthonormal frame.",
      [document.id, plane.referenceId],
      "Normalize the axes, make them mutually perpendicular, and set normal = xAxis cross yAxis."
    ));
  }
}

export function constraintReferences(constraint: SketchConstraint): readonly GeometryReference[] {
  if (constraint.kind === "fix") return [constraint.target];
  if (constraint.kind === "horizontal" || constraint.kind === "vertical") return [constraint.line];
  if (constraint.kind === "midpoint") return [constraint.point, constraint.line];
  if (constraint.kind === "symmetric") return [constraint.first, constraint.second, constraint.axis];
  return [constraint.first, constraint.second];
}

export function dimensionReferences(dimension: SketchDimension): readonly GeometryReference[] {
  if (dimension.kind === "linear" || dimension.kind === "angle") return [dimension.first, dimension.second];
  return [dimension.target];
}

export function supportsPointSelector(geometry: SketchGeometry, selector: GeometryReference["selector"]): boolean {
  if (geometry.kind === "point") return selector === "self" || selector === "point";
  if (geometry.kind === "line") return selector === "start" || selector === "end" || selector === "midpoint";
  if (geometry.kind === "circle" || geometry.kind === "arc" || geometry.kind === "ellipse" || geometry.kind === "polygon") return selector === "center";
  if (geometry.kind === "slot") return selector === "start" || selector === "end" || selector === "midpoint";
  return false;
}

function validateGeometry(geometry: SketchGeometry, diagnostics: SketchDiagnostic[]): void {
  if (typeof geometry.construction !== "boolean" || typeof geometry.suppressed !== "boolean") {
    diagnostics.push(error("INVALID_REFERENCE", `Geometry '${geometry.id}' has invalid persistence flags.`, [geometry.id], "Store construction and suppressed as booleans."));
  }
  if (geometry.source !== undefined) validateProjectedSource(geometry, diagnostics);
  const numbers = geometryNumbers(geometry);
  if (numbers.some((value) => !Number.isFinite(value))) {
    diagnostics.push(error("INVALID_NUMBER", "Sketch geometry contains a non-finite coordinate or size.", [geometry.id], "Replace every coordinate and size with a finite number."));
    return;
  }
  const degenerate =
    geometry.kind === "line" ? distance(geometry.start, geometry.end) <= 1e-9 :
    geometry.kind === "circle" ? geometry.radiusMm <= 1e-9 :
    geometry.kind === "arc" ? geometry.radiusMm <= 1e-9 || normalizedArcSweep(geometry.startAngleRad, geometry.endAngleRad) <= 1e-9 :
    geometry.kind === "ellipse" ? distance([0, 0], geometry.majorAxis) <= 1e-9 || geometry.minorToMajorRatio <= 0 || geometry.minorToMajorRatio > 1 :
    geometry.kind === "spline" ? !Number.isInteger(geometry.degree) || geometry.degree < 1 || geometry.controlPoints.length < geometry.degree + 1 || geometry.knots.length !== geometry.controlPoints.length + geometry.degree + 1 || !nondecreasing(geometry.knots) :
    geometry.kind === "polygon" ? geometry.sides < 3 || !Number.isInteger(geometry.sides) || distance(geometry.center, geometry.vertex) <= 1e-9 :
    geometry.kind === "slot" ? geometry.widthMm <= 1e-9 || distance(geometry.startCenter, geometry.endCenter) <= 1e-9 : false;
  if (degenerate) diagnostics.push(error("DEGENERATE_GEOMETRY", `Geometry '${geometry.id}' is degenerate.`, [geometry.id], "Increase its size or provide the minimum valid number of defining points."));
}

function validateProjectedSource(geometry: SketchGeometry, diagnostics: SketchDiagnostic[]): void {
  const source = geometry.source!;
  if (
    source.documentId.trim().length === 0 ||
    source.topologyId.trim().length === 0 ||
    !Number.isInteger(source.revision) ||
    source.revision < 0 ||
    typeof source.associative !== "boolean"
  ) {
    diagnostics.push(error(
      "INVALID_REFERENCE",
      `Projected geometry '${geometry.id}' has invalid source identity or revision.`,
      [geometry.id],
      "Store a non-empty source document/topology ID, a non-negative integer revision, and an associative flag."
    ));
  }
}

function validateConstraintCompatibility(
  constraint: SketchConstraint,
  geometryById: ReadonlyMap<string, SketchGeometry>,
  diagnostics: SketchDiagnostic[]
): void {
  const requireKinds = (references: readonly GeometryReference[], kinds: readonly SketchGeometry["kind"][], detail: string): void => {
    const geometries = references.map((reference) => geometryById.get(reference.entityId));
    if (geometries.some((geometry) => geometry !== undefined && !kinds.includes(geometry.kind))) {
      diagnostics.push(error("INVALID_REFERENCE", `${constraint.kind} constraint '${constraint.id}' ${detail}.`, [constraint.id], "Select compatible sketch geometry."));
    }
  };
  if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
    requireKinds([constraint.line], ["line"], "requires a line");
  } else if (constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "collinear") {
    requireKinds([constraint.first, constraint.second], ["line"], "requires two lines");
  } else if (constraint.kind === "midpoint") {
    requireKinds([constraint.line], ["line"], "requires a line target");
    const pointGeometry = geometryById.get(constraint.point.entityId);
    if (pointGeometry !== undefined && !supportsPointSelector(pointGeometry, constraint.point.selector)) {
      diagnostics.push(error("INVALID_REFERENCE", `midpoint constraint '${constraint.id}' requires a writable point-like reference.`, [constraint.id], "Select a point, endpoint, or center."));
    }
  } else if (constraint.kind === "concentric") {
    requireKinds([constraint.first, constraint.second], ["circle", "arc", "ellipse"], "requires two center-bearing curves");
  } else if (constraint.kind === "equal") {
    const first = geometryById.get(constraint.first.entityId);
    const second = geometryById.get(constraint.second.entityId);
    const bothLines = first?.kind === "line" && second?.kind === "line";
    const radialKinds: readonly SketchGeometry["kind"][] = ["circle", "arc"];
    const bothRadial = first !== undefined && second !== undefined && radialKinds.includes(first.kind) && radialKinds.includes(second.kind);
    if (first !== undefined && second !== undefined && !bothLines && !bothRadial) {
      diagnostics.push(error("INVALID_REFERENCE", `equal constraint '${constraint.id}' requires two lines or two circle/arc radii.`, [constraint.id], "Select two lines, or two circles/arcs."));
    }
  }
}

function validateDimensionCompatibility(
  dimension: SketchDimension,
  geometryById: ReadonlyMap<string, SketchGeometry>,
  diagnostics: SketchDiagnostic[]
): void {
  const incompatible = (message: string): void => {
    diagnostics.push(error("INVALID_REFERENCE", `Dimension '${dimension.id}' ${message}.`, [dimension.id], "Select compatible sketch geometry."));
  };
  if (dimension.kind === "length") {
    const geometry = geometryById.get(dimension.target.entityId);
    if (geometry !== undefined && geometry.kind !== "line") incompatible("requires a line");
  } else if (dimension.kind === "radius" || dimension.kind === "diameter") {
    const geometry = geometryById.get(dimension.target.entityId);
    if (geometry !== undefined && geometry.kind !== "circle" && geometry.kind !== "arc") incompatible("requires a circle or arc");
  } else if (dimension.kind === "angle") {
    const first = geometryById.get(dimension.first.entityId);
    const second = geometryById.get(dimension.second.entityId);
    if ((first !== undefined && first.kind !== "line") || (second !== undefined && second.kind !== "line")) incompatible("requires two lines");
  } else if (dimension.kind === "linear") {
    const first = geometryById.get(dimension.first.entityId);
    const second = geometryById.get(dimension.second.entityId);
    if ((first !== undefined && !supportsPointSelector(first, dimension.first.selector)) || (second !== undefined && !supportsPointSelector(second, dimension.second.selector))) {
      incompatible("requires two point-like references");
    }
  } else {
    const geometry = geometryById.get(dimension.target.entityId);
    if (geometry !== undefined && !supportsPointSelector(geometry, dimension.target.selector)) incompatible("requires a point-like reference");
  }
}

function validateReference(
  reference: GeometryReference,
  geometryById: ReadonlyMap<string, SketchGeometry>,
  diagnostics: SketchDiagnostic[],
  ownerId: string
): void {
  const geometry = geometryById.get(reference.entityId);
  if (geometry === undefined) {
    diagnostics.push(error("MISSING_REFERENCE", `Reference '${reference.entityId}' does not exist.`, [ownerId, reference.entityId], "Repair or remove the dangling reference."));
    return;
  }
  const valid =
    supportsPointSelector(geometry, reference.selector) ||
    reference.selector === "self" || reference.selector === "curve" ||
    ((geometry.kind === "circle" || geometry.kind === "arc") && reference.selector === "radius") ||
    (geometry.kind === "ellipse" && (reference.selector === "major-axis" || reference.selector === "minor-axis"));
  if (!valid) diagnostics.push(error("INVALID_REFERENCE", `Selector '${reference.selector}' is not valid for ${geometry.kind} '${geometry.id}'.`, [ownerId, geometry.id], "Select a compatible geometry sub-element."));
}

function geometryNumbers(geometry: SketchGeometry): readonly number[] {
  if (geometry.kind === "point") return geometry.point;
  if (geometry.kind === "line") return [...geometry.start, ...geometry.end];
  if (geometry.kind === "circle") return [...geometry.center, geometry.radiusMm];
  if (geometry.kind === "arc") return [...geometry.center, geometry.radiusMm, geometry.startAngleRad, geometry.endAngleRad];
  if (geometry.kind === "ellipse") return [...geometry.center, ...geometry.majorAxis, geometry.minorToMajorRatio];
  if (geometry.kind === "spline") return [...geometry.controlPoints.flatMap((point) => [...point]), ...geometry.knots, geometry.degree];
  if (geometry.kind === "polygon") return [...geometry.center, ...geometry.vertex, geometry.sides];
  return [...geometry.startCenter, ...geometry.endCenter, geometry.widthMm];
}

function error(code: SketchDiagnostic["code"], message: string, relatedIds: readonly string[], recovery: string): SketchDiagnostic {
  return { code, severity: "error", message, relatedIds, recovery, unsupported: false };
}

function distance(left: readonly number[], right: readonly number[]): number {
  return Math.hypot(right[0]! - left[0]!, right[1]! - left[1]!);
}

function normalizedArcSweep(startAngleRad: number, endAngleRad: number): number {
  const turn = Math.PI * 2;
  return (((endAngleRad - startAngleRad) % turn) + turn) % turn;
}

function nondecreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! < values[index - 1]!) return false;
  }
  return true;
}
