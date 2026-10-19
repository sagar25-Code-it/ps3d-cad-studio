import { solveAnalyticSketch } from "../../parametric-sketch-core/src/solver.js";
import type {
  ArcGeometry,
  GeometryReference,
  ParametricSketchDocument,
  SketchConstraint,
  SketchDimension,
  SketchGeometry
} from "../../parametric-sketch-core/src/types.js";
import type { SketchEntity, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/** A constraint the analytic solver could not enforce, kept on the sketch as design intent. */
export interface UnsolvedConstraint {
  readonly constraintId: string;
  readonly reason: string;
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
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly relatedIds: readonly string[];
      readonly recovery: string;
    };

const MOVE_TOLERANCE_MM = 1e-9;
const RADIAL_KINDS: readonly SketchEntity["kind"][] = ["circle", "arc"];

/**
 * Solves the live sketch's geometric constraints with the analytic backend.
 *
 * Only the constraint-connected component that contains `focusEntityIds` is solved, so adding a
 * relation never disturbs unrelated geometry. Lines, circles and 3-point arcs take part;
 * rectangles are rigid (only `fixed` and their own width/height dimensions apply). Anything the
 * backend cannot enforce is reported in `unsolved` and left recorded rather than approximated.
 */
export function solveLiveSketch(sketch: WorkbenchSketch, focusEntityIds?: readonly string[]): LiveSketchSolveReport {
  const component = constraintComponent(sketch, focusEntityIds);
  const entities = sketch.entities.filter((entity) => component.has(entity.id));
  // A relaxed (suppressed) relation stays recorded but is not enforced.
  const constraints = sketch.constraints.filter((constraint) => constraint.suppressed !== true && constraint.entityIds.some((id) => component.has(id)));
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));

  const arcFrames = new Map<string, ArcFrame>();
  const geometry: SketchGeometry[] = [];
  for (const entity of entities) {
    const converted = toSolverGeometry(entity, arcFrames);
    if (converted !== undefined) geometry.push(converted);
  }

  const solverConstraints: SketchConstraint[] = [];
  const dimensions: SketchDimension[] = [];
  const unsolved: UnsolvedConstraint[] = [];
  for (const constraint of constraints) {
    const translated = translateConstraint(constraint, entityById, geometry);
    if (translated.unsolved !== undefined) unsolved.push({ constraintId: constraint.id, reason: translated.unsolved });
    solverConstraints.push(...translated.constraints);
    dimensions.push(...translated.dimensions);
  }
  if (solverConstraints.length === 0 && dimensions.length === 0) {
    return { ok: true, entities: sketch.entities, movedIds: [], notes: [], unsolved };
  }

  const document: ParametricSketchDocument = {
    schemaVersion: "1.0",
    id: sketch.id,
    revision: 0,
    plane: { kind: "principal", referenceId: sketch.plane, originMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] },
    parameters: {},
    geometry,
    constraints: solverConstraints,
    dimensions
  };
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" && !diagnostic.unsupported);
  if (result.status === "failed" || errors.length > 0) {
    const first = errors[0];
    return {
      ok: false,
      message: first?.message ?? "The sketch constraints could not be solved.",
      relatedIds: [...new Set(errors.flatMap((diagnostic) => diagnostic.relatedIds))].sort(),
      recovery: first?.recovery ?? "Remove or change one of the conflicting constraints."
    };
  }
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.unsupported) unsolved.push({ constraintId: diagnostic.relatedIds[0] ?? sketch.id, reason: diagnostic.message });
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
  return { ok: true, entities: nextEntities, movedIds, notes, unsolved };
}

/** Entities reachable from the focus through constraints; every entity when there is no focus. */
function constraintComponent(sketch: WorkbenchSketch, focusEntityIds: readonly string[] | undefined): ReadonlySet<string> {
  if (focusEntityIds === undefined) return new Set(sketch.entities.map((entity) => entity.id));
  const reached = new Set<string>(focusEntityIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const constraint of sketch.constraints) {
      if (!constraint.entityIds.some((id) => reached.has(id))) continue;
      for (const id of constraint.entityIds) {
        if (!reached.has(id)) {
          reached.add(id);
          grew = true;
        }
      }
    }
  }
  return reached;
}

