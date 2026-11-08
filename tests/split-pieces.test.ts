import type { DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, isSplitPieceOf, splitPieceId, splitPieceName, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { booleanMeshes } from "../packages/workbench-geometry/src/mesh-boolean.js";
import { splitMeshPieces } from "../packages/workbench-geometry/src/mesh-split.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { replayAllBodies, replayBody } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-split-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const volumeOf = (mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(mesh.positionsMm, mesh.indices).volumeMm3;
const BODY = "general-body:plate";
const plateStep: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: BODY };
// The default plate sketch is 60 x 40 mm with a 10 mm bore; extruded 10 mm it is 24 000 mm3 less the bore.
const PLATE = 60 * 40 * 10 - Math.PI * 25 * 10;

async function plateProject(): Promise<WorkbenchProject> {
  let project = run(createWorkbenchProject("project:test-split"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const first = (await replayBody({ ...project, design: { ...designOf(project), features: [...designOf(project).features, plateStep], rollbackIndex: 2 } }, BODY)).find((result) => result.body !== undefined);
  assert(first?.body !== undefined, "the plate builds");
  project = run(project, { kind: "add-design-solid", feature: plateStep, body: first.body });
  return project;
}

/** What the app does when a step is added: apply it, replay the timeline, apply the rebuilt bodies. */
async function commit(project: WorkbenchProject, operation: Op): Promise<WorkbenchProject> {
  const added = run(project, operation);
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

async function replay(project: WorkbenchProject): Promise<WorkbenchProject> {
  return run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
}

const bigHole = (diameter: number): DesignSolidFeature => ({
  id: "feature:hole-big", name: "Hole", kind: "hole", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: diameter, bodyId: BODY, operation: "direct-edit",
  holeStyle: "simple", holePositionMm: [0, 0, 10], holeNormal: [0, 0, 1], holeDiameterMm: diameter, holeDepthMm: 0
});

/** Area of the plate (|x| <= 30, |y| <= 20) inside a circle of radius r about the origin, by fine numerical integration. */
function discAreaInPlate(radius: number): number {
  let area = 0;
  const step = 0.01;
  for (let x = -30 + step / 2; x < 30; x += step) {
    const half = radius * radius - x * x;
    if (half > 0) area += Math.min(Math.sqrt(half), 20) * 2 * step;
  }
  return area;
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): { positionsMm: number[]; indices: number[] } {
  const mesh = tessellateExtrude([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z1 - z0, "xy");
  return { positionsMm: Array.from(mesh.positionsMm, (value, index) => index % 3 === 2 ? value + z0 : value), indices: Array.from(mesh.indices) };
}

export const splitPieceTests: readonly TestCase[] = [
  {
    name: "splitMeshPieces separates a mesh into its closed pieces, largest first, with the right volumes",
    run: () => {
      const small = box(0, 5, 0, 5, 0, 5);
      const large = box(20, 30, 0, 10, 0, 10);
      const merged = { positionsMm: [...small.positionsMm, ...large.positionsMm], indices: [...small.indices, ...large.indices.map((index) => index + small.positionsMm.length / 3)] };
      const pieces = splitMeshPieces(merged.positionsMm, merged.indices);
      equal(pieces.length, 2, "two pieces");
      near(pieces[0]!.volumeMm3, 1000, 1e-6, "the larger piece comes first");
      near(pieces[1]!.volumeMm3, 125, 1e-6, "then the smaller");
      assert(pieces.every((piece) => isClosedAndOriented(piece.indices)), "each piece is a closed, consistently wound mesh");
      equal(pieces[0]!.sourceTriangles.length + pieces[1]!.sourceTriangles.length, merged.indices.length / 3, "every triangle is accounted for");
      equal(splitPieceId("general-body:a", 2), "general-body:a.piece-2", "piece ids continue the body's id");
      assert(isSplitPieceOf("general-body:a", splitPieceId("general-body:a", 3)) && !isSplitPieceOf("general-body:a", "general-body:ab.piece-2"), "piece ids are recognised only for their own body");
      equal(splitPieceName("Plate", 2), "Plate (piece 2)", "piece names are numbered");
    }
  },
  {
    name: "a Boolean cut that severs the target is refused by default and returns both closed pieces when splitting is allowed",
    run: () => {
      const block = box(0, 40, 0, 10, 0, 10);
      const slab = box(15, 25, -5, 15, -5, 15);
      const refused = booleanMeshes(block, slab, "cut");
      assert(!refused.ok && refused.message.includes("separate pieces"), "by default the severing cut is refused with the old message");
      const allowed = booleanMeshes(block, slab, "cut", { allowSplit: true });
      assert(allowed.ok, `allowed: ${allowed.ok ? "" : allowed.message}`);
      if (!allowed.ok) return;
      equal(allowed.value.pieceCount, 2, "two pieces reported");
      near(allowed.value.volumeMm3, 4000 - 1000, 1, "the cut removed the slab's volume");
      const pieces = splitMeshPieces(allowed.value.positionsMm, allowed.value.indices);
      assert(pieces.every((piece) => isClosedAndOriented(piece.indices) && piece.volumeMm3 > 0), "both pieces are closed and point outward");
      near(pieces[0]!.volumeMm3 + pieces[1]!.volumeMm3, 3000, 1, "the pieces add up to what is left");
      near(Math.min(pieces[0]!.volumeMm3, pieces[1]!.volumeMm3), 1500, 1, "each half is 15 x 10 x 10");
      const apart = booleanMeshes(box(0, 10, 0, 10, 0, 10), box(30, 40, 0, 10, 0, 10), "join", { allowSplit: true });
      assert(!apart.ok, "two bodies that do not touch still cannot be joined, even with splitting allowed");
    }
  },
  {
    name: "a through hole wider than the plate cuts it in two: replay keeps both halves as bodies named after the plate, valid and closed",
    run: async () => {
      const project = await plateProject();
      near(volumeOf(project.part.generalBodies![0]!), PLATE, PLATE * 0.02, "the plate before the hole");
      const drilled = await commit(project, { kind: "add-design-solid", feature: bigHole(50), body: project.part.generalBodies![0]! });
      const bodies = drilled.part.generalBodies ?? [];
      equal(bodies.length, 2, "the hole left two bodies");
      const main = bodies.find((body) => body.id === BODY)!;
      const piece = bodies.find((body) => body.id === splitPieceId(BODY, 2))!;
      assert(main !== undefined && piece !== undefined, "the plate keeps its id and the other half is piece 2");
      equal(piece.name, splitPieceName(main.name, 2), "named consistently after the plate");
      assert(isClosedAndOriented(main.indices) && isClosedAndOriented(piece.indices), "both halves are closed meshes");
      assert(volumeOf(main) > 0 && volumeOf(piece) > 0, "both point outward");
      const expectedTotal = 60 * 40 * 10 - discAreaInPlate(25) * 10;
      near(volumeOf(main) + volumeOf(piece), expectedTotal, expectedTotal * 0.02, "together they are the plate less the drilled disc");
      near(volumeOf(main), volumeOf(piece), expectedTotal * 0.01, "the two halves are mirror images");
      assert(validateWorkbenchProject(drilled).ok, "the project with the pieces validates");
      const mainX = main.positionsMm.filter((_, index) => index % 3 === 0);
      const pieceX = piece.positionsMm.filter((_, index) => index % 3 === 0);
      assert(Math.max(...mainX) < 0 !== Math.max(...pieceX) < 0, "they sit on opposite sides of the hole");
      assert(designOf(drilled).features.every((feature) => feature.health === undefined), "no step is flagged as failed");
    }
  },
  {
    name: "pieces follow the timeline: shrinking the hole merges them back, suppressing it removes the piece, deleting the step removes it, visibility is kept",
    run: async () => {
      const project = await plateProject();
      let current = await commit(project, { kind: "add-design-solid", feature: bigHole(50), body: project.part.generalBodies![0]! });
      const pieceId = splitPieceId(BODY, 2);
      current = run(current, { kind: "toggle-general-body-visibility", bodyId: pieceId });
      current = await replay(current);
      equal(current.part.generalBodies!.find((body) => body.id === pieceId)?.visible, false, "a replay keeps a piece the user hid");
      equal(current.part.generalBodies!.length, 2, "replaying twice does not duplicate the piece");

      const suppressed = await replay(run(current, { kind: "set-design-feature-suppressed", featureId: "feature:hole-big", suppressed: true }));
      equal(suppressed.part.generalBodies!.length, 1, "suppressing the hole puts the plate back together");
      near(volumeOf(suppressed.part.generalBodies![0]!), PLATE, PLATE * 0.02, "and whole again");

      const smaller = run(current, { kind: "update-design-solid", feature: { ...bigHole(20) }, body: current.part.generalBodies!.find((body) => body.id === BODY)! });
      const regrown = await replay(smaller);
      equal(regrown.part.generalBodies!.length, 1, "a hole that no longer severs the plate leaves one body");
      near(volumeOf(regrown.part.generalBodies![0]!), PLATE - Math.PI * 100 * 10 + Math.PI * 25 * 10, PLATE * 0.03, "with the smaller hole's volume gone");

      const deleted = run(current, { kind: "delete-design-feature", featureId: "feature:hole-big" });
      equal((await replay(deleted)).part.generalBodies!.length, 1, "deleting the hole step leaves a single plate");

      const wholeGone = run(current, { kind: "delete-design-feature", featureId: "feature:extrude-1" });
      equal((wholeGone.part.generalBodies ?? []).length, 0, "deleting the step that made the plate removes the plate and its pieces");
    }
  },
  {
    name: "a timeline cut that severs the body keeps every piece, and a second severing cut numbers its pieces after the first",
    run: async () => {
      const project = await plateProject();
      let current = run(project, { kind: "new-design-sketch", plane: "datum:xy" });
      const slot: SketchEntity = { id: "entity:slot", kind: "rectangle", center: [0, 0], widthMm: 8, heightMm: 100, rotationDeg: 0, construction: false };
      current = run(current, { kind: "add-sketch-entity", entity: slot });
      current = run(current, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
      const cut: DesignSolidFeature = { id: "feature:cut-1", name: "Cut 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-2", profileIds: [], valueMm: 30, direction: "symmetric", operation: "cut", bodyId: BODY };
      current = await commit(current, { kind: "add-design-solid", feature: cut, body: current.part.generalBodies![0]! });
      equal(current.part.generalBodies!.length, 2, "the slot cut the plate into two bodies");
      // A second cut slicing the larger half again adds a third body, numbered after the first piece.
      let more = run(current, { kind: "new-design-sketch", plane: "datum:xy" });
      more = run(more, { kind: "add-sketch-entity", entity: { id: "entity:slot2", kind: "rectangle", center: [-20, 0], widthMm: 4, heightMm: 100, rotationDeg: 0, construction: false } });
      more = run(more, { kind: "commit-design-sketch", featureId: "feature:sketch-3", name: "Sketch 3" });
      const cut2: DesignSolidFeature = { ...cut, id: "feature:cut-2", name: "Cut 2", sketchFeatureId: "feature:sketch-3" };
      more = await commit(more, { kind: "add-design-solid", feature: cut2, body: more.part.generalBodies!.find((body) => body.id === BODY)! });
      const bodies = more.part.generalBodies!;
      equal(bodies.length, 3, "three bodies after the second severing cut");
      assert(new Set(bodies.map((body) => body.id)).size === 3, "all body ids are distinct");
      assert(bodies.some((body) => body.id === splitPieceId(BODY, 2)) && bodies.some((body) => body.id === splitPieceId(BODY, 3)), "pieces are numbered 2 and 3");
      assert(bodies.every((body) => isClosedAndOriented(body.indices) && volumeOf(body) > 0), "every body is a closed outward mesh");
      assert(validateWorkbenchProject(more).ok, "the project validates");
    }
  },
  {
    name: "a regenerate result may only carry pieces named after its own body",
    run: async () => {
      const project = await plateProject();
      const body = project.part.generalBodies![0]!;
      const stray: GeneralSolidBody = { ...body, id: "general-body:stray" };
      const refused = applyWorkbenchOperation(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body, pieces: [stray] }], operationId: "operation:test-split-stray", expectedRevision: project.revision } as WorkbenchOperation);
      assert(!refused.ok, "a stray piece is refused");
      const noBody = applyWorkbenchOperation(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", pieces: [] }], operationId: "operation:test-split-nobody", expectedRevision: project.revision } as WorkbenchOperation);
      assert(!noBody.ok, "pieces without the body they came from are refused");
    }
  }
];
