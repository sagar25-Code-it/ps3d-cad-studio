import { applyWorkbenchOperation, type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { withDynamicMirror } from "../packages/workbench-sketch/src/dynamic-mirror.js";
import { dragSketchHandle, grabHandlesOf } from "../packages/workbench-sketch/src/drag.js";
import { mirrorEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { applyOk, commit, con, ctx, ellipse, ids, line, projectWith, rect } from "./edit-test-kit.js";

/** Wave 3 regression tests for mirror relations (re-audit 2: Edit tools E07 and R2-4). */

type DragHandleFor = Parameters<typeof dragSketchHandle>[2];

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const reflectAcrossY = (point: Vec2): Vec2 => [-point[0], point[1]];

function run(project: WorkbenchProject, operation: Record<string, unknown>): WorkbenchProject {
  const result = applyWorkbenchOperation(project, { operationId: `operation:e3m-${Math.random().toString(36).slice(2)}`, expectedRevision: project.revision, ...operation } as never);
  if (!result.ok) throw new Error(`operation refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}

/** Dangling or duplicate ids, or a solve that would still move geometry (the sketch origin and axes are valid references). */
function problems(project: WorkbenchProject): string[] {
  const found: string[] = [];
  const known = new Set([...project.sketch.entities.map((entity) => entity.id), "sketch:origin", "sketch:axis-x", "sketch:axis-y"]);
  for (const constraint of project.sketch.constraints) if (constraint.entityIds.some((id) => !known.has(id))) found.push(`dangling relation ${constraint.id}`);
  const solved = solveLiveSketch(project.sketch);
  if (!solved.ok) found.push(`solve fails: ${solved.message}`);
  else if (solved.movedIds.length > 0) found.push(`solve would move ${solved.movedIds.join(", ")}`);
  return found;
}

/** Whether `image` is the mirror of `source` about the sketch's Y axis. */
function followsMirror(source: SketchEntity, image: SketchEntity): boolean {
  const close = (a: Vec2, b: Vec2): boolean => dist(reflectAcrossY(a), b) < 1e-4;
  if (source.kind === "arc" && image.kind === "arc") return close(source.mid, image.mid) && ((close(source.start, image.start) && close(source.end, image.end)) || (close(source.start, image.end) && close(source.end, image.start)));
  if (source.kind === "rectangle" && image.kind === "rectangle") return close(source.center, image.center) && Math.abs(source.widthMm - image.widthMm) < 1e-4 && Math.abs(source.heightMm - image.heightMm) < 1e-4 && Math.abs(Math.sin(((image.rotationDeg + source.rotationDeg) * Math.PI) / 180)) < 1e-4;
  if (source.kind === "ellipse" && image.kind === "ellipse") return close(source.center, image.center) && Math.abs(source.majorRadiusMm - image.majorRadiusMm) < 1e-4 && Math.abs(source.minorRadiusMm - image.minorRadiusMm) < 1e-4 && Math.abs(Math.sin(((image.rotationDeg + source.rotationDeg) * Math.PI) / 180)) < 1e-4;
  if (source.kind === "spline" && image.kind === "spline") return source.fitPoints.every((point, index) => close(point, image.fitPoints[index]!));
  return false;
}

const spline = (id: string): SketchEntity => ({ id: `entity:${id}`, kind: "spline", fitPoints: [[10, 0], [20, 10], [30, 0], [40, 10]], construction: false });

export const sketchEdit3MirrorTests: readonly TestCase[] = [
  {
    name: "Wave 3 edit E07: Mirror of an arc, rectangle, ellipse and spline is solved (no 'Recorded, not solved'), and a source drag moves the mirror image",
    run: () => {
      const axis = line("axis", [0, -200], [0, 200]);
      const sources: readonly (readonly [string, SketchEntity, DragHandleFor])[] = [
        ["arc", { id: "entity:s", kind: "arc", start: [10, 0], mid: [20, 10], end: [30, 0], construction: false }, { kind: "arc-point", which: "start" }],
        ["clockwise arc", { id: "entity:s", kind: "arc", start: [30, 0], mid: [20, 10], end: [10, 0], construction: false }, { kind: "arc-point", which: "end" }],
        ["rectangle", rect("s", [30, 10], 20, 10, 15), { kind: "corner", index: 2 }],
        ["ellipse", ellipse("s", [30, 10], 12, 6, 20), { kind: "ellipse-axis", which: "major" }],
        ["spline", spline("s"), { kind: "fit", index: 1 }]
      ];
      for (const [name, entity, handle] of sources) {
        const project = projectWith([entity, axis], [con("fx", "fixed", ["axis"])]);
        const mirrored = commit(project, mirrorEntities(ctx(project), ids("s", "axis")));
        if (!mirrored.ok) throw new Error(`${name}: ${mirrored.message}`);
        assert(!/Recorded, not solved/u.test(mirrored.summary), `${name}: the summary does not say the relation is recorded but not solved (${mirrored.summary})`);
        const done = mirrored.project;
        const image = done.sketch.entities.find((candidate) => candidate.id !== "entity:s" && candidate.id !== "entity:axis")!;
        assert(followsMirror(done.sketch.entities.find((candidate) => candidate.id === "entity:s")!, image), `${name}: the image starts as the mirror`);
        const solved = solveLiveSketch(done.sketch);
        assert(solved.ok && solved.unsolved.length === 0, `${name}: the solver holds the symmetry (nothing unsolved)`);
        const source = done.sketch.entities.find((candidate) => candidate.id === "entity:s")!;
        const grab = grabHandlesOf(source).find((candidate) => JSON.stringify(candidate.handle) === JSON.stringify(handle))!;
        const dragged = dragSketchHandle(done.sketch, "entity:s", handle, grab.point, [grab.point[0] + 3, grab.point[1] + 2]);
        if (!dragged.ok) throw new Error(`${name}: drag refused: ${dragged.message}`);
        const nextSource = dragged.entities.find((candidate) => candidate.id === "entity:s")!;
        const nextImage = dragged.entities.find((candidate) => candidate.id === image.id)!;
        assert(JSON.stringify(nextSource) !== JSON.stringify(source), `${name}: the source moved`);
        assert(followsMirror(nextSource, nextImage), `${name}: after the source drag the image is still its mirror`);
        const committed = run(done, { kind: "apply-sketch-edit", label: "Drag", removeEntityIds: [], updateEntities: dragged.entities.filter((candidate) => dragged.movedIds.includes(candidate.id)), addEntities: [], addConstraints: [] });
        equal(problems(committed).join("; "), "", `${name}: the committed drag leaves a consistent sketch`);
        assert(analyzeSketch(ctx(committed)).issues.every((issue) => !/over-defined/iu.test(issue.title)), `${name}: no Over-defined warning`);
      }
    }
  },
  {
    name: "Wave 3 edit E07: dragging the image of a mirrored spline or ellipse moves the source instead of being snapped back",
    run: () => {
      const axis = line("axis", [0, -200], [0, 200]);
      for (const entity of [spline("s"), ellipse("s", [30, 10], 12, 6, 20)]) {
        const project = projectWith([entity, axis], [con("fx", "fixed", ["axis"])]);
        const done = commit(project, mirrorEntities(ctx(project), ids("s", "axis")));
        if (!done.ok) throw new Error(done.message);
        const image = done.project.sketch.entities.find((candidate) => candidate.id !== "entity:s" && candidate.id !== "entity:axis")!;
        const handle: DragHandleFor = image.kind === "spline" ? { kind: "fit", index: 1 } : { kind: "ellipse-axis", which: "major" };
        const grab = grabHandlesOf(image).find((candidate) => JSON.stringify(candidate.handle) === JSON.stringify(handle))!;
        const dragged = dragSketchHandle(done.project.sketch, image.id, handle, grab.point, [grab.point[0] - 2, grab.point[1] + 4]);
        if (!dragged.ok) throw new Error(dragged.message);
        const nextSource = dragged.entities.find((candidate) => candidate.id === "entity:s")!;
        const nextImage = dragged.entities.find((candidate) => candidate.id === image.id)!;
        assert(JSON.stringify(nextImage) !== JSON.stringify(image), `${image.kind}: the dragged image moved`);
        assert(followsMirror(nextSource, nextImage), `${image.kind}: and the source follows it`);
      }
    }
  },
  {
    name: "Wave 3 edit R2-4: Dynamic Mirror images of a half-profile (lines, an arc) stay joined when the source is edited; rectangle, ellipse and spline images get a relation too",
    run: () => {
      const axis = line("axis", [0, -100], [0, 100], { construction: true });
      const base = projectWith([axis], [con("fx", "fixed", ["axis"])]);
      const drawn: SketchEntity[] = [line("d0", [0, 0], [30, 10]), { id: "entity:a1", kind: "arc", start: [30, 10], mid: [40, 25], end: [30, 40], construction: false }, line("d2", [30, 40], [0, 50])];
      const joints = [con("c0", "coincident", ["d0", "a1"], { points: ["end", "start"] }), con("c1", "coincident", ["a1", "d2"], { points: ["end", "start"] })];
      const outcome = withDynamicMirror(ctx(base), "entity:axis", { label: "Draw", removeEntityIds: [], updateEntities: [], addEntities: drawn, addConstraints: joints });
      equal(outcome.mirrored, 3, "three images");
      assert(!outcome.withoutRelations, "the symmetry relations were kept");
      equal(outcome.plan.addConstraints.filter((c) => c.kind === "symmetry").length, 3, "line, arc and line are each tied to their image");
      const done = applyOk(base, { ok: true, value: outcome.plan });
      equal(detectSketchProfiles(done.sketch).length, 1, "one closed profile before the edit");
      const dragged = dragSketchHandle(done.sketch, "entity:d0", { kind: "point", ref: "end" }, [30, 10], [34, 8]);
      if (!dragged.ok) throw new Error(dragged.message);
      equal(detectSketchProfiles({ ...done.sketch, entities: dragged.entities }).length, 1, "still one closed profile after the source line end is dragged (it used to tear into an open chain of 6 curves)");
      const arcDragged = dragSketchHandle(done.sketch, "entity:a1", { kind: "arc-point", which: "mid" }, [40, 25], [48, 25]);
      if (!arcDragged.ok) throw new Error(arcDragged.message);
      equal(detectSketchProfiles({ ...done.sketch, entities: arcDragged.entities }).length, 1, "and after the source arc middle is dragged");
      assert(analyzeSketch(ctx(projectWith(done.sketch.entities, done.sketch.constraints))).issues.every((issue) => !/over-defined|open chain/iu.test(issue.title)), "the sketch reads as healthy");
      for (const entity of [rect("r", [30, 10], 20, 10, 15), ellipse("e", [30, 10], 12, 6, 20), spline("sp")]) {
        const planned = withDynamicMirror(ctx(base), "entity:axis", { label: "Draw", removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: [] });
        equal(planned.plan.addConstraints.filter((c) => c.kind === "symmetry").length, 1, `${entity.kind}: the image carries a symmetry relation`);
      }
    }
  }
];
