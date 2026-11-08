import { evaluateSketchExpression } from "./expression.js";
import type {
  GeometryReference,
  ParametricSketchDocument,
  SketchConstraint,
  SketchDiagnostic,
  SketchDimension,
  SketchGeometry,
  SolveAnchor
} from "./types.js";
import { SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID, SKETCH_ORIGIN_ID } from "./types.js";

/**
 * Turns a sketch document into a system of equations over one flat vector of numbers (every coordinate, radius and angle of
 * every entity). A relation is a function from that vector to residuals that are zero when it holds; the solver finds a nearby
 * vector for which all residuals vanish at once. Fixed geometry is removed from the unknowns, the sketch origin and axes are
 * constants, and "keep the shape" terms (lengths and radii) are carried separately as soft equations.
 */

export type EvalFn = (x: Float64Array, out: Float64Array, offset: number) => void;

export interface Equation {
  /** The constraint, dimension or fix this equation belongs to. */
  readonly id: string;
  readonly source: "constraint" | "dimension";
  readonly size: number;
  /** Every variable index the residuals read (frozen ones included). */
  readonly vars: readonly number[];
  readonly entities: readonly string[];
  readonly eval: EvalFn;
}

export interface EntityLayout {
  readonly id: string;
  readonly geometry: SketchGeometry;
  readonly base: number;
  readonly count: number;
}

export interface SolverModel {
  readonly document: ParametricSketchDocument;
  readonly layout: ReadonlyMap<string, EntityLayout>;
  readonly variableCount: number;
  /** Current values; the solver writes its answer here. */
  readonly x: Float64Array;
  /** Values the model was built from. */
  readonly x0: Float64Array;
  /** 1 = constant. */
  readonly frozen: Uint8Array;
  /** For a frozen variable: the Fix constraints that hold it. */
  readonly frozenBy: ReadonlyMap<number, readonly string[]>;
  readonly weight: Float64Array;
  /** What each variable measures: 0 a length or coordinate, 1 an angle, 2 a size that must stay positive. The solver limits how far one step may change an angle or a size. */
  readonly role: Uint8Array;
  /** 1 for a variable the caller asked to keep in place (an anchor). */
  readonly anchored: Uint8Array;
  readonly equations: Equation[];
  readonly soft: Equation[];
  readonly diagnostics: SketchDiagnostic[];
  readonly appliedConstraints: Set<string>;
  readonly appliedDimensions: Set<string>;
  readonly entityOfVariable: readonly string[];
}

export const ANCHOR_WEIGHT = { 0: 1, 1: 1e6, 2: 1e12 } as const;
const TWO_PI = Math.PI * 2;
const SMALL = 1e-12;

interface PointFn {
  readonly vars: readonly number[];
  x(x: Float64Array): number;
  y(x: Float64Array): number;
}

interface LineFn {
  readonly p: PointFn;
  readonly q: PointFn;
}

type Failure = { readonly diagnostic: SketchDiagnostic };
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "diagnostic" in value;

export function entityVariableCount(geometry: SketchGeometry): number {
  switch (geometry.kind) {
    case "point": return 2;
    case "line": return 4;
    case "circle": return 3;
    case "arc": return 5;
    case "ellipse": return 5;
    case "polygon": return 4;
    case "slot": return 5;
    case "rectangle": return 5;
    case "spline": return 0;
  }
}

export function wrapSweep(startRad: number, endRad: number): number {
  return (((endRad - startRad) % TWO_PI) + TWO_PI) % TWO_PI;
}

export function readEntityValues(geometry: SketchGeometry): number[] {
  switch (geometry.kind) {
    case "point": return [geometry.point[0], geometry.point[1]];
    case "line": return [geometry.start[0], geometry.start[1], geometry.end[0], geometry.end[1]];
    case "circle": return [geometry.center[0], geometry.center[1], geometry.radiusMm];
    case "arc": return [geometry.center[0], geometry.center[1], geometry.radiusMm, geometry.startAngleRad, wrapSweep(geometry.startAngleRad, geometry.endAngleRad)];
    case "ellipse": return [geometry.center[0], geometry.center[1], geometry.majorAxis[0], geometry.majorAxis[1], Math.hypot(geometry.majorAxis[0], geometry.majorAxis[1]) * geometry.minorToMajorRatio];
    case "polygon": return [geometry.center[0], geometry.center[1], geometry.vertex[0], geometry.vertex[1]];
    case "slot": return [geometry.startCenter[0], geometry.startCenter[1], geometry.endCenter[0], geometry.endCenter[1], geometry.widthMm];
    case "rectangle": return [geometry.center[0], geometry.center[1], geometry.widthMm, geometry.heightMm, geometry.rotationRad];
    case "spline": return [];
  }
}

/** Writes the solved values of `layout` back into a copy of its geometry. */
export function writeEntityValues(geometry: SketchGeometry, v: ArrayLike<number>, offset: number): SketchGeometry {
  const g = (index: number): number => v[offset + index]!;
  switch (geometry.kind) {
    case "point": return { ...geometry, point: [g(0), g(1)] };
    case "line": return { ...geometry, start: [g(0), g(1)], end: [g(2), g(3)] };
    case "circle": return { ...geometry, center: [g(0), g(1)], radiusMm: g(2) };
    case "arc": return { ...geometry, center: [g(0), g(1)], radiusMm: g(2), startAngleRad: g(3), endAngleRad: g(3) + g(4) };
    case "ellipse": {
      const major = Math.hypot(g(2), g(3));
      return { ...geometry, center: [g(0), g(1)], majorAxis: [g(2), g(3)], minorToMajorRatio: major <= SMALL ? geometry.minorToMajorRatio : g(4) / major };
    }
    case "polygon": return { ...geometry, center: [g(0), g(1)], vertex: [g(2), g(3)] };
    case "slot": return { ...geometry, startCenter: [g(0), g(1)], endCenter: [g(2), g(3)], widthMm: g(4) };
    case "rectangle": return { ...geometry, center: [g(0), g(1)], widthMm: g(2), heightMm: g(3), rotationRad: g(4) };
    case "spline": return geometry;
  }
}

function diag(code: SketchDiagnostic["code"], severity: SketchDiagnostic["severity"], message: string, relatedIds: readonly string[], recovery: string, unsupported = false): SketchDiagnostic {
  return { code, severity, message, relatedIds, recovery, unsupported };
}

const constant = (x: number, y: number): PointFn => ({ vars: [], x: () => x, y: () => y });

