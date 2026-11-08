import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  validSolidFeaturePayload,
  type SketchEntity,
  type WorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { curvatureCombOf, sketchCurvatureCombs } from "../packages/workbench-sketch/src/curvature-comb.js";
import { transformEntities, type SketchEditContext } from "../packages/workbench-sketch/src/edit-tools.js";
import { attachEdgeFlange, sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { ZEBRA_DEFAULT, ZEBRA_FRAGMENT_SOURCE, ZEBRA_UNIFORMS_SOURCE, zebraBandAt, zebraReflection } from "../packages/viewport-three/src/zebra.js";
import { assert, near, type TestCase } from "./test-kit.js";

let serial = 0;
const newId = (prefix: "entity" | "constraint"): string => `${prefix}:gen-${(serial += 1)}`;

function projectWith(entities: readonly SketchEntity[]): WorkbenchProject {
  const base = createWorkbenchProject("project:test-transform");
  return { ...base, sketch: { ...base.sketch, entities, constraints: [] } };
}

function context(project: WorkbenchProject): SketchEditContext {
  return { sketch: project.sketch, newId };
}

const line = (id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });
const circle = (id: string, center: readonly [number, number], radiusMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false });
const rectangle = (id: string, center: readonly [number, number], widthMm: number, heightMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center, widthMm, heightMm, rotationDeg: 0, construction: false });

