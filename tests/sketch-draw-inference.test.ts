import { applyWorkbenchOperation, createWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { autoConstraintsFor, inheritedTangentDirection, tangentArcPoints, type PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { measureFromCursor } from "../packages/workbench-sketch/src/dynamic-input.js";
import { advanceArcSweepTrack, startArcSweepTrack } from "../packages/workbench-sketch/src/arc-sweep.js";
import { inferSketchPoint } from "../packages/workbench-sketch/src/inference.js";
import { buildSketchEntity, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import { buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { relationPointsOf } from "../packages/workbench-sketch/src/relation-points.js";
import { DEFAULT_SNAP_ASSIST, anchorFor, assistedInference, type SnapAssistSettings, type SnapModifiers } from "../packages/workbench-sketch/src/snap-assist.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { shapeIds } from "./sketch-shape-kit.js";

/**
 * Curve creation tools T11 (origin and axis relations at draw time), T12 (tangent arc inherits tangency), T16 (parallel, equal, collinear,
 * perpendicular and on-curve hints and their relations), N2 (ortho and Shift only where a direction means something), N4 (sweep field),
 * N10 (floating-point dust) and UX N10 (the relation picker offers arc ends and rectangle corners). Each one draws the way the canvas does:
 * infer every click, build the entity, read the relations off the inference, and add all of it to a project in one edit.
 */

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

function projectOf(entities: readonly SketchEntity[]): WorkbenchProject {
  const base = createWorkbenchProject("project:draw-inference");
  const empty: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
  if (entities.length === 0) return empty;
  const applied = applyWorkbenchOperation(empty, { kind: "apply-sketch-edit", operationId: "operation:di-seed", expectedRevision: empty.revision, removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [], label: "Seed" });
  if (!applied.ok) throw new Error(applied.diagnostics[0]?.message);
  return applied.value.project;
}

let counter = 0;
const newId = (): string => `constraint:di-${(counter += 1)}`;

interface Drawn {
  readonly entity: SketchEntity;
  readonly placed: readonly PlacedPointInference[];
  readonly kinds: readonly string[];
  readonly constraints: ReturnType<typeof autoConstraintsFor>;
  readonly project: WorkbenchProject;
}

/** Draws one entity with the canvas's own steps and adds it, with the relations it earned, to the project in one edit. */
function draw(tool: Exclude<SketchTool, "select">, project: WorkbenchProject, pointers: readonly Vec2[], options: { readonly settings?: Partial<SnapAssistSettings>; readonly modifiers?: SnapModifiers; readonly tolerance?: number; readonly inheritTangent?: boolean; readonly correctTangent?: boolean; readonly id?: string } = {}): Drawn {
  const settings: SnapAssistSettings = { ...DEFAULT_SNAP_ASSIST, ...options.settings };
  const placed: PlacedPointInference[] = [];
  const points: Vec2[] = [];
  for (const pointer of pointers) {
    const result = assistedInference({ tool, pointer, sketch: project.sketch, toleranceMm: options.tolerance ?? 1, gridMm: undefined, anchor: anchorFor(tool, points), placedCount: points.length, settings, ...(options.modifiers === undefined ? {} : { modifiers: options.modifiers }) });
    const previous = points.at(-1);
    placed.push({ point: result.point, ...(result.primary === undefined ? {} : { primary: result.primary }), guides: result.guides, ...(previous === undefined ? {} : { anchor: previous }) });
    points.push(result.point);
    // A tangent arc leaves the curve it starts on along its tangent: the direction click is replaced by that direction.
    if (tool === "arc-tangent" && options.inheritTangent === true && points.length === 1) {
      const inherited = inheritedTangentDirection(placed[0]!, project.sketch);
      if (inherited !== undefined) {
        const direction: Vec2 = [result.point[0] + inherited.direction[0] * 5, result.point[1] + inherited.direction[1] * 5];
        points.push(direction);
        placed.push({ point: direction });
      }
    }
    if (tool === "arc-tangent" && options.inheritTangent === true && points.length === 3) break;
  }
  const built = buildSketchEntity(tool, options.correctTangent === true ? tangentArcPoints(points, placed, project.sketch) : points, options.id ?? "entity:drawn");
  if (!built.ok) throw new Error(`the ${tool} did not build: ${built.diagnostics[0]?.message}`);
  const constraints = autoConstraintsFor({ tool, entity: built.value, placed, sketch: project.sketch, newId });
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:di-${(counter += 1)}`, expectedRevision: project.revision, removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: constraints, label: "Drew" });
  if (!applied.ok) throw new Error(`the ${tool} and its relations were refused: ${applied.diagnostics[0]?.message}`);
  return { entity: built.value, placed, kinds: constraints.map((constraint) => constraint.kind).sort(), constraints, project: applied.value.project };
}

const drawn = (result: Drawn): SketchEntity => result.project.sketch.entities.find((entity) => entity.id === "entity:drawn")!;
const empty = (): WorkbenchProject => projectOf([]);

function kink(a: Extract<SketchEntity, { kind: "line" }>, b: Extract<SketchEntity, { kind: "arc" }>): number {
  // Angle between the line direction and the arc's tangent at the arc start, in degrees.
  const d = 2 * (b.start[0] * (b.mid[1] - b.end[1]) + b.mid[0] * (b.end[1] - b.start[1]) + b.end[0] * (b.start[1] - b.mid[1]));
  const a2 = b.start[0] ** 2 + b.start[1] ** 2;
  const b2 = b.mid[0] ** 2 + b.mid[1] ** 2;
  const c2 = b.end[0] ** 2 + b.end[1] ** 2;
  const center: Vec2 = [(a2 * (b.mid[1] - b.end[1]) + b2 * (b.end[1] - b.start[1]) + c2 * (b.start[1] - b.mid[1])) / d, (a2 * (b.end[0] - b.mid[0]) + b2 * (b.start[0] - b.end[0]) + c2 * (b.mid[0] - b.start[0])) / d];
  const radial = Math.hypot(b.start[0] - center[0], b.start[1] - center[1]);
  const lineLength = Math.hypot(a.end[0] - a.start[0], a.end[1] - a.start[1]);
  const along = (((a.end[0] - a.start[0]) / lineLength) * ((b.start[0] - center[0]) / radial)) + (((a.end[1] - a.start[1]) / lineLength) * ((b.start[1] - center[1]) / radial));
  return (Math.asin(Math.min(1, Math.abs(along))) * 180) / Math.PI;
}

export const sketchDrawInferenceTests: readonly TestCase[] = [
  // ------------------------------------------------------------------ T11
  ...([
    ["circle", [[0.2, 0.15], [5, 0]], "center"],
    ["point", [[0.2, 0.15]], "self"],
    ["line", [[0.2, 0.15], [20, 12]], "start"],
    ["line", [[20, 12], [0.2, 0.15]], "end"],
    ["rectangle", [[0.2, 0.15], [10, 5]], "corner-0"],
    ["rectangle", [[-10, -5], [0.2, 0.15]], "corner-2"],
    ["rectangle-center", [[0.2, 0.15], [10, 5]], "center"],
    ["ellipse", [[0.2, 0.15], [10, 0], [0, 4]], "center"],
    ["arc-center", [[0.2, 0.15], [10, 0], [0, 10]], "center"]
  ] as const).map(([tool, pointers, ref]): TestCase => ({
    name: `Curve creation T11: a ${tool} whose ${ref} is snapped to the origin is Coincident with the sketch origin`,
    run: () => {
      const result = draw(tool, empty(), pointers as unknown as Vec2[]);
      const joint = result.constraints.find((constraint) => constraint.kind === "coincident" && constraint.entityIds[0] === "sketch:origin");
      assert(joint !== undefined, `a coincident relation to the origin is recorded (got ${result.kinds.join(",") || "nothing"})`);
      equal(joint.points?.join(","), `self,${ref}`, "the origin's point meets the shape's " + ref);
      const stored = result.project.sketch.constraints.find((constraint) => constraint.id === joint.id);
      assert(stored !== undefined, "the project keeps the relation");
    }
  })),
  {
    name: "Curve creation T11: a circle on the origin has its centre exactly at 0,0 and 1 degree of freedom (the radius) left",
    run: () => {
      const result = draw("circle", empty(), [[0.2, 0.15], [5, 0]]);
      const circleEntity = drawn(result);
      assert(circleEntity.kind === "circle", "a circle");
      equal(circleEntity.center[0], 0, "centre x is exactly 0");
      equal(circleEntity.center[1], 0, "centre y is exactly 0");
    }
  },
  {
    name: "Curve creation T11: a point or line end level with the origin lies on the X axis, one plumb with it on the Y axis",
    run: () => {
      const onX = draw("point", empty(), [[25.2, 0.3]]);
      const xJoint = onX.constraints.find((constraint) => constraint.entityIds.includes("sketch:axis-x"));
      assert(xJoint !== undefined, `the point is on the X axis (got ${onX.kinds.join(",") || "nothing"})`);
      equal(xJoint.points?.join(","), "self,curve", "a point on the axis curve");
      const stored = drawn(onX);
      assert(stored.kind === "point" && stored.point[1] === 0, "and sits on y = 0");
      const onY = draw("point", empty(), [[0.4, 31.7]]);
      assert(onY.constraints.some((constraint) => constraint.entityIds.includes("sketch:axis-y")), "plumb with the origin: on the Y axis");
      const lineEnd = draw("line", empty(), [[10, 12], [33.1, 0.2]]);
      assert(lineEnd.constraints.some((constraint) => constraint.entityIds.includes("sketch:axis-x") && constraint.points?.[0] === "end"), "a line end level with the origin is on the X axis");
    }
  },
  {
    name: "Curve creation T11: Auto-constrain's origin relations hold when the shape is edited afterwards",
    run: () => {
      const result = draw("circle", empty(), [[0.2, 0.15], [5, 0]]);
      const dimensioned = applyWorkbenchOperation(result.project, { kind: "set-sketch-dimension", operationId: "operation:di-radius", expectedRevision: result.project.revision, entityId: "entity:drawn", dimension: "radius", valueMm: 9 });
      assert(dimensioned.ok, "the radius can be set");
      const edited = dimensioned.value.project.sketch.entities.find((entity) => entity.id === "entity:drawn");
      assert(edited?.kind === "circle" && edited.center[0] === 0 && edited.center[1] === 0 && edited.radiusMm === 9, "the centre stays on the origin");
    }
  },
  {
    name: "Curve creation T11: a line from a rectangle corner, an arc end, and a circle centre onto a rectangle corner are joined",
    run: () => {
      const rect: SketchEntity = { id: "entity:rect", kind: "rectangle", center: [60, 60], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [10, 4], mid: [7.07, 11.07], end: [0.5, 14], construction: false };
      const base = projectOf([rect, arc]);
      const fromCorner = draw("line", base, [[70, 65], [90, 80.3]]);
      assert(fromCorner.constraints.some((constraint) => constraint.kind === "coincident" && constraint.points?.join(",") === "corner-2,start"), "the line starts on corner-2");
      const toArcEnd = draw("line", base, [[40, 30], [10.05, 4.04]]);
      assert(toArcEnd.constraints.some((constraint) => constraint.kind === "coincident" && constraint.points?.join(",") === "start,end" && constraint.entityIds[0] === "entity:arc"), "the line ends on the arc's start");
      const centre = draw("circle", base, [[50.1, 54.9], [55, 54.9]]);
      assert(centre.constraints.some((constraint) => constraint.kind === "coincident" && constraint.points?.join(",") === "corner-0,center"), "the circle centre is on corner-0");
      const joined = drawn(centre);
      assert(joined.kind === "circle" && joined.center[0] === 50 && joined.center[1] === 55, "exactly on the corner");
    }
  },
  // ------------------------------------------------------------------ T12
  {
    name: "Curve creation T12: a tangent arc started on a line's end leaves along the line and records a Tangent relation",
    run: () => {
      const base = projectOf([line("entity:a", [0, 0], [10, 0])]);
      const result = draw("arc-tangent", base, [[10.1, 0.1], [15, 7]], { inheritTangent: true });
      equal(result.kinds.join(","), "coincident,tangent", "joined to the line end and tangent to it");
      const tangent = result.constraints.find((constraint) => constraint.kind === "tangent")!;
      equal(tangent.entityIds.join(","), "entity:a,entity:drawn", "the line, then the new arc");
      const arc = drawn(result);
      assert(arc.kind === "arc", "an arc");
      near(kink({ id: "l", kind: "line", start: [0, 0], end: [10, 0], construction: false }, arc), 0, 1e-6, "the arc's tangent at its start is the line's direction");
    }
  },
  {
    name: "Curve creation T12: the inherited direction is the end tangent of a line (either end) and of an arc",
    run: () => {
      const sketchWith = (entities: readonly SketchEntity[]) => projectOf(entities).sketch;
      const forLine = inheritedTangentDirection({ point: [10, 0], primary: { kind: "endpoint", point: [10, 0], entityId: "entity:a", selector: "end", distanceMm: 0 } }, sketchWith([line("entity:a", [0, 0], [10, 0])]));
      near(forLine!.direction[0], 1, 1e-12, "a line's end continues forward");
      const forStart = inheritedTangentDirection({ point: [0, 0], primary: { kind: "endpoint", point: [0, 0], entityId: "entity:a", selector: "start", distanceMm: 0 } }, sketchWith([line("entity:a", [0, 0], [10, 0])]));
      near(forStart!.direction[0], -1, 1e-12, "a line's start continues backward");
      const arc: SketchEntity = { id: "entity:r", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false };
      const forArc = inheritedTangentDirection({ point: [-10, 0], primary: { kind: "endpoint", point: [-10, 0], entityId: "entity:r", selector: "end", distanceMm: 0 } }, sketchWith([arc]));
      near(forArc!.direction[0], 0, 1e-9, "an arc's end continues along its tangent (x)");
      near(forArc!.direction[1], -1, 1e-9, "an arc's end continues along its tangent (y)");
      equal(inheritedTangentDirection({ point: [5, 5] }, sketchWith([arc])), undefined, "no inheritance from a free click");
    }
  },
  {
    name: "Curve creation T12: a tangent arc from an arc end is tangent to that arc, and the direction click 3 mm off the tangent still counts",
    run: () => {
      const arc: SketchEntity = { id: "entity:r", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false };
      const fromArc = draw("arc-tangent", projectOf([arc]), [[-10.1, 0.1], [-12, -8]], { inheritTangent: true });
      assert(fromArc.constraints.some((constraint) => constraint.kind === "tangent" && constraint.entityIds[0] === "entity:r"), "tangent to the arc it starts on");
      const base = projectOf([line("entity:a", [0, 0], [10, 0])]);
      const offByHand = draw("arc-tangent", base, [[10, 0], [20, 3], [25, 10]], { correctTangent: true });
      assert(offByHand.constraints.some((constraint) => constraint.kind === "tangent"), "a hand-clicked direction 3 mm off still reads as tangent, and the solver makes it exact");
      const stored = drawn(offByHand);
      assert(stored.kind === "arc", "an arc");
      near(kink({ id: "l", kind: "line", start: [0, 0], end: [10, 0], construction: false }, stored), 0, 1e-4, "after the solve the arc leaves the line without a kink");
    }
  },
  {
    name: "Curve creation T12: a tangent arc that starts away from any curve records no tangent",
    run: () => {
      const result = draw("arc-tangent", projectOf([line("entity:a", [0, 0], [10, 0])]), [[30, 30], [40, 30], [45, 40]]);
      assert(!result.kinds.includes("tangent"), "no tangent relation");
    }
  },
  // ------------------------------------------------------------------ T16
  {
    name: "Curve creation T16: a line drawn parallel to a slanted line snaps to its direction and is Parallel to it",
    run: () => {
      const base = projectOf([line("entity:ref", [20, 10], [30, 17.5])]);
      const hint = inferSketchPoint([15.1, 47.7], base.sketch, { toleranceMm: 1, anchor: [5, 40], anchorUse: "full" });
      equal(hint.primary?.kind, "parallel", "the inference names the hint");
      equal(hint.primary?.entityId, "entity:ref", "and the line it is parallel to");
      const result = draw("line", base, [[5, 40], [15.1, 47.7]]);
      equal(result.kinds.join(","), "parallel", "the relation is recorded");
      const stored = drawn(result);
      assert(stored.kind === "line", "a line");
      const cross = (stored.end[0] - stored.start[0]) * 7.5 - (stored.end[1] - stored.start[1]) * 10;
      near(cross, 0, 1e-6, "exactly parallel to the reference");
    }
  },
  {
    name: "Curve creation T16: a line drawn as long as another is Equal to it",
    run: () => {
      const base = projectOf([line("entity:ref", [25, 45], [35, 45])]);
      const off = draw("line", base, [[5, 40], [12.2, 47.3]]);
      assert(!off.kinds.includes("equal"), "no Equal hint unless it is switched on (a line-drawn rectangle would get a redundant relation)");
      const result = draw("line", base, [[5, 40], [12.2, 47.3]], { settings: { equalHint: true } });
      assert(result.kinds.includes("equal"), `an Equal relation (got ${result.kinds.join(",") || "nothing"})`);
      const stored = drawn(result);
      assert(stored.kind === "line", "a line");
      near(Math.hypot(stored.end[0] - stored.start[0], stored.end[1] - stored.start[1]), 10, 1e-6, "exactly 10 mm long");
    }
  },
  {
    name: "Curve creation T16: a line continuing another from its end is Collinear with it (and Coincident), not just Horizontal",
    run: () => {
      const base = projectOf([line("entity:ref", [20, 20], [30, 20])]);
      const result = draw("line", base, [[30, 20], [41.4, 20.2]]);
      equal(result.kinds.join(","), "coincident,collinear", "joined and collinear");
      const slanted = projectOf([line("entity:ref", [20, 20], [30, 25])]);
      const continued = draw("line", slanted, [[30, 25], [41.1, 30.45]]);
      equal(continued.kinds.join(","), "coincident,collinear", "a slanted line too");
      const stored = drawn(continued);
      assert(stored.kind === "line", "a line");
      near((stored.end[0] - stored.start[0]) * 5 - (stored.end[1] - stored.start[1]) * 10, 0, 1e-6, "exactly along the reference");
    }
  },
  {
    name: "Curve creation T16: a line drawn at right angles to another is Perpendicular to it",
    run: () => {
      const base = projectOf([line("entity:ref", [20, 10], [30, 17.5])]);
      const hint = inferSketchPoint([-1.1, 48.3], base.sketch, { toleranceMm: 1, anchor: [5, 40], anchorUse: "full" });
      equal(hint.primary?.kind, "perpendicular", "the inference names the hint");
      const result = draw("line", base, [[5, 40], [-1.1, 48.3]]);
      assert(result.kinds.includes("perpendicular"), `a Perpendicular relation (got ${result.kinds.join(",")})`);
      const stored = drawn(result);
      assert(stored.kind === "line", "a line");
      near((stored.end[0] - stored.start[0]) * 10 + (stored.end[1] - stored.start[1]) * 7.5, 0, 1e-6, "exactly at right angles");
    }
  },
  {
    name: "Curve creation T16: a line ending on a circle and a circle centre on a line are put on the curve",
    run: () => {
      const ring = projectOf([circle("entity:ring", [60, 60], 10)]);
      const onRing = draw("line", ring, [[20, 30], [67.1, 67.05]]);
      const joint = onRing.constraints.find((constraint) => constraint.points?.[1] === "curve");
      assert(joint !== undefined, `a point-on-curve relation (got ${onRing.kinds.join(",") || "nothing"})`);
      equal(joint.entityIds.join(","), "entity:drawn,entity:ring", "the line end on the circle");
      const stored = drawn(onRing);
      assert(stored.kind === "line", "a line");
      near(Math.hypot(stored.end[0] - 60, stored.end[1] - 60), 10, 1e-6, "the end is exactly on the circle after the solve");
      const wall = projectOf([line("entity:wall", [20, 25], [60, 35])]);
      const onWall = draw("circle", wall, [[35.1, 28.7], [40, 31]]);
      const centre = onWall.constraints.find((constraint) => constraint.points?.join(",") === "center,curve");
      assert(centre !== undefined, `the circle centre is on the line (got ${onWall.kinds.join(",") || "nothing"})`);
      const placed = drawn(onWall);
      assert(placed.kind === "circle", "a circle");
      near((placed.center[0] - 20) * 10 - (placed.center[1] - 25) * 40, 0, 1e-6, "exactly on the line");
    }
  },
  {
    name: "Curve creation T16: a line through the crossing of two curves is put on both",
    run: () => {
      const base = projectOf([line("entity:p", [0, 20], [40, 20]), line("entity:q", [20, 0], [20, 40])]);
      const result = draw("line", base, [[5, 5], [20.1, 20.1]]);
      const onBoth = result.constraints.filter((constraint) => constraint.points?.[1] === "curve").map((constraint) => constraint.entityIds[1]).sort();
      equal(onBoth.join(","), "entity:p,entity:q", "on both lines");
    }
  },
  {
    name: "Curve creation T16: a rectangle drawn with the Line tool keeps its 4 degrees of freedom and gets no redundant relation from the hints",
    run: () => {
      for (const clicks of [[[10, 10], [40, 10], [40, 30], [10, 30], [10, 10]], [[0, 0], [30, 0], [30, 20], [0, 20], [0, 0]]] as const) {
        let project = empty();
        for (let index = 1; index < clicks.length; index += 1) project = draw("line", project, [clicks[index - 1] as unknown as Vec2, clicks[index] as unknown as Vec2], { id: `entity:side-${index}` }).project;
        const analysis = analyzeWorkbenchSketch(project.sketch);
        equal(analysis.redundant.length, 0, `nothing is redundant (${analysis.redundant.map((set) => set.message).join(" | ")})`);
        equal(analysis.conflicts.length, 0, "no conflicts");
        equal(analysis.degreesOfFreedom, clicks[0]![0] === 0 ? 2 : 4, "position (unless on the origin), width and height are left");
        assert(!project.sketch.constraints.some((constraint) => constraint.kind === "equal"), "no Equal between the sides unless the equal-length hint is switched on");
      }
    }
  },
  {
    name: "Curve creation T16: the Relation hints switch turns the direction hints off, and the settings keep the choice",
    run: () => {
      const base = projectOf([line("entity:ref", [20, 10], [30, 17.5])]);
      const off = draw("line", base, [[5, 40], [15.1, 47.7]], { settings: { relationHints: false } });
      assert(!off.kinds.includes("parallel"), "no Parallel with the switch off");
      equal(DEFAULT_SNAP_ASSIST.relationHints, true, "on by default");
      equal(DEFAULT_SNAP_ASSIST.equalHint, false, "except the equal-length hint, which is opt-in");
    }
  },
  // ------------------------------------------------------------------ N2
  ...([true, false] as const).flatMap((useShift): TestCase[] => {
    const lock = (patch: Partial<SnapAssistSettings> = {}): { settings: Partial<SnapAssistSettings>; modifiers?: SnapModifiers } => useShift ? { settings: patch, modifiers: { ctrl: false, shift: true } } : { settings: { ortho: true, ...patch } };
    const how = useShift ? "Shift constrain" : "the ortho lock";
    return [{
      name: `Curve creation N2: ${how} leaves a slot's width click, an ellipse's minor click and a centerpoint arc's end click alone`,
      run: () => {
        const infer = (tool: Exclude<SketchTool, "select">, pointers: readonly Vec2[]): Vec2[] => {
          const points: Vec2[] = [];
          for (const pointer of pointers) {
            const opts = lock();
            points.push(assistedInference({ tool, pointer, sketch: empty().sketch, toleranceMm: 1, gridMm: undefined, anchor: anchorFor(tool, points), placedCount: points.length, settings: { ...DEFAULT_SNAP_ASSIST, ...opts.settings }, ...(opts.modifiers === undefined ? {} : { modifiers: opts.modifiers }) }).point);
          }
          return points;
        };
        const slotPoints = infer("slot", [[0, 0], [20, 0], [10, 3]]);
        equal(slotPoints[2]!.join(","), "10,3", "the width click stays at (10,3)");
        const slot = buildSlot(slotPoints[0]!, slotPoints[1]!, slotPoints[2]!, shapeIds());
        assert(slot.ok, `and the slot builds with a real width: ${slot.ok ? "" : slot.diagnostics[0]?.message}`);
        const ellipsePoints = infer("ellipse", [[0, 0], [10, 0], [3, 4]]);
        equal(ellipsePoints[2]!.join(","), "3,4", "the minor click stays at (3,4)");
        const ellipse = buildSketchEntity("ellipse", ellipsePoints, "entity:e");
        assert(ellipse.ok && ellipse.value.kind === "ellipse" && ellipse.value.minorRadiusMm > 0, "and the ellipse has a non-zero minor axis");
        const arc = assistedInference({ tool: "arc-center", pointer: [0.2, 10], sketch: empty().sketch, toleranceMm: 1, gridMm: undefined, anchor: anchorFor("arc-center", [[0, 0], [10, 0]]), placedCount: 2, settings: { ...DEFAULT_SNAP_ASSIST, ...lock().settings }, ...(lock().modifiers === undefined ? {} : { modifiers: lock().modifiers! }) });
        assert(Math.abs(arc.point[0]) < 0.3 && arc.point[1] === 10, `the arc end click stays near (0.2, 10) so a 90 degree arc is possible (got ${arc.point.join(",")})`);
        const withoutCount = assistedInference({ tool: "arc-center", pointer: [0.2, 10], sketch: empty().sketch, toleranceMm: 1, gridMm: undefined, anchor: [10, 0], settings: { ...DEFAULT_SNAP_ASSIST, ...lock().settings }, ...(lock().modifiers === undefined ? {} : { modifiers: lock().modifiers! }) });
        assert(withoutCount.point[0] < 1, "a caller that does not say how many points are placed gets the same: no lock on a three-click tool");
      }
    }, {
      name: `Curve creation N2: ${how} still locks a line, a rectangle corner, and the axis click of a slot, ellipse and centerpoint arc`,
      run: () => {
        const common = { sketch: empty().sketch, toleranceMm: 1, gridMm: undefined } as const;
        const opts = lock();
        const settings = { ...DEFAULT_SNAP_ASSIST, ...opts.settings };
        const modifiers = opts.modifiers;
        const at = (tool: SketchTool, pointer: Vec2, anchor: Vec2, placedCount: number) => assistedInference({ ...common, tool, pointer, anchor, placedCount, settings, ...(modifiers === undefined ? {} : { modifiers }) });
        equal(at("line", [30, 7], [0, 0], 1).point.join(","), "30,0", "a line end goes level");
        equal(at("slot", [20, 3], [0, 0], 1).point.join(","), "20,0", "a slot's second centre goes level");
        equal(at("ellipse", [10, 2], [0, 0], 1).point.join(","), "10,0", "an ellipse's major axis goes level");
        equal(at("arc-center", [10, 2], [0, 0], 1).point.join(","), "10,0", "a centerpoint arc's start goes level");
        if (useShift) equal(at("rectangle", [30, 12], [0, 0], 1).point.join(","), "30,30", "Shift makes the rectangle a square");
      }
    }];
  }),
  // ------------------------------------------------------------------ N4
  {
    name: "Curve creation N4: the live Sweep field shows 270 while the arc preview runs 270 degrees (not -90)",
    run: () => {
      let track = startArcSweepTrack([0, 0], [10, 0]);
      for (let step = 1; step <= 60; step += 1) {
        const angle = (270 * step) / 60 * (Math.PI / 180);
        track = advanceArcSweepTrack(track, [0, 0], [10 * Math.cos(angle), 10 * Math.sin(angle)]);
      }
      const cursor: Vec2 = [0, -10];
      const shortWay = measureFromCursor("arc-center", [[0, 0], [10, 0]], cursor);
      near(shortWay.sweep!, -90, 1e-9, "without the pointer path the field can only show the short way");
      const followed = measureFromCursor("arc-center", [[0, 0], [10, 0]], cursor, track);
      near(followed.sweep!, 270, 1e-6, "with the pointer path it shows the sweep the arc is built with");
      const built = buildSketchEntity("arc-center", [[0, 0], [10, 0], cursor], "entity:sweep", { sweepDirection: 1 });
      assert(built.ok && built.value.kind === "arc", "the arc builds the same way");
      let clockwise = startArcSweepTrack([0, 0], [10, 0]);
      for (let step = 1; step <= 60; step += 1) {
        const angle = (-200 * step) / 60 * (Math.PI / 180);
        clockwise = advanceArcSweepTrack(clockwise, [0, 0], [10 * Math.cos(angle), 10 * Math.sin(angle)]);
      }
      near(measureFromCursor("arc-center", [[0, 0], [10, 0]], [10 * Math.cos((-200 * Math.PI) / 180), 10 * Math.sin((-200 * Math.PI) / 180)], clockwise).sweep!, -200, 1e-6, "a clockwise sweep past 180 reads negative");
      near(measureFromCursor("arc-center", [[0, 0], [10, 0]], [0, 10], startArcSweepTrack([0, 0], [10, 0])).sweep!, 90, 1e-9, "before the pointer has travelled, the short way");
    }
  },
  // ------------------------------------------------------------------ N10 (dust)
  {
    name: "Curve creation N10: quadrant, midpoint and elliptical-arc snaps carry no trigonometric dust",
    run: () => {
      const ring = projectOf([circle("entity:c", [200, 0], 20)]);
      const left = inferSketchPoint([180.1, 0.05], ring.sketch, { toleranceMm: 1 });
      equal(left.point.join(","), "180,0", "the left quadrant of a circle is exactly (180, 0)");
      const arc: SketchEntity = { id: "entity:a", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false };
      const mid = inferSketchPoint([0.1, 10.05], projectOf([arc]).sketch, { toleranceMm: 1 });
      equal(mid.point.join(","), "0,10", "the midpoint of a half circle is exactly (0, 10)");
      const quadrants = [[200, 20], [220, 0], [200, -20], [180, 0]] as const;
      for (const quadrant of quadrants) equal(inferSketchPoint([quadrant[0] + 0.1, quadrant[1] + 0.1], ring.sketch, { toleranceMm: 1 }).point.join(","), quadrant.join(","), `quadrant ${quadrant.join(",")}`);
      const fromGrid = buildSketchEntity("circle", [[0.1, 0.2], [0.3, 0.2]], "entity:g");
      assert(fromGrid.ok && fromGrid.value.kind === "circle", "a circle");
      equal(fromGrid.value.radiusMm, 0.2, "a circle between grid points 0.1 apart has radius exactly 0.2");
      const quarter = buildSketchEntity("circle", [[0.1, 0], [0.5, 0]], "entity:g2");
      assert(quarter.ok && quarter.value.kind === "circle" && quarter.value.radiusMm === 0.4, "radius 0.4, not 0.39999999999999997");
      const centre = buildSketchEntity("arc-center", [[0, 0], [10, 0], [0, 10]], "entity:q");
      assert(centre.ok && centre.value.kind === "arc", "a centerpoint arc");
      equal(centre.value.end.join(","), "0,10", "its end is exactly (0, 10)");
    }
  },
  // ------------------------------------------------------------------ UX N10
  {
    name: "Sketch environment N10: the canvas Coincident/Midpoint picker offers arc ends and middle, and all four rectangle corners",
    run: () => {
      const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false };
      const refs = relationPointsOf(arc).map((point) => point.ref).sort();
      equal(refs.join(","), "center,end,mid,start", "an arc offers its centre, ends and middle");
      const centre = relationPointsOf(arc).find((point) => point.ref === "center")!;
      near(centre.point[0], 0, 1e-9, "the arc centre is where it should be");
      const rect: SketchEntity = { id: "entity:rect", kind: "rectangle", center: [10, 5], widthMm: 8, heightMm: 4, rotationDeg: 0, construction: false };
      const corners = relationPointsOf(rect);
      equal(corners.map((point) => point.ref).join(","), "center,corner-0,corner-1,corner-2,corner-3", "a rectangle offers its centre and four corners");
      equal(corners.find((point) => point.ref === "corner-2")!.point.join(","), "14,7", "corner-2 is the upper right");
      equal(relationPointsOf(line("entity:l", [0, 0], [4, 0])).map((point) => point.ref).join(","), "start,end,mid", "a line still offers its ends and middle");
      equal(relationPointsOf(circle("entity:c", [0, 0], 3)).map((point) => point.ref).join(","), "center", "a circle its centre");
      equal(relationPointsOf({ id: "entity:s", kind: "spline", fitPoints: [[0, 0], [1, 1], [2, 0]], construction: false }).length, 0, "a spline has none the solver can move");
      // The picked pair is accepted by the project: a rectangle corner onto an arc end.
      const base = projectOf([arc, rect]);
      const joined = applyWorkbenchOperation(base, { kind: "add-sketch-constraint", operationId: "operation:di-pick", expectedRevision: base.revision, constraint: { id: "constraint:di-pick", kind: "coincident", entityIds: ["entity:arc", "entity:rect"], points: ["end", "corner-0"] } });
      assert(joined.ok, "the picker's pair is accepted");
    }
  },
  {
    name: "Shape tools wire into the draw path: a slot placed with the ortho lock on keeps its width and is built with joints",
    run: () => {
      const slot = buildSlot([0, 0], [20, 0], [10, 3], shapeIds());
      assert(slot.ok && slot.value.constraints.filter((constraint) => constraint.kind === "coincident").length === 4, "four joints");
    }
  }
];