class ModelBuilder {
  readonly layout = new Map<string, EntityLayout>();
  readonly equations: Equation[] = [];
  readonly soft: Equation[] = [];
  readonly diagnostics: SketchDiagnostic[] = [];
  readonly applied = { constraints: new Set<string>(), dimensions: new Set<string>() };
  x0: Float64Array;
  frozen: Uint8Array;
  weight: Float64Array;
  /** The weight a variable has when nothing is anchored: an angle is weighed by the length it sweeps, so turning is measured in millimetres too. */
  defaultWeight: Float64Array;
  role: Uint8Array;
  anchored: Uint8Array;
  readonly frozenBy = new Map<number, string[]>();
  readonly entityOfVariable: string[] = [];
  readonly variableCount: number;

  constructor(readonly document: ParametricSketchDocument) {
    const values: number[] = [];
    for (const geometry of document.geometry) {
      const entityValues = readEntityValues(geometry);
      this.layout.set(geometry.id, { id: geometry.id, geometry, base: values.length, count: entityValues.length });
      for (const value of entityValues) {
        values.push(value);
        this.entityOfVariable.push(geometry.id);
      }
    }
    this.variableCount = values.length;
    this.x0 = Float64Array.from(values);
    this.frozen = new Uint8Array(values.length);
    this.weight = new Float64Array(values.length).fill(1);
    this.role = new Uint8Array(values.length);
    this.anchored = new Uint8Array(values.length);
    for (const entry of this.layout.values()) {
      const b = entry.base;
      const g = entry.geometry;
      // A size (a radius, a side, a width) is stiffer than a position, so a relation that can be met by sliding a curve or by resizing it slides it.
      const SIZE_WEIGHT = 100;
      if (g.kind === "circle") {
        this.role[b + 2] = 2;
        this.weight[b + 2] = SIZE_WEIGHT;
      } else if (g.kind === "arc") {
        this.role[b + 2] = 2;
        this.role[b + 3] = 1;
        this.role[b + 4] = 1;
        const reach = Math.max(1, values[b + 2]!);
        this.weight[b + 2] = SIZE_WEIGHT;
        this.weight[b + 3] = reach * reach;
        this.weight[b + 4] = reach * reach;
      } else if (g.kind === "rectangle") {
        this.role[b + 2] = 2;
        this.role[b + 3] = 2;
        this.role[b + 4] = 1;
        const reach = Math.max(1, Math.hypot(values[b + 2]!, values[b + 3]!) / 2);
        this.weight[b + 2] = SIZE_WEIGHT;
        this.weight[b + 3] = SIZE_WEIGHT;
        // A rectangle dragged by a corner travels; it does not turn.
        this.weight[b + 4] = reach * reach * 100;
      } else if (g.kind === "ellipse") {
        this.role[b + 4] = 2;
        this.weight[b + 4] = SIZE_WEIGHT;
      } else if (g.kind === "slot") {
        this.role[b + 4] = 2;
        this.weight[b + 4] = SIZE_WEIGHT;
      }
    }
    this.defaultWeight = Float64Array.from(this.weight);
  }

  // ------------------------------------------------------------------ references

  /** The point a reference names, as a function of the unknowns. */
  point(reference: GeometryReference): PointFn | undefined {
    const { entityId, selector } = reference;
    if (entityId === SKETCH_ORIGIN_ID) return selector === "point" || selector === "self" ? constant(0, 0) : undefined;
    const entry = this.layout.get(entityId);
    if (entry === undefined) return undefined;
    const b = entry.base;
    const g = entry.geometry;
    const at = (xi: number, yi: number): PointFn => ({ vars: [xi, yi], x: (x) => x[xi]!, y: (x) => x[yi]! });
    switch (g.kind) {
      case "point":
        return selector === "self" || selector === "point" ? at(b, b + 1) : undefined;
      case "line":
      case "slot":
        if (selector === "start") return at(b, b + 1);
        if (selector === "end") return at(b + 2, b + 3);
        if (selector === "midpoint") return { vars: [b, b + 1, b + 2, b + 3], x: (x) => (x[b]! + x[b + 2]!) / 2, y: (x) => (x[b + 1]! + x[b + 3]!) / 2 };
        return undefined;
      case "circle":
        return selector === "center" ? at(b, b + 1) : undefined;
      case "ellipse":
      case "polygon":
        return selector === "center" ? at(b, b + 1) : undefined;
      case "arc": {
        if (selector === "center") return at(b, b + 1);
        const vars = [b, b + 1, b + 2, b + 3, b + 4];
        const angle = (x: Float64Array): number => selector === "start" ? x[b + 3]! : selector === "end" ? x[b + 3]! + x[b + 4]! : x[b + 3]! + x[b + 4]! / 2;
        if (selector === "start" || selector === "end" || selector === "midpoint") {
          return { vars, x: (x) => x[b]! + x[b + 2]! * Math.cos(angle(x)), y: (x) => x[b + 1]! + x[b + 2]! * Math.sin(angle(x)) };
        }
        return undefined;
      }
      case "rectangle": {
        if (selector === "center") return at(b, b + 1);
        const corner = /^corner-([0-3])$/u.exec(selector);
        if (corner === null) return undefined;
        const k = Number(corner[1]);
        const sx = k === 0 || k === 3 ? -0.5 : 0.5;
        const sy = k === 0 || k === 1 ? -0.5 : 0.5;
        const vars = [b, b + 1, b + 2, b + 3, b + 4];
        return {
          vars,
          x: (x) => x[b]! + Math.cos(x[b + 4]!) * sx * x[b + 2]! - Math.sin(x[b + 4]!) * sy * x[b + 3]!,
          y: (x) => x[b + 1]! + Math.sin(x[b + 4]!) * sx * x[b + 2]! + Math.cos(x[b + 4]!) * sy * x[b + 3]!
        };
      }
      case "spline":
        return undefined;
    }
  }

  /** A line a relation can read a direction from: a line, a slot's centre line, a datum axis, an ellipse's major axis. */
  line(reference: GeometryReference): LineFn | undefined {
    if (reference.entityId === SKETCH_AXIS_X_ID) return { p: constant(0, 0), q: constant(1, 0) };
    if (reference.entityId === SKETCH_AXIS_Y_ID) return { p: constant(0, 0), q: constant(0, 1) };
    const entry = this.layout.get(reference.entityId);
    if (entry === undefined) return undefined;
    const b = entry.base;
    if (entry.geometry.kind === "line" || entry.geometry.kind === "slot") {
      const p = this.point({ entityId: reference.entityId, selector: "start" });
      const q = this.point({ entityId: reference.entityId, selector: "end" });
      return p === undefined || q === undefined ? undefined : { p, q };
    }
    if (entry.geometry.kind === "ellipse" && (reference.selector === "major-axis" || reference.selector === "self" || reference.selector === "curve")) {
      return { p: { vars: [b, b + 1], x: (x) => x[b]!, y: (x) => x[b + 1]! }, q: { vars: [b, b + 1, b + 2, b + 3], x: (x) => x[b]! + x[b + 2]!, y: (x) => x[b + 1]! + x[b + 3]! } };
    }
    return undefined;
  }

