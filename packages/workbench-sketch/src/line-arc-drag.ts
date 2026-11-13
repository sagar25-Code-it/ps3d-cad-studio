import type { SketchEntity, Vec2, WorkbenchResult, WorkbenchSketch, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { autoConstraintsFor, inheritedTangentDirection, type PlacedPointInference } from "./auto-constraints.js";
import { buildSketchEntity } from "./index.js";
import { keepResolvableConstraints } from "./line-chain.js";

/**
 * The Line tool's tangent arc. While lines are being chained, pressing on the chain's last point and dragging draws an arc that
 * leaves the last segment along its direction; releasing places it and the chain carries on from the arc's end with lines. The
 * same gesture on the end of any existing line or arc starts a chain with a tangent arc. A press that does not move is an
 * ordinary click.
 *
 * The arc is stored as an ordinary arc with a Coincident joint to the end it left and a Tangent relation to that curve, exactly
 * what the Tangent arc tool makes, so nothing new is saved.
 */

/** How far (screen pixels) a press has to travel before it is a drag and not a click. */
export const LINE_ARC_DRAG_PIXELS = 6;

export interface LineArcDragStart {
  /** The end the arc leaves from, with the snap that names the curve it belongs to. */
  readonly anchor: PlacedPointInference;
  /** The unit direction the arc starts in: the curve's own direction at that end, running away from it. */
  readonly direction: Vec2;
  /** The line or arc the arc continues. */
  readonly entityId: string;
}

export interface LineArcDragStartInput {
  /** The points of the Line tool that are waiting for the next click: none, or the chain's last point. */
  readonly pending: readonly Vec2[];
  /** What each pending point was snapped to (the chain's last point names the segment that ends there). */
  readonly pendingInference: readonly PlacedPointInference[];
  /** Where the pointer was pressed, before snapping. */
  readonly pressMm: Vec2;
  /** The press after snapping, with what it snapped to. */
  readonly press: PlacedPointInference;
  /** How near the chain's last point the press has to be, in millimetres. */
  readonly reachMm: number;
  readonly sketch: WorkbenchSketch;
}

/** Whether a press of the Line tool may become a tangent arc, and from which end. Undefined means the press is an ordinary click. */
export function lineArcDragStart(input: LineArcDragStartInput): LineArcDragStart | undefined {
  if (input.pending.length > 1) return undefined;
  const tail = input.pending[0];
  let anchor: PlacedPointInference | undefined;
  if (tail !== undefined) {
    // A chain is running: only a press on its last point starts an arc.
    if (Math.hypot(input.pressMm[0] - tail[0], input.pressMm[1] - tail[1]) > input.reachMm) return undefined;
    anchor = input.pendingInference[0];
  } else anchor = input.press;
  if (anchor === undefined) return undefined;
  const inherited = inheritedTangentDirection(anchor, input.sketch);
  return inherited === undefined ? undefined : { anchor, direction: inherited.direction, entityId: inherited.entityId };
}

export interface LineTangentArc {
  readonly entity: SketchEntity;
  /** The joint to the end the arc left, the Tangent relation to that curve, and whatever the arc's end was snapped to. */
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

/** The arc from the drag's start to where the pointer is (or was released), with its relations. */
export function buildLineTangentArc(input: { readonly start: LineArcDragStart; readonly end: PlacedPointInference; readonly sketch: WorkbenchSketch; readonly id: string; readonly newId: () => string }): WorkbenchResult<LineTangentArc> {
  const from = input.start.anchor.point;
  const to = input.end.point;
  const reach = Math.max(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2, 0.01);
  const directionPoint: Vec2 = [from[0] + input.start.direction[0] * reach, from[1] + input.start.direction[1] * reach];
  const built = buildSketchEntity("arc-tangent", [from, directionPoint, to], input.id);
  if (!built.ok) return built;
  const relations = autoConstraintsFor({ tool: "arc-tangent", entity: built.value, placed: [input.start.anchor, { point: directionPoint }, { ...input.end, anchor: from }], sketch: input.sketch, newId: input.newId });
  const kept = keepResolvableConstraints(relations, input.sketch.entities.map((entity) => entity.id), [built.value.id]).kept;
  return { ok: true, value: { entity: built.value, constraints: kept } };
}
