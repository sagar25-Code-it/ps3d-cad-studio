import type { SketchConstraintKind, SketchEntity, SketchPointRef, Vec2, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { arcShape } from "../../workbench-core/src/sketch-measure.js";
import { describeLength } from "./sketch-units.js";

/**
 * Pure model of the relation glyphs drawn on the sketch canvas: what each kind looks like, which relations are shown for a
 * Constraints display level, where every glyph goes so that glyphs never pile up on a small circle, which geometry a hovered
 * glyph relates, and which relations are redundant.
 *
 * Positions are in sketch millimetres (y up); sizes that depend on the screen are given in pixels and scaled by `mmPerPx`.
 */
export type ConstraintDisplayLevel = "all" | "selected" | "none";

export interface ConstraintDisplaySettings {
  readonly level: ConstraintDisplayLevel;
  /** Kinds the person turned off in the Constraints legend. A selected relation is still shown. */
  readonly hiddenKinds: readonly SketchConstraintKind[];
}

export const DEFAULT_CONSTRAINT_DISPLAY: ConstraintDisplaySettings = { level: "all", hiddenKinds: [] };

export const CONSTRAINT_LEVELS: readonly { readonly id: ConstraintDisplayLevel; readonly label: string; readonly hint: string }[] = [
  { id: "all", label: "All", hint: "Draw every relation next to its curve." },
  { id: "selected", label: "Selected", hint: "Draw only the relations of the selected or hovered curves." },
  { id: "none", label: "None", hint: "Hide the relation glyphs. A selected relation is still shown." }
];

interface GlyphInfo {
  readonly label: string;
  readonly name: string;
  /** Dimensions are drawn as dimensions, not as glyphs. */
  readonly dimension: boolean;
}

export const CONSTRAINT_GLYPH_INFO: Readonly<Record<SketchConstraintKind, GlyphInfo>> = {
  horizontal: { label: "H", name: "Horizontal", dimension: false },
  vertical: { label: "V", name: "Vertical", dimension: false },
  parallel: { label: "∥", name: "Parallel", dimension: false },
  perpendicular: { label: "⊥", name: "Perpendicular", dimension: false },
  tangent: { label: "T", name: "Tangent", dimension: false },
  collinear: { label: "C", name: "Collinear", dimension: false },
  midpoint: { label: "M", name: "Midpoint", dimension: false },
  symmetry: { label: "S", name: "Symmetric", dimension: false },
  coincident: { label: "•", name: "Coincident", dimension: false },
  concentric: { label: "◎", name: "Concentric", dimension: false },
  equal: { label: "=", name: "Equal", dimension: false },
  fixed: { label: "F", name: "Fixed", dimension: false },
  smooth: { label: "G2", name: "Smooth (G2)", dimension: false },
  pierce: { label: "⊙", name: "Pierce", dimension: false },
  refraction: { label: "n", name: "Refraction", dimension: false },
  radius: { label: "R", name: "Radius dimension", dimension: true },
  distance: { label: "D", name: "Distance dimension", dimension: true },
  angle: { label: "∠", name: "Angle dimension", dimension: true },
  "arc-length": { label: "⌒", name: "Arc length dimension", dimension: true },
  perimeter: { label: "P", name: "Perimeter dimension", dimension: true }
};

export const GEOMETRIC_CONSTRAINT_KINDS: readonly SketchConstraintKind[] = (Object.keys(CONSTRAINT_GLYPH_INFO) as SketchConstraintKind[]).filter((kind) => !CONSTRAINT_GLYPH_INFO[kind].dimension);

export function isDimensionKind(kind: SketchConstraintKind): boolean {
  return CONSTRAINT_GLYPH_INFO[kind].dimension;
}

export function glyphLabel(kind: SketchConstraintKind): string {
  return CONSTRAINT_GLYPH_INFO[kind].label;
}

// ---------------------------------------------------------------------------------------------
// Names a person can read
// ---------------------------------------------------------------------------------------------

const KIND_NAME: Readonly<Record<SketchEntity["kind"], string>> = { line: "Line", rectangle: "Rectangle", circle: "Circle", ellipse: "Ellipse", arc: "Arc", point: "Point", spline: "Spline" };

/** "Line 3", "Circle 1": the ordinal counts curves of the same kind in sketch order, so no stable ID ever reaches the screen. */
export function entityOrdinalLabels(entities: readonly SketchEntity[]): ReadonlyMap<string, string> {
  const counts = new Map<SketchEntity["kind"], number>();
  const labels = new Map<string, string>();
  for (const entity of entities) {
    const next = (counts.get(entity.kind) ?? 0) + 1;
    counts.set(entity.kind, next);
    labels.set(entity.id, `${KIND_NAME[entity.kind]} ${next}`);
  }
  return labels;
}

/** "Parallel: Line 2, Line 5", "Fixed: Circle 1", or with a value "Length: Line 3 = 25 mm". */
export function describeConstraint(constraint: WorkbenchSketchConstraint, labels: ReadonlyMap<string, string>): string {
  const info = CONSTRAINT_GLYPH_INFO[constraint.kind];
  const who = constraint.entityIds.map((id) => labels.get(id) ?? "missing curve").join(", ");
  const dimensionName = constraint.kind === "distance" && constraint.dimension !== undefined ? `${constraint.dimension[0]!.toUpperCase()}${constraint.dimension.slice(1)}` : info.name;
  const value = constraint.valueDeg !== undefined ? ` = ${Number(constraint.valueDeg.toFixed(3))}°` : constraint.valueMm !== undefined ? ` = ${describeLength(constraint.valueMm)}` : "";
  const flags = `${constraint.driven === true ? " (reference)" : ""}${constraint.suppressed === true ? " (relaxed)" : ""}`;
  return `${dimensionName}: ${who}${value}${flags}`;
}

// ---------------------------------------------------------------------------------------------
// Which relations are drawn
// ---------------------------------------------------------------------------------------------

export interface GlyphFocus {
  readonly selectedEntityIds: readonly string[];
  readonly hoveredEntityId: string | null;
  readonly selectedConstraintIds: readonly string[];
  readonly hoveredConstraintId: string | null;
  /** Relations drawn whatever the level or hidden kinds say (redundant ones), unless the level is "none". */
  readonly alwaysShowIds?: ReadonlySet<string>;
}

/**
 * The relations that get a glyph. Dimensions never do (they are drawn as dimensions). With level `selected` only the relations
 * of the selected or hovered curves appear; with `none` only a relation the person selected. Hidden kinds are skipped unless the
 * relation itself is selected or hovered, so a click on a list row always shows what it picked.
 */
export function constraintsToDraw(constraints: readonly WorkbenchSketchConstraint[], settings: ConstraintDisplaySettings, focus: GlyphFocus): readonly WorkbenchSketchConstraint[] {
  const selectedEntities = new Set(focus.selectedEntityIds);
  const selectedConstraints = new Set(focus.selectedConstraintIds);
  const hiddenKinds = new Set(settings.hiddenKinds);
  return constraints.filter((constraint) => {
    if (isDimensionKind(constraint.kind)) return false;
    const picked = selectedConstraints.has(constraint.id) || focus.hoveredConstraintId === constraint.id;
    if (picked) return true;
    if (settings.level === "none") return false;
    if (focus.alwaysShowIds?.has(constraint.id) === true) return true;
    if (hiddenKinds.has(constraint.kind)) return false;
    if (settings.level === "all") return true;
    return constraint.entityIds.some((id) => selectedEntities.has(id) || id === focus.hoveredEntityId);
  });
}

/** The curves a glyph relates: the ones to highlight while the pointer is on it. */
export function relatedEntityIds(constraint: WorkbenchSketchConstraint): readonly string[] {
  return constraint.entityIds;
}

// ---------------------------------------------------------------------------------------------
// Redundancy
// ---------------------------------------------------------------------------------------------

/**
 * The relations to flag as redundant. The degree-of-freedom analysis names them in `redundantConstraintIds` when it can (the
 * solver work package adds it); this tolerates that field being absent and always adds exact duplicates, which need no solver:
 * the same kind on the same curves and points, with the same value, later in the list than the first.
 */
export function redundantConstraintIds(constraints: readonly WorkbenchSketchConstraint[], analysis?: unknown): ReadonlySet<string> {
  const found = new Set<string>();
  if (typeof analysis === "object" && analysis !== null) {
    const named = (analysis as { readonly redundantConstraintIds?: unknown }).redundantConstraintIds;
    if (Array.isArray(named)) for (const id of named) if (typeof id === "string") found.add(id);
  }
  const ORDER_FREE: readonly SketchConstraintKind[] = ["parallel", "perpendicular", "collinear", "equal", "concentric", "tangent", "coincident"];
  const seen = new Set<string>();
  for (const constraint of constraints) {
    if (constraint.suppressed === true) continue;
    const ids = ORDER_FREE.includes(constraint.kind) ? [...constraint.entityIds].sort() : constraint.entityIds;
    const key = [constraint.kind, constraint.dimension ?? "", ids.join("|"), (constraint.points ?? []).join("|"), constraint.valueMm ?? "", constraint.valueDeg ?? "", constraint.driven === true ? "driven" : ""].join("#");
    if (seen.has(key)) found.add(constraint.id);
    else seen.add(key);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Where glyphs go
// ---------------------------------------------------------------------------------------------

function pointOf(entity: SketchEntity, ref: SketchPointRef | undefined): Vec2 | undefined {
  if (ref === undefined) return undefined;
  if (entity.kind === "line") return ref === "start" ? entity.start : ref === "end" ? entity.end : ref === "mid" ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2] : undefined;
  if (entity.kind === "circle" || entity.kind === "ellipse") return ref === "center" ? entity.center : undefined;
  if (entity.kind === "arc") return ref === "center" ? arcShape(entity.start, entity.mid, entity.end)?.center : undefined;
  if (entity.kind === "point") return ref === "self" ? entity.point : undefined;
  return undefined;
}

export interface GlyphAnchor {
  readonly point: Vec2;
  /** Unit direction, in screen terms (x right, y down), the glyph is pushed away from the curve. */
  readonly away: Vec2;
}

const DIAGONAL = Math.SQRT1_2;

/**
 * Where a relation is attached: a defining point for Coincident and Midpoint, otherwise a point on the curve itself. A circle's
 * anchor sits on its rim (not at the centre, where every relation of a small circle used to stack), so the glyph reads as
 * belonging to the outline.
 */
export function glyphAnchor(constraint: WorkbenchSketchConstraint, entity: SketchEntity): GlyphAnchor {
  const joined = constraint.kind === "coincident" || constraint.kind === "midpoint" ? pointOf(entity, constraint.points?.[0]) : undefined;
  if (joined !== undefined) return { point: joined, away: [DIAGONAL, -DIAGONAL] };
  if (entity.kind === "circle") return { point: [entity.center[0] + entity.radiusMm * DIAGONAL, entity.center[1] + entity.radiusMm * DIAGONAL], away: [DIAGONAL, -DIAGONAL] };
  if (entity.kind === "ellipse") {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const local: Vec2 = [entity.majorRadiusMm * DIAGONAL, entity.minorRadiusMm * DIAGONAL];
    return { point: [entity.center[0] + local[0] * Math.cos(radians) - local[1] * Math.sin(radians), entity.center[1] + local[0] * Math.sin(radians) + local[1] * Math.cos(radians)], away: [DIAGONAL, -DIAGONAL] };
  }
  if (entity.kind === "line") return { point: [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], away: lineAway(entity.start, entity.end) };
  if (entity.kind === "rectangle") return { point: [entity.center[0] + entity.widthMm / 2, entity.center[1] + entity.heightMm / 2], away: [DIAGONAL, -DIAGONAL] };
  if (entity.kind === "point") return { point: entity.point, away: [DIAGONAL, -DIAGONAL] };
  if (entity.kind === "spline") return { point: entity.fitPoints[Math.floor(entity.fitPoints.length / 2)]!, away: [DIAGONAL, -DIAGONAL] };
  return { point: entity.mid, away: [DIAGONAL, -DIAGONAL] };
}

/** Pushes the glyph of a line to the upper side of the line, whatever its direction. */
function lineAway(start: Vec2, end: Vec2): Vec2 {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) return [DIAGONAL, -DIAGONAL];
  let nx = -dy / length;
  let ny = dx / length;
  // Prefer the normal that points up in the sketch (and right for a vertical line).
  if (ny < -1e-9 || (Math.abs(ny) <= 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
  // Screen y runs down, so up in the sketch is negative y.
  return [nx, -ny];
}

export interface PlacedGlyph {
  readonly id: string;
  readonly kind: SketchConstraintKind;
  readonly label: string;
  /** Centre of the glyph, in sketch millimetres (y up). */
  readonly at: Vec2;
  readonly anchor: Vec2;
  readonly entityIds: readonly string[];
  readonly suppressed: boolean;
  readonly redundant: boolean;
  /** Radius of the drawn disc in screen pixels. */
  readonly radiusPx: number;
}

export interface GlyphLayoutOptions {
  /** Millimetres covered by one screen pixel. */
  readonly mmPerPx: number;
  readonly redundant?: ReadonlySet<string>;
  /** Glyph disc radius in pixels; shrinks automatically when a great many glyphs are drawn. */
  readonly radiusPx?: number;
  /** How far a glyph stands off its curve, in pixels. */
  readonly standoffPx?: number;
}

/** Slot offsets (in units of one glyph spacing) around the preferred position, nearest first, preferring up and to the right. */
function slotOffsets(rings: number): readonly (readonly [number, number])[] {
  const slots: [number, number][] = [[0, 0]];
  for (let ring = 1; ring <= rings; ring += 1) {
    const cells: [number, number][] = [];
    for (let i = -ring; i <= ring; i += 1) {
      for (let j = -ring; j <= ring; j += 1) if (Math.max(Math.abs(i), Math.abs(j)) === ring) cells.push([i, j]);
    }
    // Screen y runs down, so j < 0 is up.
    cells.sort((a, b) => (Math.hypot(a[0], a[1]) + (a[0] < 0 ? 0.35 : 0) + (a[1] > 0 ? 0.35 : 0)) - (Math.hypot(b[0], b[1]) + (b[0] < 0 ? 0.35 : 0) + (b[1] > 0 ? 0.35 : 0)));
    slots.push(...cells);
  }
  return slots;
}

const SLOTS = slotOffsets(6);

/**
 * Lays the glyphs out so that no two overlap: each starts beside the point its relation is attached to, stood off from the
 * curve, and moves to the nearest free slot (a small grid of glyph-sized cells) when that place is taken. Deterministic, and
 * linear in practice thanks to a hash grid, so 1000 relations lay out in a few milliseconds.
 */
export function layoutConstraintGlyphs(constraints: readonly WorkbenchSketchConstraint[], entities: readonly SketchEntity[], options: GlyphLayoutOptions): readonly PlacedGlyph[] {
  const px = options.mmPerPx > 0 ? options.mmPerPx : 1;
  const byId = new Map(entities.map((entity) => [entity.id, entity] as const));
  const radiusPx = options.radiusPx ?? (constraints.length > 220 ? 6 : constraints.length > 90 ? 7 : 8);
  const standoffPx = options.standoffPx ?? radiusPx + 6;
  const spacing = radiusPx * 2 + 2;
  const cell = spacing * px;
  const taken = new Map<string, Vec2[]>();
  const key = (x: number, y: number): string => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
  const free = (x: number, y: number): boolean => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = taken.get(`${cx + dx}:${cy + dy}`);
        if (bucket === undefined) continue;
        for (const other of bucket) if (Math.hypot(other[0] - x, other[1] - y) < spacing * px - 1e-9) return false;
      }
    }
    return true;
  };
  const placed: PlacedGlyph[] = [];
  for (const constraint of constraints) {
    const entity = byId.get(constraint.entityIds[0] ?? "");
    if (entity === undefined) continue;
    const anchor = glyphAnchor(constraint, entity);
    const baseX = anchor.point[0] + anchor.away[0] * standoffPx * px;
    const baseY = anchor.point[1] - anchor.away[1] * standoffPx * px;
    let chosen: Vec2 = [baseX, baseY];
    for (const slot of SLOTS) {
      const x = baseX + slot[0] * spacing * px;
      const y = baseY - slot[1] * spacing * px;
      if (free(x, y)) { chosen = [x, y]; break; }
    }
    const bucketKey = key(chosen[0], chosen[1]);
    const bucket = taken.get(bucketKey);
    if (bucket === undefined) taken.set(bucketKey, [chosen]); else bucket.push(chosen);
    placed.push({
      id: constraint.id,
      kind: constraint.kind,
      label: CONSTRAINT_GLYPH_INFO[constraint.kind].label,
      at: chosen,
      anchor: anchor.point,
      entityIds: constraint.entityIds,
      suppressed: constraint.suppressed === true,
      redundant: options.redundant?.has(constraint.id) === true,
      radiusPx
    });
  }
  return placed;
}