  geometry(id: string): SketchGeometry | undefined {
    return this.layout.get(id)?.geometry;
  }

  // ------------------------------------------------------------------ fixes

  freezeRange(entityId: string, from: number, to: number, fixId: string | undefined): void {
    const entry = this.layout.get(entityId);
    if (entry === undefined) return;
    for (let index = from; index < to; index += 1) {
      const variable = entry.base + index;
      this.frozen[variable] = 1;
      if (fixId !== undefined) this.frozenBy.set(variable, [...(this.frozenBy.get(variable) ?? []), fixId]);
    }
  }

  applyFix(constraint: Extract<SketchConstraint, { kind: "fix" }>): void {
    const { entityId, selector } = constraint.target;
    const entry = this.layout.get(entityId);
    if (entry === undefined) return;
    const g = entry.geometry;
    this.applied.constraints.add(constraint.id);
    if (selector === "self" || selector === "curve") {
      this.freezeRange(entityId, 0, entry.count, constraint.id);
      return;
    }
    if (selector === "radius" && (g.kind === "circle" || g.kind === "arc")) {
      this.freezeRange(entityId, 2, 3, constraint.id);
      return;
    }
    const direct = this.directPoint(g, selector);
    if (direct !== undefined) {
      this.freezeRange(entityId, direct[0], direct[1], constraint.id);
      return;
    }
    // A derived point (an arc end, a rectangle corner, a line midpoint, an ellipse axis end) is held by equations instead.
    const point = this.point(constraint.target);
    if (point !== undefined) {
      const px = point.x(this.x0);
      const py = point.y(this.x0);
      this.equations.push({ id: constraint.id, source: "constraint", size: 2, vars: point.vars, entities: [entityId], eval: (x, out, o) => { out[o] = point.x(x) - px; out[o + 1] = point.y(x) - py; } });
      return;
    }
    if (g.kind === "ellipse" && (selector === "major-axis" || selector === "minor-axis")) {
      const b = entry.base;
      if (selector === "major-axis") {
        const a0 = Math.hypot(this.x0[b + 2]!, this.x0[b + 3]!);
        this.equations.push({ id: constraint.id, source: "constraint", size: 1, vars: [b + 2, b + 3], entities: [entityId], eval: (x, out, o) => { out[o] = Math.hypot(x[b + 2]!, x[b + 3]!) - a0; } });
      } else {
        this.freezeRange(entityId, 4, 5, constraint.id);
      }
      return;
    }
    this.freezeRange(entityId, 0, entry.count, constraint.id);
  }

  /** [from, to) variable offsets inside an entity when the selected point is stored directly as two variables. */
  directPoint(g: SketchGeometry, selector: GeometryReference["selector"]): readonly [number, number] | undefined {
    switch (g.kind) {
      case "point": return selector === "self" || selector === "point" ? [0, 2] : undefined;
      case "line":
      case "slot":
        return selector === "start" ? [0, 2] : selector === "end" ? [2, 4] : undefined;
      case "circle":
      case "arc":
      case "ellipse":
      case "polygon":
      case "rectangle":
        return selector === "center" ? [0, 2] : undefined;
      case "spline":
        return undefined;
    }
  }

  applyAnchors(anchors: readonly SolveAnchor[]): void {
    for (const anchor of anchors) {
      const { entityId, selector } = anchor.reference;
      const entry = this.layout.get(entityId);
      if (entry === undefined) continue;
      const factor = ANCHOR_WEIGHT[anchor.priority];
      let from = 0;
      let to = 0;
      if (selector === "self" || selector === "curve") {
        from = 0;
        to = entry.count;
      } else if (selector === "radius" && (entry.geometry.kind === "circle" || entry.geometry.kind === "arc")) {
        from = 2;
        to = 3;
      } else if (selector === "start" && entry.geometry.kind === "arc") {
        // Holding an arc's start holds its centre, radius and start angle; the sweep stays free.
        from = 0;
        to = 4;
      } else if (selector === "major-axis" && entry.geometry.kind === "ellipse") {
        from = 2;
        to = 4;
      } else if (selector === "minor-axis" && entry.geometry.kind === "ellipse") {
        from = 4;
        to = 5;
      } else {
        const direct = this.directPoint(entry.geometry, selector);
        if (direct !== undefined) {
          from = direct[0];
          to = direct[1];
        } else {
          const point = this.point(anchor.reference);
          if (point === undefined) continue;
          for (const variable of point.vars) {
            this.weight[variable] = factor * this.defaultWeight[variable]!;
            this.anchored[variable] = anchor.priority > 0 ? 1 : 0;
          }
          continue;
        }
      }
      for (let index = from; index < to; index += 1) {
        this.weight[entry.base + index] = factor * this.defaultWeight[entry.base + index]!;
        this.anchored[entry.base + index] = anchor.priority > 0 ? 1 : 0;
      }
    }
  }

  // ------------------------------------------------------------------ constraints

  addConstraint(constraint: SketchConstraint): void {
    const result = this.buildConstraint(constraint);
    if (result === undefined) {
      this.applied.constraints.add(constraint.id);
      return;
    }
    if (isFailure(result)) {
      this.diagnostics.push(result.diagnostic);
      return;
    }
    this.applied.constraints.add(constraint.id);
    this.equations.push(...result);
  }

  private invalid(id: string, message: string): Failure {
    return { diagnostic: diag("INVALID_REFERENCE", "error", message, [id], "Repair the relation's geometry references.") };
  }

  private unsupported(id: string, message: string, recovery: string): Failure {
    return { diagnostic: diag("UNSUPPORTED_CONSTRAINT", "warning", message, [id], recovery, true) };
  }

  private make(id: string, source: "constraint" | "dimension", size: number, entities: readonly string[], vars: readonly (readonly number[])[], evaluate: EvalFn): Equation {
    const merged = new Set<number>();
    for (const list of vars) for (const variable of list) merged.add(variable);
    return { id, source, size, vars: [...merged].sort((a, b) => a - b), entities: entities.filter((entity) => this.layout.has(entity)), eval: evaluate };
  }

