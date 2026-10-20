import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject, type ComponentInstance, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildAssemblyPreview, findAssemblyInterference } from "../packages/workbench-geometry/src/index.js";
import { evaluateProfilePrism } from "../packages/occt-kernel-adapter/src/reference-runtime.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** An L-shaped solid from the kernel, centred on its bounds, as a mesh component. */
async function lBracket(id: string, translationMm: readonly [number, number, number]): Promise<ComponentInstance> {
  const points: readonly (readonly [number, number, number])[] = [[0, 0, 0], [0.04, 0, 0], [0.04, 0.01, 0], [0.01, 0.01, 0], [0.01, 0.03, 0], [0, 0.03, 0]];
  const prism = await evaluateProfilePrism({ operationId: `operation:${id}`, semanticId: `body:${id}`, profilePointsMeters: points, normal: [0, 0, 1], heightMeters: 0.01 });
  const positions = prism.positionsMeters.map((value) => value * 1000);
  const center = [20, 15, 5];
  return {
    id: `component:${id}`, name: id, shape: "mesh", grounded: false, visible: true, color: "#aab2b8",
    translationMm: translationMm as never, rotationDeg: [0, 0, 0], sizeMm: [40, 30, 10], explosionDirection: [0, 0, 1],
    mesh: { positionsMm: positions.map((value, index) => value - center[index % 3]!), indices: prism.indices, faceTriangles: prism.faceTriangles }
  };
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "operation failed");
  return result.value;
}

function withComponent(project: WorkbenchProject, component: ComponentInstance) {
  return applyWorkbenchOperation(project, { kind: "add-assembly-component", operationId: `operation:add-${component.id.replace(/[^a-z0-9]/gu, "-")}`, expectedRevision: project.revision, component });
}

export const assemblyMeshTests: readonly TestCase[] = [
  {
    name: "a kernel solid becomes an assembly component with its real shape, moves, and takes part in interference",
    run: async () => {
      const project = createWorkbenchProject("project:test-mesh-component");
      const first = await lBracket("bracket-a", [0, 0, 200]);
      const added = withComponent(project, first);
      assert(added.ok, added.ok ? "" : added.diagnostics[0]?.message ?? "");
      const scene = buildAssemblyPreview({ ...added.value.project.assembly, explodeMm: 0 });
      const primitive = scene.primitives.find((candidate) => candidate.id === first.id)!;
      assert(primitive.kind === "mesh", "the component renders as its own triangles, not a stand-in shape");
      const zs = primitive.positionsMm.filter((_, index) => index % 3 === 2);
      near(Math.min(...zs), 195, 1e-9, "the local mesh sits centred about the component translation (bottom)");
      near(Math.max(...zs), 205, 1e-9, "and top");

      const moved = applyWorkbenchOperation(added.value.project, { kind: "set-component-translation", operationId: "operation:move-a", expectedRevision: added.value.project.revision, componentId: first.id, translationMm: [50, 0, 200] });
      assert(moved.ok, "moving applies");
      const movedPrimitive = buildAssemblyPreview({ ...moved.value.project.assembly, explodeMm: 0 }).primitives.find((candidate) => candidate.id === first.id)!;
      assert(movedPrimitive.kind === "mesh", "still a mesh");
      near(Math.min(...movedPrimitive.positionsMm.filter((_, index) => index % 3 === 0)), 30, 1e-9, "moving shifts every vertex");

      const second = await lBracket("bracket-b", [10, 0, 200]);
      const both = withComponent(must(withComponent(project, first)).project, second);
      assert(both.ok, "a second solid adds");
      const hits = findAssemblyInterference({ ...both.value.project.assembly, explodeMm: 0 });
      assert(hits.some((hit) => JSON.stringify(hit).includes("bracket-a") && JSON.stringify(hit).includes("bracket-b")), "overlapping solids interfere using their real bounds");
      const apart = withComponent(must(withComponent(project, first)).project, await lBracket("bracket-c", [300, 0, 200]));
      assert(apart.ok && !findAssemblyInterference({ ...apart.value.project.assembly, explodeMm: 0 }).some((hit) => JSON.stringify(hit).includes("bracket-c")), "separated solids do not interfere");
    }
  },
  {
    name: "mesh components validate strictly and survive a save and load round trip",
    run: async () => {
      const project = createWorkbenchProject("project:test-mesh-validate");
      const good = await lBracket("bracket-v", [0, 0, 200]);
      const noMesh: ComponentInstance = { ...good, mesh: undefined } as unknown as ComponentInstance;
      delete (noMesh as { mesh?: unknown }).mesh;
      assert(!withComponent(project, noMesh).ok, "shape mesh without a mesh is rejected");
      assert(!withComponent(project, { ...good, shape: "box" }).ok, "a mesh on another shape is rejected");
      assert(!withComponent(project, { ...good, mesh: { positionsMm: good.mesh!.positionsMm, indices: [0, 1, 99999] } }).ok, "out-of-range indices are rejected");
      assert(!withComponent(project, { ...good, mesh: { ...good.mesh!, faceTriangles: [0] } }).ok, "face labels must match the triangle count");

      const added = withComponent(project, good);
      assert(added.ok, "the valid component adds");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(added.value.project)));
      assert(reloaded.ok, "the saved project reloads");
      const component = reloaded.value.assembly.components.find((candidate) => candidate.id === good.id)!;
      equal(component.shape, "mesh", "shape kept");
      equal(component.mesh?.indices.length, good.mesh!.indices.length, "triangles kept");
    }
  }
];
