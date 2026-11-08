import { applyWorkbenchOperation, createWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject, type WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { buildParallelogram, buildRoundedRectangle } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { dragSketchHandle, grabHandlesOf, type DragHandle } from "../packages/workbench-sketch/src/drag.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { buildEdgePolygon, buildPolygon, buildSlot, buildSlotOverall, type RegularPolygonShape, type ShapeIds, type SketchShape } from "../packages/workbench-sketch/src/shapes.js";

/** Shared pieces for the tests that edit and drag the app's parametric shapes (slot, rounded rectangle, regular polygon, parallelogram). */

let counter = 0;
export const shapeIds = (): ShapeIds => ({ entity: () => `entity:k${(counter += 1)}`, constraint: () => `constraint:k${(counter += 1)}` });

export type ShapeFamily = "slot" | "rounded-rectangle" | "polygon" | "parallelogram";

export interface ShapeCase {
  readonly name: string;
  readonly family: ShapeFamily;
  readonly build: () => SketchShape;
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`The shape did not build: ${result.diagnostics[0]?.message ?? "no reason"}`);
  return result.value;
}

export const SHAPE_CASES: readonly ShapeCase[] = [
  { name: "slot", family: "slot", build: () => must(buildSlot([0, 0], [20, 0], [10, 3], shapeIds())) },
  { name: "slanted slot", family: "slot", build: () => must(buildSlot([2, 1], [16, 12], [8, 3], shapeIds())) },
  { name: "overall slot", family: "slot", build: () => must(buildSlotOverall([-3, 0], [23, 0], [10, 3], shapeIds())) },
  { name: "rounded rectangle", family: "rounded-rectangle", build: () => must(buildRoundedRectangle([0, 0], [60, 40], 6, shapeIds())) },
  { name: "hexagon", family: "polygon", build: () => must(buildPolygon([0, 0], [10, 0], 6, shapeIds())) },
  { name: "pentagon (circumscribed)", family: "polygon", build: () => must(buildPolygon([5, 5], [5, 13], 5, shapeIds(), "circumscribed")) },
  { name: "octagon", family: "polygon", build: () => must(buildPolygon([0, 0], [10, 4], 8, shapeIds())) },
  { name: "triangle (edge)", family: "polygon", build: () => must(buildEdgePolygon([0, 0], [12, 0], 3, shapeIds())) },
  { name: "square", family: "polygon", build: () => must(buildPolygon([0, 0], [10, 0], 4, shapeIds())) },
  { name: "parallelogram", family: "parallelogram", build: () => must(buildParallelogram([0, 0], [30, 0], [40, 15], shapeIds())) }
];

export function projectWith(shape: SketchShape): WorkbenchProject {
  const base = createWorkbenchProject("project:shape-kit");
  const empty: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
  const applied = applyWorkbenchOperation(empty, { kind: "apply-sketch-edit", operationId: "operation:kit-add", expectedRevision: empty.revision, removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints, label: "Added a shape" });
  if (!applied.ok) throw new Error(`The shape was refused: ${applied.diagnostics[0]?.message ?? ""}`);
  return applied.value.project;
}

let operations = 0;

export function dimension(project: WorkbenchProject, edit: { readonly label?: string; readonly entityId: string; readonly dimension: string; readonly valueMm: number; readonly secondEntityId?: string; readonly points?: readonly string[] }): { readonly ok: true; readonly project: WorkbenchProject } | { readonly ok: false; readonly message: string } {
  const { label: _label, ...operation } = edit;
  const result = applyWorkbenchOperation(project, { kind: "set-sketch-dimension", operationId: `operation:kit-${(operations += 1)}`, expectedRevision: project.revision, ...operation } as never);
  return result.ok ? { ok: true, project: result.value.project } : { ok: false, message: result.diagnostics[0]?.message ?? "refused" };
}

/** What the canvas does when a drag ends: the changed curves are committed as one edit. */
export function dragAndCommit(project: WorkbenchProject, entityId: string, handle: DragHandle, from: Vec2, to: Vec2): { readonly ok: true; readonly project: WorkbenchProject } | { readonly ok: false; readonly message: string } {
  const dragged = dragSketchHandle(project.sketch, entityId, handle, from, to);
  if (!dragged.ok) return { ok: false, message: dragged.message };
  const before = new Map(project.sketch.entities.map((entity) => [entity.id, entity]));
  const changed = dragged.entities.filter((entity) => before.get(entity.id) !== entity);
  const committed = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:kit-${(operations += 1)}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: changed, addEntities: [], addConstraints: [], label: "Moved a curve" });
  return committed.ok ? { ok: true, project: committed.value.project } : { ok: false, message: committed.diagnostics[0]?.message ?? "refused" };
}