  private buildConstraint(constraint: SketchConstraint): readonly Equation[] | Failure | undefined {
    const id = constraint.id;
    switch (constraint.kind) {
      case "fix":
        this.applyFix(constraint);
        return undefined;
      case "horizontal":
      case "vertical": {
        const target = this.geometry(constraint.line.entityId);
        if (target?.kind === "rectangle") {
          const b = this.layout.get(constraint.line.entityId)!.base;
          return [this.make(id, "constraint", 1, [target.id], [[b + 4]], (x, out, o) => { out[o] = Math.sin(2 * x[b + 4]!) / 2; })];
        }
        const line = this.line(constraint.line);
        if (line === undefined || (target?.kind !== "line" && target?.kind !== "slot")) return this.invalid(id, "The orientation constraint requires a line.");
        const horizontal = constraint.kind === "horizontal";
        return [this.make(id, "constraint", 1, [constraint.line.entityId], [line.p.vars, line.q.vars], (x, out, o) => {
          out[o] = horizontal ? line.q.y(x) - line.p.y(x) : line.q.x(x) - line.p.x(x);
        })];
      }
      case "coincident": {
        const first = this.point(constraint.first);
        const second = this.point(constraint.second);
        if (first === undefined || second === undefined) {
          return this.unsupported(id, "The solver joins defining points; this reference is not a point. Use point-on-curve for a point on a curve.", "Select two point-like references, or use a point-on-curve relation.");
        }
        return [this.make(id, "constraint", 2, [constraint.first.entityId, constraint.second.entityId], [first.vars, second.vars], (x, out, o) => {
          out[o] = first.x(x) - second.x(x);
          out[o + 1] = first.y(x) - second.y(x);
        })];
      }
      case "concentric": {
        const first = this.point({ entityId: constraint.first.entityId, selector: "center" });
        const second = this.point({ entityId: constraint.second.entityId, selector: "center" });
        if (first === undefined || second === undefined) return this.invalid(id, "Concentric requires two curves that have a centre.");
        return [this.make(id, "constraint", 2, [constraint.first.entityId, constraint.second.entityId], [first.vars, second.vars], (x, out, o) => {
          out[o] = first.x(x) - second.x(x);
          out[o + 1] = first.y(x) - second.y(x);
        })];
      }
      case "midpoint": {
        const point = this.point(constraint.point);
        const line = this.line(constraint.line);
        if (point === undefined || line === undefined) return this.invalid(id, "Midpoint requires a point and a line.");
        return [this.make(id, "constraint", 2, [constraint.point.entityId, constraint.line.entityId], [point.vars, line.p.vars, line.q.vars], (x, out, o) => {
          out[o] = point.x(x) - (line.p.x(x) + line.q.x(x)) / 2;
          out[o + 1] = point.y(x) - (line.p.y(x) + line.q.y(x)) / 2;
        })];
      }
      case "parallel":
      case "perpendicular":
      case "collinear": {
        const first = this.line(constraint.first);
        const second = this.line(constraint.second);
        if (first === undefined || second === undefined) return this.invalid(id, `${constraint.kind} requires two lines.`);
        if (constraint.first.entityId === constraint.second.entityId) return this.invalid(id, `${constraint.kind} needs two different lines.`);
        const entities = [constraint.first.entityId, constraint.second.entityId];
        const vars = [first.p.vars, first.q.vars, second.p.vars, second.q.vars];
        const directions = (x: Float64Array): readonly [number, number, number, number] => [first.q.x(x) - first.p.x(x), first.q.y(x) - first.p.y(x), second.q.x(x) - second.p.x(x), second.q.y(x) - second.p.y(x)];
        if (constraint.kind === "parallel") {
          return [this.make(id, "constraint", 1, entities, vars, (x, out, o) => {
            const [ax, ay, bx, by] = directions(x);
            out[o] = (ax * by - ay * bx) / Math.max(Math.hypot(ax, ay) * Math.hypot(bx, by), 1e-12);
          })];
        }
        if (constraint.kind === "perpendicular") {
          return [this.make(id, "constraint", 1, entities, vars, (x, out, o) => {
            const [ax, ay, bx, by] = directions(x);
            out[o] = (ax * bx + ay * by) / Math.max(Math.hypot(ax, ay) * Math.hypot(bx, by), 1e-12);
          })];
        }
        return [this.make(id, "constraint", 2, entities, vars, (x, out, o) => {
          const [ax, ay, bx, by] = directions(x);
          out[o] = (ax * by - ay * bx) / Math.max(Math.hypot(ax, ay) * Math.hypot(bx, by), 1e-12);
          out[o + 1] = (ax * (second.p.y(x) - first.p.y(x)) - ay * (second.p.x(x) - first.p.x(x))) / Math.max(Math.hypot(ax, ay), 1e-12);
        })];
      }
      case "equal": return this.buildEqual(constraint);
      case "tangent": return this.buildTangent(constraint);
      case "symmetric": {
        const first = this.point(constraint.first);
        const second = this.point(constraint.second);
        const axis = this.line(constraint.axis);
        if (first === undefined || second === undefined || axis === undefined) {
          return this.unsupported(id, "The solver mirrors point references about a line axis only.", "Reference two writable points and a line axis.");
        }
        return [this.make(id, "constraint", 2, [constraint.first.entityId, constraint.second.entityId, constraint.axis.entityId], [first.vars, second.vars, axis.p.vars, axis.q.vars], (x, out, o) => {
          const ux = axis.q.x(x) - axis.p.x(x);
          const uy = axis.q.y(x) - axis.p.y(x);
          const length = Math.max(Math.hypot(ux, uy), 1e-12);
          const mx = (first.x(x) + second.x(x)) / 2 - axis.p.x(x);
          const my = (first.y(x) + second.y(x)) / 2 - axis.p.y(x);
          out[o] = (ux * my - uy * mx) / length;
          out[o + 1] = (ux * (first.x(x) - second.x(x)) + uy * (first.y(x) - second.y(x))) / length;
        })];
      }
      case "on-curve": return this.buildOnCurve(constraint);
    }
  }

