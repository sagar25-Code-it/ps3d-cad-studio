import type { GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { WORKBENCH_LIMITS } from "../../../packages/workbench-core/src/index.js";
import { nearestPickableEdge, pickableEdges, planProjection, type ProjectionMode, type Segment3 } from "../../../packages/workbench-geometry/src/index.js";

/**
 * The sketch ribbon's Project group, as pure functions: which body a command works on, which edges can be picked, and the sketch
 * edit that brings the curves in. The App adds the pointer work (waiting for a click on the model) and applies the operation.
 */
export type SketchProjectCommand = "project-body" | "project-edge" | "intersect-body" | "silhouette-body" | "convert-face";

export const SKETCH_PROJECT_COMMANDS: readonly SketchProjectCommand[] = ["project-body", "project-edge", "intersect-body", "silhouette-body", "convert-face"];

export const isSketchProjectCommand = (command: string): command is SketchProjectCommand => (SKETCH_PROJECT_COMMANDS as readonly string[]).includes(command);

const MODE_OF: Readonly<Record<SketchProjectCommand, ProjectionMode>> = {
  "project-body": "project",
  "project-edge": "project",
  "intersect-body": "intersect",
  "silhouette-body": "silhouette",
  "convert-face": "convert"
};

/** The commands that need a click on the model: a picked edge, or a picked face. */
export const needsPick = (command: SketchProjectCommand): boolean => command === "project-edge" || command === "convert-face";

export type SourceBody = { readonly ok: true; readonly body: GeneralSolidBody } | { readonly ok: false; readonly message: string };

/** The body a command works on: the selected solid, or the only visible one. */
export function sourceBodyOf(project: WorkbenchProject, selectedId: string | null): SourceBody {
  const bodies = project.part.generalBodies ?? [];
  if (bodies.length === 0) return { ok: false, message: "There is no solid body to bring into the sketch. Extrude a profile first." };
  const selected = bodies.find((body) => body.id === selectedId);
  if (selected !== undefined) return { ok: true, body: selected };
  const visible = bodies.filter((body) => body.visible);
  if (visible.length === 1) return { ok: true, body: visible[0]! };
  return { ok: false, message: "Select the solid body to bring into the sketch (click it in the browser tree), then choose the command again." };
}

/** The sharp convex edges of a body, as the picking guides and their runs; a message when there are none or too many. */
export function edgesToPick(body: GeneralSolidBody): ReturnType<typeof pickableEdges> {
  return pickableEdges({ positionsMm: body.positionsMm, indices: body.indices });
}

/** The edges of the whole run (chain) of the edge nearest a picked point, ready to project. */
export function pickedEdgeRun(body: GeneralSolidBody, pointMm: readonly [number, number, number]): { readonly segments: readonly Segment3[]; readonly pieces: number } | string {
  const edges = edgesToPick(body);
  if (typeof edges === "string") return edges;
  const nearest = nearestPickableEdge(edges, pointMm);
  if (nearest === undefined) return `${body.name} has no sharp convex edge to pick.`;
  return { segments: nearest.chain.map((edge): Segment3 => [edge.a, edge.b]), pieces: nearest.chain.length };
}

export interface SketchProjectPick {
  readonly pointMm: readonly [number, number, number];
  readonly faceIndex?: number | null | undefined;
  /** Project edge: the run of edges the click chose. */
  readonly edges?: readonly Segment3[] | undefined;
}

export type SketchProjectPlan =
  | { readonly ok: true; readonly operation: Omit<Extract<WorkbenchOperation, { readonly kind: "apply-sketch-edit" }>, "operationId" | "expectedRevision">; readonly summary: string }
  | { readonly ok: false; readonly message: string };

/** The sketch edit that brings the body's curves into the working sketch, or the reason it cannot. */
export function planSketchProject(project: WorkbenchProject, body: GeneralSolidBody, command: SketchProjectCommand, options: { readonly construction: boolean; readonly pick?: SketchProjectPick; readonly newId: () => string }): SketchProjectPlan {
  const pick = options.pick;
  if (needsPick(command) && pick === undefined) return { ok: false, message: command === "convert-face" ? "Pick a face of the body." : "Pick an edge of the body." };
  const planned = planProjection({
    mode: MODE_OF[command],
    body,
    sketch: project.sketch,
    construction: options.construction,
    newId: options.newId,
    room: WORKBENCH_LIMITS.maxEntities - project.sketch.entities.length,
    ...(command === "project-edge" && pick?.edges !== undefined ? { edges: pick.edges } : {}),
    ...(command === "convert-face" && pick !== undefined ? { pointMm: pick.pointMm, faceIndex: pick.faceIndex ?? null } : {})
  });
  if (!planned.ok) return { ok: false, message: planned.message };
  return {
    ok: true,
    operation: { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: planned.plan.entities, addConstraints: [], label: planned.plan.label },
    summary: planned.plan.summary
  };
}
