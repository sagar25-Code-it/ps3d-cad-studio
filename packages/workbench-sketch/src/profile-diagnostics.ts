import type { SketchEntity, Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { PROFILE_GAP_TOLERANCE_MM, type Arrangement } from "./arrangement.js";
import { arrangeSketch } from "./profile-detect.js";
import { profileGapToleranceOf } from "./profile-regions.js";

/**
 * Why a sketch has the regions it has, and why it has none: gaps, free ends, curves that stop short of another, crossings,
 * junctions, overlaps and curves that cross themselves, each with the curves named and the point on the canvas.
 */

export type ProfileProblemCode = "gap" | "short" | "open-end" | "crossing" | "junction" | "overlap" | "self-crossing" | "skipped";

export interface ProfileProblem {
  readonly code: ProfileProblemCode;
  /** "warning" for something that stops a region from closing or doubles geometry; "info" for something that is handled. */
  readonly severity: "warning" | "info";
  readonly message: string;
  readonly entityIds: readonly string[];
  readonly at?: Vec2;
  /** The size of the gap or shortfall in millimetres. */
  readonly distanceMm?: number;
}

export interface ProfileDiagnosis {
  readonly profileCount: number;
  readonly problems: readonly ProfileProblem[];
  /** Plain sentences saying why there are no closed regions; empty when there are some. */
  readonly noProfileReasons: readonly string[];
}

const fmt = (value: number): string => String(Math.round(value * 1000) / 1000);
const label = (id: string): string => {
  const bare = id.replace(/^entity:/u, "");
  return bare.length > 18 ? `${bare.slice(0, 12)}…` : bare;
};
const names = (ids: readonly string[]): string => ids.map(label).join(" and ");
const at = (point: Vec2): string => `(${fmt(point[0])}, ${fmt(point[1])})`;

function distanceToPolyline(point: Vec2, points: readonly Vec2[]): number {
  let best = Infinity;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const w = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(point[0] - (a[0] + dx * w), point[1] - (a[1] + dy * w)));
  }
  return best;
}