  private buildEqual(constraint: Extract<SketchConstraint, { kind: "equal" }>): readonly Equation[] | Failure {
    const id = constraint.id;
    const a = this.layout.get(constraint.first.entityId);
    const b = this.layout.get(constraint.second.entityId);
    if (a === undefined || b === undefined) return this.invalid(id, "Equal requires two existing curves.");
    if (a.id === b.id) return this.invalid(id, "Equal needs two different curves.");
    const entities = [a.id, b.id];
    const ga = a.geometry;
    const gb = b.geometry;
    if (ga.kind === "line" && gb.kind === "line") {
      const p = this.line(constraint.first)!;
      const q = this.line(constraint.second)!;
      return [this.make(id, "constraint", 1, entities, [p.p.vars, p.q.vars, q.p.vars, q.q.vars], (x, out, o) => {
        out[o] = Math.hypot(p.q.x(x) - p.p.x(x), p.q.y(x) - p.p.y(x)) - Math.hypot(q.q.x(x) - q.p.x(x), q.q.y(x) - q.p.y(x));
      })];
    }
    if ((ga.kind === "circle" || ga.kind === "arc") && (gb.kind === "circle" || gb.kind === "arc")) {
      const ra = a.base + 2;
      const rb = b.base + 2;
      return [this.make(id, "constraint", 1, entities, [[ra], [rb]], (x, out, o) => { out[o] = x[ra]! - x[rb]!; })];
    }
    if (ga.kind === "ellipse" && gb.kind === "ellipse") {
      const ba = a.base;
      const bb = b.base;
      return [this.make(id, "constraint", 2, entities, [[ba + 2, ba + 3, ba + 4], [bb + 2, bb + 3, bb + 4]], (x, out, o) => {
        out[o] = Math.hypot(x[ba + 2]!, x[ba + 3]!) - Math.hypot(x[bb + 2]!, x[bb + 3]!);
        out[o + 1] = x[ba + 4]! - x[bb + 4]!;
      })];
    }
    if (ga.kind === "rectangle" && gb.kind === "rectangle") {
      const ba = a.base;
      const bb = b.base;
      return [this.make(id, "constraint", 2, entities, [[ba + 2, ba + 3], [bb + 2, bb + 3]], (x, out, o) => {
        out[o] = x[ba + 2]! - x[bb + 2]!;
        out[o + 1] = x[ba + 3]! - x[bb + 3]!;
      })];
    }
    return this.invalid(id, "Equal requires two lines, two circles or arcs, two ellipses or two rectangles.");
  }

  private buildTangent(constraint: Extract<SketchConstraint, { kind: "tangent" }>): readonly Equation[] | Failure {
    const id = constraint.id;
    const first = this.layout.get(constraint.first.entityId);
    const second = this.layout.get(constraint.second.entityId);
    const radial = (g: SketchGeometry | undefined): boolean => g?.kind === "circle" || g?.kind === "arc";
    const unsupportedPair = this.unsupported(id, "The solver makes a line tangent to a circle or arc, or two circles or arcs tangent.", "Use a line with a circle or arc, or two circles or arcs.");
    if (first === undefined || second === undefined) {
      return this.invalid(id, "Tangent requires two existing curves.");
    }
    if (first.id === second.id) return this.invalid(id, "Tangent needs two different curves.");
    const lineSide = first.geometry.kind === "line" ? first : second.geometry.kind === "line" ? second : undefined;
    const circleSide = radial(first.geometry) && lineSide === second ? first : radial(second.geometry) && lineSide === first ? second : undefined;
    if (lineSide !== undefined && circleSide !== undefined) {
      const line = this.line({ entityId: lineSide.id, selector: "curve" })!;
      const cb = circleSide.base;
      const side = (x: Float64Array): number => {
        const ux = line.q.x(x) - line.p.x(x);
        const uy = line.q.y(x) - line.p.y(x);
        return (ux * (x[cb + 1]! - line.p.y(x)) - uy * (x[cb]! - line.p.x(x))) / Math.max(Math.hypot(ux, uy), 1e-12);
      };
      const sign = side(this.x0) < 0 ? -1 : 1;
      return [this.make(id, "constraint", 1, [lineSide.id, circleSide.id], [line.p.vars, line.q.vars, [cb, cb + 1, cb + 2]], (x, out, o) => { out[o] = side(x) - sign * x[cb + 2]!; })];
    }
    if (radial(first.geometry) && radial(second.geometry)) {
      const ba = first.base;
      const bb = second.base;
      const gap = (x: Float64Array): number => Math.hypot(x[ba]! - x[bb]!, x[ba + 1]! - x[bb + 1]!);
      const d0 = gap(this.x0);
      const r1 = this.x0[ba + 2]!;
      const r2 = this.x0[bb + 2]!;
      const external = Math.abs(d0 - (r1 + r2)) <= Math.abs(d0 - Math.abs(r1 - r2));
      const sign = r1 >= r2 ? 1 : -1;
      return [this.make(id, "constraint", 1, [first.id, second.id], [[ba, ba + 1, ba + 2], [bb, bb + 1, bb + 2]], (x, out, o) => {
        out[o] = external ? gap(x) - (x[ba + 2]! + x[bb + 2]!) : gap(x) - sign * (x[ba + 2]! - x[bb + 2]!);
      })];
    }
    return unsupportedPair;
  }

  private buildOnCurve(constraint: Extract<SketchConstraint, { kind: "on-curve" }>): readonly Equation[] | Failure {
    const id = constraint.id;
    const point = this.point(constraint.point);
    if (point === undefined) return this.invalid(id, "Point on curve needs a point reference.");
    const curveId = constraint.curve.entityId;
    const entities = [constraint.point.entityId, curveId];
    if (constraint.point.entityId === curveId) return this.invalid(id, "A point cannot be put on its own curve.");
    if (curveId === SKETCH_AXIS_X_ID) return [this.make(id, "constraint", 1, entities, [point.vars], (x, out, o) => { out[o] = point.y(x); })];
    if (curveId === SKETCH_AXIS_Y_ID) return [this.make(id, "constraint", 1, entities, [point.vars], (x, out, o) => { out[o] = point.x(x); })];
    const entry = this.layout.get(curveId);
    if (entry === undefined) return this.invalid(id, "Point on curve needs an existing curve.");
    const b = entry.base;
    switch (entry.geometry.kind) {
      case "line":
      case "slot": {
        const line = this.line({ entityId: curveId, selector: "curve" })!;
        return [this.make(id, "constraint", 1, entities, [point.vars, line.p.vars, line.q.vars], (x, out, o) => {
          const ux = line.q.x(x) - line.p.x(x);
          const uy = line.q.y(x) - line.p.y(x);
          out[o] = (ux * (point.y(x) - line.p.y(x)) - uy * (point.x(x) - line.p.x(x))) / Math.max(Math.hypot(ux, uy), 1e-12);
        })];
      }
      case "circle":
      case "arc":
        return [this.make(id, "constraint", 1, entities, [point.vars, [b, b + 1, b + 2]], (x, out, o) => { out[o] = Math.hypot(point.x(x) - x[b]!, point.y(x) - x[b + 1]!) - x[b + 2]!; })];
      case "ellipse":
        return [this.make(id, "constraint", 1, entities, [point.vars, [b, b + 1, b + 2, b + 3, b + 4]], (x, out, o) => {
          const major = Math.max(Math.hypot(x[b + 2]!, x[b + 3]!), 1e-12);
          const ux = x[b + 2]! / major;
          const uy = x[b + 3]! / major;
          const dx = point.x(x) - x[b]!;
          const dy = point.y(x) - x[b + 1]!;
          const along = dx * ux + dy * uy;
          const across = -dx * uy + dy * ux;
          const minor = Math.max(x[b + 4]!, 1e-12);
          out[o] = (Math.hypot(along / major, across / minor) - 1) * Math.min(major, minor);
        })];
      default:
        return this.unsupported(id, `A point cannot be put on a ${entry.geometry.kind} yet.`, "Choose a line, circle, arc or ellipse.");
    }
  }

