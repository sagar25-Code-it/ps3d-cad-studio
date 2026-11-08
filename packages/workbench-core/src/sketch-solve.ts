import { solveAnalyticSketch } from "../../parametric-sketch-core/src/solver.js";
import type { SketchRelationSet } from "../../parametric-sketch-core/src/types.js";
import { applyExtraConstraints } from "./sketch-solve-extras.js";
import { toSolverAnchors, type LiveAnchor } from "./sketch-anchors.js";
import { constraintComponent, fromSolverGeometry, liveConstraintId, solverSelector, translateSketch, type UnsolvedConstraint } from "./sketch-translate.js";
import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch } from "./types.js";

export type { UnsolvedConstraint } from "./sketch-translate.js";
export type { LiveAnchor } from "./sketch-anchors.js";

/** A group of relations that overlap (one adds nothing) or contradict, by the IDs of the constraints the user made. */
export interface LiveRelationSet {
  readonly kind: "redundant" | "conflicting";
  readonly constraintIds: readonly string[];
  readonly labels: readonly string[];
  readonly message: string;
  /** For a redundant set: the constraint, made last, that the others already imply. */
  readonly impliedConstraintId?: string;
}

export type LiveSketchSolveReport =
  | {
      readonly ok: true;
      /** The full entity list, with solved geometry substituted. Unchanged entities keep their identity. */
      readonly entities: readonly SketchEntity[];
      readonly movedIds: readonly string[];
      /** Short human-readable lines describing what the solve changed. */
      readonly notes: readonly string[];
      readonly unsolved: readonly UnsolvedConstraint[];
      /** Relations in the solved part of the sketch that overlap (consistent but dependent). */
      readonly redundant: readonly LiveRelationSet[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly relatedIds: readonly string[];
      readonly recovery: string;
    };

export interface LiveSolveOptions {
  /** Which geometry should stay put when a relation can be met several ways (see sketch-anchors.ts). */
  readonly anchors?: readonly LiveAnchor[];
  /** Relaxed constraints to treat as active for this solve (used when restoring them). */
  readonly forceActive?: ReadonlySet<string>;
  /** Entities whose size is kept while their position and direction change (a line turned parallel keeps its length). */
  readonly preserve?: readonly string[];
}

const MOVE_TOLERANCE_MM = 1e-9;

/**
 * Solves the live sketch's geometric constraints with the simultaneous solver.
 *
 * Only the constraint-connected component that contains `focusEntityIds` is solved, so adding a relation never disturbs unrelated
 * geometry. Lines, circles, 3-point arcs, ellipses, rectangles and points take part, together with the sketch origin and axes. Every
 * relation is solved at once and the geometry moves as little as it can. Anything the solver cannot enforce (splines, or a pairing
 * the rule table does not allow) is reported in `unsolved` and left recorded rather than approximated.
 */
export function solveLiveSketch(sketch: WorkbenchSketch, focusEntityIds?: readonly string[], options: LiveSolveOptions = {}): LiveSketchSolveReport {
  return runLiveSolve(sketch, focusEntityIds, undefined, options);
}

/** Where a drag put a defining point: the entity, which of its points, and the position in millimetres. */
export interface LiveDragTarget {
  readonly entityId: string;
  readonly point: SketchPointRef;
  readonly positionMm: Vec2;
}

/**
 * Moves one defining point of a line, circle, arc, rectangle or point entity to `positionMm` and lets every relation that touches
 * it relax around the pinned point: a joint follows the dragged end, an equal-radius circle resizes, a Horizontal line keeps its
 * direction. Nothing is committed; the caller decides what to do with the returned entities, which makes this safe to call on every
 * pointer move. A fixed point, or relations that cannot all hold, are reported instead of forced; when a dimension stops the point
 * from reaching the pointer it goes as near as the relations allow.
 */
export function dragLiveSketch(sketch: WorkbenchSketch, target: LiveDragTarget, options: LiveSolveOptions = {}): LiveSketchSolveReport {
  return runLiveSolve(sketch, [target.entityId], target, options);
}

function runLiveSolve(sketch: WorkbenchSketch, focusEntityIds: readonly string[] | undefined, drag: LiveDragTarget | undefined, options: LiveSolveOptions): LiveSketchSolveReport {
  const base = runSimultaneousSolve(sketch, focusEntityIds, drag, options);
  if (!base.ok) return base;
  // Relations on splines (smooth) and refraction are solved on the simultaneous pass's result.
  const component = constraintComponent(sketch, focusEntityIds);
  const extras = applyExtraConstraints({ entities: base.entities, constraints: sketch.constraints }, (id) => component.has(id));
  if (!extras.ok) return { ok: false, message: extras.message, relatedIds: extras.relatedIds, recovery: extras.recovery };
  if (extras.movedIds.length === 0 && extras.unsolved.length === 0) return base;
  return {
    ok: true,
    entities: extras.entities,
    movedIds: [...new Set([...base.movedIds, ...extras.movedIds])],
    notes: [...base.notes, ...extras.notes],
    unsolved: [...base.unsolved, ...extras.unsolved],
    redundant: base.redundant
  };
}

function runSimultaneousSolve(sketch: WorkbenchSketch, focusEntityIds: readonly string[] | undefined, drag: LiveDragTarget | undefined, options: LiveSolveOptions): LiveSketchSolveReport {
  const component = constraintComponent(sketch, focusEntityIds);
  const translation = translateSketch(sketch, { component, ...(options.forceActive === undefined ? {} : { forceActive: options.forceActive }) });
  const { document, arcFrames, unsolved } = translation;
  const unsolvedList: UnsolvedConstraint[] = [...unsolved];
  if (drag === undefined && document.constraints.length === 0 && document.dimensions.length === 0) {
    return { ok: true, entities: sketch.entities, movedIds: [], notes: [], unsolved: unsolvedList, redundant: [] };
  }
  if (drag !== undefined && !document.geometry.some((candidate) => candidate.id === drag.entityId)) {
    return { ok: false, message: "This kind of curve cannot be dragged by that point.", relatedIds: [drag.entityId], recovery: "Drag a line, circle, arc, rectangle or point." };
  }
  // Unless told otherwise, the curve the caller just edited is the reference and what is joined to it follows.
  const anchors = toSolverAnchors(options.anchors ?? (drag === undefined ? (focusEntityIds ?? []).map((entityId): LiveAnchor => ({ entityId, ref: "self", priority: 2 })) : []));
  // A line joined to others at both ends belongs to a chain or a loop: when the chain is moved or pinned the line travels with it instead of stretching.
  // (A dragged corner still stretches its neighbours.)
  const inDocument = (id: string): boolean => document.geometry.some((candidate) => candidate.id === id);
  const chained = (drag === undefined ? linesJoinedAtBothEnds(sketch) : []).filter(inDocument);
  const preserve = (options.preserve ?? []).filter(inDocument);
  const result = drag === undefined
    ? solveAnalyticSketch({ document, mode: "regenerate", anchors, preserve, preserveWeak: chained, labels: translation.labels })
    : solveAnalyticSketch({ document, mode: "drag", anchors, preserve, labels: translation.labels, dragTarget: { reference: { entityId: drag.entityId, selector: solverSelector(drag.point) }, positionMm: drag.positionMm } });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" && !diagnostic.unsupported);
  if (result.status === "failed" || errors.length > 0) {
    const first = errors[0];
    const related = [...new Set(errors.flatMap((diagnostic) => diagnostic.relatedIds).map(liveConstraintId))].sort();
    const message = errors.length === 0 ? "The sketch constraints could not be solved." : [...new Set(errors.slice(0, 2).map((diagnostic) => diagnostic.message))].join(" ");
    return { ok: false, message, relatedIds: related.length === 0 ? [sketch.id] : related, recovery: first?.recovery ?? "Remove or change one of the conflicting constraints." };
  }
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.unsupported) unsolvedList.push({ constraintId: liveConstraintId(diagnostic.relatedIds[0] ?? sketch.id), reason: diagnostic.message });
  }

  const solvedById = new Map(result.document.geometry.map((solved) => [solved.id, solved]));
  const notes: string[] = [];
  const movedIds: string[] = [];
  const nextEntities = sketch.entities.map((entity) => {
    const solved = solvedById.get(entity.id);
    if (solved === undefined) return entity;
    const replacement = fromSolverGeometry(entity, solved, arcFrames.get(entity.id));
    if (replacement === undefined) return entity;
    movedIds.push(entity.id);
    notes.push(describeChange(entity, replacement));
    return replacement;
  });
  return { ok: true, entities: nextEntities, movedIds, notes, unsolved: unsolvedList, redundant: toLiveSets(result.dof.relationSets ?? [], "redundant") };
}