/** Every edge is used once in each direction, which is what a closed, consistently wound solid looks like. */
function isClosedAndOriented(indices: readonly number[]): boolean {
  const directed = new Map<string, number>();
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    for (let side = 0; side < 3; side += 1) {
      const key = `${indices[corner + side]}>${indices[corner + (side + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split(">");
    if (count !== 1 || directed.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

function plate(widthMm: number, heightMm: number, thicknessMm: number): { positionsMm: number[]; indices: number[] } {
  const mesh = tessellateExtrude([[0, 0], [widthMm, 0], [widthMm, heightMm], [0, heightMm]], thicknessMm, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

const quarterBendArea = (radius: number, thickness: number): number => (Math.PI / 4) * ((radius + thickness) ** 2 - radius ** 2);

export const inspectTransformEdgeFlangeTests: readonly TestCase[] = [
  {
    name: "Move updates the selected entities in place and a copy leaves the originals",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), circle("c", [5, 5], 2)]);
      const moved = transformEntities(context(project), ["entity:a", "entity:c"], { kind: "move", dxMm: 3, dyMm: -4 }, false);
      assert(moved.ok, "move accepted");
      if (!moved.ok) return;
      assert(moved.value.updateEntities.length === 2 && moved.value.addEntities.length === 0, "in place");
      const movedLine = moved.value.updateEntities.find((entity) => entity.id === "entity:a");
      assert(movedLine?.kind === "line" && movedLine.start[0] === 3 && movedLine.end[1] === -4, "line translated");
      const copied = transformEntities(context(project), ["entity:a"], { kind: "move", dxMm: 3, dyMm: 0 }, true);
      assert(copied.ok && copied.value.addEntities.length === 1 && copied.value.updateEntities.length === 0 && copied.value.addEntities[0]!.id !== "entity:a", "copy adds a new entity");
    }
  },
  {
    name: "Rotate turns points about the centre and the rotation of rectangles and ellipses",
    run: () => {
      const project = projectWith([line("a", [10, 0], [20, 0]), rectangle("r", [10, 0], 4, 2)]);
      const result = transformEntities(context(project), ["entity:a", "entity:r"], { kind: "rotate", angleDeg: 90, center: [0, 0] }, false);
      assert(result.ok, "rotate accepted");
      if (!result.ok) return;
      const turned = result.value.updateEntities.find((entity) => entity.id === "entity:a");
      assert(turned?.kind === "line", "line");
      if (turned?.kind === "line") {
        near(turned.start[0], 0, 1e-9, "start x");
        near(turned.start[1], 10, 1e-9, "start y");
        near(turned.end[1], 20, 1e-9, "end y");
      }
      const turnedRectangle = result.value.updateEntities.find((entity) => entity.id === "entity:r");
      assert(turnedRectangle?.kind === "rectangle" && Math.abs(turnedRectangle.rotationDeg - 90) < 1e-9, "rectangle rotation follows");
    }
  },
  {
    name: "Scale multiplies circle radius and rectangle size about the centre, and refuses a factor of 1",
    run: () => {
      const project = projectWith([circle("c", [10, 0], 3), rectangle("r", [10, 10], 4, 2)]);
      const result = transformEntities(context(project), ["entity:c", "entity:r"], { kind: "scale", factor: 2, center: [0, 0] }, false);
      assert(result.ok, "scale accepted");
      if (!result.ok) return;
      const scaledCircle = result.value.updateEntities.find((entity) => entity.id === "entity:c");
      assert(scaledCircle?.kind === "circle" && scaledCircle.radiusMm === 6 && scaledCircle.center[0] === 20, "circle scaled");
      const scaledRectangle = result.value.updateEntities.find((entity) => entity.id === "entity:r");
      assert(scaledRectangle?.kind === "rectangle" && scaledRectangle.widthMm === 8 && scaledRectangle.heightMm === 4 && scaledRectangle.center[1] === 20, "rectangle scaled");
      assert(!transformEntities(context(project), ["entity:c"], { kind: "scale", factor: 1, center: [0, 0] }, false).ok, "factor 1 refused");
      assert(!transformEntities(context(project), [], { kind: "move", dxMm: 1, dyMm: 0 }, false).ok, "empty selection refused");
    }
  },
  {
    name: "An in-place transform goes through apply-sketch-edit and moves the real sketch",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0])]);
      const planResult = transformEntities(context(project), ["entity:a"], { kind: "move", dxMm: 5, dyMm: 5 }, false);
      assert(planResult.ok, "plan");
      if (!planResult.ok) return;
      const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", ...planResult.value, operationId: "operation:test-move", expectedRevision: project.revision });
      assert(applied.ok, "applied");
      if (!applied.ok) return;
      const entity = applied.value.project.sketch.entities[0];
      assert(entity?.kind === "line" && entity.start[0] === 5 && entity.end[1] === 5, "sketch moved");
    }
  },
  {
    name: "A circle's curvature comb has curvature 1/r everywhere and teeth pointing outward",
    run: () => {
      const samples: [number, number][] = [];
      for (let i = 0; i < 96; i += 1) samples.push([10 * Math.cos((i / 96) * Math.PI * 2), 10 * Math.sin((i / 96) * Math.PI * 2)]);
      const comb = curvatureCombOf(samples, true, 50);
      near(comb.maxCurvature, 0.1, 0.001, "curvature 1/r");
      near(comb.minRadiusMm, 10, 0.1, "radius");
      for (const tooth of comb.teeth) {
        assert(Math.hypot(tooth.tip[0], tooth.tip[1]) > Math.hypot(tooth.base[0], tooth.base[1]), "tooth points away from the centre");
        near(Math.hypot(tooth.tip[0] - tooth.base[0], tooth.tip[1] - tooth.base[1]), 0.1 * 50, 0.05, "tooth length = curvature x scale");
      }
    }
  },
  {
    name: "A straight run has no teeth length and an S-curve flips tooth side at the inflection",
    run: () => {
      const straight = curvatureCombOf([[0, 0], [5, 0], [10, 0], [15, 0]], false, 10);
      assert(straight.maxCurvature === 0 && straight.teeth.every((tooth) => tooth.turn === 0), "no curvature on a line");
      const s: [number, number][] = [];
      for (let i = 0; i <= 40; i += 1) { const t = (i / 40) * Math.PI * 2; s.push([t * 5, 10 * Math.sin(t)]); }
      const comb = curvatureCombOf(s, false, 10);
      assert(comb.teeth.some((tooth) => tooth.turn === 1) && comb.teeth.some((tooth) => tooth.turn === -1), "both turn directions present");
    }
  },
  {
    name: "Sketch combs share one scale so the tightest curve gets the tallest tooth",
    run: () => {
      const combs = sketchCurvatureCombs([circle("small", [0, 0], 5), circle("large", [50, 0], 20), line("l", [0, 30], [10, 30])], 8);
      assert(combs.length === 2, "lines are skipped");
      const longest = (entityId: string): number => Math.max(...combs.find((item) => item.entityId === entityId)!.comb.teeth.map((tooth) => Math.hypot(tooth.tip[0] - tooth.base[0], tooth.tip[1] - tooth.base[1])));
      near(longest("entity:small"), 8, 0.05, "tightest curve hits the target length");
      near(longest("entity:large"), 2, 0.05, "a 4x larger radius gets a 4x shorter tooth");
    }
  },
  {
    name: "Zebra: a flat mirror gives one band everywhere while a sphere shows both bands, and the reflection is mirror-correct",
    run: () => {
      const toCamera: [number, number, number] = [0, 0, 1];
      const flat = new Set<number>();
      for (let i = 0; i < 10; i += 1) flat.add(zebraBandAt(toCamera, [0, 0, 1], ZEBRA_DEFAULT));
      assert(flat.size === 1, "a flat face has no stripes");
      const sphere = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        const angle = (i / 40) * Math.PI - Math.PI / 2;
        sphere.add(zebraBandAt(toCamera, [0, Math.sin(angle) * 0.9, Math.cos(angle)], ZEBRA_DEFAULT));
      }
      assert(sphere.size === 2, "a curved face shows both bands");
      const bounced = zebraReflection([0, 0, 1], [0, 1, 0]);
      near(bounced[2], -1, 1e-9, "a view straight onto a sideways face reflects back");
      assert(ZEBRA_UNIFORMS_SOURCE.includes("uZebraAxis") && ZEBRA_FRAGMENT_SOURCE.includes("viewMatrix") && ZEBRA_FRAGMENT_SOURCE.includes("gl_FragColor"), "shader source is present");
    }
  },
  {
    name: "sheetFrameOf finds the top face, the thickness and four outward-facing edges of a plate",
    run: () => {
      const frame = sheetFrameOf(plate(40, 30, 2), [0, 0, 1]);
      assert(frame !== undefined, "frame");
      if (frame === undefined) return;
      near(frame.thicknessMm, 2, 1e-9, "thickness");
      near(frame.topMm, 2, 1e-9, "top");
      assert(frame.edges.length === 4, `four edges, got ${frame.edges.length}`);
      for (const edge of frame.edges) {
        const mid = [(edge.startMm[0] + edge.endMm[0]) / 2, (edge.startMm[1] + edge.endMm[1]) / 2];
        const away = (mid[0]! - 20) * edge.outward[0] + (mid[1]! - 15) * edge.outward[1];
        assert(away > 0, "outward points away from the plate centre");
        near(Math.hypot(...edge.outward), 1, 1e-9, "unit outward");
      }
      assert(sheetFrameOf({ positionsMm: [], indices: [] }, [0, 0, 1]) === undefined, "empty mesh has no frame");
    }
  },
  {
    name: "An edge flange keeps the plate a closed, outward solid whose volume is plate plus flange",
    run: () => {
      const base = plate(40, 30, 2);
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      for (const edge of frame.edges) {
        const result = attachEdgeFlange(base, base, [0, 0, 1], { edgeIndex: edge.index, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90 });
        assert(result.ok, `edge ${edge.index} accepted`);
        if (!result.ok) return;
        assert(isClosedAndOriented(result.indices), `edge ${edge.index} gives a closed, consistently wound mesh`);
        const metrics = solidMetrics(result.positionsMm, result.indices);
        assert(metrics.outward, "winding points outward");
        const expected = 40 * 30 * 2 + (15 * 2 + quarterBendArea(2, 2)) * edge.lengthMm;
        near(metrics.volumeMm3, expected, expected * 0.02, `edge ${edge.index} volume`);
        const flangeTop = Math.max(...result.positionsMm.filter((_, index) => index % 3 === 2));
        assert(flangeTop > 15, "the flange rises above the plate");
      }
    }
  },
  {
    name: "Flanges on two different edges stack, and a second flange on the same edge is refused",
    run: () => {
      const base = plate(40, 30, 2);
      const first = attachEdgeFlange(base, base, [0, 0, 1], { edgeIndex: 0, innerRadiusMm: 1, flangeLengthMm: 10, angleDeg: 90 });
      assert(first.ok, "first");
      if (!first.ok) return;
      const second = attachEdgeFlange(first, base, [0, 0, 1], { edgeIndex: 2, innerRadiusMm: 1, flangeLengthMm: 10, angleDeg: 90 });
      assert(second.ok, "second");
      if (!second.ok) return;
      assert(isClosedAndOriented(second.indices), "still closed after two flanges");
      const again = attachEdgeFlange(first, base, [0, 0, 1], { edgeIndex: 0, innerRadiusMm: 1, flangeLengthMm: 10, angleDeg: 90 });
      assert(!again.ok, "the same edge twice is refused");
    }
  },
  {
    name: "A flange also works on a plate sketched on the XZ plane (normal -Y), a 180° hem, and refuses bad edges and angles",
    run: () => {
      const mesh = tessellateExtrude([[0, 0], [40, 0], [40, 30], [0, 30]], 2, "xz");
      const base = { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
      const hem = attachEdgeFlange(base, base, [0, -1, 0], { edgeIndex: 1, innerRadiusMm: 0.05, flangeLengthMm: 8, angleDeg: 180 });
      assert(hem.ok, "hem on an XZ plate");
      if (hem.ok) {
        assert(isClosedAndOriented(hem.indices), "closed");
        assert(solidMetrics(hem.positionsMm, hem.indices).outward, "outward");
      }
      assert(!attachEdgeFlange(base, base, [0, -1, 0], { edgeIndex: 9, innerRadiusMm: 1, flangeLengthMm: 8, angleDeg: 90 }).ok, "edge 9 does not exist");
      assert(!attachEdgeFlange(base, base, [0, -1, 0], { edgeIndex: 0, innerRadiusMm: 1, flangeLengthMm: 8, angleDeg: 200 }).ok, "angle over 180 refused");
    }
  },
  {
    name: "validSolidFeaturePayload accepts a sheet-edge-flange step and rejects one missing its edge or direct-edit operation",
    run: () => {
      const good = { id: "feature:sef", name: "Edge flange", kind: "sheet-edge-flange", suppressed: false, sketchFeatureId: "feature:s", profileIds: [], valueMm: 15, bodyId: "general-body:b", operation: "direct-edit", flangeEdgeIndex: 2, sheetBendRadiusMm: 2, flangeLengthMm: 15, flangeAngleDeg: 90 };
      assert(validSolidFeaturePayload(good), "valid step accepted");
      const { flangeEdgeIndex: _edge, ...withoutEdge } = good;
      void _edge;
      assert(!validSolidFeaturePayload(withoutEdge), "edge index required");
      assert(!validSolidFeaturePayload({ ...good, operation: "join" }), "must be a direct edit");
      assert(!validSolidFeaturePayload({ ...good, flangeEdgeIndex: 1.5 }), "edge index must be a whole number");
      assert(!validSolidFeaturePayload({ ...good, kind: "extrude", operation: "new-body" }), "edge index only on an edge flange");
    }
  }
];