export function everyHandle(sketch: WorkbenchSketch): readonly { readonly entityId: string; readonly handle: DragHandle; readonly point: Vec2; readonly label: string }[] {
  const result: { entityId: string; handle: DragHandle; point: Vec2; label: string }[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction) continue;
    for (const grab of grabHandlesOf(entity)) result.push({ entityId: entity.id, handle: grab.handle, point: grab.point, label: `${entity.kind} ${grab.label}` });
    if (entity.kind === "line") {
      const middle: Vec2 = [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
      result.push({ entityId: entity.id, handle: { kind: "body" }, point: middle, label: "line body" });
    }
  }
  return result;
}

const at = (entity: SketchEntity, ref: "start" | "end"): Vec2 | undefined => (entity.kind === "line" || entity.kind === "arc" ? entity[ref] : undefined);
const gap = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The largest distance between two ends that a Coincident joint of the sketch says touch. */
export function worstJointGap(sketch: WorkbenchSketch): number {
  const byId = new Map(sketch.entities.map((entity) => [entity.id, entity]));
  let worst = 0;
  for (const constraint of sketch.constraints) {
    if (constraint.kind !== "coincident" || constraint.points === undefined) continue;
    const [a, b] = constraint.entityIds.map((id) => byId.get(id));
    const [ra, rb] = constraint.points;
    if (a === undefined || b === undefined || a.construction || b.construction) continue;
    if ((ra !== "start" && ra !== "end") || (rb !== "start" && rb !== "end")) continue;
    const pa = at(a, ra);
    const pb = at(b, rb);
    if (pa !== undefined && pb !== undefined) worst = Math.max(worst, gap(pa, pb));
  }
  return worst;
}

function circleOf(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radius: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  return { center, radius: gap(center, a) };
}

export function arcRadius(entity: SketchEntity): number | undefined {
  return entity.kind === "arc" ? circleOf(entity.start, entity.mid, entity.end)?.radius : undefined;
}

/** How far the line leaves the arc from the arc's own tangent at their joint (0 when the pair is tangent). */
function kink(line: Extract<SketchEntity, { kind: "line" }>, arc: Extract<SketchEntity, { kind: "arc" }>, joint: Vec2): number {
  const circle = circleOf(arc.start, arc.mid, arc.end);
  if (circle === undefined) return 1;
  const radial: Vec2 = [(joint[0] - circle.center[0]) / circle.radius, (joint[1] - circle.center[1]) / circle.radius];
  const length = gap(line.start, line.end);
  const direction: Vec2 = [(line.end[0] - line.start[0]) / length, (line.end[1] - line.start[1]) / length];
  return Math.abs(direction[0] * radial[0] + direction[1] * radial[1]);
}

/** Why the sketch no longer holds the shape it was built as, or undefined when it does. */
export function shapeProblem(sketch: WorkbenchSketch, family: ShapeFamily): string | undefined {
  const profiles = detectSketchProfiles(sketch);
  if (profiles.length !== 1) return `${profiles.length} profiles (expected 1)`;
  const jointGap = worstJointGap(sketch);
  if (jointGap > 1e-6) return `a joint is open by ${jointGap.toExponential(2)} mm`;
  const solid = sketch.entities.filter((entity) => !entity.construction);
  if (family === "slot" || family === "rounded-rectangle") {
    const lines = solid.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line");
    const arcs = solid.filter((entity): entity is Extract<SketchEntity, { kind: "arc" }> => entity.kind === "arc");
    const radii = arcs.map((arc) => arcRadius(arc) ?? NaN);
    if (radii.some((radius) => !Number.isFinite(radius) || Math.abs(radius - radii[0]!) > 1e-5)) return `the arcs no longer share one radius (${radii.map((radius) => radius.toFixed(4)).join(", ")})`;
    for (const arc of arcs) for (const line of lines) {
      for (const joint of [arc.start, arc.end]) {
        for (const end of [line.start, line.end]) if (gap(end, joint) < 1e-6 && kink(line, arc, joint) > 1e-4) return "a side meets its arc at a kink (no longer tangent)";
      }
    }
    if (family === "rounded-rectangle") {
      for (const line of lines) if (Math.abs(line.start[0] - line.end[0]) > 1e-6 && Math.abs(line.start[1] - line.end[1]) > 1e-6) return "a rounded-rectangle side is no longer level or plumb";
    }
  }
  if (family === "polygon") {
    const lines = solid.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line");
    const sides = lines.map((line) => gap(line.start, line.end));
    if (sides.some((side) => Math.abs(side - sides[0]!) > 1e-5 * Math.max(1, sides[0]!))) return `the sides are not equal (${sides.map((side) => side.toFixed(4)).join(", ")})`;
    const cx = lines.reduce((sum, line) => sum + line.start[0], 0) / lines.length;
    const cy = lines.reduce((sum, line) => sum + line.start[1], 0) / lines.length;
    const radii = lines.map((line) => gap(line.start, [cx, cy]));
    if (radii.some((radius) => Math.abs(radius - radii[0]!) > 1e-5 * Math.max(1, radii[0]!))) return `the corners are not on one circle (radii ${radii.map((radius) => radius.toFixed(4)).join(", ")})`;
    const guide = sketch.entities.find((entity) => entity.kind === "circle" && entity.construction);
    if (guide?.kind === "circle" && (gap(guide.center, [cx, cy]) > 1e-5 || Math.abs(guide.radiusMm - radii[0]!) > 1e-5)) return "the guide circle no longer passes through the corners";
  }
  if (family === "parallelogram") {
    const lines = solid.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line");
    const direction = (line: Extract<SketchEntity, { kind: "line" }>): Vec2 => [line.end[0] - line.start[0], line.end[1] - line.start[1]];
    const cross = (a: Vec2, b: Vec2): number => (a[0] * b[1] - a[1] * b[0]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]));
    if (Math.abs(cross(direction(lines[0]!), direction(lines[2]!))) > 1e-6 || Math.abs(cross(direction(lines[1]!), direction(lines[3]!))) > 1e-6) return "opposite sides are no longer parallel";
  }
  return undefined;
}

