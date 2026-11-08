import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject, type PartPreviewBody, type PartPrimitiveParams, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { buildPartPreview, newPrimitiveMesh, primitiveVolumeMm3 } from "../packages/workbench-geometry/src/index.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { selectionMetrics } from "../apps/studio-web/src/selection-metrics.js";
import { buildWorkbenchMenus, type WorkbenchMenuActions, type WorkbenchMenuState } from "../apps/studio-web/src/ui/menu-model.js";

type Shape = "ellipsoid" | "prism" | "wedge" | "spiral" | "tube";
let serial = 0;

function body(id: string, shape: Shape, sizeMm: readonly [number, number, number], primitiveParams?: PartPrimitiveParams, translationMm: readonly [number, number, number] = [0, 0, 0]): PartPreviewBody {
  return { id, name: id, shape, visible: true, color: "#aeb3b8", translationMm, rotationDeg: [0, 0, 0], sizeMm, ...(primitiveParams === undefined ? {} : { primitiveParams }) };
}

function tryApply(project: WorkbenchProject, intent: Record<string, unknown>): ReturnType<typeof applyWorkbenchOperation> {
  serial += 1;
  return applyWorkbenchOperation(project, { ...intent, operationId: `operation:test-primitive-${serial}`, expectedRevision: project.revision } as unknown as WorkbenchOperation);
}