  // ------------------------------------------------------------------ dimensions

  resolveValue(dimension: SketchDimension): { readonly value: number } | Failure {
    if (dimension.value.expression === undefined) return { value: dimension.value.value };
    const result = evaluateSketchExpression(dimension.value.expression, this.document.parameters, dimension.id);
    return result.ok ? { value: result.value! } : { diagnostic: result.diagnostic! };
  }

  addDimension(dimension: SketchDimension): void {
    const resolved = this.resolveValue(dimension);
    if (isFailure(resolved)) {
      this.diagnostics.push(resolved.diagnostic);
      return;
    }
    const result = this.buildDimension(dimension, resolved.value);
    if (isFailure(result)) {
      this.diagnostics.push(result.diagnostic);
      return;
    }
    this.applied.dimensions.add(dimension.id);
    this.equations.push(...result);
  }

  private invalidDimension(id: string, message: string): Failure {
    return { diagnostic: diag("INVALID_REFERENCE", "error", message, [id], "Select compatible geometry for the dimension.") };
  }

  private nonPositive(id: string, message: string): Failure {
    return { diagnostic: diag("DIMENSION_CONFLICT", "error", message, [id], "Change the driving dimension to a positive value.") };
  }

  private buildDimension(dimension: SketchDimension, target: number): readonly Equation[] | Failure {
    const id = dimension.id;
    const one = (entities: readonly string[], vars: readonly (readonly number[])[], evaluate: (x: Float64Array) => number): readonly Equation[] =>
      [this.make(id, "dimension", 1, entities, vars, (x, out, o) => { out[o] = evaluate(x); })];
    switch (dimension.kind) {
      case "length": {
        const line = this.line(dimension.target);
        const g = this.geometry(dimension.target.entityId);
        if (line === undefined || (g?.kind !== "line" && g?.kind !== "slot")) return this.invalidDimension(id, "Length requires a line.");
        if (target <= 0) return this.nonPositive(id, "A line length must be positive.");
        return one([dimension.target.entityId], [line.p.vars, line.q.vars], (x) => Math.hypot(line.q.x(x) - line.p.x(x), line.q.y(x) - line.p.y(x)) - target);
      }
      case "radius":
      case "diameter": {
        const entry = this.layout.get(dimension.target.entityId);
        if (entry === undefined) return this.invalidDimension(id, `${dimension.kind} requires a circle, arc or ellipse.`);
        const scale = dimension.kind === "diameter" ? 2 : 1;
        if (target <= 0) return this.nonPositive(id, dimension.kind === "diameter" ? "A diameter must be positive." : "A radius must be positive.");
        const b = entry.base;
        if (entry.geometry.kind === "circle" || entry.geometry.kind === "arc") return one([entry.id], [[b + 2]], (x) => scale * x[b + 2]! - target);
        if (entry.geometry.kind === "ellipse") {
          if (dimension.target.selector === "minor-axis") return one([entry.id], [[b + 4]], (x) => scale * x[b + 4]! - target);
          return one([entry.id], [[b + 2, b + 3]], (x) => scale * Math.hypot(x[b + 2]!, x[b + 3]!) - target);
        }
        return this.invalidDimension(id, `${dimension.kind} requires a circle, arc or ellipse.`);
      }
      case "arc-length": {
        const entry = this.layout.get(dimension.target.entityId);
        if (entry?.geometry.kind !== "arc") return this.invalidDimension(id, "Arc length requires an arc.");
        if (target <= 0) return this.nonPositive(id, "An arc length must be positive.");
        const b = entry.base;
        if (target / Math.max(this.x0[b + 2]!, SMALL) >= TWO_PI - 1e-9) {
          return { diagnostic: diag("DIMENSION_CONFLICT", "error", "An arc cannot be as long as, or longer than, its full circle at this radius.", [id], "Change the arc length or the radius.") };
        }
        return one([entry.id], [[b + 2, b + 4]], (x) => x[b + 2]! * x[b + 4]! - target);
      }
      case "linear": {
        const first = this.point(dimension.first);
        const second = this.point(dimension.second);
        if (first === undefined || second === undefined) return this.invalidDimension(id, "Linear dimensions require two point references.");
        const magnitude = Math.abs(target);
        const entities = [dimension.first.entityId, dimension.second.entityId];
        const vars = [first.vars, second.vars];
        if (dimension.orientation === "horizontal") {
          const sign = second.x(this.x0) - first.x(this.x0) < 0 ? -1 : 1;
          return one(entities, vars, (x) => second.x(x) - first.x(x) - sign * magnitude);
        }
        if (dimension.orientation === "vertical") {
          const sign = second.y(this.x0) - first.y(this.x0) < 0 ? -1 : 1;
          return one(entities, vars, (x) => second.y(x) - first.y(x) - sign * magnitude);
        }
        return one(entities, vars, (x) => Math.hypot(second.x(x) - first.x(x), second.y(x) - first.y(x)) - magnitude);
      }
      case "coordinate-x":
      case "coordinate-y": {
        const point = this.point(dimension.target);
        if (point === undefined) return this.invalidDimension(id, "Coordinate dimensions require a point reference.");
        return one([dimension.target.entityId], [point.vars], dimension.kind === "coordinate-x" ? (x) => point.x(x) - target : (x) => point.y(x) - target);
      }
      case "angle": {
        const first = this.line(dimension.first);
        const second = this.line(dimension.second);
        if (first === undefined || second === undefined) return this.invalidDimension(id, "Angular dimensions require two lines.");
        const wanted = wrapPi(target);
        return one([dimension.first.entityId, dimension.second.entityId], [first.p.vars, first.q.vars, second.p.vars, second.q.vars], (x) => {
          const a = Math.atan2(first.q.y(x) - first.p.y(x), first.q.x(x) - first.p.x(x));
          const b = Math.atan2(second.q.y(x) - second.p.y(x), second.q.x(x) - second.p.x(x));
          return wrapPi(b - a - wanted);
        });
      }
      case "point-line-distance":
      case "line-line-distance": {
        const line = this.line(dimension.kind === "point-line-distance" ? dimension.line : dimension.first);
        const point = dimension.kind === "point-line-distance"
          ? this.point(dimension.point)
          : (() => {
            const other = this.line(dimension.second);
            return other === undefined ? undefined : { vars: [...other.p.vars, ...other.q.vars], x: (x: Float64Array) => (other.p.x(x) + other.q.x(x)) / 2, y: (x: Float64Array) => (other.p.y(x) + other.q.y(x)) / 2 } as PointFn;
          })();
        if (line === undefined || point === undefined) return this.invalidDimension(id, "A distance to a line needs a line and a point, or two lines.");
        const signed = (x: Float64Array): number => {
          const ux = line.q.x(x) - line.p.x(x);
          const uy = line.q.y(x) - line.p.y(x);
          return (ux * (point.y(x) - line.p.y(x)) - uy * (point.x(x) - line.p.x(x))) / Math.max(Math.hypot(ux, uy), 1e-12);
        };
        const sign = signed(this.x0) < 0 ? -1 : 1;
        const magnitude = Math.abs(target);
        const entities = dimension.kind === "point-line-distance" ? [dimension.point.entityId, dimension.line.entityId] : [dimension.first.entityId, dimension.second.entityId];
        return one(entities, [line.p.vars, line.q.vars, point.vars], (x) => signed(x) - sign * magnitude);
      }
      case "perimeter": {
        const entry = this.layout.get(dimension.target.entityId);
        if (entry === undefined) return this.invalidDimension(id, "A perimeter applies to a circle, ellipse or rectangle.");
        if (target <= 0) return this.nonPositive(id, "A perimeter must be positive.");
        const b = entry.base;
        if (entry.geometry.kind === "circle") return one([entry.id], [[b + 2]], (x) => TWO_PI * x[b + 2]! - target);
        if (entry.geometry.kind === "rectangle") return one([entry.id], [[b + 2, b + 3]], (x) => 2 * (x[b + 2]! + x[b + 3]!) - target);
        if (entry.geometry.kind === "ellipse") return one([entry.id], [[b + 2, b + 3, b + 4]], (x) => ellipsePerimeter(Math.hypot(x[b + 2]!, x[b + 3]!), x[b + 4]!) - target);
        return this.invalidDimension(id, "A perimeter applies to a circle, ellipse or rectangle.");
      }
      case "width":
      case "height": {
        const entry = this.layout.get(dimension.target.entityId);
        if (entry?.geometry.kind !== "rectangle") return this.invalidDimension(id, `A ${dimension.kind} applies to a rectangle.`);
        if (target <= 0) return this.nonPositive(id, `A ${dimension.kind} must be positive.`);
        const index = entry.base + (dimension.kind === "width" ? 2 : 3);
        return one([entry.id], [[index]], (x) => x[index]! - target);
      }
    }
  }

