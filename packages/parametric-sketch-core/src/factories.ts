import type {
  ArcGeometry,
  CircleGeometry,
  EllipseGeometry,
  LineGeometry,
  PointGeometry,
  PolygonGeometry,
  ProjectedSource,
  SlotGeometry,
  SplineGeometry,
  Vec2
} from "./types.js";

/** Persistence flags shared by every sketch entity factory. */
export interface SketchGeometryOptions {
  readonly construction?: boolean;
  readonly suppressed?: boolean;
  /**
   * Exact source identity for projected geometry. Associative projections are
   * treated as read-only by the analytic solver until their source is updated
   * by the CAD document/topology layer.
   */
  readonly source?: ProjectedSource;
}

export function createPointGeometry(id: string, point: Vec2, options: SketchGeometryOptions = {}): PointGeometry {
  assertId(id);
  assertVec2(point, "point");
  return { ...base(id, options), kind: "point", point: copyVec2(point) };
}

export function createLineGeometry(id: string, start: Vec2, end: Vec2, options: SketchGeometryOptions = {}): LineGeometry {
  assertId(id);
  assertVec2(start, "line start");
  assertVec2(end, "line end");
  assertPositive(Math.hypot(end[0] - start[0], end[1] - start[1]), "line length");
  return { ...base(id, options), kind: "line", start: copyVec2(start), end: copyVec2(end) };
}

export function createCircleGeometry(id: string, center: Vec2, radiusMm: number, options: SketchGeometryOptions = {}): CircleGeometry {
  assertId(id);
  assertVec2(center, "circle center");
  assertPositive(radiusMm, "circle radius");
  return { ...base(id, options), kind: "circle", center: copyVec2(center), radiusMm };
}

export function createArcGeometry(
  id: string,
  center: Vec2,
  radiusMm: number,
  startAngleRad: number,
  endAngleRad: number,
  options: SketchGeometryOptions = {}
): ArcGeometry {
  assertId(id);
  assertVec2(center, "arc center");
  assertPositive(radiusMm, "arc radius");
  assertFinite(startAngleRad, "arc start angle");
  assertFinite(endAngleRad, "arc end angle");
  if (normalizedArcSweep(startAngleRad, endAngleRad) <= 1e-12) {
    throw new RangeError("Arc sweep must be greater than zero and less than one full turn; use a circle for a full turn.");
  }
  return { ...base(id, options), kind: "arc", center: copyVec2(center), radiusMm, startAngleRad, endAngleRad };
}

export function createEllipseGeometry(
  id: string,
  center: Vec2,
  majorAxis: Vec2,
  minorToMajorRatio: number,
  options: SketchGeometryOptions = {}
): EllipseGeometry {
  assertId(id);
  assertVec2(center, "ellipse center");
  assertVec2(majorAxis, "ellipse major axis");
  assertPositive(Math.hypot(majorAxis[0], majorAxis[1]), "ellipse major-axis length");
  assertFinite(minorToMajorRatio, "ellipse axis ratio");
  if (minorToMajorRatio <= 0 || minorToMajorRatio > 1) throw new RangeError("Ellipse minor-to-major ratio must be in (0, 1].");
  return { ...base(id, options), kind: "ellipse", center: copyVec2(center), majorAxis: copyVec2(majorAxis), minorToMajorRatio };
}

export function createRegularPolygonGeometry(
  id: string,
  center: Vec2,
  vertex: Vec2,
  sides: number,
  options: SketchGeometryOptions = {}
): PolygonGeometry {
  assertId(id);
  assertVec2(center, "polygon center");
  assertVec2(vertex, "polygon vertex");
  if (!Number.isInteger(sides) || sides < 3) throw new RangeError("A regular polygon must have an integer side count of at least 3.");
  assertPositive(Math.hypot(vertex[0] - center[0], vertex[1] - center[1]), "polygon circumradius");
  return { ...base(id, options), kind: "polygon", center: copyVec2(center), vertex: copyVec2(vertex), sides };
}

