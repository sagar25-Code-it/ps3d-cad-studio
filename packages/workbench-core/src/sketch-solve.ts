import { solveAnalyticSketch } from "../../parametric-sketch-core/src/solver.js";
import type { SketchRelationSet } from "../../parametric-sketch-core/src/types.js";
import { explainOrientationCollapse, ORIENTATION_RECOVERY } from "./sketch-orientation-explain.js";
import { applyExtraConstraints } from "./sketch-solve-extras.js";
import { friendlySolveMessage } from "./sketch-messages.js";
import { livePointOf } from "./sketch-measure.js";
import { toSolverAnchors, type LiveAnchor } from "./sketch-anchors.js";
import { turnAcrossLines } from "./sketch-quarter-turn.js";
import { refractionRefusal, seedRefractions } from "./sketch-refraction.js";
import { constraintComponent, fromSolverGeometry, liveConstraintId, solverSelector, translateSketch, type UnsolvedConstraint } from "./sketch-translate.js";
import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";
import type { SketchGeometry } from "../../parametric-sketch-core/src/types.js";

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
  /**
   * Whether a line joined at both ends is weakly kept at its length, so a chain that is pinned or translated moves rather than stretches.
   * On by default. A dimension edit turns it off: the dimensioned curve is the one thing that changes and its neighbours follow by moving
   * as little as they can, which keeps untouched vertices where they are (a joined polygon never flattens).
   */
  readonly keepChains?: boolean;
  /**
   * Drag only: the entities the previous pointer position produced. Every drag step is solved from the sketch the gesture began with, so
   * it depends only on where the pointer is now; when that answer jumps far from the previous one (the pointer passed over an opposite
   * edge, so the nearest solution is on the other branch) or fails, the step is solved again from the previous solution instead, which
   * moves the sketch continuously.
   */
  readonly continueFrom?: readonly SketchEntity[];
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
  const fresh = runLiveSolve(sketch, [target.entityId], target, options);
  const previous = options.continueFrom;
  if (previous === undefined) return fresh;
  if (fresh.ok && !jumped(fresh.entities, previous, target)) return fresh;
  // Continue from where the last pointer position left the sketch.
  const byId = new Map(previous.map((entity) => [entity.id, entity] as const));
  const resumed: WorkbenchSketch = { ...sketch, entities: sketch.entities.map((entity) => { const earlier = byId.get(entity.id); return earlier !== undefined && earlier.kind === entity.kind ? earlier : entity; }) };
  const second = runLiveSolve(resumed, [target.entityId], target, options);
  if (!second.ok) return fresh;
  if (fresh.ok && displacement(second.entities, previous) >= displacement(fresh.entities, previous)) return fresh;
  return second;
}

/** The pointer moved this many times its own step before a solution counts as a jump, but never less than this many millimetres. */
const JUMP_FACTOR = 6;
const JUMP_FLOOR_MM = 1;

function jumped(next: readonly SketchEntity[], previous: readonly SketchEntity[], target: LiveDragTarget): boolean {
  const earlier = previous.find((entity) => entity.id === target.entityId);
  const held = earlier === undefined ? undefined : livePointOf(earlier, target.point);
  const step = held === undefined ? 0 : Math.hypot(target.positionMm[0] - held[0], target.positionMm[1] - held[1]);
  return displacement(next, previous) > Math.max(JUMP_FLOOR_MM, JUMP_FACTOR * step);
}