export function diagnoseArrangement(arrangement: Arrangement, sketch: Pick<WorkbenchSketch, "snapToleranceMm">, entities: readonly SketchEntity[]): ProfileDiagnosis {
  const problems: ProfileProblem[] = [];
  const reach = Math.max(sketch.snapToleranceMm * 2, 1.5);
  const tolerance = arrangement.toleranceMm;

  for (const skipped of arrangement.skipped) {
    problems.push({ code: "skipped", severity: "warning", message: `${label(skipped.entityId)} is ignored when finding regions: it ${skipped.reason}.`, entityIds: [skipped.entityId] });
  }

  // Free ends: a vertex only one curve reaches.
  const curvesThatClose = new Set(entities.filter((entity) => entity.kind === "arc" || entity.kind === "spline").map((entity) => entity.id));
  const freeEnds = arrangement.vertices.map((vertex, index) => ({ vertex, index })).filter((item) => item.vertex.degree === 1);
  const used = new Set<number>();
  for (const end of freeEnds) {
    if (used.has(end.index)) continue;
    const partner = freeEnds
      .filter((other) => other.index !== end.index && !used.has(other.index) && (other.vertex.entityIds.join("|") !== end.vertex.entityIds.join("|") || curvesThatClose.has(end.vertex.entityIds[0] ?? "")))
      .map((other) => ({ other, distance: Math.hypot(other.vertex.point[0] - end.vertex.point[0], other.vertex.point[1] - end.vertex.point[1]) }))
      .filter((item) => item.distance <= reach)
      .sort((left, right) => left.distance - right.distance)[0];
    if (partner !== undefined) {
      used.add(end.index);
      used.add(partner.other.index);
      const entityIds = [...new Set([...end.vertex.entityIds, ...partner.other.vertex.entityIds])];
      const middle: Vec2 = [(end.vertex.point[0] + partner.other.vertex.point[0]) / 2, (end.vertex.point[1] + partner.other.vertex.point[1]) / 2];
      problems.push({
        code: "gap", severity: "warning", entityIds, at: middle, distanceMm: partner.distance,
        message: `Gap of ${fmt(partner.distance)} mm between ${names(entityIds)} at ${at(middle)}: the outline is open there (curve ends within ${fmt(tolerance)} mm join by themselves), so no region closes. Join the ends, or use Validate Sketch to close the gap.`
      });
      continue;
    }
    // A free end that stops just short of another curve's side, in the direction the curve is heading (an overshoot past a corner is not that).
    const incident = arrangement.edges.find((edge) => edge.u === end.index || edge.v === end.index);
    let heading: Vec2 | undefined;
    if (incident !== undefined) {
      const last = incident.points.length - 1;
      const [from, to] = incident.v === end.index ? [incident.points[last - 1]!, incident.points[last]!] : [incident.points[1]!, incident.points[0]!];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      heading = length === 0 ? undefined : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    }
    let shortOf: { readonly id: string; readonly distance: number } | undefined;
    for (const edge of arrangement.edges) {
      if (edge.u === end.index || edge.v === end.index) continue;
      const distance = distanceToPolyline(end.vertex.point, edge.points);
      if (distance > reach || distance <= tolerance || (shortOf !== undefined && distance >= shortOf.distance)) continue;
      const nearest = nearestPointOnPolyline(end.vertex.point, edge.points);
      const ahead = heading === undefined ? 1 : ((nearest[0] - end.vertex.point[0]) * heading[0] + (nearest[1] - end.vertex.point[1]) * heading[1]) / (distance || 1);
      if (ahead >= 0.5) shortOf = { id: edge.owners[0]!.entityId, distance };
    }
    used.add(end.index);
    if (shortOf !== undefined) {
      problems.push({
        code: "short", severity: "warning", entityIds: [...end.vertex.entityIds, shortOf.id], at: end.vertex.point, distanceMm: shortOf.distance,
        message: `${names(end.vertex.entityIds)} stops ${fmt(shortOf.distance)} mm short of ${label(shortOf.id)} at ${at(end.vertex.point)}, so the outline is open there. Extend it to the curve.`
      });
    } else {
      problems.push({ code: "open-end", severity: "warning", entityIds: end.vertex.entityIds, at: end.vertex.point, message: `${names(end.vertex.entityIds)} has a free end at ${at(end.vertex.point)} that touches nothing, so it bounds no region.` });
    }
  }

  const crossed = new Set<string>();
  for (const crossing of arrangement.crossings) {
    const key = `${crossing.point[0].toFixed(4)},${crossing.point[1].toFixed(4)}`;
    if (crossed.has(key)) continue;
    crossed.add(key);
    if (crossing.entityIds.length >= 2) {
      problems.push({ code: "crossing", severity: "info", entityIds: crossing.entityIds, at: crossing.point, message: `${names(crossing.entityIds)} cross or meet at ${at(crossing.point)}; the regions are split there.` });
    }
  }
  for (const [index, vertex] of arrangement.vertices.entries()) {
    if (vertex.degree >= 3 && !crossed.has(`${vertex.point[0].toFixed(4)},${vertex.point[1].toFixed(4)}`) && !used.has(index)) {
      problems.push({ code: "junction", severity: "info", entityIds: vertex.entityIds, at: vertex.point, message: `${vertex.degree} curves meet at ${at(vertex.point)}; the regions on each side of every curve are separate.` });
    }
  }
  for (const overlap of arrangement.overlaps) {
    problems.push({ code: "overlap", severity: "warning", entityIds: overlap.entityIds, at: overlap.at, message: `${names(overlap.entityIds)} run over each other near ${at(overlap.at)}; the shared stretch counts once. Delete one of them if it is a leftover.` });
  }
  for (const own of arrangement.selfCrossings) {
    problems.push({ code: "self-crossing", severity: "warning", entityIds: [own.entityId], at: own.at, message: `${label(own.entityId)} crosses itself at ${at(own.at)}; the loop it makes is a separate region.` });
  }

  const noProfileReasons: string[] = [];
  if (arrangement.faces.length === 0) {
    const open = problems.filter((problem) => problem.code === "gap" || problem.code === "short" || problem.code === "open-end");
    if (arrangement.edges.length === 0 && arrangement.skipped.length === 0) noProfileReasons.push("There are no curves to enclose a region. Draw a closed shape.");
    else {
      for (const problem of open.slice(0, 3)) noProfileReasons.push(problem.message);
      if (open.length > 3) noProfileReasons.push(`${open.length - 3} more open end${open.length - 3 === 1 ? "" : "s"}.`);
      if (open.length === 0) noProfileReasons.push(arrangement.edges.length === 0 ? "Every curve was skipped as degenerate." : "The curves meet but do not enclose any area.");
    }
  }
  return { profileCount: arrangement.faces.length, problems, noProfileReasons };
}

/** Diagnoses a whole sketch: what stops regions from closing and what is split or merged to make the ones that do. */
export function diagnoseProfiles(sketch: WorkbenchSketch): ProfileDiagnosis {
  const arrangement = arrangeSketch(sketch);
  const diagnosis = diagnoseArrangement(arrangement, sketch, sketch.entities);
  if (diagnosis.noProfileReasons.length === 0 && arrangement.faces.length === 0) return diagnosis;
  if (arrangement.faces.length > 0) return diagnosis;
  const hasHidden = sketch.entities.some((entity) => entity.kind !== "point" && (entity.construction || entity.visible === false));
  const visible = sketch.entities.some((entity) => entity.kind !== "point" && !entity.construction && entity.visible !== false);
  if (!visible && hasHidden) return { ...diagnosis, noProfileReasons: ["Every curve is construction or hidden, and those never bound a region. Turn one into a normal curve or show it."] };
  return diagnosis;
}

/** Why there is no closed region, as plain sentences for a disabled button or a tooltip. Empty when a region exists. */
export function explainNoProfiles(sketch: WorkbenchSketch): readonly string[] {
  return diagnoseProfiles(sketch).noProfileReasons;
}

export { PROFILE_GAP_TOLERANCE_MM, profileGapToleranceOf };

function nearestPointOnPolyline(point: Vec2, points: readonly Vec2[]): Vec2 {
  let best: Vec2 = points[0]!;
  let bestDistance = Infinity;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index]!;
    const b = points[index + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const w = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    const candidate: Vec2 = [a[0] + dx * w, a[1] + dy * w];
    const distance = Math.hypot(point[0] - candidate[0], point[1] - candidate[1]);
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  return best;
}
