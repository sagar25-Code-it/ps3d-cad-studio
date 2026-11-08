import { failure, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { ShapeIds, SketchShape } from "./shapes.js";
import { circumcircle, turn } from "./curve-math.js";

/**
 * Reusable sketch blocks: a named group of curves (and the relations between them) that is saved once and dropped into
 * a sketch any number of times, turned and scaled as it goes in. Insertion places independent copies (like Copy), not
 * live instances: editing the block later does not change what was already inserted. Blocks are kept in the browser,
 * not in the project file.
 */
export interface SketchBlock {
  readonly name: string;
  /** The curves, moved so that the middle of their bounding box is the origin. */
  readonly entities: readonly SketchEntity[];
  /** Relations whose every entity is in the block. */
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

export const BLOCK_MAX_ENTITIES = 150;
export const BLOCK_NAME_MAX = 40;

const bad = (message: string, recovery = "Select the curves to save, then name the block."): WorkbenchResult<never> => failure("INVALID_OPERATION", message, [], recovery);

/** The bounding box of an entity (arcs follow their curve, splines their fit points), kept local so this module needs nothing from the sketch index. */
function extentsOf(entity: SketchEntity): { readonly min: Vec2; readonly max: Vec2 } {
  const points: Vec2[] = [];
  if (entity.kind === "line") points.push(entity.start, entity.end);
  else if (entity.kind === "point") points.push(entity.point);
  else if (entity.kind === "spline") points.push(...entity.fitPoints);
  else if (entity.kind === "circle") points.push([entity.center[0] - entity.radiusMm, entity.center[1] - entity.radiusMm], [entity.center[0] + entity.radiusMm, entity.center[1] + entity.radiusMm]);
  else if (entity.kind === "rectangle" || entity.kind === "ellipse") {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const [a, b] = entity.kind === "rectangle" ? [entity.widthMm / 2, entity.heightMm / 2] : [entity.majorRadiusMm, entity.minorRadiusMm];
    const spanX = entity.kind === "rectangle" ? Math.abs(a * Math.cos(radians)) + Math.abs(b * Math.sin(radians)) : Math.hypot(a * Math.cos(radians), b * Math.sin(radians));
    const spanY = entity.kind === "rectangle" ? Math.abs(a * Math.sin(radians)) + Math.abs(b * Math.cos(radians)) : Math.hypot(a * Math.sin(radians), b * Math.cos(radians));
    points.push([entity.center[0] - spanX, entity.center[1] - spanY], [entity.center[0] + spanX, entity.center[1] + spanY]);
  } else {
    const circle = circumcircle(entity.start, entity.mid, entity.end);
    if (circle === undefined) points.push(entity.start, entity.end);
    else {
      const counterClockwise = turn(entity.start, entity.mid, entity.end) > 0;
      const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
      const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
      const full = Math.PI * 2;
      const sweep = ((((counterClockwise ? endAngle - startAngle : startAngle - endAngle) % full) + full) % full);
      for (let step = 0; step <= 64; step += 1) {
        const angle = startAngle + (counterClockwise ? 1 : -1) * (sweep * step) / 64;
        points.push([circle.center[0] + circle.radiusMm * Math.cos(angle), circle.center[1] + circle.radiusMm * Math.sin(angle)]);
      }
    }
  }
  return { min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))], max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))] };
}

/** Applies a point transform to an entity, producing the same kind of entity at the new place. `turnDeg` and `factor` carry the rotation and scale for the entities that store them. */
function transformEntity(entity: SketchEntity, id: string, move: (point: Vec2) => Vec2, turnDeg: number, factor: number): SketchEntity {
  const base = { id, construction: entity.construction };
  switch (entity.kind) {
    case "line": return { ...base, kind: "line", start: move(entity.start), end: move(entity.end) };
    case "arc": return { ...base, kind: "arc", start: move(entity.start), mid: move(entity.mid), end: move(entity.end) };
    case "circle": return { ...base, kind: "circle", center: move(entity.center), radiusMm: entity.radiusMm * factor };
    case "ellipse": return { ...base, kind: "ellipse", center: move(entity.center), majorRadiusMm: entity.majorRadiusMm * factor, minorRadiusMm: entity.minorRadiusMm * factor, rotationDeg: wrapDegrees(entity.rotationDeg + turnDeg) };
    case "rectangle": return { ...base, kind: "rectangle", center: move(entity.center), widthMm: entity.widthMm * factor, heightMm: entity.heightMm * factor, rotationDeg: wrapDegrees(entity.rotationDeg + turnDeg) };
    case "point": return { ...base, kind: "point", point: move(entity.point) };
    case "spline": return { ...base, kind: "spline", fitPoints: entity.fitPoints.map((point) => move(point)) };
  }
}

