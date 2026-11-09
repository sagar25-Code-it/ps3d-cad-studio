import { applyWorkbenchOperation, createWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { curveEnds, extendProfileChain, startProfileChain, type ProfileChain, type ProfileSegmentMode } from "../packages/workbench-sketch/src/blend-profile.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { dimension, dragAndCommit, everyHandle, shapeIds, worstJointGap, arcRadius } from "./sketch-shape-kit.js";
import type { SketchShape } from "../packages/workbench-sketch/src/shapes.js";

/** Shared pieces for the wave-3 shape tests: building shapes the way the canvas does, and checking that they stay whole. */

export const ids3 = shapeIds;

export function emptyProject3(): WorkbenchProject {
  const base = createWorkbenchProject("project:shapes3");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

let operations = 0;

export function addShape(project: WorkbenchProject, shape: SketchShape): WorkbenchProject {
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:s3-${(operations += 1)}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints, label: "Added a shape" });
  if (!applied.ok) throw new Error(`The shape was refused: ${applied.diagnostics[0]?.message ?? ""}`);
  return applied.value.project;
}

/** The edit as an operation result (so a refusal can be examined), with the same shape the canvas sends. */
export function tryAdd(project: WorkbenchProject, shape: SketchShape): { readonly ok: true; readonly project: WorkbenchProject } | { readonly ok: false; readonly message: string } {
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:s3-${(operations += 1)}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints, label: "Added a shape" });
  return applied.ok ? { ok: true, project: applied.value.project } : { ok: false, message: applied.diagnostics[0]?.message ?? "refused" };
}

/** What the Profile tool does with a list of clicks: one edit per click, exactly like the canvas. */
export function profileProject(clicks: readonly { readonly point: Vec2; readonly mode: ProfileSegmentMode }[], start: Vec2 = [0, 0]): { readonly project: WorkbenchProject; readonly closed: boolean } {
  let project = emptyProject3();
  let chain: ProfileChain = startProfileChain(start);
  let closed = false;
  for (const click of clicks) {
    const step = extendProfileChain(chain, click.point, click.mode, 0.5, shapeIds());
    if (!step.ok) throw new Error(`The profile click was refused: ${step.diagnostics[0]?.message ?? ""}`);
    project = addShape(project, { entities: [step.value.entity], constraints: step.value.constraints });
    chain = step.value.chain;
    closed = step.value.closed;
  }
  return { project, closed };
}

export const PROFILE_CHAINS: readonly { readonly name: string; readonly clicks: readonly { readonly point: Vec2; readonly mode: ProfileSegmentMode }[] }[] = [
  { name: "rounded end", clicks: [{ point: [40, 0], mode: "line" }, { point: [40, 30], mode: "tangent-arc" }, { point: [0, 30], mode: "line" }, { point: [0, 0], mode: "line" }] },
  { name: "wavy outline with arc after arc", clicks: [{ point: [20, 0], mode: "line" }, { point: [40, 15], mode: "tangent-arc" }, { point: [60, 0], mode: "tangent-arc" }, { point: [80, -10], mode: "line" }, { point: [60, -30], mode: "tangent-arc" }, { point: [0, 0], mode: "line" }] },
  { name: "box with a bulge", clicks: [{ point: [40, 0], mode: "line" }, { point: [60, 20], mode: "tangent-arc" }, { point: [60, 40], mode: "line" }, { point: [0, 40], mode: "line" }, { point: [0, 0], mode: "line" }] }
];

const at = (entity: SketchEntity, ref: "start" | "end"): Vec2 | undefined => (entity.kind === "line" || entity.kind === "arc" ? entity[ref] : undefined);

/** Why a tangent relation of the sketch is not tangent in the geometry any more (undefined when every one is). */
export function tangencyProblem(sketch: WorkbenchSketch): string | undefined {
  const byId = new Map(sketch.entities.map((entity) => [entity.id, entity] as const));
  for (const constraint of sketch.constraints) {
    if (constraint.kind !== "tangent" || constraint.suppressed === true) continue;
    const [a, b] = constraint.entityIds.map((id) => byId.get(id));
    if (a === undefined || b === undefined) continue;
    for (const endA of curveEnds(a)) for (const endB of curveEnds(b)) {
      if (Math.hypot(endA.point[0] - endB.point[0], endA.point[1] - endB.point[1]) > 1e-6) continue;
      const sum = Math.hypot(endA.outward[0] + endB.outward[0], endA.outward[1] + endB.outward[1]);
      if (sum > 1e-4) return `${a.id} and ${b.id} meet at a kink of ${sum.toExponential(2)}`;
    }
  }
  return undefined;
}

/** Whether the project is still one closed outline with every Coincident joint closed and every Tangent relation tangent. */
export function wholeProblem(project: WorkbenchProject, profiles: number | null = 1): string | undefined {
  const count = detectSketchProfiles(project.sketch).length;
  if (profiles !== null && count !== profiles) return `${count} profiles (expected ${profiles})`;
  const gap = worstJointGap(project.sketch);
  if (gap > 1e-6) return `a joint is open by ${gap.toExponential(2)} mm`;
  return tangencyProblem(project.sketch);
}

