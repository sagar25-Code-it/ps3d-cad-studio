import { isSketchDatumEntityId, type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { solveLiveSketch } from "../../workbench-core/src/sketch-solve.js";
import { analyzeWorkbenchSketch, detectSketchProfiles, sampleSpline } from "./index.js";
import { arcFrame, editPlan, type SketchEditContext, type SketchEditPlan } from "./edit-tools.js";
import { curveEnd, isOpenCurve, jointBetween, withCurveEnd, type CurveEnd } from "./endpoint-join.js";
import { applyPlanToSketch, planHolds } from "./sketch-clone.js";
import { arrangeSketch } from "./profile-detect.js";
import { diagnoseProfiles } from "./profile-diagnostics.js";
import { profileGapToleranceOf } from "./profile-regions.js";

/**
 * Interactive sketch repair (SketchXpert style) and the Validate Sketch report. `analyzeSketch` looks for real problems, each with the
 * constraints or curves involved and, where one can be made to work, one or more one-click fixes. A fix is only offered once it has been
 * checked against the same rules `apply-sketch-edit` uses, so pressing it cannot be refused for a reason the analysis could have seen.
 *
 *  - conflicting relations: the solver cannot satisfy them, or they contradict each other (horizontal and vertical, parallel and perpendicular,
 *    two different radii on circles held equal ...). Fix: relax one of the relations involved (reversible).
 *  - redundant relations: a relation another already implies (a duplicate, a parallel between lines that are both horizontal, a second
 *    dimension on an equal pair ...). Fix: delete it.
 *  - tiny gaps between curve ends that almost meet. Fix: move an end onto the other and join them.
 *  - duplicate curves, and zero-length or degenerate curves. Fix: delete.
 *  - unclosed chains whose two free ends can be joined. Fix: close with a line.
 *  - geometry that does not satisfy its relations yet. Fix: apply the solve.
 */

export type RepairCategory = "conflict" | "redundant" | "gap" | "duplicate" | "degenerate" | "open-chain" | "unsolved-geometry" | "note" | "region";

export type RepairFix =
  | { readonly kind: "edit"; readonly label: string; readonly plan: SketchEditPlan }
  | { readonly kind: "relax"; readonly label: string; readonly constraintIds: readonly string[] };

export interface RepairIssue {
  /** Stable for the same problem, so a panel can keep its place across re-analysis. */
  readonly id: string;
  readonly category: RepairCategory;
  readonly severity: "error" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  readonly entityIds: readonly string[];
  readonly constraintIds: readonly string[];
  /** One-click fixes, best first; empty when none could be made to work. */
  readonly fixes: readonly RepairFix[];
  /** Why there is no fix, when that is worth saying. */
  readonly noFixReason?: string;
}

export interface SketchRepairReport {
  readonly issues: readonly RepairIssue[];
  readonly errors: number;
  readonly warnings: number;
  readonly fixable: number;
  readonly closedProfiles: number;
  readonly degreesOfFreedom: number;
  readonly classification: string;
  /** True when every recorded relation can be solved together. */
  readonly solves: boolean;
  /** No errors. */
  readonly valid: boolean;
  /** Valid, and at least one closed profile exists for a solid feature to use. */
  readonly usableForSolid: boolean;
  /** Plain-language lines for the Validate Sketch report. */
  readonly summary: readonly string[];
}

const COINCIDENT_MM = 1e-4;
const ZERO_MM = 1e-3;
const TINY_MM = 0.1;
const MAX_CULPRIT_TRIALS = 80;

type Open = Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function short(id: string): string {
  const bare = id.replace(/^(entity|constraint):/u, "");
  return bare.length > 18 ? `${bare.slice(0, 12)}…` : bare;
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function describeConstraint(constraint: WorkbenchSketchConstraint): string {
  return `${kindLabel(constraint.kind)} on ${constraint.entityIds.map(short).join(" and ")}`;
}

// ---------------------------------------------------------------------------------------------
// Relation analysis: duplicates, implied relations and contradictions
// ---------------------------------------------------------------------------------------------

type Relate = "new" | "redundant" | "conflict";

/** Angle relations between lines (and the horizontal axis), tracked as differences mod 180 degrees. */
class AngleGraph {
  private readonly parent = new Map<string, string>();
  private readonly offset = new Map<string, number>();

  private static norm(angle: number): number {
    return ((angle % 180) + 180) % 180;
  }

  private find(node: string): { readonly root: string; readonly offset: number } {
    let current = node;
    let total = 0;
    while (this.parent.has(current)) {
      total += this.offset.get(current)!;
      current = this.parent.get(current)!;
    }
    return { root: current, offset: AngleGraph.norm(total) };
  }

  /** Records angle(a) - angle(b) = difference, and says whether that was news, already implied, or contradicts what is known. */
  relate(a: string, b: string, difference: number): Relate {
    const left = this.find(a);
    const right = this.find(b);
    if (left.root === right.root) {
      const actual = AngleGraph.norm(left.offset - right.offset);
      const wanted = AngleGraph.norm(difference);
      const gap = Math.min(Math.abs(actual - wanted), 180 - Math.abs(actual - wanted));
      return gap < 1e-9 ? "redundant" : "conflict";
    }
    this.parent.set(left.root, right.root);
    this.offset.set(left.root, AngleGraph.norm(difference - left.offset + right.offset));
    return "new";
  }
}

/** Equal-size classes (lengths of lines, radii of circles and arcs) and the driving value each class has been given. */
class SizeClasses {
  private readonly parent = new Map<string, string>();
  private readonly value = new Map<string, number>();

  private find(id: string): string {
    let current = id;
    while (this.parent.has(current)) current = this.parent.get(current)!;
    return current;
  }

  equal(a: string, b: string): Relate {
    const left = this.find(a);
    const right = this.find(b);
    if (left === right) return "redundant";
    const lv = this.value.get(left);
    const rv = this.value.get(right);
    if (lv !== undefined && rv !== undefined) return Math.abs(lv - rv) < 1e-9 ? "redundant" : "conflict";
    this.parent.set(left, right);
    if (lv !== undefined) this.value.set(right, lv);
    return "new";
  }

  dimension(id: string, valueMm: number): Relate {
    const root = this.find(id);
    const known = this.value.get(root);
    if (known === undefined) { this.value.set(root, valueMm); return "new"; }
    return Math.abs(known - valueMm) < 1e-9 ? "redundant" : "conflict";
  }
}

interface RelationFinding {
  readonly kind: "redundant" | "conflict";
  readonly constraint: WorkbenchSketchConstraint;
  readonly reason: string;
  /** Other relations that take part, for the alternative fixes. */
  readonly with: readonly WorkbenchSketchConstraint[];
}

function constraintSignature(constraint: WorkbenchSketchConstraint): string {
  const symmetric = ["parallel", "perpendicular", "collinear", "equal", "tangent", "concentric", "coincident"].includes(constraint.kind);
  const members = constraint.entityIds.map((id, index) => `${id}@${constraint.points?.[index] ?? ""}`);
  const ordered = symmetric ? [...members].sort() : members;
  return `${constraint.kind}|${ordered.join(",")}|${constraint.dimension ?? ""}`;
}

function findRelationProblems(sketch: WorkbenchSketch): readonly RelationFinding[] {
  const findings: RelationFinding[] = [];
  const entities = new Map(sketch.entities.map((entity) => [entity.id, entity] as const));
  const active = sketch.constraints.filter((constraint) => constraint.suppressed !== true && constraint.entityIds.every((id) => entities.has(id)));
  const angles = new AngleGraph();
  const sizes = new SizeClasses();
  const seen = new Map<string, WorkbenchSketchConstraint>();
  const orientationOf = (id: string): WorkbenchSketchConstraint[] => active.filter((c) => (c.kind === "horizontal" || c.kind === "vertical" || c.kind === "parallel" || c.kind === "perpendicular") && c.entityIds.includes(id));
  for (const constraint of active) {
    // An exact repeat of an earlier relation, whatever it is.
    const signature = constraintSignature(constraint);
    const earlier = seen.get(signature);
    if (earlier !== undefined && constraint.kind !== "radius" && constraint.kind !== "distance") {
      findings.push({ kind: "redundant", constraint, reason: `${describeConstraint(constraint)} repeats ${short(earlier.id)}.`, with: [earlier] });
      continue;
    }
    seen.set(signature, earlier ?? constraint);
    let outcome: Relate | undefined;
    let others: WorkbenchSketchConstraint[] = [];
    const [first, second] = constraint.entityIds;
    const bothLines = (): boolean => constraint.entityIds.length === 2 && constraint.entityIds.every((id) => entities.get(id)?.kind === "line");
    if ((constraint.kind === "horizontal" || constraint.kind === "vertical") && first !== undefined && entities.get(first)?.kind === "line") {
      outcome = angles.relate(first, "axis:x", constraint.kind === "horizontal" ? 0 : 90);
      others = orientationOf(first).filter((c) => c.id !== constraint.id);
    } else if ((constraint.kind === "parallel" || constraint.kind === "perpendicular") && bothLines()) {
      outcome = angles.relate(first!, second!, constraint.kind === "parallel" ? 0 : 90);
      others = [...orientationOf(first!), ...orientationOf(second!)].filter((c) => c.id !== constraint.id);
    } else if (constraint.kind === "collinear" && bothLines()) {
      // Collinear also fixes a position, so an implied direction does not make it redundant; it can still contradict one.
      if (angles.relate(first!, second!, 0) === "conflict") outcome = "conflict";
      others = [...orientationOf(first!), ...orientationOf(second!)].filter((c) => c.id !== constraint.id);
    } else if (constraint.kind === "equal" && constraint.entityIds.length === 2) {
      outcome = sizes.equal(first!, second!);
      others = active.filter((c) => c.id !== constraint.id && (c.kind === "equal" || c.kind === "radius" || c.kind === "distance") && c.entityIds.some((id) => constraint.entityIds.includes(id)));
    } else if ((constraint.kind === "radius" || constraint.kind === "distance") && constraint.valueMm !== undefined && constraint.entityIds.length === 1 && (constraint.kind === "radius" || constraint.dimension === "length") && entities.get(first!)?.kind !== "rectangle") {
      outcome = sizes.dimension(first!, constraint.valueMm);
      others = active.filter((c) => c.id !== constraint.id && (c.kind === "equal" || c.kind === "radius" || c.kind === "distance") && c.entityIds.some((id) => constraint.entityIds.includes(id)));
      if (outcome === "redundant" && earlier !== undefined) outcome = "redundant";
    }
    if (outcome === "redundant") findings.push({ kind: "redundant", constraint, reason: `${describeConstraint(constraint)} is already implied by the other relations${constraint.valueMm === undefined ? "" : ` (${fmt(constraint.valueMm)} mm)`}.`, with: others });
    else if (outcome === "conflict") findings.push({ kind: "conflict", constraint, reason: `${describeConstraint(constraint)} contradicts the relations already on ${constraint.entityIds.map(short).join(" and ")}.`, with: others });
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Curve geometry checks
// ---------------------------------------------------------------------------------------------

function measureOf(entity: SketchEntity): number | undefined {
  switch (entity.kind) {
    case "line": return dist(entity.start, entity.end);
    case "arc": {
      const frame = arcFrame(entity);
      return frame === undefined ? 0 : frame.radius * frame.sweep;
    }
    case "circle": return entity.radiusMm;
    case "rectangle": return Math.min(entity.widthMm, entity.heightMm);
    case "ellipse": return Math.min(entity.majorRadiusMm, entity.minorRadiusMm);
    case "spline": {
      const samples = sampleSpline(entity.fitPoints);
      let total = 0;
      for (let index = 1; index < samples.length; index += 1) total += dist(samples[index - 1]!, samples[index]!);
      return total;
    }
    default: return undefined;
  }
}

function sameCurve(a: SketchEntity, b: SketchEntity, tolerance: number): boolean {
  if (a.kind !== b.kind || a.construction !== b.construction) return false;
  const close = (p: Vec2, q: Vec2): boolean => dist(p, q) <= tolerance;
  switch (a.kind) {
    case "line": { const o = b as typeof a; return (close(a.start, o.start) && close(a.end, o.end)) || (close(a.start, o.end) && close(a.end, o.start)); }
    case "arc": { const o = b as typeof a; return close(a.mid, o.mid) && ((close(a.start, o.start) && close(a.end, o.end)) || (close(a.start, o.end) && close(a.end, o.start))); }
    case "circle": { const o = b as typeof a; return close(a.center, o.center) && Math.abs(a.radiusMm - o.radiusMm) <= tolerance; }
    case "point": return close(a.point, (b as typeof a).point);
    case "rectangle": { const o = b as typeof a; return close(a.center, o.center) && ((Math.abs(a.widthMm - o.widthMm) <= tolerance && Math.abs(a.heightMm - o.heightMm) <= tolerance && Math.min(Math.abs(a.rotationDeg - o.rotationDeg) % 180, 180 - (Math.abs(a.rotationDeg - o.rotationDeg) % 180)) < 1e-6) || (Math.abs(a.widthMm - o.heightMm) <= tolerance && Math.abs(a.heightMm - o.widthMm) <= tolerance && Math.min(Math.abs(a.rotationDeg - o.rotationDeg - 90) % 180, 180 - (Math.abs(a.rotationDeg - o.rotationDeg - 90) % 180)) < 1e-6)); }
    case "ellipse": { const o = b as typeof a; return close(a.center, o.center) && Math.abs(a.majorRadiusMm - o.majorRadiusMm) <= tolerance && Math.abs(a.minorRadiusMm - o.minorRadiusMm) <= tolerance && Math.abs(a.rotationDeg - o.rotationDeg) < 1e-6; }
    case "spline": {
      const o = b as typeof a;
      if (a.fitPoints.length !== o.fitPoints.length) return false;
      const forward = a.fitPoints.every((point, index) => close(point, o.fitPoints[index]!));
      const backward = a.fitPoints.every((point, index) => close(point, o.fitPoints[o.fitPoints.length - 1 - index]!));
      return forward || backward;
    }
    default: return false;
  }
}

interface EndRef {
  readonly entity: Open;
  readonly which: CurveEnd;
  readonly point: Vec2;
}

function endsOfSketch(sketch: WorkbenchSketch): readonly EndRef[] {
  const result: EndRef[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction || entity.visible === false || !isOpenCurve(entity)) continue;
    for (const which of ["first", "last"] as const) result.push({ entity, which, point: curveEnd(entity, which) });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------------------------

export function analyzeSketch(context: SketchEditContext): SketchRepairReport {
  const sketch = context.sketch;
  const issues: RepairIssue[] = [];
  const snap = Math.max(sketch.snapToleranceMm, 1e-6);
  const gapLimit = Math.max(snap * 2, 1.5);
  const profileTolerance = profileGapToleranceOf(sketch);
  const verified = (plan: SketchEditPlan): boolean => planHolds(sketch, plan).ok;

  // Relations that do not reference any curve still in the sketch.
  const entityIds = new Set(sketch.entities.map((entity) => entity.id));
  const orphans = sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => !entityIds.has(id) && !isSketchDatumEntityId(id)));
  if (orphans.length > 0) {
    const plan = editPlan(`Removed ${orphans.length} orphan relation${orphans.length === 1 ? "" : "s"}`, { removeConstraintIds: orphans.map((constraint) => constraint.id) });
    issues.push({
      id: "note:orphans", category: "redundant", severity: "error", title: `${orphans.length} relation${orphans.length === 1 ? "" : "s"} refer to a curve that no longer exists`,
      detail: orphans.map(describeConstraint).join("; "), entityIds: [], constraintIds: orphans.map((constraint) => constraint.id),
      fixes: plan.ok ? [{ kind: "edit", label: "Delete the orphan relations", plan: plan.value }] : []
    });
  }

  // Redundant and contradictory relations found by reasoning about directions and sizes.
  const known = new Set<string>();
  for (const finding of findRelationProblems(sketch)) {
    known.add(finding.constraint.id);
    if (finding.kind === "redundant") {
      const plan = editPlan(`Deleted a redundant ${finding.constraint.kind} relation`, { removeConstraintIds: [finding.constraint.id] });
      issues.push({
        id: `redundant:${finding.constraint.id}`, category: "redundant", severity: "warning", title: `Over-defined: ${describeConstraint(finding.constraint)} is redundant`, detail: finding.reason,
        entityIds: finding.constraint.entityIds, constraintIds: [finding.constraint.id, ...finding.with.map((c) => c.id)],
        fixes: plan.ok && verified(plan.value) ? [{ kind: "edit", label: `Delete the redundant ${finding.constraint.kind}`, plan: plan.value }, { kind: "relax", label: "Relax it instead (keep, but ignore)", constraintIds: [finding.constraint.id] }] : [{ kind: "relax", label: "Relax it (keep, but ignore)", constraintIds: [finding.constraint.id] }]
      });
    } else {
      const alternatives = finding.with.slice(0, 3);
      issues.push({
        id: `conflict:${finding.constraint.id}`, category: "conflict", severity: "error", title: `Conflict: ${describeConstraint(finding.constraint)}`, detail: finding.reason,
        entityIds: finding.constraint.entityIds, constraintIds: [finding.constraint.id, ...alternatives.map((c) => c.id)],
        fixes: [
          { kind: "relax", label: `Relax the ${finding.constraint.kind} just added`, constraintIds: [finding.constraint.id] },
          ...alternatives.map((other): RepairFix => ({ kind: "relax", label: `Relax ${describeConstraint(other)}`, constraintIds: [other.id] }))
        ]
      });
    }
  }

  // Relations the Jacobian rank shows to be implied by others (loops of dimensions that close, duplicates the pairwise rules cannot see).
  const rankReport = analyzeWorkbenchSketch(sketch);
  for (const set of rankReport.redundant) {
    const implied = sketch.constraints.find((candidate) => candidate.id === (set.impliedConstraintId ?? set.constraintIds[set.constraintIds.length - 1]));
    if (implied === undefined || known.has(implied.id)) continue;
    known.add(implied.id);
    const plan = editPlan(`Deleted a redundant ${implied.kind} relation`, { removeConstraintIds: [implied.id] });
    issues.push({
      id: `redundant:${implied.id}`, category: "redundant", severity: "warning", title: `Over-defined: ${describeConstraint(implied)} is redundant`, detail: set.message,
      entityIds: implied.entityIds.filter((id) => entityIds.has(id)), constraintIds: [...set.constraintIds],
      fixes: plan.ok && verified(plan.value)
        ? [{ kind: "edit", label: `Delete the redundant ${implied.kind}`, plan: plan.value }, { kind: "relax", label: "Relax it instead (keep, but ignore)", constraintIds: [implied.id] }]
        : [{ kind: "relax", label: "Relax it (keep, but ignore)", constraintIds: [implied.id] }]
    });
  }

  // The solver's own verdict: relations that cannot be satisfied together, or geometry that does not satisfy them yet.
  const solved = solveLiveSketch(sketch);
  let solves = true;
  if (!solved.ok) {
    solves = false;
    const alreadyExplained = [...known].length > 0 && issues.some((issue) => issue.category === "conflict");
    if (!alreadyExplained) {
      const live = sketch.constraints.filter((constraint) => constraint.suppressed !== true);
      const touching = solved.relatedIds.length === 0 ? live : live.filter((constraint) => solved.relatedIds.includes(constraint.id) || constraint.entityIds.some((id) => solved.relatedIds.includes(id)));
      const suspects = (touching.length === 0 ? live : touching).slice(0, MAX_CULPRIT_TRIALS);
      const culprits = suspects.filter((candidate) => {
        const trial = { ...sketch, constraints: sketch.constraints.map((constraint) => (constraint.id === candidate.id ? { ...constraint, suppressed: true } : constraint)) };
        return solveLiveSketch(trial).ok;
      });
      issues.push({
        id: "conflict:solver", category: "conflict", severity: "error", title: "The relations cannot all be satisfied", detail: solved.message,
        entityIds: [...new Set([...solved.relatedIds.filter((id) => entityIds.has(id)), ...live.filter((constraint) => solved.relatedIds.includes(constraint.id)).flatMap((constraint) => constraint.entityIds.filter((id) => entityIds.has(id)))])], constraintIds: culprits.map((constraint) => constraint.id),
        fixes: culprits.slice(0, 4).map((constraint): RepairFix => ({ kind: "relax", label: `Relax ${describeConstraint(constraint)}`, constraintIds: [constraint.id] })),
        ...(culprits.length === 0 ? { noFixReason: "No single relation fixes it; relax several of the ones on the highlighted curves." } : {})
      });
    }
  } else if (solved.movedIds.length > 0) {
    const moved = new Set(solved.movedIds);
    const plan = editPlan(`Applied the constraint solve to ${moved.size} curve${moved.size === 1 ? "" : "s"}`, { updateEntities: solved.entities.filter((entity) => moved.has(entity.id)) });
    issues.push({
      id: "unsolved-geometry", category: "unsolved-geometry", severity: "warning", title: `${moved.size} curve${moved.size === 1 ? "" : "s"} do not satisfy their relations yet`,
      detail: `${solved.notes.slice(0, 4).join("; ")}${solved.notes.length > 4 ? "; ..." : ""}. They would move the next time the sketch is solved.`,
      entityIds: solved.movedIds, constraintIds: [],
      fixes: plan.ok && verified(plan.value) ? [{ kind: "edit", label: "Apply the solve now", plan: plan.value }] : []
    });
  }
  if (solved.ok) {
    for (const entry of solved.unsolved) {
      issues.push({ id: `note:unsolved:${entry.constraintId}`, category: "note", severity: "info", title: "Recorded but not solved", detail: entry.reason, entityIds: [], constraintIds: sketch.constraints.some((c) => c.id === entry.constraintId) ? [entry.constraintId] : [], fixes: [] });
    }
  }

  // Duplicate curves.
  const tolerance = Math.min(snap, 0.01);
  const countRelations = (id: string): number => sketch.constraints.filter((constraint) => constraint.entityIds.includes(id)).length;
  const duplicated = new Set<string>();
  sketch.entities.forEach((entity, index) => {
    if (duplicated.has(entity.id)) return;
    for (const other of sketch.entities.slice(index + 1)) {
      if (duplicated.has(other.id) || !sameCurve(entity, other, tolerance)) continue;
      const drop = countRelations(entity.id) < countRelations(other.id) ? entity : other;
      const keep = drop === entity ? other : entity;
      duplicated.add(drop.id);
      const lost = countRelations(drop.id);
      const plan = editPlan(`Deleted a duplicate ${drop.kind}`, { removeEntityIds: [drop.id] });
      issues.push({
        id: `duplicate:${drop.id}`, category: "duplicate", severity: "warning", title: `Duplicate ${drop.kind}: ${short(drop.id)} repeats ${short(keep.id)}`,
        detail: `They are the same curve drawn twice${lost === 0 ? "" : `; deleting ${short(drop.id)} also removes its ${lost} relation${lost === 1 ? "" : "s"}`}.`,
        entityIds: [drop.id, keep.id], constraintIds: [], fixes: plan.ok ? [{ kind: "edit", label: `Delete ${short(drop.id)}`, plan: plan.value }] : []
      });
    }
  });

  // Zero-length and degenerate curves.
  for (const entity of sketch.entities) {
    if (duplicated.has(entity.id)) continue;
    const size = measureOf(entity);
    if (size === undefined || size >= TINY_MM) continue;
    const zero = size < ZERO_MM;
    const plan = editPlan(`Deleted a ${zero ? "zero-length" : "tiny"} ${entity.kind}`, { removeEntityIds: [entity.id] });
    issues.push({
      id: `degenerate:${entity.id}`, category: "degenerate", severity: zero ? "error" : "warning",
      title: `${zero ? "Zero-length" : "Tiny"} ${entity.kind}: ${short(entity.id)}`,
      detail: zero ? `${kindLabel(entity.kind)} ${short(entity.id)} has no usable size (${fmt(size)} mm) and breaks profiles.` : `${kindLabel(entity.kind)} ${short(entity.id)} is only ${fmt(size)} mm; it is almost certainly a stray.`,
      entityIds: [entity.id], constraintIds: [], fixes: plan.ok ? [{ kind: "edit", label: `Delete ${short(entity.id)}`, plan: plan.value }] : []
    });
  }

  // Gaps between curve ends that almost meet.
  // Only ends that really are free count: one that sits on another curve (a rib on an edge), that an overlap covers, or that joins its own
  // curve (a closed spline) is part of a region and needs no gap fix.
  const freeVertexPoints = arrangeSketch(sketch).vertices.filter((vertex) => vertex.degree === 1).map((vertex) => vertex.point);
  const isFreeEnd = (point: Vec2): boolean => freeVertexPoints.some((free) => dist(free, point) <= Math.max(profileTolerance * 2, 1e-6));
  const ends = endsOfSketch(sketch).filter((end) => !duplicated.has(end.entity.id) && (measureOf(end.entity) ?? 1) >= ZERO_MM);
  const partnersWithin = (end: EndRef, limit: number): EndRef[] => ends.filter((other) => other.entity.id !== end.entity.id && dist(other.point, end.point) <= limit);
  const gapPairs = new Set<string>();
  const gapJoins: { readonly a: string; readonly b: string }[] = [];
  const gapEnds = new Set<EndRef>();
  for (const end of ends) {
    if (!isFreeEnd(end.point) || partnersWithin(end, COINCIDENT_MM).length > 0) continue;
    const candidates = partnersWithin(end, gapLimit).filter((other) => isFreeEnd(other.point) && partnersWithin(other, COINCIDENT_MM).length === 0).sort((a, b) => dist(a.point, end.point) - dist(b.point, end.point));
    const partner = candidates[0];
    if (partner === undefined) continue;
    const mutual = ends.filter((other) => other.entity.id !== partner.entity.id && dist(other.point, partner.point) <= gapLimit && isFreeEnd(other.point) && partnersWithin(other, COINCIDENT_MM).length === 0).sort((a, b) => dist(a.point, partner.point) - dist(b.point, partner.point))[0];
    if (mutual !== end) continue;
    const key = [end.entity.id + end.which, partner.entity.id + partner.which].sort().join("|");
    if (gapPairs.has(key)) continue;
    gapPairs.add(key);
    gapJoins.push({ a: end.entity.id, b: partner.entity.id });
    gapEnds.add(end);
    gapEnds.add(partner);
    const gap = dist(end.point, partner.point);
    const middle: Vec2 = [(end.point[0] + partner.point[0]) / 2, (end.point[1] + partner.point[1]) / 2];
    const variants: { readonly label: string; readonly moves: readonly { readonly end: EndRef; readonly to: Vec2 }[] }[] = [
      { label: `Move ${short(partner.entity.id)}'s end onto ${short(end.entity.id)}`, moves: [{ end: partner, to: end.point }] },
      { label: `Move ${short(end.entity.id)}'s end onto ${short(partner.entity.id)}`, moves: [{ end, to: partner.point }] },
      { label: "Move both ends to the middle of the gap", moves: [{ end, to: middle }, { end: partner, to: middle }] }
    ];
    const fixes: RepairFix[] = [];
    let blocked: string | undefined;
    const pinned = (id: string): boolean => sketch.constraints.some((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true && constraint.entityIds.includes(id));
    for (const variant of variants) {
      const updates: SketchEntity[] = [];
      let ok = true;
      const pinnedMove = variant.moves.find((move) => pinned(move.end.entity.id));
      if (pinnedMove !== undefined) { blocked ??= `${short(pinnedMove.end.entity.id)} is fixed in place.`; continue; }
      for (const move of variant.moves) {
        const moved = withCurveEnd(move.end.entity, move.end.which, move.to);
        if (moved === undefined) { ok = false; break; }
        updates.push(moved);
      }
      if (!ok) continue;
      const joint = jointBetween(context, updates.find((u) => u.id === end.entity.id) ?? end.entity, end.which, updates.find((u) => u.id === partner.entity.id) ?? partner.entity, partner.which);
      const withJoint = editPlan(`Closed a ${fmt(gap)} mm gap`, { updateEntities: updates, addConstraints: joint === undefined ? [] : [joint] });
      const without = editPlan(`Closed a ${fmt(gap)} mm gap`, { updateEntities: updates });
      if (withJoint.ok && verified(withJoint.value)) fixes.push({ kind: "edit", label: variant.label, plan: withJoint.value });
      else if (without.ok && verified(without.value)) fixes.push({ kind: "edit", label: `${variant.label} (not joined by a relation)`, plan: without.value });
      else if (blocked === undefined && without.ok) { const check = planHolds(sketch, without.value); if (!check.ok) blocked = check.reason; }
    }
    issues.push({
      id: `gap:${key}`, category: "gap", severity: "warning", title: `Gap of ${fmt(gap)} mm between ${short(end.entity.id)} and ${short(partner.entity.id)}`,
      detail: `The ends at (${fmt(end.point[0])}, ${fmt(end.point[1])}) and (${fmt(partner.point[0])}, ${fmt(partner.point[1])}) almost meet but do not touch${gap <= profileTolerance ? ` (within the ${fmt(profileTolerance)} mm that profiles close by themselves, so the profile still joins, but the geometry is not exact)` : `, so the chain is not closed (profiles join only across gaps up to ${fmt(profileTolerance)} mm)`}.`,
      entityIds: [end.entity.id, partner.entity.id], constraintIds: [], fixes: fixes.slice(0, 3),
      ...(fixes.length === 0 ? { noFixReason: `Relations stop either end from moving${blocked === undefined ? "" : `: ${blocked}`} Relax them first.` } : {})
    });
  }

  // Open chains: connected groups of curves with free ends left over.
  const groupOf = new Map<string, string>();
  const root = (id: string): string => { let current = id; while (groupOf.get(current) !== current) current = groupOf.get(current)!; return current; };
  for (const end of ends) groupOf.set(end.entity.id, end.entity.id);
  const join = (a: string, b: string): void => { const ra = root(a); const rb = root(b); if (ra !== rb) groupOf.set(ra, rb); };
  for (const end of ends) for (const other of partnersWithin(end, snap)) join(end.entity.id, other.entity.id);
  for (const pair of gapJoins) join(pair.a, pair.b);
  const groups = new Map<string, EndRef[]>();
  for (const end of ends) { const key = root(end.entity.id); groups.set(key, [...(groups.get(key) ?? []), end]); }
  const detectedNow = detectSketchProfiles(sketch);
  for (const members of groups.values()) {
    const curveIds = [...new Set(members.map((end) => end.entity.id))];
    const freeEnds = members.filter((end) => !gapEnds.has(end) && partnersWithin(end, snap).length === 0 && isFreeEnd(end.point));
    if (freeEnds.length === 0) continue;
    const lone = curveIds.length === 1 && members[0]!.entity.kind === "line";
    if (lone) continue;
    if (freeEnds.length === 2 && dist(freeEnds[0]!.point, freeEnds[1]!.point) > gapLimit) {
      const [a, b] = freeEnds as [EndRef, EndRef];
      const closing: SketchEntity = { id: context.newId("entity"), kind: "line", start: a.point, end: b.point, construction: false };
      const constraints = [jointBetween(context, a.entity, a.which, closing, "first"), jointBetween(context, b.entity, b.which, closing, "last")].filter((c): c is WorkbenchSketchConstraint => c !== undefined);
      const withJoints = editPlan("Closed the chain with a line", { addEntities: [closing], addConstraints: constraints });
      const bare = editPlan("Closed the chain with a line", { addEntities: [closing] });
      const profilesNow = detectSketchProfiles(sketch).length;
      let fix: RepairFix | undefined;
      for (const candidate of [withJoints, bare]) {
        if (!candidate.ok || !verified(candidate.value)) continue;
        const next = applyPlanToSketch(sketch, candidate.value);
        if (typeof next !== "string" && detectSketchProfiles(next.sketch).length > profilesNow) { fix = { kind: "edit", label: "Close the chain with a line", plan: candidate.value }; break; }
      }
      issues.push({
        id: `open-chain:${curveIds.slice().sort().join("|")}`, category: "open-chain", severity: "warning", title: `Open chain of ${curveIds.length} curve${curveIds.length === 1 ? "" : "s"}`,
        detail: `The chain is open at (${fmt(a.point[0])}, ${fmt(a.point[1])}) and (${fmt(b.point[0])}, ${fmt(b.point[1])}), ${fmt(dist(a.point, b.point))} mm apart, so it does not enclose a profile.`,
        entityIds: curveIds, constraintIds: [], fixes: fix === undefined ? [] : [fix],
        ...(fix === undefined ? { noFixReason: "A closing line between the two ends would not make a valid closed profile (it would cross other curves)." } : {})
      });
    } else {
      // A chain that already bounds a region and only has a stub left over is not a broken loop; it is worth a note, not a warning.
      const stub = detectedNow.some((profile) => profile.entityIds.some((id) => curveIds.includes(id)));
      issues.push({
        detail: `Free ends at ${freeEnds.map((end) => `(${fmt(end.point[0])}, ${fmt(end.point[1])})`).join(", ")}. ${stub ? "They bound no region of their own; trim them if they are leftovers." : "A branching or single-ended chain cannot be closed automatically."}`,
        id: `open-chain:${curveIds.slice().sort().join("|")}`, category: "open-chain", severity: stub ? "info" : "warning", title: stub ? `Free end on a closed outline (${freeEnds.length})` : `Open chain of ${curveIds.length} curve${curveIds.length === 1 ? "" : "s"} with ${freeEnds.length} free end${freeEnds.length === 1 ? "" : "s"}`,
        entityIds: curveIds, constraintIds: [], fixes: [], noFixReason: "Join or trim the free ends by hand (Extend, Trim or Corner)."
      });
    }
  }

  // Regions: what the curves split into, what stops them closing, and what is doubled or crossed.
  const diagnosis = diagnoseProfiles(sketch);
  // Crossings and junctions are handled, not faults; a grid of lines has hundreds, so each kind is one entry that counts them.
  const handled = new Map<"crossing" | "junction", typeof diagnosis.problems[number][]>();
  for (const problem of diagnosis.problems) {
    if (problem.code === "gap" || problem.code === "open-end") continue; // the gap and open-chain checks above already say it, with fixes
    if (problem.severity === "info" && (problem.code === "crossing" || problem.code === "junction")) {
      handled.set(problem.code, [...(handled.get(problem.code) ?? []), problem]);
      continue;
    }
    issues.push({
      id: `region:${problem.code}:${[...problem.entityIds].sort().join("|")}:${problem.at === undefined ? "" : `${fmt(problem.at[0])},${fmt(problem.at[1])}`}`,
      category: "region", severity: problem.severity, title: problem.code === "crossing" ? "Curves cross: the regions are split" : problem.code === "junction" ? "Curves meet at a junction" : problem.code === "overlap" ? "Curves overlap" : problem.code === "near-meet" ? "Curves nearly meet: intersections were merged" : problem.code === "self-crossing" ? "A curve crosses itself" : problem.code === "short" ? "A curve stops short of another" : "A curve is ignored",
      detail: problem.message, entityIds: problem.entityIds, constraintIds: [], fixes: []
    });
  }
  for (const [code, group] of handled) {
    if (group.length === 1) {
      const only = group[0]!;
      issues.push({
        id: `region:${code}:${[...only.entityIds].sort().join("|")}:${only.at === undefined ? "" : `${fmt(only.at[0])},${fmt(only.at[1])}`}`,
        category: "region", severity: "info", title: code === "crossing" ? "Curves cross: the regions are split" : "Curves meet at a junction",
        detail: only.message, entityIds: only.entityIds, constraintIds: [], fixes: []
      });
      continue;
    }
    const listed = group.slice(0, 4).map((problem) => problem.at === undefined ? "" : `(${fmt(problem.at[0])}, ${fmt(problem.at[1])})`).filter((place) => place !== "").join(", ");
    const entityIds = [...new Set(group.flatMap((problem) => problem.entityIds))].slice(0, 200);
    issues.push({
      id: `region:${code}`, category: "region", severity: "info",
      title: code === "crossing" ? `Curves cross at ${group.length} places: the regions are split` : `Curves meet at ${group.length} junctions`,
      detail: `${code === "crossing" ? "The regions are split where curves cross or meet" : "The regions on each side of every curve are separate at junctions"}: ${listed}${group.length > 4 ? ` and ${group.length - 4} more` : ""}. This is handled; nothing needs fixing.`,
      entityIds, constraintIds: [], fixes: []
    });
  }
  const noRegionExplained = issues.some((issue) => issue.category === "gap" || issue.category === "open-chain" || issue.category === "region" && issue.severity === "warning");
  if (diagnosis.profileCount === 0 && diagnosis.noProfileReasons.length > 0 && !noRegionExplained) {
    issues.push({ id: "region:none", category: "region", severity: "warning", title: "No closed region", detail: diagnosis.noProfileReasons.join(" "), entityIds: [], constraintIds: [], fixes: [] });
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const fixable = issues.filter((issue) => issue.fixes.length > 0).length;
  const profiles = detectSketchProfiles(sketch);
  const analysis = rankReport;
  const valid = errors === 0;
  const usableForSolid = valid && profiles.length > 0;
  const summary = [
    valid ? "No errors." : `${errors} error${errors === 1 ? "" : "s"} to fix before this sketch is dependable.`,
    warnings === 0 ? "No warnings." : `${warnings} warning${warnings === 1 ? "" : "s"}: ${fixable} with a one-click fix.`,
    `${profiles.length} closed profile${profiles.length === 1 ? "" : "s"} ${usableForSolid ? "ready for a solid feature" : profiles.length === 0 ? `(a solid feature needs at least one closed profile)${diagnosis.noProfileReasons.length === 0 ? "" : `: ${diagnosis.noProfileReasons.join(" ").replace(/[.s]+$/u, "")}`}` : "(resolve the errors first)"}.`,
    `${analysis.degreesOfFreedom} degree${analysis.degreesOfFreedom === 1 ? "" : "s"} of freedom left (${analysis.classification}).`,
    solves ? "All recorded relations solve together." : "The recorded relations cannot all be solved together."
  ];
  return { issues, errors, warnings, fixable, closedProfiles: profiles.length, degreesOfFreedom: analysis.degreesOfFreedom, classification: analysis.classification, solves, valid, usableForSolid, summary };
}

/** The Validate Sketch report: the same analysis, summarised. */
export function validateSketch(context: SketchEditContext): SketchRepairReport {
  return analyzeSketch(context);
}

/**
 * Applies the first fix of every fixable error and warning, one at a time, re-checking after each so a fix that changes the sketch
 * cannot leave a stale one behind. Returns the repaired sketch and what was done. Used by "Fix all" and by tests.
 */
export function repairAll(context: SketchEditContext, maxSteps = 60): { readonly sketch: WorkbenchSketch; readonly applied: readonly string[]; readonly remaining: SketchRepairReport } {
  let sketch = context.sketch;
  const applied: string[] = [];
  const attempted = new Set<string>();
  for (let step = 0; step < maxSteps; step += 1) {
    const report = analyzeSketch({ sketch, newId: context.newId });
    const next = report.issues.find((issue) => issue.severity !== "info" && issue.fixes.length > 0 && !attempted.has(issue.id));
    if (next === undefined) return { sketch, applied, remaining: report };
    attempted.add(next.id);
    const fix = next.fixes[0]!;
    if (fix.kind === "relax") {
      sketch = { ...sketch, constraints: sketch.constraints.map((constraint) => (fix.constraintIds.includes(constraint.id) ? { ...constraint, suppressed: true } : constraint)) };
    } else {
      const result = applyPlanToSketch(sketch, fix.plan);
      if (typeof result === "string") continue;
      const solved = solveLiveSketch(result.sketch, result.focus);
      sketch = solved.ok ? { ...result.sketch, entities: solved.entities } : result.sketch;
    }
    applied.push(fix.label);
  }
  return { sketch, applied, remaining: analyzeSketch({ sketch, newId: context.newId }) };
}