  // ------------------------------------------------------------------ shape preservation

  addShapePreservation(only: ReadonlySet<string>): void {
    for (const entry of this.layout.values()) {
      if (!only.has(entry.id)) continue;
      const b = entry.base;
      const x0 = this.x0;
      const add = (size: number, vars: readonly number[], evaluate: EvalFn): void => {
        this.soft.push({ id: `shape:${entry.id}`, source: "constraint", size, vars, entities: [entry.id], eval: evaluate });
      };
      switch (entry.geometry.kind) {
        case "line":
        case "slot": {
          const length0 = Math.hypot(x0[b + 2]! - x0[b]!, x0[b + 3]! - x0[b + 1]!);
          add(1, [b, b + 1, b + 2, b + 3], (x, out, o) => { out[o] = Math.hypot(x[b + 2]! - x[b]!, x[b + 3]! - x[b + 1]!) - length0; });
          break;
        }
        case "circle": {
          const r0 = x0[b + 2]!;
          add(1, [b + 2], (x, out, o) => { out[o] = x[b + 2]! - r0; });
          break;
        }
        case "arc": {
          const r0 = x0[b + 2]!;
          const s0 = x0[b + 4]!;
          add(2, [b + 2, b + 4], (x, out, o) => { out[o] = x[b + 2]! - r0; out[o + 1] = r0 * (x[b + 4]! - s0); });
          break;
        }
        case "ellipse": {
          const a0 = Math.hypot(x0[b + 2]!, x0[b + 3]!);
          const b0 = x0[b + 4]!;
          add(2, [b + 2, b + 3, b + 4], (x, out, o) => { out[o] = Math.hypot(x[b + 2]!, x[b + 3]!) - a0; out[o + 1] = x[b + 4]! - b0; });
          break;
        }
        case "rectangle": {
          const w0 = x0[b + 2]!;
          const h0 = x0[b + 3]!;
          add(2, [b + 2, b + 3], (x, out, o) => { out[o] = x[b + 2]! - w0; out[o + 1] = x[b + 3]! - h0; });
          break;
        }
        default:
          break;
      }
    }
  }
}

export function wrapPi(angle: number): number {
  let wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  else if (wrapped <= -Math.PI) wrapped += TWO_PI;
  return wrapped;
}