/** The glyph under a sketch point (within its disc plus `slackPx` of forgiveness), the nearest when several qualify. */
export function glyphAt(glyphs: readonly PlacedGlyph[], point: Vec2, mmPerPx: number, slackPx = 3): PlacedGlyph | undefined {
  let best: { readonly glyph: PlacedGlyph; readonly distance: number } | undefined;
  for (const glyph of glyphs) {
    const distance = Math.hypot(glyph.at[0] - point[0], glyph.at[1] - point[1]);
    if (distance <= (glyph.radiusPx + slackPx) * mmPerPx && (best === undefined || distance < best.distance)) best = { glyph, distance };
  }
  return best?.glyph;
}

/** The constraint kinds present in a sketch, for the per-type show/hide list. */
export function constraintKindsPresent(constraints: readonly WorkbenchSketchConstraint[]): readonly SketchConstraintKind[] {
  const present = new Set(constraints.filter((constraint) => !isDimensionKind(constraint.kind)).map((constraint) => constraint.kind));
  return GEOMETRIC_CONSTRAINT_KINDS.filter((kind) => present.has(kind));
}

/** Toggles one kind in the hidden list. */
export function toggleHiddenKind(settings: ConstraintDisplaySettings, kind: SketchConstraintKind): ConstraintDisplaySettings {
  const hidden = settings.hiddenKinds.includes(kind) ? settings.hiddenKinds.filter((entry) => entry !== kind) : [...settings.hiddenKinds, kind];
  return { ...settings, hiddenKinds: hidden };
}

