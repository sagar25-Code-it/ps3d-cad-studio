import { failure, type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { isDimensionConstraint, measureDimensionConstraint } from "../../workbench-core/src/sketch-measure.js";
import { entityExtents, entityPoints } from "./index.js";
import { mapEntity, type SketchEditContext, type SketchEditResult } from "./edit-tools.js";
import { constraintHolds, finishPlan, finiteVec, nameOf, pairRelation } from "./edit-relations.js";
import { internalRelations } from "./sketch-clone.js";

/**
 * Mirror, Pattern, Move / Rotate / Scale (with copies and a non-uniform scale) and Stretch. Copies carry the relations between the copied
 * entities (re-measured when the copy is mirrored or scaled), a scale or stretch rewrites the dimensions that follow the geometry instead
 * of leaving them stale, and every number is checked up front so a typo never reaches the operation.
 */

const MAX_COPIES = 100;
const EPSILON = 1e-9;

/** Sentinels for mirroring about the sketch origin's X axis (y becomes -y) or Y axis (x becomes -x) with no helper line. */
export const MIRROR_AXIS_X = "axis:x";
export const MIRROR_AXIS_Y = "axis:y";

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the values and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function find(sketch: WorkbenchSketch, id: string): SketchEntity | undefined {
  return sketch.entities.find((entity) => entity.id === id);
}

function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function wrapDegrees(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function entitiesOf(context: SketchEditContext, ids: readonly string[]): readonly SketchEntity[] | undefined {
  const unique = [...new Set(ids)];
  const found = unique.map((id) => find(context.sketch, id));
  return unique.length === 0 || found.some((entity) => entity === undefined) ? undefined : (found as readonly SketchEntity[]);
}

// ---------------------------------------------------------------------------------------------
// Copies that keep their relations
// ---------------------------------------------------------------------------------------------

interface CloneSet {
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
  readonly idMap: ReadonlyMap<string, string>;
}

function withMeasuredValue(constraint: WorkbenchSketchConstraint, measured: number): WorkbenchSketchConstraint {
  const { expression: _expression, ...rest } = constraint;
  return constraint.kind === "angle" ? { ...rest, valueDeg: measured } : { ...rest, valueMm: measured };
}

/**
 * Copies the sources through `make` with fresh IDs and re-creates the relations between them. A dimension is re-measured on the copy
 * (a mirrored angle, a scaled length); any other relation the copy no longer satisfies is left out; Fixed is never copied.
 */
function cloneSet(context: SketchEditContext, sources: readonly SketchEntity[], make: (entity: SketchEntity, id: string) => SketchEntity | string): CloneSet | string {
  const idMap = new Map<string, string>();
  const copies: SketchEntity[] = [];
  for (const source of sources) {
    const id = context.newId("entity");
    idMap.set(source.id, id);
    const made = make(source, id);
    if (typeof made === "string") return made;
    copies.push(made);
  }
  const probe = { entities: copies };
  const constraints: WorkbenchSketchConstraint[] = [];
  for (const relation of internalRelations(context.sketch.constraints, sources.map((entity) => entity.id))) {
    if (relation.kind === "fixed") continue;
    const cloned: WorkbenchSketchConstraint = { ...relation, id: context.newId("constraint"), entityIds: relation.entityIds.map((id) => idMap.get(id)!) };
    if (isDimensionConstraint(cloned) && cloned.driven !== true && cloned.suppressed !== true) {
      const measured = measureDimensionConstraint(probe, cloned);
      constraints.push(measured === undefined ? cloned : withMeasuredValue(cloned, measured));
    } else if (constraintHolds(probe, cloned)) constraints.push(cloned);
  }
  return { entities: copies, constraints, idMap };
}

/** Dimensions that follow the geometry: every driving dimension whose entities all moved, re-valued to what the new geometry measures. */
function followDimensions(sketch: WorkbenchSketch, candidate: WorkbenchSketch, movedIds: ReadonlySet<string>): { readonly remove: readonly string[]; readonly add: readonly WorkbenchSketchConstraint[] } {
  const remove: string[] = [];
  const add: WorkbenchSketchConstraint[] = [];
  for (const constraint of sketch.constraints) {
    if (!isDimensionConstraint(constraint) || constraint.driven === true || constraint.suppressed === true) continue;
    if (!constraint.entityIds.every((id) => movedIds.has(id))) continue;
    if (constraintHolds(candidate, constraint)) continue;
    const measured = measureDimensionConstraint(candidate, constraint);
    if (measured === undefined || (constraint.kind !== "angle" && measured < 0.01)) continue;
    remove.push(constraint.id);
    add.push(withMeasuredValue(constraint, measured));
  }
  return { remove, add };
}

function afterUpdate(sketch: WorkbenchSketch, updated: readonly SketchEntity[]): WorkbenchSketch {
  const byId = new Map(updated.map((entity) => [entity.id, entity] as const));
  return { ...sketch, entities: sketch.entities.map((entity) => byId.get(entity.id) ?? entity) };
}

// ---------------------------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------------------------

type Line = Extract<SketchEntity, { kind: "line" }>;

function reflectAcross(point: Vec2, axis: Line): Vec2 {
  const dx = axis.end[0] - axis.start[0];
  const dy = axis.end[1] - axis.start[1];
  const parameter = ((point[0] - axis.start[0]) * dx + (point[1] - axis.start[1]) * dy) / (dx * dx + dy * dy);
  const foot: Vec2 = [axis.start[0] + parameter * dx, axis.start[1] + parameter * dy];
  return [2 * foot[0] - point[0], 2 * foot[1] - point[1]];
}

/**
 * Mirrors the selected entities about the axis (the last id: a line, or MIRROR_AXIS_X / MIRROR_AXIS_Y for the sketch origin's axes).
 * The copies keep the relations among them, and each copy is linked to its source by a symmetry relation about a line axis.
 */
export function mirrorEntities(context: SketchEditContext, ids: readonly string[]): SketchEditResult {
  const last = ids[ids.length - 1];
  const virtual = last === MIRROR_AXIS_X || last === MIRROR_AXIS_Y;
  const axisEntity = virtual || ids.length < 2 ? undefined : find(context.sketch, last!);
  if (!virtual && axisEntity?.kind !== "line") return reject("Select the entities to mirror, then the mirror line last (or choose the X or Y axis of the sketch).");
  const sources = entitiesOf(context, ids.slice(0, -1));
  if (sources === undefined || sources.some((entity) => entity.id === axisEntity?.id)) return reject("Select the entities to mirror before the mirror line.");
  let reflect: (point: Vec2) => Vec2;
  let rotation: (degrees: number) => number;
  let description: string;
  if (virtual) {
    const mirrorX = last === MIRROR_AXIS_X;
    reflect = mirrorX ? (point) => [point[0], -point[1]] : (point) => [-point[0], point[1]];
    rotation = mirrorX ? (degrees) => -degrees : (degrees) => 180 - degrees;
    description = mirrorX ? "the sketch X axis" : "the sketch Y axis";
  } else {
    const axis = axisEntity as Line;
    if (!finiteVec([...axis.start, ...axis.end]) || Math.hypot(axis.end[0] - axis.start[0], axis.end[1] - axis.start[1]) < 0.01) return reject("The mirror line has no length, so there is no axis to mirror about.", [axis.id]);
    const angle = (Math.atan2(axis.end[1] - axis.start[1], axis.end[0] - axis.start[0]) * 180) / Math.PI;
    reflect = (point) => reflectAcross(point, axis);
    rotation = (degrees) => 2 * angle - degrees;
    description = nameOf(axis.id);
  }
  const cloned = cloneSet(context, sources, (entity, id) => mapEntity(entity, id, reflect, rotation));
  if (typeof cloned === "string") return reject(cloned);
  const constraints = [...cloned.constraints];
  if (axisEntity !== undefined) {
    for (const source of sources) constraints.push({ id: context.newId("constraint"), kind: "symmetry", entityIds: [source.id, cloned.idMap.get(source.id)!, axisEntity.id] });
  }
  return finishPlan(context, { label: `Mirrored ${cloned.entities.length} ${plural(cloned.entities.length, "entity", "entities")} about ${description}`, removeEntityIds: [], updateEntities: [], addEntities: cloned.entities, addConstraints: constraints });
}

// ---------------------------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------------------------

export type PatternSpec =
  | {
      readonly kind: "rectangular";
      readonly countX: number;
      readonly countY: number;
      readonly dxMm: number;
      readonly dyMm: number;
      /** Direction of the pattern's X axis in degrees from the sketch X axis (default 0): a single-direction angled pattern uses this. */
      readonly angleDeg?: number;
      /** When true, `dxMm` and `dyMm` are the total extent from the first to the last instance instead of the spacing. */
      readonly extent?: boolean;
    }
  | { readonly kind: "circular"; readonly count: number; readonly angleDeg: number; readonly center: Vec2 };

function sameGeometry(a: SketchEntity, b: SketchEntity): boolean {
  const close = (p: Vec2, q: Vec2): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  if (a.kind === "circle" && b.kind === "circle") return close(a.center, b.center) && Math.abs(a.radiusMm - b.radiusMm) < 1e-6;
  if (a.kind === "point" && b.kind === "point") return close(a.point, b.point);
  if (a.kind === "line" && b.kind === "line") return (close(a.start, b.start) && close(a.end, b.end)) || (close(a.start, b.end) && close(a.end, b.start));
  if (a.kind === "ellipse" && b.kind === "ellipse") return close(a.center, b.center) && Math.abs(a.majorRadiusMm - b.majorRadiusMm) < 1e-6 && Math.abs(a.minorRadiusMm - b.minorRadiusMm) < 1e-6;
  return false;
}

/** Copies the selected entities in a rectangular grid or around a centre. The original stays as the first instance. */
export function patternEntities(context: SketchEditContext, ids: readonly string[], spec: PatternSpec): SketchEditResult {
  const sources = entitiesOf(context, ids);
  if (sources === undefined) return reject("Select the entities to pattern.");
  const instances: { readonly point: (value: Vec2) => Vec2; readonly rotation: (degrees: number) => number }[] = [];
  let label: string;
  if (spec.kind === "rectangular") {
    const { countX, countY } = spec;
    const angle = spec.angleDeg ?? 0;
    if (![countX, countY].every((count) => Number.isInteger(count) && count >= 1) || countX * countY < 2) return reject("Enter whole-number counts of at least 1, with at least 2 instances in total.");
    if (!Number.isFinite(spec.dxMm) || !Number.isFinite(spec.dyMm) || !Number.isFinite(angle)) return reject("Enter numbers for the spacing and the direction.");
    if (countX * countY - 1 > MAX_COPIES) return reject(`A pattern is limited to ${MAX_COPIES + 1} instances.`);
    const dx = spec.extent === true ? (countX > 1 ? spec.dxMm / (countX - 1) : 0) : spec.dxMm;
    const dy = spec.extent === true ? (countY > 1 ? spec.dyMm / (countY - 1) : 0) : spec.dyMm;
    if ((countX > 1 && Math.abs(dx) < 0.01) || (countY > 1 && Math.abs(dy) < 0.01)) return reject("Enter a spacing of at least 0.01 mm in each direction that has more than one instance.");
    const cos = Math.cos((angle * Math.PI) / 180);
    const sin = Math.sin((angle * Math.PI) / 180);
    for (let row = 0; row < countY; row += 1) {
      for (let column = 0; column < countX; column += 1) {
        if (row === 0 && column === 0) continue;
        const offset: Vec2 = [column * dx * cos - row * dy * sin, column * dx * sin + row * dy * cos];
        if (Math.abs(offset[0]) > 1e6 || Math.abs(offset[1]) > 1e6) return reject("The pattern spacing is far outside the sketch limit of 10000 mm.");
        instances.push({ point: (value) => [value[0] + offset[0], value[1] + offset[1]], rotation: (degrees) => degrees });
      }
    }
    label = `Rectangular pattern ${countX} × ${countY}${angle === 0 ? "" : ` at ${format(angle)}°`}`;
  } else {
    const { count, angleDeg, center } = spec;
    if (!Number.isInteger(count) || count < 2 || count - 1 > MAX_COPIES) return reject(`Enter a count from 2 to ${MAX_COPIES + 1}.`);
    if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 0.01 || Math.abs(angleDeg) > 360) return reject("Enter a total angle between 0.01 and 360 degrees.");
    if (!finiteVec(center)) return reject("Enter numbers for the pattern centre.");
    // A full turn spaces the instances evenly around the circle; a partial angle puts the last instance at that angle.
    const step = Math.abs(angleDeg) >= 360 - EPSILON ? angleDeg / count : angleDeg / (count - 1);
    for (let index = 1; index < count; index += 1) {
      const radians = (step * index * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      instances.push({
        point: (value) => [center[0] + (value[0] - center[0]) * cos - (value[1] - center[1]) * sin, center[1] + (value[0] - center[0]) * sin + (value[1] - center[1]) * cos],
        rotation: (degrees) => degrees + step * index
      });
    }
    label = `Circular pattern of ${count}`;
  }
  const total = sources.length * instances.length;
  if (context.sketch.entities.length + total > 500) {
    return failure("RESOURCE_LIMIT", `Would create ${total} entities, which makes ${context.sketch.entities.length + total} in the sketch; the limit is 500.`, [], "Select fewer entities or use a smaller count.");
  }
  const added: SketchEntity[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  for (const instance of instances) {
    const cloned = cloneSet(context, sources, (entity, id) => mapEntity(entity, id, instance.point, instance.rotation));
    if (typeof cloned === "string") return reject(cloned);
    for (const copy of cloned.entities) {
      const original = sources.find((source) => cloned.idMap.get(source.id) === copy.id)!;
      if (sameGeometry(original, copy)) return reject(`A copy of ${nameOf(original.id)} would land exactly on the original, so the pattern would only stack duplicates.`, [original.id], "Move the pattern centre away from the entity, or choose a different spacing.");
    }
    added.push(...cloned.entities);
    constraints.push(...cloned.constraints);
  }
  return finishPlan(context, { label, removeEntityIds: [], updateEntities: [], addEntities: added, addConstraints: addSizeLinks(context, sources, added, instances.length, constraints) });
}

/** Equal-size relations from each source to its copies, when they fit in the edit's relation budget. */
function addSizeLinks(context: SketchEditContext, sources: readonly SketchEntity[], added: readonly SketchEntity[], instanceCount: number, existing: readonly WorkbenchSketchConstraint[]): readonly WorkbenchSketchConstraint[] {
  const linkable = sources.filter((source) => source.kind === "line" || source.kind === "circle" || source.kind === "arc");
  if (existing.length + linkable.length * instanceCount > 360) return existing;
  const links: WorkbenchSketchConstraint[] = [];
  for (let instance = 0; instance < instanceCount; instance += 1) {
    sources.forEach((source, index) => {
      if (source.kind !== "line" && source.kind !== "circle" && source.kind !== "arc") return;
      const copy = added[instance * sources.length + index];
      if (copy !== undefined) links.push(pairRelation(context, "equal", source.id, copy.id));
    });
  }
  return [...existing, ...links];
}

// ---------------------------------------------------------------------------------------------
// Move, rotate and scale
// ---------------------------------------------------------------------------------------------

export type TransformSpec =
  | { readonly kind: "move"; readonly dxMm: number; readonly dyMm: number; readonly copies?: number }
  | { readonly kind: "rotate"; readonly angleDeg: number; readonly center: Vec2; readonly copies?: number }
  | { readonly kind: "scale"; readonly factor: number; readonly center: Vec2; /** A different factor along Y gives a non-uniform scale. */ readonly factorY?: number };

/** Scales every defining point about `center` (x by `sx`, y by `sy`) and the size fields to match; a message when the shape cannot stay itself. */
function scaleEntity(entity: SketchEntity, id: string, center: Vec2, sx: number, sy: number): SketchEntity | string {
  const point = (value: Vec2): Vec2 => [center[0] + (value[0] - center[0]) * sx, center[1] + (value[1] - center[1]) * sy];
  const uniform = Math.abs(sx - sy) < 1e-12;
  if (entity.kind === "circle") {
    if (uniform) return { ...entity, id, center: point(entity.center), radiusMm: entity.radiusMm * sx };
    const along = entity.radiusMm * sx;
    const up = entity.radiusMm * sy;
    return along >= up
      ? { id, kind: "ellipse", center: point(entity.center), majorRadiusMm: along, minorRadiusMm: up, rotationDeg: 0, construction: entity.construction, ...(entity.visible === undefined ? {} : { visible: entity.visible }) }
      : { id, kind: "ellipse", center: point(entity.center), majorRadiusMm: up, minorRadiusMm: along, rotationDeg: 90, construction: entity.construction, ...(entity.visible === undefined ? {} : { visible: entity.visible }) };
  }
  if (entity.kind === "arc" && !uniform) return "A non-uniform scale cannot keep an arc an arc. Scale it uniformly, or convert it to a spline first.";
  if (entity.kind === "rectangle") {
    if (uniform) return { ...entity, id, center: point(entity.center), widthMm: entity.widthMm * sx, heightMm: entity.heightMm * sx };
    const turns = entity.rotationDeg / 90;
    if (Math.abs(turns - Math.round(turns)) > 1e-6) return "A non-uniform scale needs a rectangle whose sides are parallel to the axes; this one is rotated.";
    const odd = Math.abs(Math.round(turns)) % 2 === 1;
    return { ...entity, id, center: point(entity.center), widthMm: entity.widthMm * (odd ? sy : sx), heightMm: entity.heightMm * (odd ? sx : sy) };
  }
  if (entity.kind === "ellipse") {
    if (uniform) return { ...entity, id, center: point(entity.center), majorRadiusMm: entity.majorRadiusMm * sx, minorRadiusMm: entity.minorRadiusMm * sx };
    const turns = entity.rotationDeg / 90;
    if (Math.abs(turns - Math.round(turns)) > 1e-6) return "A non-uniform scale needs an ellipse whose axes are parallel to the sketch axes; this one is tilted.";
    const odd = Math.abs(Math.round(turns)) % 2 === 1;
    const major = entity.majorRadiusMm * (odd ? sy : sx);
    const minor = entity.minorRadiusMm * (odd ? sx : sy);
    return major >= minor ? { ...entity, id, center: point(entity.center), majorRadiusMm: major, minorRadiusMm: minor } : { ...entity, id, center: point(entity.center), majorRadiusMm: minor, minorRadiusMm: major, rotationDeg: wrapDegrees(entity.rotationDeg + 90) };
  }
  return mapEntity(entity, id, point, (degrees) => degrees);
}

/**
 * Moves, rotates or scales the selected entities. With `copy` the originals stay and transformed copies with fresh IDs are added (a
 * move or rotation can make several in one go); otherwise the entities are updated in place. A relation the edit makes untrue is
 * removed by the plan, a scale rewrites the dimensions it changes, and a Fixed curve is never moved.
 */
export function transformEntities(context: SketchEditContext, ids: readonly string[], spec: TransformSpec, copy: boolean): SketchEditResult {
  const entities = entitiesOf(context, ids);
  if (entities === undefined) return reject("Select the entities to transform.");
  const copies = copy ? Math.max(1, spec.kind === "scale" ? 1 : (spec.copies ?? 1)) : 1;
  if (!Number.isInteger(copies) || copies > MAX_COPIES) return reject(`Enter a whole number of copies from 1 to ${MAX_COPIES}.`);
  if (copy && entities.length * copies > MAX_COPIES) return reject(`A copy is limited to ${MAX_COPIES} entities (this would make ${entities.length * copies}).`);
  let apply: (entity: SketchEntity, id: string, step: number) => SketchEntity | string;
  let label: string;
  if (spec.kind === "move") {
    if (!Number.isFinite(spec.dxMm) || !Number.isFinite(spec.dyMm)) return reject("Enter numbers for the move distance.");
    if (Math.hypot(spec.dxMm, spec.dyMm) < 0.001 || Math.abs(spec.dxMm) > 100_000 || Math.abs(spec.dyMm) > 100_000) return reject("Enter a move distance between 0.001 mm and 100000 mm.");
    apply = (entity, id, step) => mapEntity(entity, id, (point) => [point[0] + spec.dxMm * step, point[1] + spec.dyMm * step], (degrees) => degrees);
    label = `${copy ? "Copied" : "Moved"} ${entities.length} ${plural(entities.length, "entity", "entities")} by (${format(spec.dxMm)}, ${format(spec.dyMm)}) mm`;
  } else if (spec.kind === "rotate") {
    if (!Number.isFinite(spec.angleDeg) || Math.abs(spec.angleDeg) < 0.001 || Math.abs(spec.angleDeg) > 360) return reject("Enter a rotation angle between 0.001 and 360 degrees.");
    if (!finiteVec(spec.center)) return reject("Enter numbers for the rotation centre.");
    const [cx, cy] = spec.center;
    apply = (entity, id, step) => {
      const radians = (spec.angleDeg * step * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return mapEntity(entity, id, (point) => [cx + (point[0] - cx) * cos - (point[1] - cy) * sin, cy + (point[0] - cx) * sin + (point[1] - cy) * cos], (degrees) => degrees + spec.angleDeg * step);
    };
    label = `${copy ? "Copied" : "Rotated"} ${entities.length} ${plural(entities.length, "entity", "entities")} ${format(spec.angleDeg)}°`;
  } else {
    const factorY = spec.factorY ?? spec.factor;
    if (!Number.isFinite(spec.factor) || !Number.isFinite(factorY)) return reject("Enter numbers for the scale factor.");
    if (!finiteVec(spec.center)) return reject("Enter numbers for the scale centre.");
    if (spec.factor < 0.01 || spec.factor > 100 || factorY < 0.01 || factorY > 100 || (Math.abs(spec.factor - 1) < 1e-6 && Math.abs(factorY - 1) < 1e-6)) return reject("Enter a scale factor between 0.01 and 100 (other than 1).");
    apply = (entity, id) => scaleEntity(entity, id, spec.center, spec.factor, factorY);
    label = `${copy ? "Copied" : "Scaled"} ${entities.length} ${plural(entities.length, "entity", "entities")} by ${format(spec.factor)}${spec.factorY === undefined ? "" : ` × ${format(factorY)}`}x`;
  }
  if (copy) {
    const added: SketchEntity[] = [];
    const constraints: WorkbenchSketchConstraint[] = [];
    for (let step = 1; step <= copies; step += 1) {
      const cloned = cloneSet(context, entities, (entity, id) => apply(entity, id, step));
      if (typeof cloned === "string") return reject(cloned);
      added.push(...cloned.entities);
      constraints.push(...cloned.constraints);
    }
    return finishPlan(context, { label: copies > 1 ? `${label} (${copies} copies)` : label, removeEntityIds: [], updateEntities: [], addEntities: added, addConstraints: constraints });
  }
  const updated: SketchEntity[] = [];
  for (const entity of entities) {
    const moved = apply(entity, entity.id, 1);
    if (typeof moved === "string") return reject(moved, [entity.id]);
    updated.push(moved);
  }
  const kindChanged = updated.some((entity, index) => entity.kind !== entities[index]!.kind);
  if (kindChanged) {
    // A circle that becomes an ellipse is a different kind of entity; replace it, which also drops the relations that no longer apply.
    const replaced = entities.filter((_, index) => updated[index]!.kind !== entities[index]!.kind);
    const keptUpdates = updated.filter((entity, index) => entity.kind === entities[index]!.kind);
    const additions = updated.filter((entity, index) => entity.kind !== entities[index]!.kind).map((entity) => ({ ...entity, id: context.newId("entity") }));
    return finishPlan(context, { label, removeEntityIds: replaced.map((entity) => entity.id), updateEntities: keptUpdates, addEntities: additions, addConstraints: [] });
  }
  const follow = spec.kind === "scale" ? followDimensions(context.sketch, afterUpdate(context.sketch, updated), new Set(updated.map((entity) => entity.id))) : { remove: [], add: [] };
  return finishPlan(context, { label, removeEntityIds: [], updateEntities: updated, addEntities: [], addConstraints: follow.add, ...(follow.remove.length === 0 ? {} : { removeConstraintIds: follow.remove }) });
}

// ---------------------------------------------------------------------------------------------
// Stretch
// ---------------------------------------------------------------------------------------------

export interface StretchWindow {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** The true bounding box of the selected entities (arc and ellipse extremes included), for seeding a stretch window. */
export function selectionBounds(sketch: WorkbenchSketch, ids: readonly string[]): StretchWindow | undefined {
  const boxes = ids.map((id) => find(sketch, id)).filter((entity): entity is SketchEntity => entity !== undefined).map(entityExtents);
  if (boxes.length === 0) return undefined;
  return {
    x1: Math.min(...boxes.map((box) => box.min[0])),
    y1: Math.min(...boxes.map((box) => box.min[1])),
    x2: Math.max(...boxes.map((box) => box.max[0])),
    y2: Math.max(...boxes.map((box) => box.max[1]))
  };
}

/**
 * Moves only the points of the selected entities that lie inside the window, by (dx, dy), so the rest of each entity stays put and
 * it stretches. A line end, arc point or spline fit point inside the window moves; a circle, ellipse or point moves whole when its
 * centre is inside; a rectangle moves whole when all four corners are inside, and otherwise each side that lies fully inside moves,
 * which changes its width or height. Dimensions of what stretched follow the new size.
 */
export function stretchEntities(context: SketchEditContext, ids: readonly string[], window: StretchWindow, dxMm: number, dyMm: number): SketchEditResult {
  if (![window.x1, window.y1, window.x2, window.y2, dxMm, dyMm].every(Number.isFinite)) return reject("Enter numbers for the window and the distance.");
  if (Math.hypot(dxMm, dyMm) < 0.001 || Math.abs(dxMm) > 100_000 || Math.abs(dyMm) > 100_000) return reject("Enter a stretch distance between 0.001 mm and 100000 mm.");
  const low: Vec2 = [Math.min(window.x1, window.x2), Math.min(window.y1, window.y2)];
  const high: Vec2 = [Math.max(window.x1, window.x2), Math.max(window.y1, window.y2)];
  if (high[0] - low[0] < 1e-6 || high[1] - low[1] < 1e-6) return reject("The window needs a width and a height.");
  const inside = (point: Vec2): boolean => point[0] >= low[0] - 1e-9 && point[0] <= high[0] + 1e-9 && point[1] >= low[1] - 1e-9 && point[1] <= high[1] + 1e-9;
  const shift = (point: Vec2): Vec2 => (inside(point) ? [point[0] + dxMm, point[1] + dyMm] : point);
  const sources = entitiesOf(context, ids);
  if (sources === undefined) return reject("Select the entities to stretch, then set the window over the part to move.");
  const updated: SketchEntity[] = [];
  for (const entity of sources) {
    if (entity.kind === "line") {
      if (inside(entity.start) || inside(entity.end)) updated.push({ ...entity, start: shift(entity.start), end: shift(entity.end) });
    } else if (entity.kind === "arc") {
      if (inside(entity.start) || inside(entity.mid) || inside(entity.end)) updated.push({ ...entity, start: shift(entity.start), mid: shift(entity.mid), end: shift(entity.end) });
    } else if (entity.kind === "spline") {
      if (entity.fitPoints.some(inside)) updated.push({ ...entity, fitPoints: entity.fitPoints.map(shift) });
    } else if (entity.kind === "circle" || entity.kind === "ellipse") {
      if (inside(entity.center)) updated.push({ ...entity, center: shift(entity.center) });
    } else if (entity.kind === "point") {
      if (inside(entity.point)) updated.push({ ...entity, point: shift(entity.point) });
    } else {
      const corners = entityPoints(entity);
      const hit = corners.map(inside);
      if (hit.every(Boolean)) { updated.push({ ...entity, center: [entity.center[0] + dxMm, entity.center[1] + dyMm] }); continue; }
      // Corners run (-w,-h), (w,-h), (w,h), (-w,h): a side is a pair of neighbouring corners.
      const left = hit[0]! && hit[3]!;
      const right = hit[1]! && hit[2]!;
      const bottom = hit[0]! && hit[1]!;
      const top = hit[2]! && hit[3]!;
      if (!left && !right && !bottom && !top) continue;
      const radians = (entity.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const localDx = dxMm * cos + dyMm * sin;
      const localDy = -dxMm * sin + dyMm * cos;
      const halfW = entity.widthMm / 2;
      const halfH = entity.heightMm / 2;
      const newLeft = -halfW + (left ? localDx : 0);
      const newRight = halfW + (right ? localDx : 0);
      const newBottom = -halfH + (bottom ? localDy : 0);
      const newTop = halfH + (top ? localDy : 0);
      const width = newRight - newLeft;
      const height = newTop - newBottom;
      if (width < 0.01 || height < 0.01) return reject(`The stretch would collapse ${nameOf(entity.id)}; use a smaller distance.`, [entity.id]);
      const centerX = (newLeft + newRight) / 2;
      const centerY = (newBottom + newTop) / 2;
      updated.push({ ...entity, widthMm: width, heightMm: height, center: [entity.center[0] + centerX * cos - centerY * sin, entity.center[1] + centerX * sin + centerY * cos] });
    }
  }
  if (updated.length === 0) return reject("Nothing in the selection lies inside the window. Move the window over the points or sides you want to stretch.");
  const follow = followDimensions(context.sketch, afterUpdate(context.sketch, updated), new Set(updated.map((entity) => entity.id)));
  return finishPlan(context, {
    label: `Stretched ${updated.length} ${plural(updated.length, "entity", "entities")} by (${format(dxMm)}, ${format(dyMm)}) mm`,
    removeEntityIds: [],
    updateEntities: updated,
    addEntities: [],
    addConstraints: follow.add,
    ...(follow.remove.length === 0 ? {} : { removeConstraintIds: follow.remove })
  });
}
