import { constraintFit, type SketchConstraintKind, type SketchEntityKind, type SketchPointRef, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";

/**
 * The constraint tools: pick a relation first, then pick the geometry on the canvas. Each click is a pick of a curve (the curve itself)
 * or of one of its defining points (a blue square). This module decides, for the tool and the picks so far, whether the next pick
 * completes a relation, needs another pick, or cannot be used, and builds the relation to add. It holds no state and touches no
 * sketch: the canvas keeps the picks and adds the relation, and the tool stays active for the next one until it is ended.
 */
export const CONSTRAINT_TOOLS = ["coincident", "collinear", "concentric", "midpoint", "fixed", "parallel", "perpendicular", "horizontal", "vertical", "tangent", "equal", "symmetry"] as const;
export type ConstraintToolKind = (typeof CONSTRAINT_TOOLS)[number];

export function isConstraintToolKind(value: unknown): value is ConstraintToolKind {
  return typeof value === "string" && (CONSTRAINT_TOOLS as readonly string[]).includes(value);
}

export interface ConstraintToolInfo {
  readonly label: string;
  /** What the first click should be. */
  readonly prompt: string;
  /** Whether the tool can use a defining point, so the canvas offers the point squares. */
  readonly takesPoints: boolean;
}

export const CONSTRAINT_TOOL_INFO: Readonly<Record<ConstraintToolKind, ConstraintToolInfo>> = {
  coincident: { label: "Coincident", prompt: "Pick a point (blue squares) or a curve, then the point that should move onto it.", takesPoints: true },
  collinear: { label: "Collinear", prompt: "Pick the line that stays, then the line to put on it.", takesPoints: false },
  concentric: { label: "Concentric", prompt: "Pick the circle or arc that stays, then the one to centre on it.", takesPoints: false },
  midpoint: { label: "Midpoint", prompt: "Pick a point (blue squares), then the line it should sit in the middle of.", takesPoints: true },
  fixed: { label: "Fix", prompt: "Click a curve to fix it in place, or a point (blue squares) to fix only that point.", takesPoints: true },
  parallel: { label: "Parallel", prompt: "Pick the line that stays, then the line to make parallel to it.", takesPoints: false },
  perpendicular: { label: "Perpendicular", prompt: "Pick the line that stays, then the line to make perpendicular to it.", takesPoints: false },
  horizontal: { label: "Horizontal", prompt: "Click a line or rectangle to make it level, or pick two points (blue squares) to put them level with each other.", takesPoints: true },
  vertical: { label: "Vertical", prompt: "Click a line or rectangle to make it upright, or pick two points (blue squares) to put one above the other.", takesPoints: true },
  tangent: { label: "Tangent", prompt: "Pick a line, circle or arc, then the circle or arc that should touch it.", takesPoints: false },
  equal: { label: "Equal", prompt: "Pick the curve that keeps its size, then the one to make equal to it.", takesPoints: false },
  symmetry: { label: "Symmetric", prompt: "Pick the two curves to mirror, then the axis line last.", takesPoints: false }
};

export interface ConstraintToolPick {
  readonly entityId: string;
  /** The kind of the picked entity; "origin" for the sketch origin. */
  readonly kind: SketchEntityKind;
  /** The defining point that was picked; absent when the curve itself was clicked. */
  readonly ref?: SketchPointRef;
  /** "Line 2" or "Line 2 end": how the pick is named in prompts. */
  readonly label: string;
}

export type ConstraintToolStep =
  /** The pick was taken; another one is needed. */
  | { readonly status: "more"; readonly picks: readonly ConstraintToolPick[]; readonly prompt: string }
  /** The picks make a relation. The tool keeps going with no picks. */
  | { readonly status: "ready"; readonly constraint: Omit<WorkbenchSketchConstraint, "id">; readonly picks: readonly ConstraintToolPick[]; readonly prompt: string }
  /** The pick cannot be used; the earlier picks are kept. */
  | { readonly status: "refused"; readonly picks: readonly ConstraintToolPick[]; readonly message: string };

const ANY_KINDS: readonly SketchEntityKind[] = ["line", "circle", "arc", "ellipse", "rectangle", "point", "spline", "axis"];
const PAIR_TOOLS: readonly ConstraintToolKind[] = ["parallel", "perpendicular", "collinear", "concentric", "equal", "tangent"];

const samePick = (a: ConstraintToolPick, b: ConstraintToolPick): boolean => a.entityId === b.entityId && a.ref === b.ref;

/** A sketch point is always picked as a point; Horizontal and Vertical read a click on a circle or ellipse as its centre. */
function asPicked(tool: ConstraintToolKind, pick: ConstraintToolPick): ConstraintToolPick {
  if (pick.ref !== undefined) return pick;
  if (pick.kind === "point" || pick.kind === "origin") return { ...pick, ref: "self" };
  if ((tool === "horizontal" || tool === "vertical") && (pick.kind === "circle" || pick.kind === "ellipse")) return { ...pick, ref: "center", label: `${pick.label} centre` };
  return pick;
}

/**
 * What one more pick does. `picks` are the picks already taken for the relation being built (never a finished one).
 * Picking the same thing again takes it back.
 */
export function constraintToolStep(tool: ConstraintToolKind, picks: readonly ConstraintToolPick[], next: ConstraintToolPick): ConstraintToolStep {
  const info = CONSTRAINT_TOOL_INFO[tool];
  const pick = PAIR_TOOLS.includes(tool) || tool === "symmetry" ? { entityId: next.entityId, kind: next.kind, label: next.label } : asPicked(tool, next);
  const refused = (message: string): ConstraintToolStep => ({ status: "refused", picks, message });
  const ready = (constraint: Omit<WorkbenchSketchConstraint, "id">, kinds: readonly SketchEntityKind[], done: string): ConstraintToolStep => {
    const fit = constraintFit(constraint.kind, kinds, constraint.points);
    return fit.ok ? { status: "ready", constraint, picks: [], prompt: `${done} ${info.label} is still on: ${info.prompt} Esc finishes.` } : refused(fit.reason);
  };
  const more = (prompt: string): ConstraintToolStep => ({ status: "more", picks: [...picks, pick], prompt });
  const earlier = picks.find((candidate) => samePick(candidate, pick));
  if (earlier !== undefined) return { status: "more", picks: picks.filter((candidate) => candidate !== earlier), prompt: `${pick.label} cleared. ${info.prompt}` };
  const first = picks[0];

  switch (tool) {
    case "fixed":
      return pick.ref === undefined
        ? ready({ kind: "fixed", entityIds: [pick.entityId] }, [pick.kind], `Fixed ${pick.label}.`)
        : ready({ kind: "fixed", entityIds: [pick.entityId], points: [pick.ref] }, [pick.kind], `Fixed ${pick.label}.`);
    case "horizontal":
    case "vertical": {
      const word = tool === "horizontal" ? "level" : "upright";
      if (pick.ref === undefined) {
        if (first !== undefined) return refused(`${first.label} is picked: pick a second point (blue squares) to line up with it, or pick it again to clear it.`);
        return ready({ kind: tool, entityIds: [pick.entityId] }, [pick.kind], `Made ${pick.label} ${word}.`);
      }
      if (first === undefined) return more(`${pick.label} picked. Now pick the point to put ${tool === "horizontal" ? "level with" : "in line above or below"} it.`);
      if (first.entityId === pick.entityId) return refused(`Both points belong to ${first.label.replace(/ (start|end|midpoint|centre|center)$/u, "")}; click the line itself to make it ${word}, or pick a point of another curve.`);
      return ready({ kind: tool, entityIds: [first.entityId, pick.entityId], points: [first.ref ?? "self", pick.ref] }, [first.kind, pick.kind], `Put ${pick.label} ${tool === "horizontal" ? "level with" : "in line with"} ${first.label}.`);
    }
    case "coincident": {
      if (first === undefined) return more(pick.ref === undefined ? `${pick.label} picked. Now pick the point (blue squares) to put on it.` : `${pick.label} picked. Now pick the point that should move onto it, or a curve to put it on.`);
      if (first.ref === undefined && pick.ref === undefined) return refused("Coincident needs at least one point: pick a blue square, not a second curve.");
      if (first.entityId === pick.entityId) return refused("Two points of one shape cannot be made coincident: that would collapse it.");
      return ready({ kind: "coincident", entityIds: [first.entityId, pick.entityId], points: [first.ref ?? "curve", pick.ref ?? "curve"] }, [first.kind, pick.kind],
        first.ref === undefined || pick.ref === undefined ? `Put ${(first.ref === undefined ? pick : first).label} on ${(first.ref === undefined ? first : pick).label}.` : `Joined ${pick.label} to ${first.label}.`);
    }
    case "midpoint": {
      if (first === undefined) {
        if (pick.ref === undefined && pick.kind !== "line") return refused("Midpoint needs a point and a line: pick a point (blue squares) or the line.");
        return more(pick.ref === undefined ? `${pick.label} picked. Now pick the point (blue squares) that should sit at its middle.` : `${pick.label} picked. Now click the line it should sit in the middle of.`);
      }
      const point = first.ref !== undefined ? first : pick.ref !== undefined ? pick : undefined;
      const line = first.ref === undefined ? first : pick.ref === undefined ? pick : undefined;
      // A second point replaces the first, as a new choice of the point.
      if (line === undefined) return { status: "more", picks: [pick], prompt: `${pick.label} picked instead. Now click the line it should sit in the middle of.` };
      if (point === undefined) return refused("Midpoint needs a point: pick a blue square.");
      if (line.kind !== "line") return refused("Midpoint needs a line: click the line the point should sit in the middle of.");
      if (line.entityId === point.entityId) return refused("A line's own point cannot be the middle of that same line. Click another line.");
      return ready({ kind: "midpoint", entityIds: [point.entityId, line.entityId], points: [point.ref!] }, [point.kind, line.kind], `Put ${point.label} at the middle of ${line.label}.`);
    }
    case "symmetry": {
      if (picks.some((candidate) => candidate.entityId === pick.entityId)) return refused(`${pick.label} is already picked; pick another curve.`);
      if (picks.length === 0) return more(`${pick.label} picked. Now pick the curve that mirrors it.`);
      if (picks.length === 1) return more(`${pick.label} picked. Now pick the axis line.`);
      const all = [...picks, pick];
      return ready({ kind: "symmetry", entityIds: all.map((candidate) => candidate.entityId) }, all.map((candidate) => candidate.kind), `Made ${all[0]!.label} and ${all[1]!.label} symmetric about ${pick.label}.`);
    }
    default: {
      const kind: SketchConstraintKind = tool;
      if (first === undefined) {
        // A first pick that no second pick could complete is refused at once, with the rule's own reason.
        const possible = ANY_KINDS.some((other) => constraintFit(kind, [pick.kind, other]).ok);
        if (!possible) return refused(constraintFit(kind, [pick.kind, pick.kind]).reason);
        return more(`${pick.label} picked. Now pick the ${tool === "concentric" ? "circle or arc to centre on it" : tool === "tangent" ? "curve that should touch it" : tool === "equal" ? "curve to make equal to it" : `line to make ${tool} to it`}.`);
      }
      if (first.entityId === pick.entityId) return refused(`${pick.label} is already picked; pick a second curve.`);
      return ready({ kind, entityIds: [first.entityId, pick.entityId] }, [first.kind, pick.kind], `${info.label}: ${first.label} and ${pick.label}.`);
    }
  }
}