export function ellipsePerimeter(a: number, b: number): number {
  const major = Math.max(a, b);
  const minor = Math.min(a, b);
  const h = ((major - minor) / (major + minor)) ** 2;
  return Math.PI * (major + minor) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export interface BuildOptions {
  readonly anchors?: readonly SolveAnchor[];
  /** Entities whose size is kept while their position and direction change (a line turned parallel keeps its length). */
  readonly preserve?: ReadonlySet<string>;
}

/** Builds the equation system for the active (not suppressed) geometry, constraints and driving dimensions of a document. */
export function buildSolverModel(document: ParametricSketchDocument, options: BuildOptions = {}): SolverModel {
  const active = document;
  const builder = new ModelBuilder(active);
  for (const geometry of active.geometry) {
    // Projected (associative) geometry and suppressed geometry are constants: relations can read them but never move them.
    if (geometry.source?.associative === true || geometry.suppressed) builder.freezeRange(geometry.id, 0, builder.layout.get(geometry.id)!.count, undefined);
  }
  // Relations are taken in the order the document lists them (the order they were made), so "the later one is the redundant one" means something.
  for (const constraint of document.constraints.filter((candidate) => !candidate.suppressed)) {
    if (constraint.kind === "fix") builder.addConstraint(constraint);
  }
  for (const constraint of document.constraints.filter((candidate) => !candidate.suppressed)) {
    if (constraint.kind !== "fix") builder.addConstraint(constraint);
  }
  for (const dimension of document.dimensions.filter((candidate) => !candidate.suppressed && candidate.mode === "driving")) builder.addDimension(dimension);
  if (options.anchors !== undefined) builder.applyAnchors(options.anchors);
  if (options.preserve !== undefined && options.preserve.size > 0) builder.addShapePreservation(options.preserve);
  return {
    document: active,
    layout: builder.layout,
    variableCount: builder.variableCount,
    x: Float64Array.from(builder.x0),
    x0: builder.x0,
    frozen: builder.frozen,
    frozenBy: builder.frozenBy,
    weight: builder.weight,
    role: builder.role,
    anchored: builder.anchored,
    equations: builder.equations,
    soft: builder.soft,
    diagnostics: builder.diagnostics,
    appliedConstraints: builder.applied.constraints,
    appliedDimensions: builder.applied.dimensions,
    entityOfVariable: builder.entityOfVariable
  };
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Pin equation for a derived point, used by drags. */
export function pinPointEquation(model: SolverModel, id: string, reference: GeometryReference, target: readonly [number, number]): Equation | undefined {
  const builder = new ModelBuilder(model.document);
  const point = builder.point(reference);
  if (point === undefined) return undefined;
  return { id, source: "constraint", size: 2, vars: point.vars, entities: [reference.entityId], eval: (x, out, o) => { out[o] = point.x(x) - target[0]; out[o + 1] = point.y(x) - target[1]; } };
}

/** The variables a point reference reads, or undefined for a reference that is not a point. */
export function pointVariables(model: SolverModel, reference: GeometryReference): readonly number[] | undefined {
  return new ModelBuilder(model.document).point(reference)?.vars;
}

/** The two variables that store a point directly, if it is stored that way. */
export function directPointVariables(model: SolverModel, reference: GeometryReference): readonly [number, number] | undefined {
  const entry = model.layout.get(reference.entityId);
  if (entry === undefined) return undefined;
  const builder = new ModelBuilder(model.document);
  const direct = builder.directPoint(entry.geometry, reference.selector);
  return direct === undefined ? undefined : [entry.base + direct[0], entry.base + direct[0] + 1];
}

/** Where a point reference currently is (document coordinates), or undefined for a reference that is not a point. */
export function getReferencedPoint(document: ParametricSketchDocument, reference: GeometryReference): readonly [number, number] | undefined {
  const builder = new ModelBuilder(document);
  const point = builder.point(reference);
  return point === undefined ? undefined : [point.x(builder.x0), point.y(builder.x0)];
}

/** What a dimension measures in the document's current geometry (millimetres, or radians for an angle); undefined when it cannot be measured. */
export function measureDimensionValue(document: ParametricSketchDocument, dimension: SketchDimension): number | undefined {
  const builder = new ModelBuilder(document);
  const x = builder.x0;
  const entry = (reference: GeometryReference): EntityLayout | undefined => builder.layout.get(reference.entityId);
  switch (dimension.kind) {
    case "length": {
      const line = builder.line(dimension.target);
      const g = entry(dimension.target)?.geometry;
      return line === undefined || (g?.kind !== "line" && g?.kind !== "slot") ? undefined : Math.hypot(line.q.x(x) - line.p.x(x), line.q.y(x) - line.p.y(x));
    }
    case "radius":
    case "diameter": {
      const e = entry(dimension.target);
      if (e === undefined) return undefined;
      const scale = dimension.kind === "diameter" ? 2 : 1;
      if (e.geometry.kind === "circle" || e.geometry.kind === "arc") return scale * x[e.base + 2]!;
      if (e.geometry.kind === "ellipse") return dimension.target.selector === "minor-axis" ? scale * x[e.base + 4]! : scale * Math.hypot(x[e.base + 2]!, x[e.base + 3]!);
      return undefined;
    }
    case "arc-length": {
      const e = entry(dimension.target);
      return e?.geometry.kind === "arc" ? x[e.base + 2]! * x[e.base + 4]! : undefined;
    }
    case "linear": {
      const first = builder.point(dimension.first);
      const second = builder.point(dimension.second);
      if (first === undefined || second === undefined) return undefined;
      const dx = second.x(x) - first.x(x);
      const dy = second.y(x) - first.y(x);
      return dimension.orientation === "horizontal" ? Math.abs(dx) : dimension.orientation === "vertical" ? Math.abs(dy) : Math.hypot(dx, dy);
    }
    case "coordinate-x":
    case "coordinate-y": {
      const point = builder.point(dimension.target);
      return point === undefined ? undefined : dimension.kind === "coordinate-x" ? point.x(x) : point.y(x);
    }
    case "angle": {
      const first = builder.line(dimension.first);
      const second = builder.line(dimension.second);
      if (first === undefined || second === undefined) return undefined;
      return wrapPi(Math.atan2(second.q.y(x) - second.p.y(x), second.q.x(x) - second.p.x(x)) - Math.atan2(first.q.y(x) - first.p.y(x), first.q.x(x) - first.p.x(x)));
    }
    case "point-line-distance":
    case "line-line-distance": {
      const line = builder.line(dimension.kind === "point-line-distance" ? dimension.line : dimension.first);
      if (line === undefined) return undefined;
      let px: number;
      let py: number;
      if (dimension.kind === "point-line-distance") {
        const point = builder.point(dimension.point);
        if (point === undefined) return undefined;
        px = point.x(x);
        py = point.y(x);
      } else {
        const other = builder.line(dimension.second);
        if (other === undefined) return undefined;
        px = (other.p.x(x) + other.q.x(x)) / 2;
        py = (other.p.y(x) + other.q.y(x)) / 2;
      }
      const ux = line.q.x(x) - line.p.x(x);
      const uy = line.q.y(x) - line.p.y(x);
      return Math.abs(ux * (py - line.p.y(x)) - uy * (px - line.p.x(x))) / Math.max(Math.hypot(ux, uy), 1e-12);
    }
    case "perimeter": {
      const e = entry(dimension.target);
      if (e === undefined) return undefined;
      if (e.geometry.kind === "circle") return TWO_PI * x[e.base + 2]!;
      if (e.geometry.kind === "rectangle") return 2 * (x[e.base + 2]! + x[e.base + 3]!);
      if (e.geometry.kind === "ellipse") return ellipsePerimeter(Math.hypot(x[e.base + 2]!, x[e.base + 3]!), x[e.base + 4]!);
      return undefined;
    }
    case "width":
    case "height": {
      const e = entry(dimension.target);
      return e?.geometry.kind === "rectangle" ? x[e.base + (dimension.kind === "width" ? 2 : 3)]! : undefined;
    }
  }
}

/** The number a dimension is driven to (its expression evaluated against the document's parameters), or undefined when the expression is invalid. */
export function resolveDimensionTarget(document: ParametricSketchDocument, dimension: SketchDimension): number | undefined {
  const resolved = new ModelBuilder(document).resolveValue(dimension);
  return isFailure(resolved) ? undefined : resolved.value;
}