/** How a live 3-point arc maps onto the solver's counter-clockwise centre/angle arc. */
interface ArcFrame {
  /** True when the live start-mid-end order runs clockwise, so the solver arc starts at the live end. */
  readonly reversed: boolean;
  readonly center: Vec2;
  readonly radiusMm: number;
}

function toSolverGeometry(entity: SketchEntity, arcFrames: Map<string, ArcFrame>): SketchGeometry | undefined {
  const base = { id: entity.id, construction: entity.construction, suppressed: false } as const;
  if (entity.kind === "line") return { ...base, kind: "line", start: entity.start, end: entity.end };
  if (entity.kind === "circle") return { ...base, kind: "circle", center: entity.center, radiusMm: entity.radiusMm };
  if (entity.kind === "arc") {
    const circle = circumcircle(entity.start, entity.mid, entity.end);
    if (circle === undefined) return undefined;
    const reversed = cross(entity.start, entity.mid, entity.end) < 0;
    arcFrames.set(entity.id, { reversed, center: circle.center, radiusMm: circle.radiusMm });
    const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
    const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
    return { ...base, kind: "arc", center: circle.center, radiusMm: circle.radiusMm, startAngleRad: reversed ? endAngle : startAngle, endAngleRad: reversed ? startAngle : endAngle };
  }
  return undefined;
}

/** Returns the updated live entity, or undefined when the solver left it where it was. */
function fromSolverGeometry(entity: SketchEntity, solved: SketchGeometry, frame: ArcFrame | undefined): SketchEntity | undefined {
  if (entity.kind === "line" && solved.kind === "line") {
    return near2(entity.start, solved.start) && near2(entity.end, solved.end) ? undefined : { ...entity, start: solved.start, end: solved.end };
  }
  if (entity.kind === "circle" && solved.kind === "circle") {
    return near2(entity.center, solved.center) && Math.abs(entity.radiusMm - solved.radiusMm) <= MOVE_TOLERANCE_MM ? undefined : { ...entity, center: solved.center, radiusMm: solved.radiusMm };
  }
  if (entity.kind === "arc" && solved.kind === "arc" && frame !== undefined) {
    if (near2(frame.center, solved.center) && Math.abs(frame.radiusMm - solved.radiusMm) <= MOVE_TOLERANCE_MM) return undefined;
    return rebuildArc(entity, solved, frame);
  }
  return undefined;
}