function wrapDegrees(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** Saves a group of curves as a block. The constraints given are filtered to those that stay inside the group. */
export function makeSketchBlock(name: string, entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[]): WorkbenchResult<SketchBlock> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > BLOCK_NAME_MAX) return bad(`A block name takes 1 to ${BLOCK_NAME_MAX} characters.`, "Type a name for the block.");
  const curves = entities.filter((entity) => entity.visible !== false);
  if (curves.length === 0) return bad("Select at least one curve to save as a block.");
  if (curves.length > BLOCK_MAX_ENTITIES) return bad(`A block takes at most ${BLOCK_MAX_ENTITIES} curves.`, "Select fewer curves.");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entity of curves) {
    const box = extentsOf(entity);
    minX = Math.min(minX, box.min[0]);
    minY = Math.min(minY, box.min[1]);
    maxX = Math.max(maxX, box.max[0]);
    maxY = Math.max(maxY, box.max[1]);
  }
  const origin: Vec2 = [(minX + maxX) / 2, (minY + maxY) / 2];
  const toOrigin = (point: Vec2): Vec2 => [point[0] - origin[0], point[1] - origin[1]];
  const moved = curves.map((entity) => transformEntity(entity, entity.id, toOrigin, 0, 1));
  const inside = new Set(moved.map((entity) => entity.id));
  const kept = constraints.filter((constraint) => constraint.suppressed !== true && constraint.entityIds.every((id) => inside.has(id)));
  return { ok: true, value: { name: trimmed, entities: moved, constraints: kept } };
}

export interface BlockPlacement {
  /** Counter-clockwise turn about the insertion point. */
  readonly rotationDeg: number;
  /** Uniform scale factor. */
  readonly scale: number;
}

/**
 * Drops a copy of a block with its middle at `at`. Fresh IDs are made for every curve and relation. A Fixed relation is
 * not carried over (the copy is free to move), and Horizontal / Vertical are dropped when the block is turned by an angle
 * that is not a multiple of 90 degrees, since they would no longer hold. Dimension values scale with the block.
 */
export function insertSketchBlock(block: SketchBlock, at: Vec2, placement: BlockPlacement, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const { rotationDeg, scale } = placement;
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 100) return bad("Block scale must be between 0.01 and 100.", "Type a scale in that range.");
  if (!Number.isFinite(rotationDeg)) return bad("The block angle must be a number.", "Type an angle in degrees.");
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const move = (point: Vec2): Vec2 => [at[0] + scale * (point[0] * cos - point[1] * sin), at[1] + scale * (point[0] * sin + point[1] * cos)];
  const remap = new Map<string, string>();
  const entities = block.entities.map((entity) => {
    const id = ids.entity();
    remap.set(entity.id, id);
    return transformEntity(entity, id, move, rotationDeg, scale);
  });
  const quarterTurns = Math.abs(rotationDeg / 90 - Math.round(rotationDeg / 90)) < 1e-9;
  const constraints: WorkbenchSketchConstraint[] = [];
  for (const constraint of block.constraints) {
    if (constraint.kind === "fixed") continue;
    if ((constraint.kind === "horizontal" || constraint.kind === "vertical") && !quarterTurns) continue;
    const swapAxes = quarterTurns && Math.round(rotationDeg / 90) % 2 !== 0;
    const kind = swapAxes && constraint.kind === "horizontal" ? "vertical" : swapAxes && constraint.kind === "vertical" ? "horizontal" : constraint.kind;
    const { valueMm, ...rest } = constraint;
    constraints.push({
      ...rest,
      id: ids.constraint(),
      kind,
      entityIds: constraint.entityIds.map((id) => remap.get(id)!),
      ...(valueMm === undefined ? {} : { valueMm: valueMm * scale })
    });
  }
  return { ok: true, value: { entities, constraints } };
}

// ---------------------------------------------------------------- the block library

/** The slice of the browser's Storage a block library needs, so it can be tested without a browser. */
export interface BlockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BlockLibrary {
  list(): readonly SketchBlock[];
  get(name: string): SketchBlock | undefined;
  /** Saves (or replaces) a block by name. */
  save(block: SketchBlock): void;
  remove(name: string): void;
}

const STORAGE_KEY = "ps3d.sketch-blocks.v1";

/** A block library kept in memory and mirrored to `storage` when there is one; a storage that throws or holds junk is ignored. */
export function createBlockLibrary(storage?: BlockStorage): BlockLibrary {
  let blocks: SketchBlock[] = [];
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw !== null && raw !== undefined) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        blocks = parsed.filter((item): item is SketchBlock => typeof item === "object" && item !== null && typeof (item as SketchBlock).name === "string" && Array.isArray((item as SketchBlock).entities) && Array.isArray((item as SketchBlock).constraints));
      }
    }
  } catch {
    blocks = [];
  }
  const persist = (): void => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(blocks)); } catch { /* storage is a convenience: the library still works in memory */ }
  };
  return {
    list: () => blocks,
    get: (name) => blocks.find((block) => block.name === name),
    save: (block) => { blocks = [...blocks.filter((existing) => existing.name !== block.name), block].sort((left, right) => left.name.localeCompare(right.name)); persist(); },
    remove: (name) => { blocks = blocks.filter((block) => block.name !== name); persist(); }
  };
}
