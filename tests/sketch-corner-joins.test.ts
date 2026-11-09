import { applyWorkbenchOperation, createWorkbenchProject, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Curve creation tools N1 (blocker): joining a rectangle corner or an arc end to a point moves the whole rectangle or arc; it never
 * stretches, turns or re-radii it. (The simultaneous solver used to spend a little rotation and size to save moving the curve.)
 */

function projectWith(entities: readonly SketchEntity[]): WorkbenchProject {
  const base = createWorkbenchProject("project:corner-joins");
  const empty: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
  const applied = applyWorkbenchOperation(empty, { kind: "apply-sketch-edit", operationId: "operation:cj-add", expectedRevision: empty.revision, removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [], label: "Added" });
  if (!applied.ok) throw new Error(applied.diagnostics[0]?.message);
  return applied.value.project;
}

let count = 0;
function join(project: WorkbenchProject, constraint: { readonly entityIds: readonly string[]; readonly points: readonly SketchPointRef[] }): WorkbenchProject {
  const result = applyWorkbenchOperation(project, { kind: "add-sketch-constraint", operationId: `operation:cj-${(count += 1)}`, expectedRevision: project.revision, constraint: { id: `constraint:cj-${count}`, kind: "coincident", ...constraint } });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.value.project;
}

const rectangle = (id: string, center: Vec2, widthMm: number, heightMm: number, rotationDeg = 0): SketchEntity => ({ id, kind: "rectangle", center, widthMm, heightMm, rotationDeg, construction: false });
const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });

function corner(entity: Extract<SketchEntity, { kind: "rectangle" }>, index: number): Vec2 {
  const r = (entity.rotationDeg * Math.PI) / 180;
  const sx = index === 0 || index === 3 ? -1 : 1;
  const sy = index < 2 ? -1 : 1;
  const x = (sx * entity.widthMm) / 2;
  const y = (sy * entity.heightMm) / 2;
  return [entity.center[0] + x * Math.cos(r) - y * Math.sin(r), entity.center[1] + x * Math.sin(r) + y * Math.cos(r)];
}