/** Every dimension edit and every handle drag of a project: each accepted one must leave it whole. Returns the first problem. */
/** `dragProfiles` is the profile count required after a drag (null: not checked, for outlines a big drag can legitimately make cross themselves). */
export function stressProblem(project: WorkbenchProject, profiles = 1, dragProfiles: number | null = profiles): string | undefined {
  const problem0 = wholeProblem(project, profiles);
  if (problem0 !== undefined) return `as built: ${problem0}`;
  for (const entity of project.sketch.entities) {
    if (entity.construction) continue;
    const edits: { label: string; dimension: string; valueMm: number }[] = [];
    if (entity.kind === "line") {
      const length = Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
      edits.push({ label: "length x0.6", dimension: "length", valueMm: Number((length * 0.6).toFixed(4)) }, { label: "length x1.5", dimension: "length", valueMm: Number((length * 1.5).toFixed(4)) });
    }
    if (entity.kind === "arc") {
      const radius = arcRadius(entity)!;
      edits.push({ label: "radius x0.8", dimension: "radius", valueMm: Number((radius * 0.8).toFixed(4)) }, { label: "radius x1.25", dimension: "radius", valueMm: Number((radius * 1.25).toFixed(4)) });
    }
    for (const edit of edits) {
      const result = dimension(project, { entityId: entity.id, dimension: edit.dimension, valueMm: edit.valueMm });
      if (!result.ok) continue; // a refusal with a reason is fine; an accepted edit must leave the outline whole
      const problem = wholeProblem(result.project, profiles);
      if (problem !== undefined) return `after ${entity.id} ${edit.label}: ${problem}`;
    }
  }
  for (const grab of everyHandle(project.sketch)) {
    for (const delta of [[2.5, -1.5], [-3, 2], [0.5, 4]] as const) {
      const result = dragAndCommit(project, grab.entityId, grab.handle, grab.point, [grab.point[0] + delta[0], grab.point[1] + delta[1]]);
      if (!result.ok) continue;
      const problem = wholeProblem(result.project, dragProfiles);
      if (problem !== undefined) return `after dragging ${grab.label} of ${grab.entityId} by ${delta.join(",")}: ${problem}`;
    }
  }
  return undefined;
}

export const kindsOf = (constraints: readonly WorkbenchSketchConstraint[]): string => constraints.map((constraint) => constraint.kind).join(",");
export const endOf = at;

/** A curved slot's width: the long arcs differ by twice the cap radius and the caps are equal (undefined when it still is one). */
export function arcSlotProblem(sketch: WorkbenchSketch): string | undefined {
  const arcs = sketch.entities.filter((entity) => entity.kind === "arc");
  if (arcs.length !== 4) return `${arcs.length} arcs (expected 4)`;
  const [outer, endCap, inner, startCap] = arcs.map((arc) => arcRadius(arc)!) as [number, number, number, number];
  if (Math.abs(endCap - startCap) > 1e-5) return `the caps differ (${endCap.toFixed(4)} and ${startCap.toFixed(4)})`;
  if (Math.abs(outer - inner - 2 * endCap) > 1e-4) return `the width is not twice the cap radius (outer ${outer.toFixed(4)}, inner ${inner.toFixed(4)}, cap ${endCap.toFixed(4)})`;
  return undefined;
}

// ---------------------------------------------------------------- drawing the way the canvas does

import { autoConstraintsFor, type PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { buildSketchEntity, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import { DEFAULT_SNAP_ASSIST, anchorFor, assistedInference, type SnapAssistSettings, type SnapModifiers } from "../packages/workbench-sketch/src/snap-assist.js";

export interface DrawnEntity {
  readonly entity: SketchEntity;
  readonly constraints: readonly WorkbenchSketchConstraint[];
  readonly placed: readonly PlacedPointInference[];
  readonly points: readonly Vec2[];
}

let autoCounter = 0;
export const autoId = (): string => `constraint:s3-${(autoCounter += 1)}`;

/** Infers each pointer like the pointer-move handler does and returns what the click handler would place. */
export function inferPlaced(tool: SketchTool, project: WorkbenchProject, pointers: readonly Vec2[], options: { readonly settings?: Partial<SnapAssistSettings>; readonly modifiers?: SnapModifiers; readonly tolerance?: number } = {}): { readonly points: Vec2[]; readonly placed: PlacedPointInference[] } {
  const settings: SnapAssistSettings = { ...DEFAULT_SNAP_ASSIST, ...options.settings };
  const placed: PlacedPointInference[] = [];
  const points: Vec2[] = [];
  for (const pointer of pointers) {
    const result = assistedInference({ tool, pointer, sketch: project.sketch, toleranceMm: options.tolerance ?? 1, gridMm: undefined, anchor: anchorFor(tool, points), placedCount: points.length, settings, ...(options.modifiers === undefined ? {} : { modifiers: options.modifiers }) });
    const previous = points.at(-1);
    placed.push({ point: result.point, ...(result.primary === undefined ? {} : { primary: result.primary }), guides: result.guides, ...(previous === undefined ? {} : { anchor: previous }) });
    points.push(result.point);
  }
  return { points, placed };
}

/** Draws one single-entity tool through inference, the entity builder and autoConstraintsFor (no project change). */
export function drawEntity(tool: Exclude<SketchTool, "select">, project: WorkbenchProject, pointers: readonly Vec2[], options: { readonly settings?: Partial<SnapAssistSettings>; readonly modifiers?: SnapModifiers; readonly tolerance?: number } = {}): DrawnEntity {
  const { points, placed } = inferPlaced(tool, project, pointers, options);
  const built = buildSketchEntity(tool, points, "entity:s3-drawn");
  if (!built.ok) throw new Error(`the ${tool} did not build: ${built.diagnostics[0]?.message}`);
  return { entity: built.value, constraints: autoConstraintsFor({ tool, entity: built.value, placed, sketch: project.sketch, newId: autoId }), placed, points };
}
