import { failure, type SketchEntity, type Vec2, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import {
  arcFrame,
  buildLineChains,
  editPlan,
  intersectInfinite,
  mapEntity,
  offsetChain,
  type SketchEditContext,
  type SketchEditResult
} from "./edit-tools.js";
import { movedEnd } from "./split-jog.js";
import { pinnedAmong } from "./sketch-clone.js";

/**
 * Offset Move: moves the selected curves, a chain or a whole region, in place (the originals are changed, not copied) and keeps the
 * curves that were attached to them attached, by extending or trimming them. Two modes:
 *  - "offset": each selected curve moves along its own normal by a distance, like Offset but replacing the original. A closed region
 *    grows or shrinks; an open chain steps sideways. Neighbouring lines are stretched along their own direction to meet the moved chain,
 *    so a horizontal or vertical neighbour stays horizontal or vertical.
 *  - "vector": the selection moves by (dx, dy) and the ends of attached curves follow it.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;

export type OffsetMoveSpec =
  | { readonly kind: "offset"; readonly distanceMm: number }
  | { readonly kind: "vector"; readonly dxMm: number; readonly dyMm: number };

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the distance and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The free ends of a curve, in `[start, end]` order. */
function endsOf(entity: SketchEntity): readonly Vec2[] {
  if (entity.kind === "line" || entity.kind === "arc") return [entity.start, entity.end];
  if (entity.kind === "spline") return [entity.fitPoints[0]!, entity.fitPoints[entity.fitPoints.length - 1]!];
  return [];
}

export function offsetMoveEntities(context: SketchEditContext, ids: readonly string[], spec: OffsetMoveSpec): SketchEditResult {
  const found = ids.map((id) => context.sketch.entities.find((entity) => entity.id === id));
  if (found.length === 0 || found.some((entity) => entity === undefined)) return reject("Select the curves or the region to move.");
  const selected = found as SketchEntity[];
  return spec.kind === "offset" ? offsetMove(context, selected, spec.distanceMm) : vectorMove(context, selected, spec.dxMm, spec.dyMm);
}

// ---------------------------------------------------------------------------------------------
// Vector mode
// ---------------------------------------------------------------------------------------------

function vectorMove(context: SketchEditContext, selected: readonly SketchEntity[], dx: number, dy: number): SketchEditResult {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.001 || Math.abs(dx) > 100_000 || Math.abs(dy) > 100_000) return reject("Enter a move distance of at least 0.001 mm.");
  const moved = new Set(selected.map((entity) => entity.id));
  const shift = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  const tolerance = Math.max(context.sketch.snapToleranceMm, 1e-6);
  const updates = new Map<string, SketchEntity>();
  for (const entity of selected) updates.set(entity.id, mapEntity(entity, entity.id, shift, (degrees) => degrees));
  // Ends of the selection, so unselected curves touching them can follow.
  const anchors = selected.flatMap(endsOf);
  const followed: string[] = [];
  for (const entity of context.sketch.entities) {
    if (moved.has(entity.id) || entity.construction || entity.visible === false) continue;
    const touching = (point: Vec2): boolean => anchors.some((anchor) => dist(anchor, point) <= tolerance);
    if (entity.kind === "line") {
      const start = touching(entity.start);
      const end = touching(entity.end);
      if (start && end) return reject("A curve outside the selection is attached to the selection at both ends, so it cannot follow without being squashed.", [entity.id], "Include it in the selection.");
      if (start || end) { updates.set(entity.id, { ...entity, ...(start ? { start: shift(entity.start) } : { end: shift(entity.end) }) }); followed.push(entity.id); }
    } else if (entity.kind === "arc") {
      const start = touching(entity.start);
      const end = touching(entity.end);
      if (start && end) return reject("A curve outside the selection is attached to the selection at both ends, so it cannot follow without being squashed.", [entity.id], "Include it in the selection.");
      if (start || end) {
        const next = { ...entity, ...(start ? { start: shift(entity.start) } : { end: shift(entity.end) }) };
        if (arcFrame(next) === undefined) return reject("Moving the region would flatten an attached arc.", [entity.id], "Include the arc in the selection or move by a smaller distance.");
        updates.set(entity.id, next);
        followed.push(entity.id);
      }
    } else if (entity.kind === "spline") {
      const first = touching(entity.fitPoints[0]!);
      const last = touching(entity.fitPoints[entity.fitPoints.length - 1]!);
      if (first || last) {
        updates.set(entity.id, { ...entity, fitPoints: entity.fitPoints.map((point, index) => ((first && index === 0) || (last && index === entity.fitPoints.length - 1) ? shift(point) : point)) });
        followed.push(entity.id);
      }
    }
  }
  const pinned = pinnedAmong(context.sketch, [...updates.keys()]);
  if (pinned.length > 0) return reject(`${pinned.map((id) => id.replace(/^entity:/u, "")).join(", ")} ${pinned.length === 1 ? "is" : "are"} fixed and would have to move.`, pinned, "Relax the Fixed relation first (Relax Relations).");
  return editPlan(`Moved ${selected.length} curve${selected.length === 1 ? "" : "s"} by (${fmt(dx)}, ${fmt(dy)}) mm; ${followed.length} attached curve${followed.length === 1 ? "" : "s"} followed`, { updateEntities: [...updates.values()] });
}

