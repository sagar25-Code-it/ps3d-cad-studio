import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignHistory, DesignSolidFeature, GeneralSolidBody, SketchEntity, Vec3, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { evaluateConstructionPlaneDefinition, frameThroughPoints } from "../packages/workbench-geometry/src/index.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { binderTargetFromPick, edgeRefFromPick, emptyEdgeForm, parseTypedPoint, planeDefinitionOfForm, sketchPathOptions, sketchPointToWorld } from "../apps/studio-web/src/construction-ui.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { ConstructionPlaneDialog } from "../apps/studio-web/src/ui/ConstructionPlaneDialog.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
let serial = 0;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-ui-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function box(widthMm: number, depthMm: number, heightMm: number): GeneralSolidBody {
  const mesh = tessellateExtrude([[0, 0], [widthMm, 0], [widthMm, depthMm], [0, depthMm]], heightMm, "xy");
  return { id: "general-body:block", name: "Block", visible: true, color: "#b9c2c8", positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

function emptySketch(base: WorkbenchSketch, extra: Partial<WorkbenchSketch>, entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...base, ...extra, entities, constraints: [] };
}

const square = (size: number): SketchEntity[] => ([[[0, 0], [size, 0]], [[size, 0], [size, size]], [[size, size], [0, size]], [[0, size], [0, 0]]] as const)
  .map(([start, end], index): SketchEntity => ({ id: `entity:side-${index}`, kind: "line", start, end, construction: false }));

const noopPick = async (): Promise<{ readonly ok: false; readonly message: string }> => ({ ok: false, message: "n/a" });

export const constructionUiTests: readonly TestCase[] = [
  {
    name: "A sketch point maps to the world exactly as the solid builder places it, on XY, XZ and YZ, with an offset, a tilt and a three-point frame",
    run: async () => {
      const base = createWorkbenchProject("project:ui-map").sketch;
      const frame = frameThroughPoints([[5, 5, 5], [5, 15, 5], [5, 5, 15]]);
      assert(!("error" in frame), "frame");
      if ("error" in frame) return;
      const cases: readonly Partial<WorkbenchSketch>[] = [
        { plane: "datum:xy" }, { plane: "datum:xy", planeOffsetMm: 7 }, { plane: "datum:xz", planeOffsetMm: 7 }, { plane: "datum:yz", planeOffsetMm: -4 },
        { plane: "datum:xy", planeFrame: frame }, { plane: "datum:xz", planeTilt: { axis: "x", angleDeg: 30 } }
      ];
      for (const extra of cases) {
        const sketch = emptySketch(base, extra, square(10));
        let project = run(createWorkbenchProject("project:ui-map"), { kind: "new-design-sketch", plane: sketch.plane, ...(sketch.planeOffsetMm === undefined ? {} : { offsetMm: sketch.planeOffsetMm }), ...(sketch.planeTilt === undefined ? {} : { tilt: sketch.planeTilt }), ...(sketch.planeFrame === undefined ? {} : { frame: sketch.planeFrame }) });
        for (const entity of sketch.entities) project = run(project, { kind: "add-sketch-entity", entity });
        project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-m", name: "Sketch" });
        const committed = designOf(project).features.find((feature) => feature.id === "feature:sketch-m");
        assert(committed?.kind === "sketch", "committed");
        if (committed?.kind !== "sketch") return;
        const feature: DesignSolidFeature = { id: "feature:extrude-m", name: "Extrude", kind: "extrude", suppressed: false, sketchFeatureId: committed.id, profileIds: [], valueMm: 3, bodyId: "general-body:m" };
        const built = await rebuildSolidFeature(feature, committed);
        assert(built.ok, `solid builds for ${JSON.stringify(extra)}`);
        if (!built.ok) return;
        const vertices: Vec3[] = [];
        for (let i = 0; i < built.body.positionsMm.length; i += 3) vertices.push([built.body.positionsMm[i]!, built.body.positionsMm[i + 1]!, built.body.positionsMm[i + 2]!]);
        for (const corner of [[0, 0], [10, 0], [10, 10], [0, 10]] as const) {
          const world = sketchPointToWorld(committed.sketch, corner);
          const nearest = Math.min(...vertices.map((vertex) => Math.hypot(vertex[0] - world[0], vertex[1] - world[1], vertex[2] - world[2])));
          near(nearest, 0, 1e-6, `sketch corner ${corner.join(",")} on ${JSON.stringify(extra)} is a vertex of the solid built from that sketch`);
        }
      }
    }
  },
  {
    name: "Sketch lines, arcs, splines and circles become world-space paths, including sketches already in the timeline, and a plane along one sits on it",
    run: () => {
      const base = createWorkbenchProject("project:ui-paths").sketch;
      const working = emptySketch(base, { plane: "datum:xy" }, [
        { id: "entity:line", kind: "line", start: [0, 0], end: [30, 0], construction: false },
        { id: "entity:arc", kind: "arc", start: [30, 0], mid: [30 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2], end: [40, 10], construction: false },
        { id: "entity:circle", kind: "circle", center: [0, 0], radiusMm: 12, construction: false },
        { id: "entity:point", kind: "point", point: [1, 1], construction: false }
      ]);
      const history: DesignHistory = { ...designOf(createWorkbenchProject("project:ui-paths")), features: [{ id: "feature:sketch-old", name: "Old sketch", kind: "sketch", suppressed: false, sketch: emptySketch(base, { plane: "datum:yz", planeOffsetMm: 5 }, [{ id: "entity:l2", kind: "line", start: [0, 0], end: [0, 20], construction: false }]) }] };
      const options = sketchPathOptions(working, history);
      equal(options.length, 4, "an old line, plus the working line, arc and circle (a point is not a path)");
      const old = options.find((option) => option.path.sketchFeatureId === "feature:sketch-old")!;
      equal(old.path.pointsMm[0]!.join(","), "5,0,0", "a YZ sketch offset 5 puts its origin at x = 5");
      equal(old.path.pointsMm[1]!.join(","), "5,20,0", "and its y runs along world Y");
      const circle = options.find((option) => option.label.includes("Circle"))!;
      near(Math.hypot(circle.path.pointsMm[10]![0], circle.path.pointsMm[10]![1]), 12, 1e-9, "circle samples lie on the circle");
      const frame = evaluateConstructionPlaneDefinition({ kind: "along-path", path: circle.path, t: 0.25, orientation: "perpendicular" });
      assert(!("error" in frame), "a plane along a sketch circle evaluates");
      if (!("error" in frame)) {
        near(frame.origin[0], 0, 0.1, "a quarter of the way round, x is 0");
        near(frame.origin[1], 12, 0.1, "and y is the radius");
        near(Math.abs(frame.normal[0]), 1, 0.01, "the plane faces along the tangent (X) there");
      }
    }
  },
  {
    name: "Picking: a click near a straight edge records that edge whole; a round rim is refused; binder targets come from the same clicks",
    run: () => {
      const body = box(40, 30, 10);
      const picked = edgeRefFromPick(body, [18, 0.3, 9.8]);
      assert(picked.ok, `a straight edge is picked: ${picked.message}`);
      if (picked.ok) {
        const [lo, hi] = picked.value.a[0] < picked.value.b[0] ? [picked.value.a, picked.value.b] : [picked.value.b, picked.value.a];
        equal(`${lo.join(",")}|${hi.join(",")}`, "0,0,10|40,0,10", "it is the whole top front edge");
      }
      const rim = tessellateExtrude(Array.from({ length: 48 }, (_, index): [number, number] => [20 * Math.cos(index / 48 * Math.PI * 2), 20 * Math.sin(index / 48 * Math.PI * 2)]), 10, "xy");
      const cylinder: GeneralSolidBody = { ...body, positionsMm: Array.from(rim.positionsMm), indices: Array.from(rim.indices) };
      const round = edgeRefFromPick(cylinder, [20, 0, 10]);
      assert(!round.ok && round.message.includes("curved"), "a round rim is refused as curved");
      const face = binderTargetFromPick(body, "face", [20, 15, 10]);
      assert(face.ok && face.value.kind === "face" && face.value.normal[2] > 0.99 && Math.abs(face.value.areaMm2 - 1200) < 1e-6, "a click on top records the top face");
      const edge = binderTargetFromPick(body, "edge", [18, 0.3, 9.8]);
      assert(edge.ok && edge.value.kind === "edge", "a click near an edge records an edge");
      assert(binderTargetFromPick(body, "body", undefined).ok, "a shape binder needs no click");
      assert(!binderTargetFromPick(body, "face", undefined).ok, "a face binder does");
    }
  },
  {
    name: "The plane dialog's fields turn into plane definitions only when complete and in range, and the dialog renders its live verdict",
    run: () => {
      const axes = [
        { id: "construction-axis:a", name: "Axis A", visible: true, definition: { kind: "two-points", a: [0, 0, 0], b: [40, 0, 0] } },
        { id: "construction-axis:b", name: "Axis B", visible: true, definition: { kind: "two-points", a: [0, 0, 9], b: [40, 0, 9] } }
      ] as const;
      const edgeA = { ...emptyEdgeForm(axes, [], []), axisId: "construction-axis:a" };
      const edgeB = { ...emptyEdgeForm(axes, [], []), axisId: "construction-axis:b" };
      const definition = planeDefinitionOfForm({ mode: "through-two-edges", edgeA, edgeB });
      equal(definition?.kind, "through-two-edges", "two axes make a definition");
      assert(planeDefinitionOfForm({ mode: "through-two-edges", edgeA: { ...edgeA, source: "points", from: "0,0,0", to: "" }, edgeB }) === undefined, "an unfinished typed edge makes none");
      const typed = planeDefinitionOfForm({ mode: "through-two-edges", edgeA: { ...edgeA, source: "points", from: "0, 0, 0", to: "10 0 0" }, edgeB });
      assert(typed?.kind === "through-two-edges" && typed.edgeA.kind === "segment" && typed.edgeA.b[0] === 10, "typed points parse with commas or spaces");
      const path = { kind: "polyline", pointsMm: [[0, 0, 0], [10, 0, 0]] } as const;
      assert(planeDefinitionOfForm({ mode: "along-path", path, percentText: "101", orientation: "tangent" }) === undefined, "above 100 % makes none");
      assert(planeDefinitionOfForm({ mode: "along-path", path, percentText: "abc", orientation: "tangent" }) === undefined, "a non-number makes none");
      assert(planeDefinitionOfForm({ mode: "along-path", path: undefined, percentText: "50", orientation: "tangent" }) === undefined, "no path makes none");
      const along = planeDefinitionOfForm({ mode: "along-path", path, percentText: "25", orientation: "perpendicular" });
      assert(along?.kind === "along-path" && along.t === 0.25, "25 % is t = 0.25");
      equal(parseTypedPoint("1;2;3")?.join(","), "1,2,3", "semicolons separate too");
      assert(parseTypedPoint("1,2") === undefined && parseTypedPoint("1,2,x") === undefined, "bad points are refused");

      const markup = (mode: "through-two-edges" | "along-path"): string => renderToStaticMarkup(createElement(ConstructionPlaneDialog, {
        open: true, mode, axes, bodies: [], binders: [], paths: [{ id: "p", label: "Sketch 1 · Line 1", path }], picking: false,
        onPickEdge: noopPick, onConfirm: () => undefined, onClose: () => undefined
      }));
      const edges = markup("through-two-edges");
      assert(edges.includes("Plane through two edges") && edges.includes("Axis A") && edges.includes("Axis B"), "the two-edge dialog offers the axes");
      // Both blocks start on the first axis, which is one line: the dialog must say so, and must not allow Create.
      assert(edges.includes("one line"), "the live verdict explains why the default choice is not a plane");
      assert(/<button class="primary" disabled="">/.test(edges), "Create plane is disabled for an unusable choice");
      const along2 = markup("along-path");
      assert(along2.includes("Sketch 1 · Line 1") && along2.includes("Perpendicular to the path"), "the path dialog lists the sketch curve and orientations");
      assert(along2.includes("Perpendicular to path at 50%"), "and previews the plane it would make at 50 %");
      assert(/<button class="primary">/.test(along2), "Create plane is available for a usable choice");
      const closed = renderToStaticMarkup(createElement(ConstructionPlaneDialog, { open: false, mode: "along-path", axes: [], bodies: [], binders: [], paths: [], picking: false, onPickEdge: noopPick, onConfirm: () => undefined, onClose: () => undefined }));
      equal(closed, "", "a closed dialog renders nothing");
    }
  }
];