/** Reads settings saved by an older session, ignoring anything it does not recognise. */
export function parseConstraintDisplay(text: string | null | undefined): ConstraintDisplaySettings {
  if (text === null || text === undefined) return DEFAULT_CONSTRAINT_DISPLAY;
  try {
    const value = JSON.parse(text) as { readonly level?: unknown; readonly hiddenKinds?: unknown };
    const level: ConstraintDisplayLevel = value.level === "selected" || value.level === "none" || value.level === "all" ? value.level : "all";
    const hiddenKinds = Array.isArray(value.hiddenKinds) ? value.hiddenKinds.filter((kind): kind is SketchConstraintKind => typeof kind === "string" && Object.hasOwn(CONSTRAINT_GLYPH_INFO, kind)) : [];
    return { level, hiddenKinds };
  } catch {
    return DEFAULT_CONSTRAINT_DISPLAY;
  }
}

export interface ConstraintRow {
  readonly id: string;
  readonly kind: SketchConstraintKind;
  readonly label: string;
  /** "Parallel: Line 2, Line 5", with a value for a dimension. */
  readonly text: string;
  readonly suppressed: boolean;
  readonly dimension: boolean;
  readonly entityIds: readonly string[];
}

/** Every relation of the sketch as a list row, newest first. There is no cap: the list scrolls (the old one showed only the last ten). */
export function constraintRows(constraints: readonly WorkbenchSketchConstraint[], labels: ReadonlyMap<string, string>): readonly ConstraintRow[] {
  return [...constraints].reverse().map((constraint) => ({
    id: constraint.id,
    kind: constraint.kind,
    label: CONSTRAINT_GLYPH_INFO[constraint.kind].label,
    text: describeConstraint(constraint, labels),
    suppressed: constraint.suppressed === true,
    dimension: isDimensionKind(constraint.kind),
    entityIds: constraint.entityIds
  }));
}