export function dimensionEdits(project: WorkbenchProject, family: ShapeFamily, shape: SketchShape): readonly { readonly label: string; readonly entityId: string; readonly dimension: string; readonly valueMm: number; readonly secondEntityId?: string; readonly points?: readonly string[] }[] {
  const edits: { label: string; entityId: string; dimension: string; valueMm: number; secondEntityId?: string; points?: readonly string[] }[] = [];
  const size = (shape as Partial<RegularPolygonShape>).sizeDimension;
  for (const entity of project.sketch.entities) {
    if (entity.kind === "line" && !entity.construction) {
      const length = gap(entity.start, entity.end);
      edits.push({ label: `${entity.id} length x0.6`, entityId: entity.id, dimension: "length", valueMm: Number((length * 0.6).toFixed(4)) });
      edits.push({ label: `${entity.id} length x1.5`, entityId: entity.id, dimension: "length", valueMm: Number((length * 1.5).toFixed(4)) });
    }
    if (entity.kind === "arc") {
      const radius = arcRadius(entity)!;
      edits.push({ label: `${entity.id} radius x0.7`, entityId: entity.id, dimension: "radius", valueMm: Number((radius * 0.7).toFixed(4)) });
    }
  }
  if (family === "polygon" && size !== undefined) {
    edits.push({ label: "polygon size dimension x1.4", entityId: size.entityId, dimension: size.dimension, valueMm: Number((size.valueMm * 1.4).toFixed(4)), ...(size.secondEntityId === undefined ? {} : { secondEntityId: size.secondEntityId }), ...(size.points === undefined ? {} : { points: size.points }) });
  }
  return edits;
}

/** What a dimension edit must have achieved besides keeping the shape: the edited size is exact and the sizes it does not own are unchanged. */
export function editOutcomeProblem(before: WorkbenchSketch, after: WorkbenchSketch, family: ShapeFamily, edit: { readonly entityId: string; readonly dimension: string; readonly valueMm: number }): string | undefined {
  const entity = after.entities.find((candidate) => candidate.id === edit.entityId);
  if (entity === undefined) return "the edited curve is gone";
  if (edit.dimension === "length" && entity.kind === "line" && Math.abs(gap(entity.start, entity.end) - edit.valueMm) > 1e-4) return `the side is ${gap(entity.start, entity.end).toFixed(5)} mm, not ${edit.valueMm}`;
  if (edit.dimension === "radius" && entity.kind === "arc" && Math.abs((arcRadius(entity) ?? NaN) - edit.valueMm) > 1e-4) return `the arc radius is ${arcRadius(entity)?.toFixed(5)}, not ${edit.valueMm}`;
  if (edit.dimension === "radius" && entity.kind === "circle" && Math.abs(entity.radiusMm - edit.valueMm) > 1e-4) return `the circle radius is ${entity.radiusMm.toFixed(5)}, not ${edit.valueMm}`;
  if ((family === "slot" || family === "rounded-rectangle") && edit.dimension === "length") {
    const was = before.entities.filter((candidate) => candidate.kind === "arc").map((arc) => arcRadius(arc)!);
    const now = after.entities.filter((candidate) => candidate.kind === "arc").map((arc) => arcRadius(arc)!);
    if (now.some((radius, index) => Math.abs(radius - was[index]!) > 1e-4)) return `a side edit changed a cap radius (${was.map((radius) => radius.toFixed(4)).join(", ")} to ${now.map((radius) => radius.toFixed(4)).join(", ")})`;
  }
  return undefined;
}