/** The largest distance any defining point of an entity travelled between two lists of the same entities. */
function displacement(next: readonly SketchEntity[], previous: readonly SketchEntity[]): number {
  const before = new Map(previous.map((entity) => [entity.id, entity] as const));
  let largest = 0;
  for (const entity of next) {
    const earlier = before.get(entity.id);
    if (earlier === undefined || earlier === entity || earlier.kind !== entity.kind) continue;
    for (const ref of DISPLACEMENT_REFS) {
      const a = livePointOf(entity, ref);
      const b = livePointOf(earlier, ref);
      if (a !== undefined && b !== undefined) largest = Math.max(largest, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    if (entity.kind === "circle" && earlier.kind === "circle") largest = Math.max(largest, Math.abs(entity.radiusMm - earlier.radiusMm));
  }
  return largest;
}

const DISPLACEMENT_REFS: readonly SketchPointRef[] = ["start", "end", "mid", "center", "self", "corner-0", "corner-2"];

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
  // A line lying exactly across the direction a relation asks for is turned to it first, keeping its length (see sketch-quarter-turn.ts).
  const turned = drag === undefined ? turnAcrossLines(sketch, component, options.forceActive).sketch : sketch;
  // A refraction starts from the refracted line it implies, on the correct side of the interface; rays that cannot cross are refused by name.
  const seeded = drag === undefined ? seedRefractions(turned, component, options.forceActive) : { sketch: turned };
  if ("refusal" in seeded) return { ok: false, message: seeded.refusal.message, relatedIds: seeded.refusal.relatedIds, recovery: seeded.refusal.recovery };
  const working = seeded.sketch;
  const translation = translateSketch(working, { component, ...(options.forceActive === undefined ? {} : { forceActive: options.forceActive }) });
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
  const chained = (drag === undefined && options.keepChains !== false ? linesJoinedAtBothEnds(sketch) : []).filter(inDocument);
  const preserve = (options.preserve ?? []).filter(inDocument);
  const result = drag === undefined
    ? solveAnalyticSketch({ document, mode: "regenerate", anchors, preserve, preserveWeak: chained, labels: translation.labels, ...(options.keepChains === false ? { keepShape: true } : {}) })
    : solveAnalyticSketch({ document, mode: "drag", anchors, preserve, labels: translation.labels, keepShape: true, dragTarget: { reference: { entityId: drag.entityId, selector: solverSelector(drag.point) }, positionMm: drag.positionMm } });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" && !diagnostic.unsupported);
  if (result.status === "failed" || errors.length > 0) {
    const first = errors[0];
    const related = [...new Set(errors.flatMap((diagnostic) => diagnostic.relatedIds).map(liveConstraintId))].sort();
    // One group of contradicting relations is named; a second sentence would repeat part of the first.
    const message = errors.length === 0 || first === undefined ? "The sketch constraints could not be solved." : friendlySolveMessage(sketch, first);
    const orientation = errors.some((diagnostic) => /collapse|shrink/u.test(diagnostic.message)) ? explainOrientationCollapse(sketch, related) : undefined;
    if (orientation !== undefined) return { ok: false, message: orientation, relatedIds: related, recovery: ORIENTATION_RECOVERY };
    return { ok: false, message, relatedIds: related.length === 0 ? [sketch.id] : related, recovery: first?.recovery ?? "Remove or change one of the conflicting constraints." };
  }
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.unsupported) unsolvedList.push({ constraintId: liveConstraintId(diagnostic.relatedIds[0] ?? sketch.id), reason: diagnostic.message });
  }

  const solvedById = new Map(result.document.geometry.map((solved) => [solved.id, solved]));
  if (drag === undefined) {
    // A tangent relation between geometry that is far apart must not quietly change the size of a hole or boss: report it instead.
    const active = sketch.constraints.filter((candidate) => candidate.suppressed !== true && candidate.entityIds.some((id) => component.has(id)));
    const resize = excessiveTangentResize(active, sketch.entities, solvedById, arcFrames);
    if (resize !== undefined) return { ok: false, message: resize.message, relatedIds: resize.relatedIds, recovery: "Move the circle (or the line) close to where it should touch first, or dimension the radius so it is held and the other geometry moves instead." };
  }
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
  // A ray the solve had to move so far that it can no longer cross the interface (a dimension on the incident line, say) is refused by name.
  const refusal = refractionRefusal(nextEntities, sketch.constraints, component);
  if (refusal !== undefined) return { ok: false, message: refusal.message, relatedIds: refusal.relatedIds, recovery: refusal.recovery };
  return { ok: true, entities: nextEntities, movedIds, notes, unsolved: unsolvedList, redundant: toLiveSets(result.dof.relationSets ?? [], "redundant") };
}

/** A tangent relation may change a circle or arc by this much (the larger of the two limits: 10 mm, or twice its radius) before it counts as a surprise resize. A smaller change is reported in the status line, as before. */
const TANGENT_RESIZE_ABSOLUTE_MM = 10;
const TANGENT_RESIZE_RELATIVE = 2;

const lengthText = (valueMm: number): string => String(Number(valueMm.toFixed(3)));

/**
 * Finds a circle or arc whose radius a tangent relation would change by a lot although nothing holds that radius (no radius dimension,
 * no equal relation). Small adjustments are the normal way a tangent closes a tiny gap; a jump from 5 mm to 30 mm is the circle being
 * stretched to reach geometry that was far away, which a designer would never want to happen silently.
 */
function excessiveTangentResize(
  constraints: readonly WorkbenchSketchConstraint[],
  entities: readonly SketchEntity[],
  solvedById: ReadonlyMap<string, SketchGeometry>,
  arcFrames: ReadonlyMap<string, { readonly radiusMm: number }>
): { readonly message: string; readonly relatedIds: readonly string[] } | undefined {
  for (const entity of entities) {
    if (entity.kind !== "circle" && entity.kind !== "arc") continue;
    const solved = solvedById.get(entity.id);
    if (solved === undefined || (solved.kind !== "circle" && solved.kind !== "arc")) continue;
    const before = entity.kind === "circle" ? entity.radiusMm : arcFrames.get(entity.id)?.radiusMm;
    if (before === undefined) continue;
    const change = Math.abs(solved.radiusMm - before);
    if (change <= Math.max(TANGENT_RESIZE_ABSOLUTE_MM, before * TANGENT_RESIZE_RELATIVE)) continue;
    const mine = constraints.filter((candidate) => candidate.entityIds.includes(entity.id));
    const tangents = mine.filter((candidate) => candidate.kind === "tangent");
    if (tangents.length === 0) continue;
    const holdsRadius = mine.some((candidate) => (candidate.kind === "radius" && candidate.driven !== true) || candidate.kind === "equal");
    if (holdsRadius) continue;
    const label = entity.id.replace(/^entity:/u, "");
    const others = [...new Set(tangents.flatMap((candidate) => candidate.entityIds).filter((id) => id !== entity.id))].map((id) => id.replace(/^entity:/u, ""));
    return {
      message: `Making ${label} tangent to ${others.join(" and ")} would resize ${entity.kind} ${label} from radius ${lengthText(before)} mm to ${lengthText(solved.radiusMm)} mm, because they are far apart and nothing holds its radius.`,
      relatedIds: [entity.id, ...tangents.map((candidate) => candidate.id)]
    };
  }
  return undefined;
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