function rebuildArc(entity: Extract<SketchEntity, { kind: "arc" }>, solved: ArcGeometry, frame: ArcFrame): SketchEntity {
  const sweep = (((solved.endAngleRad - solved.startAngleRad) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const at = (angle: number): Vec2 => [solved.center[0] + solved.radiusMm * Math.cos(angle), solved.center[1] + solved.radiusMm * Math.sin(angle)];
  const first = at(solved.startAngleRad);
  const last = at(solved.startAngleRad + sweep);
  const mid = at(solved.startAngleRad + sweep / 2);
  return frame.reversed ? { ...entity, start: last, mid, end: first } : { ...entity, start: first, mid, end: last };
}

interface Translated {
  readonly constraints: readonly SketchConstraint[];
  readonly dimensions: readonly SketchDimension[];
  readonly unsolved?: string;
}

function translateConstraint(
  constraint: WorkbenchSketchConstraint,
  entities: ReadonlyMap<string, SketchEntity>,
  geometry: readonly SketchGeometry[]
): Translated {
  const stable = { id: constraint.id, suppressed: false } as const;
  const self = (id: string): GeometryReference => ({ entityId: id, selector: "self" });
  const kindOf = (id: string): SketchEntity["kind"] | undefined => entities.get(id)?.kind;
  const present = new Set(geometry.map((candidate) => candidate.id));
  const none = (reason: string): Translated => ({ constraints: [], dimensions: [], unsolved: reason });
  const [first, second, third] = constraint.entityIds;
  if (constraint.entityIds.some((id) => kindOf(id) === undefined)) return none("A referenced entity no longer exists.");

  if (constraint.kind === "fixed") {
    return { constraints: constraint.entityIds.filter((id) => present.has(id)).map((id, index) => ({ id: `${constraint.id}#${index}`, suppressed: false, kind: "fix" as const, target: self(id) })), dimensions: [] };
  }
  if (constraint.kind === "radius" || constraint.kind === "distance") return translateDimension(constraint, kindOf, present);
  if (constraint.entityIds.some((id) => kindOf(id) === "rectangle")) return none("Rectangles are rigid in the solver; only Fixed and their own width and height apply.");

  if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
    return kindOf(first!) === "line"
      ? { constraints: [{ ...stable, kind: constraint.kind, line: self(first!) }], dimensions: [] }
      : none(`${constraint.kind} applies to a line.`);
  }
  if (constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "collinear") {
    return kindOf(first!) === "line" && kindOf(second!) === "line"
      ? { constraints: [{ ...stable, kind: constraint.kind, first: self(first!), second: self(second!) }], dimensions: [] }
      : none(`${constraint.kind} needs two lines.`);
  }
  if (constraint.kind === "concentric") {
    return isRadial(kindOf(first!)) && isRadial(kindOf(second!))
      ? { constraints: [{ ...stable, kind: "concentric", first: self(first!), second: self(second!) }], dimensions: [] }
      : none("Concentric needs two circles or arcs.");
  }
  if (constraint.kind === "equal") {
    const bothLines = kindOf(first!) === "line" && kindOf(second!) === "line";
    return bothLines || (isRadial(kindOf(first!)) && isRadial(kindOf(second!)))
      ? { constraints: [{ ...stable, kind: "equal", first: self(first!), second: self(second!) }], dimensions: [] }
      : none("Equal needs two lines, or two circles or arcs.");
  }
  if (constraint.kind === "tangent") {
    const lineAndRadial = (kindOf(first!) === "line" && isRadial(kindOf(second!))) || (kindOf(second!) === "line" && isRadial(kindOf(first!)));
    return lineAndRadial || (isRadial(kindOf(first!)) && isRadial(kindOf(second!)))
      ? { constraints: [{ ...stable, kind: "tangent", first: self(first!), second: self(second!) }], dimensions: [] }
      : none("Tangent solves a line against a circle or arc, or two circles or arcs.");
  }
  if (constraint.kind === "symmetry") return translateSymmetry(constraint, entities, first, second, third);
  return none(`${constraint.kind} needs endpoint selection, which the sketch records but does not solve yet.`);
}

function translateSymmetry(
  constraint: WorkbenchSketchConstraint,
  entities: ReadonlyMap<string, SketchEntity>,
  first: string | undefined,
  second: string | undefined,
  axisId: string | undefined
): Translated {
  const none = (reason: string): Translated => ({ constraints: [], dimensions: [], unsolved: reason });
  if (first === undefined || second === undefined || axisId === undefined) return none("Symmetric needs two entities and an axis line (select the axis last).");
  const a = entities.get(first);
  const b = entities.get(second);
  const axis = entities.get(axisId);
  if (a === undefined || b === undefined || axis?.kind !== "line") return none("Symmetric needs an axis line as the last selection.");
  const point = (entityId: string, selector: GeometryReference["selector"]): GeometryReference => ({ entityId, selector });
  const mirror = (id: string, one: GeometryReference, other: GeometryReference): SketchConstraint => ({ id, suppressed: false, kind: "symmetric", first: one, second: other, axis: { entityId: axisId, selector: "self" } });
  if (a.kind === "line" && b.kind === "line") {
    // Pair the endpoints that are nearer once mirrored, so a drawn mirror image keeps its orientation.
    const straight = distanceSquared(reflect(a.start, axis), b.start) + distanceSquared(reflect(a.end, axis), b.end);
    const crossed = distanceSquared(reflect(a.start, axis), b.end) + distanceSquared(reflect(a.end, axis), b.start);
    const startMate: "start" | "end" = straight <= crossed ? "start" : "end";
    const endMate: "start" | "end" = startMate === "start" ? "end" : "start";
    return {
      constraints: [mirror(`${constraint.id}#start`, point(first, "start"), point(second, startMate)), mirror(`${constraint.id}#end`, point(first, "end"), point(second, endMate))],
      dimensions: []
    };
  }
  if (a.kind === "circle" && b.kind === "circle") {
    return {
      constraints: [
        mirror(`${constraint.id}#centre`, point(first, "center"), point(second, "center")),
        { id: `${constraint.id}#radius`, suppressed: false, kind: "equal", first: point(first, "self"), second: point(second, "self") }
      ],
      dimensions: []
    };
  }
  return none("Symmetric solves two lines or two circles about a line axis; arcs and mixed pairs are recorded only.");
}

function translateDimension(constraint: WorkbenchSketchConstraint, kindOf: (id: string) => SketchEntity["kind"] | undefined, present: ReadonlySet<string>): Translated {
  const id = constraint.entityIds[0]!;
  const value = constraint.valueMm;
  if (value === undefined) return { constraints: [], dimensions: [], unsolved: "The dimension has no value." };
  if (constraint.kind === "radius" && isRadial(kindOf(id)) && present.has(id)) {
    const target: GeometryReference = { entityId: id, selector: "radius" };
    return {
      // A dimensioned radius is also held fixed, so tangent and equal relations move or resize the other geometry instead.
      constraints: [{ id: `${constraint.id}#hold`, suppressed: false, kind: "fix", target }],
      dimensions: [{ id: constraint.id, mode: "driving", suppressed: false, value: { value }, kind: "radius", target: { entityId: id, selector: "self" }, unit: "mm" }]
    };
  }
  if (constraint.kind === "distance" && constraint.dimension === "length" && kindOf(id) === "line" && present.has(id)) {
    return { constraints: [], dimensions: [{ id: constraint.id, mode: "driving", suppressed: false, value: { value }, kind: "length", target: { entityId: id, selector: "self" }, unit: "mm" }] };
  }
  // Rectangle width and height are applied directly to the rectangle when the dimension is set.
  return { constraints: [], dimensions: [] };
}

function describeChange(before: SketchEntity, after: SketchEntity): string {
  const label = before.id.replace(/^entity:/u, "");
  if (before.kind === "circle" && after.kind === "circle") {
    const resized = Math.abs(before.radiusMm - after.radiusMm) > 1e-6;
    const moved = !near2(before.center, after.center, 1e-6);
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

function isRadial(kind: SketchEntity["kind"] | undefined): boolean {
  return kind !== undefined && RADIAL_KINDS.includes(kind);
}

function near2(a: Vec2, b: Vec2, tolerance = MOVE_TOLERANCE_MM): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

function distanceSquared(a: Vec2, b: Vec2): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function reflect(point: Vec2, axis: Extract<SketchEntity, { kind: "line" }>): Vec2 {
  const dx = axis.end[0] - axis.start[0];
  const dy = axis.end[1] - axis.start[1];
  const denominator = dx * dx + dy * dy;
  const parameter = denominator <= 1e-18 ? 0 : ((point[0] - axis.start[0]) * dx + (point[1] - axis.start[1]) * dy) / denominator;
  const foot: Vec2 = [axis.start[0] + parameter * dx, axis.start[1] + parameter * dy];
  return [2 * foot[0] - point[0], 2 * foot[1] - point[1]];
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}