// ---------------------------------------------------------------------------------------------
// Offset mode
// ---------------------------------------------------------------------------------------------

function offsetMove(context: SketchEditContext, selected: readonly SketchEntity[], distanceMm: number): SketchEditResult {
  if (!Number.isFinite(distanceMm) || Math.abs(distanceMm) < 0.01 || Math.abs(distanceMm) > 5000) return reject("Enter an offset distance between 0.01 mm and 5000 mm (negative moves the other way).");
  const sketch = context.sketch;
  const selectedIds = new Set(selected.map((entity) => entity.id));
  const tolerance = Math.max(sketch.snapToleranceMm, 1e-6);
  const updates = new Map<string, SketchEntity>();
  const attached = (point: Vec2, except: ReadonlySet<string>): SketchEntity[] => sketch.entities.filter((entity) => !except.has(entity.id) && !entity.construction && entity.visible !== false && endsOf(entity).some((end) => dist(end, point) <= tolerance));

  for (const entity of selected) {
    if (entity.kind === "line") continue;
    if (entity.kind === "circle") {
      const radiusMm = entity.radiusMm + distanceMm;
      if (radiusMm < 0.01) return reject("The inward move is larger than the circle's radius.", [entity.id]);
      updates.set(entity.id, { ...entity, radiusMm });
    } else if (entity.kind === "rectangle") {
      const widthMm = entity.widthMm + 2 * distanceMm;
      const heightMm = entity.heightMm + 2 * distanceMm;
      if (widthMm < 0.01 || heightMm < 0.01) return reject("The inward move is larger than the rectangle.", [entity.id]);
      updates.set(entity.id, { ...entity, widthMm, heightMm });
    } else if (entity.kind === "arc") {
      const frame = arcFrame(entity);
      if (frame === undefined) return reject("The arc is degenerate.", [entity.id]);
      const radius = frame.radius + distanceMm;
      if (radius < 0.01) return reject("The inward move is larger than the arc's radius.", [entity.id]);
      if (endsOf(entity).some((end) => attached(end, selectedIds).length > 0 || selected.some((other) => other.id !== entity.id && endsOf(other).some((far) => dist(far, end) <= tolerance)))) {
        return reject("This arc is joined to other curves, and moving it in place would break those joints.", [entity.id], "Offset the arc to make a copy instead, or include the lines it joins and move the whole chain.");
      }
      const scale = radius / frame.radius;
      const about = (point: Vec2): Vec2 => [frame.center[0] + (point[0] - frame.center[0]) * scale, frame.center[1] + (point[1] - frame.center[1]) * scale];
      updates.set(entity.id, { ...entity, start: about(entity.start), mid: about(entity.mid), end: about(entity.end) });
    } else {
      return reject(`Offset Move applies to lines, arcs, circles and rectangles; a ${entity.kind} cannot be moved this way.`, [entity.id]);
    }
  }

  const lines = selected.filter((entity): entity is Line => entity.kind === "line");
  let stretched = 0;
  if (lines.length > 0) {
    for (const chain of buildLineChains(lines, tolerance)) {
      const created = offsetChain(chain, distanceMm, context);
      if (typeof created === "string") return reject(created, chain.lines.map((line) => line.id));
      // `created[i]` runs along the chain's traversal; give each original line back its own start-to-end direction.
      const mapped: Line[] = chain.lines.map((original, index) => {
        const made = created[index] as Line;
        const forward = dist(original.start, chain.vertices[index]!) <= dist(original.start, chain.vertices[(index + 1) % chain.vertices.length]!);
        return forward ? { ...original, start: made.start, end: made.end } : { ...original, start: made.end, end: made.start };
      });
      // An open chain's two outer ends: lines outside the selection that meet them are stretched to the moved chain.
      if (!chain.closed) {
        const first = created[0] as Line;
        const last = created[created.length - 1] as Line;
        const ends = [
          { vertex: chain.vertices[0]!, edge: first, index: 0, atStart: true },
          { vertex: chain.vertices[chain.vertices.length - 1]!, edge: last, index: created.length - 1, atStart: false }
        ];
        for (const end of ends) {
          const neighbours = attached(end.vertex, selectedIds);
          if (neighbours.length === 0) continue;
          if (neighbours.length > 1) return reject("More than one curve outside the selection meets the end of the chain, so the move cannot keep them all attached.", neighbours.map((entity) => entity.id), "Include them in the selection or move one curve at a time.");
          const neighbour = neighbours[0]!;
          if (neighbour.kind !== "line") return reject("An arc or spline meets the end of the selected chain, and Offset Move cannot stretch it to follow.", [neighbour.id], "Include it in the selection, or use the vector mode, which moves attached curves by the same distance.");
          const meet = intersectInfinite(end.edge.start, end.edge.end, neighbour.start, neighbour.end);
          if (meet === undefined) return reject("The attached line is parallel to the end of the chain, so it cannot be stretched to meet it.", [neighbour.id]);
          const neighbourEnd: "start" | "end" = dist(neighbour.start, end.vertex) <= dist(neighbour.end, end.vertex) ? "start" : "end";
          const healed = movedEnd(neighbour, neighbourEnd, meet);
          if (healed === undefined) return reject("Stretching the attached line to the moved chain would flip or collapse it.", [neighbour.id], "Use a smaller distance.");
          updates.set(neighbour.id, healed);
          stretched += 1;
          // The chain's end line runs on to the same meeting point so the two stay joined.
          const target = mapped[end.index]!;
          const original = chain.lines[end.index]!;
          const originalForward = dist(original.start, chain.vertices[end.index]!) <= dist(original.start, chain.vertices[(end.index + 1) % chain.vertices.length]!);
          const movesStart = end.atStart ? originalForward : !originalForward;
          mapped[end.index] = movesStart ? { ...target, start: meet } : { ...target, end: meet };
          if (dist(mapped[end.index]!.start, mapped[end.index]!.end) < 0.01) return reject("The move collapses a line of the chain.", [target.id]);
        }
      }
      for (const line of mapped) updates.set(line.id, line);
    }
  }

  const pinnedOffset = pinnedAmong(sketch, [...updates.keys()]);
  if (pinnedOffset.length > 0) return reject(`${pinnedOffset.map((id) => id.replace(/^entity:/u, "")).join(", ")} ${pinnedOffset.length === 1 ? "is" : "are"} fixed and would have to move.`, pinnedOffset, "Relax the Fixed relation first (Relax Relations).");
  const description = `${selected.length} curve${selected.length === 1 ? "" : "s"} by ${fmt(distanceMm)} mm`;
  return editPlan(`Offset-moved ${description}${stretched === 0 ? "" : `; ${stretched} attached line${stretched === 1 ? "" : "s"} stretched`}`, { updateEntities: [...updates.values()] });
}

/** Selection of the whole connected region or chain the picked curve belongs to (a convenience for the tool's click). */
export function connectedSelection(sketch: WorkbenchSketch, seedId: string): readonly string[] {
  const seed = sketch.entities.find((entity) => entity.id === seedId);
  if (seed === undefined) return [];
  const tolerance = Math.max(sketch.snapToleranceMm, 1e-6);
  const reached = new Set<string>([seed.id]);
  const queue = [seed];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const other of sketch.entities) {
      if (reached.has(other.id) || other.construction || other.visible === false) continue;
      if (endsOf(current).some((a) => endsOf(other).some((b) => dist(a, b) <= tolerance))) { reached.add(other.id); queue.push(other); }
    }
  }
  return [...reached];
}