function apply(project: WorkbenchProject, intent: Record<string, unknown>): WorkbenchProject {
  const result = tryApply(project, intent);
  assert(result.ok, `${String(intent["kind"])} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const CASES: readonly { readonly shape: Shape; readonly size: readonly [number, number, number]; readonly params?: PartPrimitiveParams; readonly tolerance: number }[] = [
  { shape: "ellipsoid", size: [40, 28, 22], tolerance: 0.01 },
  { shape: "prism", size: [30, 30, 24], params: { sides: 6 }, tolerance: 1e-9 },
  { shape: "prism", size: [20, 20, 10], params: { sides: 3 }, tolerance: 1e-9 },
  { shape: "wedge", size: [30, 24, 18], tolerance: 1e-9 },
  { shape: "spiral", size: [50, 50, 4], params: { turns: 3 }, tolerance: 0.01 },
  { shape: "spiral", size: [80, 80, 2], params: { turns: 7.5 }, tolerance: 0.01 },
  { shape: "tube", size: [30, 22, 30], tolerance: 0.01 }
];

export const primitiveBodyTests: readonly TestCase[] = [
  {
    name: "the Create menu offers all five new primitives and each dispatches its own shape; the status bar reports their exact volume",
    run: () => {
      const calls: string[] = [];
      const noop = (): void => undefined;
      const actions = new Proxy({ onCreatePrimitive: (shape: string) => { calls.push(shape); }, onWorkspace: noop, onModifyGeneralBody: noop }, { get: (target, key) => (key in target ? (target as Record<string | symbol, unknown>)[key] : noop) }) as unknown as WorkbenchMenuActions;
      const state: WorkbenchMenuState = { workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 0, previewBodySelected: false, generalBodySelected: false, selectionDeletable: false };
      const items = buildWorkbenchMenus(state, actions).flatMap((menu) => menu.items);
      for (const shape of ["ellipsoid", "prism", "wedge", "spiral", "tube"]) {
        const entry = items.find((candidate) => candidate.id === `create.${shape}`);
        assert(entry !== undefined && entry.disabled !== true, `create.${shape} exists and is enabled`);
        entry?.action();
      }
      equal(calls.join(","), "ellipsoid,prism,wedge,spiral,tube", "each menu item creates its own shape");
      const project = apply(createWorkbenchProject("project:primitives-metrics"), { kind: "add-part-preview-bodies", bodies: [body("part-body:pri", "prism", [30, 30, 24], { sides: 6 })] });
      const reading = selectionMetrics(project, "part-body:pri");
      assert(reading !== undefined && reading.metrics.some((line) => line.includes("6 sides")) && reading.metrics.some((line) => line.startsWith("Volume ")), "the status bar names the side count and volume");
    }
  },
  {
    name: "every new primitive builds a closed, outward-wound mesh whose volume matches the analytic formula",
    run: () => {
      for (const entry of CASES) {
        const primitive = body("part-body:p", entry.shape, entry.size, entry.params);
        const mesh = newPrimitiveMesh(primitive);
        assert(mesh !== undefined, `${entry.shape} has a mesh`);
        if (mesh === undefined) return;
        assert(isClosedAndOriented(mesh.indices), `${entry.shape} ${JSON.stringify(entry.params ?? {})} is closed with every edge used once each way`);
        const metrics = solidMetrics(mesh.positions, mesh.indices);
        assert(metrics.outward, `${entry.shape} winds outward`);
        const analytic = primitiveVolumeMm3(primitive)!;
        near(metrics.volumeMm3, analytic, analytic * entry.tolerance + 1e-9, `${entry.shape} ${JSON.stringify(entry.params ?? {})} mesh volume against the analytic volume`);
        assert(metrics.volumeMm3 <= analytic + 1e-6, `${entry.shape} tessellation never exceeds the exact volume`);
      }
    }
  },
  {
    name: "closed-form volumes: ellipsoid pi/6 xyz, regular prism, half-box wedge, annular tube, and a sphere is the equal-axis ellipsoid",
    run: () => {
      near(primitiveVolumeMm3(body("part-body:a", "ellipsoid", [10, 20, 30]))!, Math.PI / 6 * 10 * 20 * 30, 1e-9, "ellipsoid");
      near(primitiveVolumeMm3(body("part-body:b", "ellipsoid", [12, 12, 12]))!, 4 / 3 * Math.PI * 216, 1e-9, "equal axes give a sphere of radius 6");
      near(primitiveVolumeMm3(body("part-body:c", "prism", [20, 20, 5], { sides: 4 }))!, 2 * 100 * 5, 1e-9, "a square prism inscribed in a circle of radius 10 has area 2 r^2");
      near(primitiveVolumeMm3(body("part-body:d", "wedge", [10, 8, 6]))!, 240, 1e-9, "a wedge is half its box");
      near(primitiveVolumeMm3(body("part-body:e", "tube", [20, 10, 4]))!, Math.PI * (100 - 25) * 4, 1e-9, "a tube is an annulus times its length");
    }
  },
  {
    name: "bounding boxes: the mesh fills the declared sizeMm for ellipsoid, wedge, prism and tube, and the spiral stays inside it",
    run: () => {
      for (const entry of CASES) {
        const primitive = body("part-body:p", entry.shape, entry.size, entry.params);
        const metrics = solidMetrics(newPrimitiveMesh(primitive)!.positions, newPrimitiveMesh(primitive)!.indices);
        const [sx, sy, sz] = metrics.sizeMm;
        near(sz, entry.size[2], 1e-9, `${entry.shape} height`);
        if (entry.shape === "ellipsoid" || entry.shape === "wedge") { near(sx, entry.size[0], 1e-9, `${entry.shape} X`); near(sy, entry.size[1], 1e-9, `${entry.shape} Y`); }
        if (entry.shape === "tube") near(sx, entry.size[0], 1e-9, "tube outer diameter");
        assert(sx <= entry.size[0] + 1e-9 && sy <= (entry.shape === "tube" ? entry.size[0] : entry.size[1]) + 1e-9, `${entry.shape} stays inside its declared box`);
      }
      const spiral = newPrimitiveMesh(body("part-body:s", "spiral", [60, 60, 3], { turns: 4 }))!;
      const bounds = solidMetrics(spiral.positions, spiral.indices);
      assert(bounds.sizeMm[0] > 55 && bounds.sizeMm[0] <= 60 + 1e-9, "the spiral's outermost point reaches the declared outer diameter");
    }
  },
  {
    name: "spiral turns are real: the ribbon never overlaps itself and the gap between turns equals the ribbon width",
    run: () => {
      const outer = 50; const turns = 3;
      const mesh = newPrimitiveMesh(body("part-body:s", "spiral", [outer, outer, 4], { turns }))!;
      const pitch = (outer / 2) / (turns + 1); const width = pitch / 2;
      // Walk a ray along +X from the middle: it must alternate between ribbon and gap, crossing `turns` full ribbons.
      let inside = false; let crossings = 0;
      for (let step = 0; step <= 4000; step += 1) {
        const x = (outer / 2) * step / 4000;
        const hit = rayHitsMaterial(mesh, [x, 0, 0]);
        if (hit && !inside) crossings += 1;
        inside = hit;
      }
      assert(crossings >= turns, `a ray along +X crosses at least ${turns} ribbon turns (${crossings})`);
      near(pitch - width, width, 1e-12, "gap equals width");
    }
  },
  {
    name: "preview bodies of the new shapes survive operations, validation and a JSON round trip, and render their own mesh at the body's pose",
    run: () => {
      let project = createWorkbenchProject("project:primitives");
      const bodies = [
        body("part-body:ell", "ellipsoid", [40, 28, 22], undefined, [100, 0, 11]),
        body("part-body:pri", "prism", [30, 30, 24], { sides: 5 }, [150, 0, 12]),
        body("part-body:wed", "wedge", [30, 24, 18], undefined, [200, 0, 9]),
        body("part-body:spi", "spiral", [50, 50, 4], { turns: 3 }, [250, 0, 2]),
        body("part-body:tub", "tube", [30, 22, 30], undefined, [300, 0, 15])
      ];
      project = apply(project, { kind: "add-part-preview-bodies", bodies });
      equal(project.part.previewBodies?.length, bodies.length, "all five bodies were added");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(reloaded.ok, `the saved project validates again: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
      if (!reloaded.ok) return;
      equal(reloaded.value.part.previewBodies?.find((candidate) => candidate.id === "part-body:pri")?.primitiveParams?.sides, 5, "the prism side count survives the round trip");
      const scene = buildPartPreview(reloaded.value.part);
      for (const entry of bodies) {
        const mesh = scene.primitives.find((primitive) => primitive.id === entry.id);
        assert(mesh !== undefined && mesh.kind === "mesh", `${entry.id} renders as an analytic mesh`);
        if (mesh === undefined || mesh.kind !== "mesh") return;
        assert(isClosedAndOriented(mesh.indices), `${entry.id} renders closed`);
        const metrics = solidMetrics(mesh.positionsMm, mesh.indices);
        const analytic = primitiveVolumeMm3(entry)!;
        near(metrics.volumeMm3, analytic, analytic * 0.015, `${entry.id} rendered volume`);
        // A wedge's centre of volume sits one sixth of its height below the middle of its box; the rest are balanced about it.
        const expectedZ = entry.translationMm[2] - (entry.shape === "wedge" ? entry.sizeMm[2] / 6 : 0);
        near(metrics.centroidMm[2], expectedZ, 0.01, `${entry.id} sits at its translation`);
        near(metrics.centroidMm[0], entry.translationMm[0] + (entry.shape === "spiral" ? 0 : 0), entry.shape === "spiral" ? 3 : 0.01, `${entry.id} X position`);
      }
    }
  },
  {
    name: "invalid primitive payloads are refused: bad side counts, turn counts, tube walls, stray params, and params on older shapes",
    run: () => {
      const project = createWorkbenchProject("project:primitives-bad");
      const bad: readonly { readonly why: string; readonly body: PartPreviewBody }[] = [
        { why: "prism with two sides", body: body("part-body:b1", "prism", [20, 20, 10], { sides: 2 }) },
        { why: "prism with 65 sides", body: body("part-body:b2", "prism", [20, 20, 10], { sides: 65 }) },
        { why: "prism with a fractional side count", body: body("part-body:b3", "prism", [20, 20, 10], { sides: 5.5 }) },
        { why: "prism without a side count", body: body("part-body:b4", "prism", [20, 20, 10]) },
        { why: "prism whose Y differs from X", body: body("part-body:b5", "prism", [20, 15, 10], { sides: 6 }) },
        { why: "spiral with zero turns", body: body("part-body:b6", "spiral", [40, 40, 3], { turns: 0 }) },
        { why: "spiral with 21 turns", body: body("part-body:b7", "spiral", [40, 40, 3], { turns: 21 }) },
        { why: "spiral carrying a side count", body: body("part-body:b8", "spiral", [40, 40, 3], { sides: 6 }) },
        { why: "tube with the inner diameter equal to the outer", body: body("part-body:b9", "tube", [20, 20, 10]) },
        { why: "tube with a zero inner diameter", body: body("part-body:b10", "tube", [20, 0, 10]) },
        { why: "ellipsoid with a zero axis", body: body("part-body:b11", "ellipsoid", [20, 0, 10]) },
        { why: "wedge carrying params", body: body("part-body:b12", "wedge", [20, 10, 10], { sides: 3 }) },
        { why: "cylinder carrying params", body: { ...body("part-body:b13", "tube", [20, 20, 10]), shape: "cylinder", primitiveParams: { sides: 6 } } as PartPreviewBody }
      ];
      for (const entry of bad) {
        assert(!tryApply(project, { kind: "add-part-preview-bodies", bodies: [entry.body] }).ok, `${entry.why} is refused`);
      }
    }
  },
  {
    name: "resizing keeps round shapes round and changing sides or turns through set-part-preview-body-size regenerates the mesh",
    run: () => {
      let project = apply(createWorkbenchProject("project:primitives-resize"), {
        kind: "add-part-preview-bodies",
        bodies: [body("part-body:pri", "prism", [30, 30, 20], { sides: 6 }), body("part-body:spi", "spiral", [50, 50, 4], { turns: 3 }), body("part-body:tub", "tube", [30, 20, 10])]
      });
      project = apply(project, { kind: "set-part-preview-body-size", bodyId: "part-body:pri", sizeMm: [40, 7, 20], primitiveParams: { sides: 8 } });
      const prism = project.part.previewBodies!.find((candidate) => candidate.id === "part-body:pri")!;
      equal(prism.sizeMm.join(","), "40,40,20", "a prism's Y follows X, as a cylinder's does");
      equal(prism.primitiveParams?.sides, 8, "the new side count is stored");
      const octagon = newPrimitiveMesh(prism)!;
      near(solidMetrics(octagon.positions, octagon.indices).volumeMm3, 0.5 * 8 * 400 * Math.sin(Math.PI / 4) * 20, 1e-6, "the regenerated prism is an octagon of circumradius 20");
      project = apply(project, { kind: "set-part-preview-body-size", bodyId: "part-body:spi", sizeMm: [50, 50, 4], primitiveParams: { turns: 5 } });
      const spiral = project.part.previewBodies!.find((candidate) => candidate.id === "part-body:spi")!;
      const metrics = solidMetrics(newPrimitiveMesh(spiral)!.positions, newPrimitiveMesh(spiral)!.indices);
      near(metrics.volumeMm3, primitiveVolumeMm3(spiral)!, primitiveVolumeMm3(spiral)! * 0.01, "five turns match the analytic volume");
      assert(!tryApply(project, { kind: "set-part-preview-body-size", bodyId: "part-body:pri", sizeMm: [40, 40, 20], primitiveParams: { sides: 2 } }).ok, "two sides is refused");
      assert(!tryApply(project, { kind: "set-part-preview-body-size", bodyId: "part-body:tub", sizeMm: [30, 30, 10] }).ok, "a tube whose inner diameter reaches the outer is refused");
      project = apply(project, { kind: "set-part-preview-body-size", bodyId: "part-body:tub", sizeMm: [30, 12, 40] });
      equal(project.part.previewBodies!.find((candidate) => candidate.id === "part-body:tub")!.sizeMm.join(","), "30,12,40", "a tube takes a new wall");
    }
  },
  {
    name: "direct edits that would silently change the shape are refused: mirroring a spiral or a wedge off its symmetry plane, moving a wedge face",
    run: () => {
      let project = apply(createWorkbenchProject("project:primitives-edit"), {
        kind: "add-part-preview-bodies",
        bodies: [body("part-body:spi", "spiral", [50, 50, 4], { turns: 3 }), body("part-body:wed", "wedge", [30, 24, 18]), body("part-body:odd", "prism", [30, 30, 10], { sides: 5 }), body("part-body:even", "prism", [30, 30, 10], { sides: 6 })]
      });
      assert(!tryApply(project, { kind: "mirror-part-feature", bodyId: "part-body:spi", newBodyId: "part-body:spi-m", plane: "yz" }).ok, "a mirrored spiral would be the other hand");
      assert(!tryApply(project, { kind: "mirror-part-feature", bodyId: "part-body:wed", newBodyId: "part-body:wed-m", plane: "xz" }).ok, "mirroring a wedge across XZ would flip its slope");
      assert(tryApply(project, { kind: "mirror-part-feature", bodyId: "part-body:wed", newBodyId: "part-body:wed-m", plane: "yz" }).ok, "a wedge is symmetric across YZ");
      assert(!tryApply(project, { kind: "mirror-part-feature", bodyId: "part-body:odd", newBodyId: "part-body:odd-m", plane: "yz" }).ok, "an odd prism is not symmetric across YZ");
      assert(tryApply(project, { kind: "mirror-part-feature", bodyId: "part-body:even", newBodyId: "part-body:even-m", plane: "yz" }).ok, "an even prism is");
      assert(!tryApply(project, { kind: "replace-part-body-face", bodyId: "part-body:wed", face: "z-positive", localPositionMm: 12 }).ok, "a wedge has no parallel faces to move");
      project = apply(project, { kind: "pattern-part-feature", bodyId: "part-body:spi", instanceIds: ["part-body:spi-2"], direction: "x", spacingMm: 80 });
      equal(project.part.previewBodies!.find((candidate) => candidate.id === "part-body:spi-2")!.primitiveParams?.turns, 3, "a pattern copy keeps the turn count");
    }
  }
];

/** Casts a ray along +Z through (x, y) and reports whether it is inside the mesh at z = 0 (an odd number of crossings above it). */
function rayHitsMaterial(mesh: { readonly positions: readonly number[]; readonly indices: readonly number[] }, point: readonly [number, number, number]): boolean {
  let crossings = 0;
  for (let corner = 0; corner < mesh.indices.length; corner += 3) {
    const a = vertex(mesh, mesh.indices[corner]!); const b = vertex(mesh, mesh.indices[corner + 1]!); const c = vertex(mesh, mesh.indices[corner + 2]!);
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
    const l2 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
    if (z > point[2]) crossings += 1;
  }
  return crossings % 2 === 1;
}

function vertex(mesh: { readonly positions: readonly number[] }, index: number): readonly [number, number, number] {
  return [mesh.positions[index * 3]!, mesh.positions[index * 3 + 1]!, mesh.positions[index * 3 + 2]!];
}
