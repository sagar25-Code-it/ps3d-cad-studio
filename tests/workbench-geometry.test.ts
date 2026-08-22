import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  bezierPoint,
  buildAssemblyPreview,
  buildControlNet,
  buildSurfacePreview,
  findAssemblyInterference
} from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const workbenchGeometryTests: readonly TestCase[] = [
  {
    name: "assembly preview produces one selectable primitive per visible component",
    run: () => {
      const assembly = createWorkbenchProject("project:test-assembly").assembly;
      const scene = buildAssemblyPreview(assembly);
      equal(scene.kind, "assembly", "scene kind should remain explicit");
      equal(scene.primitives.length, assembly.components.length, "all visible components should render");
      assert(scene.boundsMm.size.every((value) => Number.isFinite(value) && value > 0), "assembly bounds must be finite and positive");
    }
  },
  {
    name: "assembly interference is conservative and responds to explode distance",
    run: () => {
      const seeded = createWorkbenchProject("project:test-interference").assembly;
      const compact = findAssemblyInterference({ ...seeded, explodeMm: 0 });
      const exploded = findAssemblyInterference({ ...seeded, explodeMm: 80 });
      assert(compact.length > exploded.length, "exploding the fixture should remove compact AABB overlaps");
      assert(compact.every((candidate) => candidate.conservative), "interference results must stay labeled conservative");
      assert(compact.every((candidate) => candidate.volumeCubicMm > 0), "reported candidates need positive overlap volume");
    }
  },
  {
    name: "assembly preview and interference bounds conservatively include component rotation",
    run: () => {
      const seeded = createWorkbenchProject("project:test-rotated-bounds").assembly;
      const component = { ...seeded.components[0]!, shape: "box" as const, translationMm: [0, 0, 0] as const, sizeMm: [100, 20, 10] as const, rotationDeg: [0, 0, 45] as const };
      const scene = buildAssemblyPreview({ ...seeded, components: [component], mates: [], explodeMm: 0 });
      near(scene.boundsMm.size[0], Math.sqrt(2) * 60, 1e-9, "rotated box X bounds should include projected width and depth");
      near(scene.boundsMm.size[1], Math.sqrt(2) * 60, 1e-9, "rotated box Y bounds should include projected width and depth");
      near(scene.boundsMm.size[2], 10, 1e-9, "Z bounds should remain unchanged for a Z-axis rotation");
    }
  },
  {
    name: "bicubic surface preview has deterministic finite topology and area",
    run: () => {
      const surface = createWorkbenchProject("project:test-surface").surface;
      const first = buildSurfacePreview(surface);
      const second = buildSurfacePreview(surface);
      equal(first.metrics.vertices, (surface.uSegments + 1) * (surface.vSegments + 1), "vertex count follows the sampling grid");
      equal(first.metrics.triangles, surface.uSegments * surface.vSegments * 2, "each grid cell should create two triangles");
      assert(first.metrics.approximateAreaSquareMm > 0, "surface area should be positive");
      assert(first.metrics.finite, "surface metrics must attest finite output");
      equal(JSON.stringify(first), JSON.stringify(second), "identical intent should create byte-stable preview data");
    }
  },
  {
    name: "Bezier patch interpolates its corner control points",
    run: () => {
      const surface = createWorkbenchProject("project:test-bezier-corners").surface;
      const net = buildControlNet(surface);
      const start = bezierPoint(net, 0, 0);
      const end = bezierPoint(net, 1, 1);
      for (let axis = 0; axis < 3; axis += 1) {
        near(start[axis]!, net[0]![axis]!, 1e-10, `start corner axis ${axis} should interpolate`);
        near(end[axis]!, net[15]![axis]!, 1e-10, `end corner axis ${axis} should interpolate`);
      }
    }
  }
];
