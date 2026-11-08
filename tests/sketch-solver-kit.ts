import type { SketchEntity, SketchPointRef, WorkbenchOperation, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { assert } from "./test-kit.js";

/** Shared helpers for the simultaneous-solver regression tests: build sketches, apply operations through the real validated path. */

export type Vec = readonly [number, number];
export type Line = Extract<SketchEntity, { kind: "line" }>;
export type Circle = Extract<SketchEntity, { kind: "circle" }>;
export type Arc = Extract<SketchEntity, { kind: "arc" }>;
export type Rect = Extract<SketchEntity, { kind: "rectangle" }>;
export type Ellipse = Extract<SketchEntity, { kind: "ellipse" }>;
export type Point = Extract<SketchEntity, { kind: "point" }>;

export const ORIGIN = "sketch:origin";
export const AXIS_X = "sketch:axis-x";
export const AXIS_Y = "sketch:axis-y";

let serial = 0;

export const ident = (name: string): string => (name.startsWith("sketch:") ? name : `entity:${name}`);
export const line = (name: string, start: Vec, end: Vec): SketchEntity => ({ id: ident(name), kind: "line", start, end, construction: false });
export const circle = (name: string, center: Vec, radiusMm: number): SketchEntity => ({ id: ident(name), kind: "circle", center, radiusMm, construction: false });
export const arc = (name: string, start: Vec, mid: Vec, end: Vec): SketchEntity => ({ id: ident(name), kind: "arc", start, mid, end, construction: false });
export const point = (name: string, at: Vec): SketchEntity => ({ id: ident(name), kind: "point", point: at, construction: false });
export const rect = (name: string, center: Vec, widthMm: number, heightMm: number, rotationDeg = 0): SketchEntity => ({ id: ident(name), kind: "rectangle", center, widthMm, heightMm, rotationDeg, construction: false });
export const ellipse = (name: string, center: Vec, majorRadiusMm: number, minorRadiusMm: number, rotationDeg = 0): SketchEntity => ({ id: ident(name), kind: "ellipse", center, majorRadiusMm, minorRadiusMm, rotationDeg, construction: false });

export function rel(kind: WorkbenchSketchConstraint["kind"], names: readonly string[], extra: Partial<WorkbenchSketchConstraint> = {}): WorkbenchSketchConstraint {
  serial += 1;
  return { id: `constraint:sim-${kind}-${serial}`, kind, entityIds: names.map(ident), ...extra } as WorkbenchSketchConstraint;
}

export function lengthDim(name: string, valueMm: number): WorkbenchSketchConstraint {
  serial += 1;
  return { id: `constraint:sim-length-${serial}`, kind: "distance", dimension: "length", entityIds: [ident(name)], valueMm };
}

export function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-sim");
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

export type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

export function apply(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-sim-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

/** Applies an operation and requires it to succeed; the resulting project must also pass full validation. */
export function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = apply(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  assert(validateWorkbenchProject(result.value.project).ok, "the resulting project validates");
  return result.value.project;
}

/** Applies an operation and requires it to be refused; returns the first diagnostic message. */
export function refuse(project: WorkbenchProject, operation: Op): string {
  const result = apply(project, operation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.ok ? "" : result.diagnostics[0]?.message ?? "";
}

export const addConstraint = (project: WorkbenchProject, constraint: WorkbenchSketchConstraint): WorkbenchProject => run(project, { kind: "add-sketch-constraint", constraint });

export function setDimension(project: WorkbenchProject, name: string, dimension: Extract<Op, { readonly kind: "set-sketch-dimension" }>["dimension"], valueMm: number, extra: { readonly second?: string; readonly points?: readonly SketchPointRef[]; readonly expression?: string; readonly driven?: boolean } = {}): WorkbenchProject {
  return run(project, {
    kind: "set-sketch-dimension",
    entityId: ident(name),
    dimension,
    valueMm,
    ...(extra.second === undefined ? {} : { secondEntityId: ident(extra.second) }),
    ...(extra.points === undefined ? {} : { points: extra.points }),
    ...(extra.expression === undefined ? {} : { expression: extra.expression }),
    ...(extra.driven === undefined ? {} : { driven: extra.driven })
  });
}

export function refuseDimension(project: WorkbenchProject, name: string, dimension: Extract<Op, { readonly kind: "set-sketch-dimension" }>["dimension"], valueMm: number, extra: { readonly second?: string; readonly points?: readonly SketchPointRef[] } = {}): string {
  return refuse(project, {
    kind: "set-sketch-dimension",
    entityId: ident(name),
    dimension,
    valueMm,
    ...(extra.second === undefined ? {} : { secondEntityId: ident(extra.second) }),
    ...(extra.points === undefined ? {} : { points: extra.points })
  });
}

export function get<K extends SketchEntity["kind"]>(project: WorkbenchProject, name: string, kind: K): Extract<SketchEntity, { kind: K }> {
  const found = project.sketch.entities.find((entity) => entity.id === ident(name));
  if (found === undefined || found.kind !== kind) throw new Error(`${name} is not a ${kind}`);
  return found as Extract<SketchEntity, { kind: K }>;
}

export const lengthOf = (l: Line): number => Math.hypot(l.end[0] - l.start[0], l.end[1] - l.start[1]);
export const dof = (project: WorkbenchProject): number => analyzeWorkbenchSketch(project.sketch).degreesOfFreedom;
export const analysis = (project: WorkbenchProject) => analyzeWorkbenchSketch(project.sketch);

/** Four lines b, r, t, l joined end to start around a (w by h) rectangle whose lower left is (x, y), level and plumb. Returns the entities and relations. */
export function lineRing(x = 0, y = 0, w = 52, h = 30, withShape = true): { readonly entities: readonly SketchEntity[]; readonly constraints: readonly WorkbenchSketchConstraint[] } {
  const entities = [line("b", [x, y], [x + w, y]), line("r", [x + w, y], [x + w, y + h]), line("t", [x + w, y + h], [x, y + h]), line("l", [x, y + h], [x, y])];
  const joins = [["b", "r"], ["r", "t"], ["t", "l"], ["l", "b"]] as const;
  const constraints = [
    ...joins.map(([a, b]) => rel("coincident", [a, b], { points: ["end", "start"] })),
    ...(withShape ? [rel("horizontal", ["b"]), rel("horizontal", ["t"]), rel("vertical", ["r"]), rel("vertical", ["l"])] : [])
  ];
  return { entities, constraints };
}

/** Whether the four ring lines still form a closed, level and plumb rectangle. */
export function ringIsClosedRectangle(project: WorkbenchProject, tolerance = 1e-6): boolean {
  const b = get(project, "b", "line");
  const r = get(project, "r", "line");
  const t = get(project, "t", "line");
  const l = get(project, "l", "line");
  const same = (p: Vec, q: Vec): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance;
  return same(b.end, r.start) && same(r.end, t.start) && same(t.end, l.start) && same(l.end, b.start)
    && Math.abs(b.end[1] - b.start[1]) <= tolerance && Math.abs(t.end[1] - t.start[1]) <= tolerance
    && Math.abs(r.end[0] - r.start[0]) <= tolerance && Math.abs(l.end[0] - l.start[0]) <= tolerance;
}