/** Lines that have a Coincident joint at their start and another at their end. */
function linesJoinedAtBothEnds(sketch: WorkbenchSketch): readonly string[] {
  const ends = new Map<string, Set<string>>();
  for (const constraint of sketch.constraints) {
    if (constraint.kind !== "coincident" || constraint.suppressed === true || constraint.points === undefined) continue;
    constraint.entityIds.forEach((id, index) => {
      const ref = constraint.points?.[index];
      if (ref === "start" || ref === "end") ends.set(id, (ends.get(id) ?? new Set<string>()).add(ref));
    });
  }
  return [...ends.entries()].filter(([, refs]) => refs.has("start") && refs.has("end")).map(([id]) => id);
}

/** Maps the solver's relation sets (solver IDs) onto the constraints the user made. */
export function toLiveSets(sets: readonly SketchRelationSet[], kind: "redundant" | "conflicting"): readonly LiveRelationSet[] {
  const seen = new Set<string>();
  const result: LiveRelationSet[] = [];
  for (const set of sets) {
    if (set.kind !== kind) continue;
    const ids = [...new Set(set.ids.map(liveConstraintId))].sort();
    const key = ids.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    // Several parts of one relation (the two joints of a mirror pair) collapse to one name.
    const labels = [...new Set(set.labels)];
    result.push({ kind, constraintIds: ids, labels, message: set.message, ...(set.implied === undefined ? {} : { impliedConstraintId: liveConstraintId(set.implied) }) });
  }
  return result;
}

function describeChange(before: SketchEntity, after: SketchEntity): string {
  const label = before.id.replace(/^entity:/u, "");
  if (before.kind === "circle" && after.kind === "circle") {
    const resized = Math.abs(before.radiusMm - after.radiusMm) > 1e-6;
    const moved = !near(before.center, after.center, 1e-6);
    if (resized && moved) return `Resized and moved circle ${label} (radius ${format(before.radiusMm)} → ${format(after.radiusMm)} mm)`;
    if (resized) return `Resized circle ${label} from radius ${format(before.radiusMm)} to ${format(after.radiusMm)} mm`;
    return `Moved circle ${label}`;
  }
  if (before.kind === "arc" && after.kind === "arc") return `Adjusted arc ${label}`;
  return `Moved ${before.kind} ${label}`;
}

function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function near(a: Vec2, b: Vec2, tolerance = MOVE_TOLERANCE_MM): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}