export const sketchCornerJoinTests: readonly TestCase[] = [
  ...([
    ["40x20 to (100,0)", 40, 20, [100, 0]],
    ["100x60 to (300,-200)", 100, 60, [300, -200]],
    ["10x6 to (20,0)", 10, 6, [20, 0]],
    ["40x20 to (0.5,0.3)", 40, 20, [0.5, 0.3]]
  ] as const).flatMap(([label, width, height, target]): TestCase[] => [0, 1, 2, 3].map((index): TestCase => ({
    name: `Curve creation N1: joining corner-${index} of a ${label} to a line start slides the rectangle (size and angle unchanged)`,
    run: () => {
      const project = join(projectWith([rectangle("entity:r", [0, 0], width, height), line("entity:l", [target[0], target[1]], [target[0] + 10, target[1] + 5])]), { entityIds: ["entity:l", "entity:r"], points: ["start", `corner-${index}` as SketchPointRef] });
      const rect = project.sketch.entities.find((entity) => entity.id === "entity:r");
      assert(rect?.kind === "rectangle", "the rectangle remains");
      near(rect.widthMm, width, 1e-9, "width unchanged");
      near(rect.heightMm, height, 1e-9, "height unchanged");
      near(rect.rotationDeg, 0, 1e-9, "rotation unchanged");
      const joined = corner(rect, index);
      near(joined[0], target[0], 1e-9, "the corner is on the line start (x)");
      near(joined[1], target[1], 1e-9, "the corner is on the line start (y)");
      const other = project.sketch.entities.find((entity) => entity.id === "entity:l");
      assert(other?.kind === "line" && other.start[0] === target[0] && other.end[0] === target[0] + 10, "the line did not move");
    }
  }))),
  {
    name: "Curve creation N1: a Horizontal rectangle joined at a corner still keeps its size",
    run: () => {
      const base = projectWith([rectangle("entity:r", [0, 0], 40, 20), line("entity:l", [100, 0], [110, 5])]);
      const flagged = applyWorkbenchOperation(base, { kind: "add-sketch-constraint", operationId: "operation:cj-h", expectedRevision: base.revision, constraint: { id: "constraint:cj-h", kind: "horizontal", entityIds: ["entity:r"] } });
      assert(flagged.ok, "horizontal applies");
      const project = join(flagged.value.project, { entityIds: ["entity:l", "entity:r"], points: ["start", "corner-2"] });
      const rect = project.sketch.entities.find((entity) => entity.id === "entity:r");
      assert(rect?.kind === "rectangle", "the rectangle remains");
      near(rect.widthMm, 40, 1e-9, "width unchanged");
      near(rect.heightMm, 20, 1e-9, "height unchanged");
    }
  },
  {
    name: "Curve creation N1: a rectangle listed first is the reference and the line moves to its corner",
    run: () => {
      const project = join(projectWith([rectangle("entity:r", [0, 0], 40, 20), line("entity:l", [100, 0], [110, 5])]), { entityIds: ["entity:r", "entity:l"], points: ["corner-2", "start"] });
      const rect = project.sketch.entities.find((entity) => entity.id === "entity:r");
      assert(rect?.kind === "rectangle", "the rectangle remains");
      near(rect.center[0], 0, 1e-9, "the rectangle stayed (x)");
      const moved = project.sketch.entities.find((entity) => entity.id === "entity:l");
      assert(moved?.kind === "line", "the line remains");
      near(moved.start[0], 20, 1e-9, "the line start is on the corner (x)");
      near(moved.start[1], 10, 1e-9, "the line start is on the corner (y)");
      near(moved.end[0], 110, 1e-9, "the line's far end stays where it was (a line end follows its joint, as for any two lines)");
    }
  },
  {
    name: "Curve creation N1: joining a semicircle's end to a line start slides the arc with its radius unchanged, for the start, end and middle",
    run: () => {
      for (const ref of ["start", "end", "mid"] as const) {
        const arc: SketchEntity = { id: "entity:a", kind: "arc", start: [0, 0], mid: [5, 5], end: [10, 0], construction: false };
        const project = join(projectWith([arc, line("entity:l", [30, 0], [40, 5])]), { entityIds: ["entity:l", "entity:a"], points: ["start", ref] });
        const moved = project.sketch.entities.find((entity) => entity.id === "entity:a");
        assert(moved?.kind === "arc", "the arc remains");
        const radius = Math.hypot(moved.start[0] - (moved.start[0] + moved.end[0]) / 2, moved.start[1] - (moved.start[1] + moved.end[1]) / 2);
        near(radius, 5, 1e-9, `${ref}: radius unchanged`);
        near(Math.hypot(moved.end[0] - moved.start[0], moved.end[1] - moved.start[1]), 10, 1e-9, `${ref}: chord unchanged`);
        const at = moved[ref];
        near(at[0], 30, 1e-9, `${ref}: on the line start (x)`);
        near(at[1], 0, 1e-9, `${ref}: on the line start (y)`);
      }
    }
  },
  {
    name: "Curve creation N1: a distance dimension to a rectangle corner moves the rectangle without reshaping it",
    run: () => {
      const base = projectWith([rectangle("entity:r", [20, 10], 40, 20)]);
      const set = applyWorkbenchOperation(base, { kind: "set-sketch-dimension", operationId: "operation:cj-d", expectedRevision: base.revision, entityId: "sketch:origin", secondEntityId: "entity:r", dimension: "horizontal", points: ["self", "corner-0"], valueMm: 15 });
      assert(set.ok, `the dimension applies: ${set.ok ? "" : set.diagnostics[0]?.message}`);
      const rect = set.value.project.sketch.entities.find((entity) => entity.id === "entity:r");
      assert(rect?.kind === "rectangle", "the rectangle remains");
      near(rect.widthMm, 40, 1e-9, "width unchanged");
      near(rect.heightMm, 20, 1e-9, "height unchanged");
      near(rect.rotationDeg, 0, 1e-9, "rotation unchanged");
      near(corner(rect, 0)[0], 15, 1e-9, "the corner is 15 mm from the origin");
      equal(rect.center[1], 10, "and did not move sideways");
    }
  }
];