export function createSlotGeometry(
  id: string,
  startCenter: Vec2,
  endCenter: Vec2,
  widthMm: number,
  options: SketchGeometryOptions = {}
): SlotGeometry {
  assertId(id);
  assertVec2(startCenter, "slot start center");
  assertVec2(endCenter, "slot end center");
  assertPositive(Math.hypot(endCenter[0] - startCenter[0], endCenter[1] - startCenter[1]), "slot centerline length");
  assertPositive(widthMm, "slot width");
  return { ...base(id, options), kind: "slot", startCenter: copyVec2(startCenter), endCenter: copyVec2(endCenter), widthMm };
}

export function createSplineGeometry(
  id: string,
  degree: number,
  controlPoints: readonly Vec2[],
  knots: readonly number[],
  closed: boolean,
  options: SketchGeometryOptions = {}
): SplineGeometry {
  assertId(id);
  if (!Number.isInteger(degree) || degree < 1) throw new RangeError("Spline degree must be a positive integer.");
  if (controlPoints.length < degree + 1) throw new RangeError("A spline needs at least degree + 1 control points.");
  if (knots.length !== controlPoints.length + degree + 1) throw new RangeError("Spline knot count must equal control-point count + degree + 1.");
  controlPoints.forEach((point, index) => assertVec2(point, `spline control point ${index}`));
  knots.forEach((knot, index) => assertFinite(knot, `spline knot ${index}`));
  if (!isNondecreasing(knots)) throw new RangeError("Spline knots must be nondecreasing.");
  return {
    ...base(id, options),
    kind: "spline",
    degree,
    controlPoints: controlPoints.map(copyVec2),
    knots: [...knots],
    closed
  };
}

/** Returns a local construction copy while preserving the entity's stable ID. */
export function asConstructionGeometry<T extends PointGeometry | LineGeometry | CircleGeometry | ArcGeometry | EllipseGeometry | SplineGeometry | PolygonGeometry | SlotGeometry>(geometry: T): T {
  return { ...geometry, construction: true };
}

/** Returns a projected copy with explicit source identity and revision. */
export function asProjectedGeometry<T extends PointGeometry | LineGeometry | CircleGeometry | ArcGeometry | EllipseGeometry | SplineGeometry | PolygonGeometry | SlotGeometry>(
  geometry: T,
  source: ProjectedSource
): T {
  validateProjectedSource(source);
  return { ...geometry, source: { ...source } };
}

export function validateProjectedSource(source: ProjectedSource): void {
  assertId(source.documentId, "projected source document ID");
  assertId(source.topologyId, "projected topology ID");
  if (!Number.isInteger(source.revision) || source.revision < 0) throw new RangeError("Projected source revision must be a non-negative integer.");
  if (typeof source.associative !== "boolean") throw new TypeError("Projected source associative must be a boolean.");
}

function base(id: string, options: SketchGeometryOptions): {
  readonly id: string;
  readonly construction: boolean;
  readonly suppressed: boolean;
  readonly source?: ProjectedSource;
} {
  const common = { id, construction: options.construction ?? false, suppressed: options.suppressed ?? false };
  if (options.source === undefined) return common;
  validateProjectedSource(options.source);
  return { ...common, source: { ...options.source } };
}

function copyVec2(point: Vec2): Vec2 {
  return [point[0], point[1]];
}

function assertId(id: string, label = "geometry ID"): void {
  if (id.trim().length === 0) throw new TypeError(`${label} must not be empty.`);
}

function assertVec2(point: Vec2, label: string): void {
  assertFinite(point[0], `${label} x`);
  assertFinite(point[1], `${label} y`);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 1e-12) throw new RangeError(`${label} must be greater than zero.`);
}

function isNondecreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! < values[index - 1]!) return false;
  }
  return true;
}

function normalizedArcSweep(startAngleRad: number, endAngleRad: number): number {
  const turn = Math.PI * 2;
  const raw = endAngleRad - startAngleRad;
  const normalized = ((raw % turn) + turn) % turn;
  return normalized;
}
