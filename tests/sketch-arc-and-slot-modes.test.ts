import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { buildSlotOverall } from "../packages/workbench-sketch/src/shapes.js";
import type { Vec2 } from "../packages/workbench-core/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

const ids = {
  entity: (() => { let counter = 0; return (): string => `entity:test-${counter += 1}`; })(),
  constraint: (() => { let counter = 0; return (): string => `constraint:test-${counter += 1}`; })()
};

export const sketchArcAndSlotModeTests: readonly TestCase[] = [
  {
    name: "centerpoint arc: (0,0) center, (3,0) start, (0,3) end is a quarter arc through (√4.5, √4.5)",
    run: () => {
      const result = buildSketchEntity("arc-center", [[0, 0], [3, 0], [0, 3]], "entity:arc-center-1");
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok) return;
      assert(result.value.kind === "arc", "the result is an arc entity");
      if (result.value.kind !== "arc") return;
      near(result.value.end[0], 0, 1e-6, "end snaps to the circle (x = 0)");
      near(result.value.end[1], 3, 1e-6, "end snaps to the circle (y = 3)");
      const midAngle = Math.atan2(result.value.mid[1], result.value.mid[0]);
      near(midAngle * 180 / Math.PI, 45, 1e-4, "mid sits at 45° — the midpoint of the CCW quarter sweep");
    }
  },
  {
    name: "centerpoint arc snaps end to the start-radius circle even when clicked off-circle",
    run: () => {
      // Start at (2, 0) gives radius 2. End clicked at (0, 10) should snap to (0, 2).
      const result = buildSketchEntity("arc-center", [[0, 0], [2, 0], [0, 10]], "entity:arc-center-2");
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok || result.value.kind !== "arc") return;
      near(result.value.end[0], 0, 1e-6, "end snaps to (0, 2) on x");
      near(result.value.end[1], 2, 1e-6, "end snaps to (0, 2) on y");
    }
  },
  {
    name: "centerpoint arc refuses a zero-length radius",
    run: () => {
      const result = buildSketchEntity("arc-center", [[0, 0], [0, 0], [1, 1]], "entity:arc-center-3");
      assert(!result.ok, "zero radius is refused");
    }
  },
  {
    name: "tangent arc leaves the anchor in the clicked tangent direction",
    run: () => {
      // Anchor at origin, tangent direction along +X (click at (1, 0)), end at (2, 2).
      // The arc should be tangent to the X axis at origin, curve upward, and end at (2, 2).
      // Geometry: center lies on +Y axis (perpendicular to tangent). dSq = 8, dn = (end · n) where n = (0, 1), so dn = 2.
      // signedR = 8/4 = 2. Center = (0, 2), radius = 2. Arc starts at (0, 0), ends at (2, 2), sweeps 90° CW.
      const result = buildSketchEntity("arc-tangent", [[0, 0], [1, 0], [2, 2]], "entity:arc-tangent-1");
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok || result.value.kind !== "arc") return;
      near(result.value.start[0], 0, 1e-6, "arc starts at anchor x");
      near(result.value.start[1], 0, 1e-6, "arc starts at anchor y");
      near(result.value.end[0], 2, 1e-6, "arc ends at (2, 2) x");
      near(result.value.end[1], 2, 1e-6, "arc ends at (2, 2) y");
      // Mid should sit on the quarter-arc at (center + radius * (sin45°, -sin45°·... )).
      // Center is at (0, 2), radius 2. Start at angle -90° (270°), end at angle 0°, going CCW from -90° → 0° (90° sweep).
      // Mid at -45°: center + 2*(cos(-45°), sin(-45°)) = (√2, 2 - √2) ≈ (1.414, 0.586).
      near(result.value.mid[0], Math.SQRT2, 1e-4, "mid x = √2");
      near(result.value.mid[1], 2 - Math.SQRT2, 1e-4, "mid y = 2 - √2");
    }
  },
  {
    name: "tangent arc refuses an end collinear with the tangent direction",
    run: () => {
      // Anchor at (0,0), tangent +X, end at (3, 0) — collinear → arc would be a line.
      const result = buildSketchEntity("arc-tangent", [[0, 0], [1, 0], [3, 0]], "entity:arc-tangent-2");
      assert(!result.ok, "a collinear end is refused");
    }
  },
  {
    name: "straight slot with 10 mm end-to-end and 4 mm width makes a slot with 6 mm centerline",
    run: () => {
      const result = buildSlotOverall([0, 0], [10, 0], [5, 2], ids);
      assert(result.ok, result.ok ? "" : "overall slot build failed");
      if (!result.ok) return;
      assert(result.value.entities.length === 4, "a slot has four entities (two lines and two arcs)");
      const lines = result.value.entities.filter((entity) => entity.kind === "line");
      assert(lines.length === 2, "two straight lines");
      // The top line should go from (2, 2) to (8, 2) — pulled inward by the half-width (2) from each end, at +2 y.
      const top = lines.find((line) => line.kind === "line" && line.start[1] > 0 && line.end[1] > 0);
      assert(top !== undefined && top.kind === "line", "the top line is present");
      if (top === undefined || top.kind !== "line") return;
      const [s, e] = top.start[0] < top.end[0] ? [top.start, top.end] : [top.end, top.start];
      near(s[0], 2, 1e-6, "top line start x = 2");
      near(e[0], 8, 1e-6, "top line end x = 8");
      near(s[1], 2, 1e-6, "top line y = 2");
    }
  },
  {
    name: "straight slot refuses an end-to-end length that is shorter than the width",
    run: () => {
      // 3 mm end-to-end, 4 mm width → too short to fit two caps.
      const result = buildSlotOverall([0, 0], [3, 0], [1, 2], ids);
      assert(!result.ok, "a too-short straight slot is refused");
    }
  }
];
