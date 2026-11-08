import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { flatLayoutDxf, flatLayoutSvg, flatPatternOfPlate, layoutOfFlatPattern, planeCoordinates } from "../packages/workbench-geometry/src/flat-pattern.js";
import { sheetBendAllowanceMm, flatPatternOf } from "../packages/workbench-geometry/src/sheet-metal.js";
import { sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { tessellateDome, tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { selectionBounds, stretchEntities, type SketchEditContext } from "../packages/workbench-sketch/src/edit-tools.js";
import { applyParameterValues, parameterFieldsOf, parameterValuesOf, refreshedName } from "../apps/studio-web/src/feature-parameters.js";
import { flatPatternForBody, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-dpsf-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function withSketch(): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  const project = run(createWorkbenchProject("project:test-dpsf"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  return { project, sketch: designOf(project).features[0] as DesignSketchFeature };
}

const step = (sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra });

function closedAndOriented(indices: readonly number[]): boolean {
  const directed = new Map<string, number>();
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    for (let side = 0; side < 3; side += 1) {
      const key = `${indices[corner + side]}>${indices[corner + (side + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) { const [a, b] = key.split(">"); if (count !== 1 || directed.get(`${b}>${a}`) !== 1) return false; }
  return true;
}

const circlePolygon = (radius: number, count = 72): [number, number][] => Array.from({ length: count }, (_, i) => [radius * Math.cos((i / count) * Math.PI * 2), radius * Math.sin((i / count) * Math.PI * 2)]);
const area = (points: readonly (readonly [number, number])[]): number => Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]!; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const plate = (w: number, h: number, t: number, plane: "xy" | "xz" | "yz" = "xy"): { positionsMm: number[]; indices: number[] } => {
  const mesh = tessellateExtrude([[0, 0], [w, 0], [w, h], [0, h]], t, plane);
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
};

let editSerial = 0;
const newId = (prefix: "entity" | "constraint"): string => `${prefix}:dpsf-${(editSerial += 1)}`;
function editContext(entities: readonly SketchEntity[]): { readonly project: WorkbenchProject; readonly context: SketchEditContext } {
  const base = createWorkbenchProject("project:test-stretch");
  const project = { ...base, sketch: { ...base.sketch, entities, constraints: [] } };
  return { project, context: { sketch: project.sketch, newId } };
}
const line = (id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });
const rect = (id: string, center: readonly [number, number], widthMm: number, heightMm: number, rotationDeg = 0): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center, widthMm, heightMm, rotationDeg, construction: false });

const SAMPLES: readonly DesignSolidFeature[] = (() => {
  const sketch = { id: "feature:sketch-1" } as DesignSketchFeature;
  return [
    step(sketch, "sweep", "sweep", { sweepDirectionMm: [0.2, 0, 1], sweepTwistDeg: 15 }),
    step(sketch, "loft", "loft", { loftTopScale: 0.7 }),
    step(sketch, "edge-fillet", "fillet", { edge: { kind: "fillet", sizeMm: 1 } }),
    step(sketch, "edge-chamfer", "chamfer", { edge: { kind: "chamfer", sizeMm: 1 } }),
    step(sketch, "shell", "shell", { shellThicknessMm: 2, shellOpenFace: "top" }),
    step(sketch, "draft", "draft", { draftAngleDeg: 5, draftNeutralFace: "bottom" }),
    step(sketch, "helix", "helix", { helixRadiusMm: 20, helixPitchMm: 5, helixTurns: 3, helixHandedness: "right" }),
    step(sketch, "thread", "thread", { threadPitchMm: 2, threadTurns: 4, threadDepthMm: 10, threadHandedness: "right" }),
    step(sketch, "rib", "rib", { ribThicknessMm: 2 }),
    step(sketch, "dome", "dome", { domeHeightMm: 8 }),
    step(sketch, "sheet-base", "sheet", { sheetThicknessMm: 2, valueMm: 2 }),
    step(sketch, "sheet-flange", "flange", { sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 10, flangeAngleDeg: 90 }),
    step(sketch, "sheet-hem", "hem", { sheetThicknessMm: 2, sheetBendRadiusMm: 1, flangeLengthMm: 8, hemStyle: "closed" }),
    step(sketch, "sheet-edge-flange", "edgeflange", { operation: "direct-edit", flangeEdgeIndex: 1, sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90 }),
    step(sketch, "move-body", "move", { operation: "direct-edit", moveDeltaMm: [5, 0, 0] }),
    step(sketch, "scale-body", "scale", { operation: "direct-edit", scaleFactor: 1.5 }),
    step(sketch, "move-face", "moveface", { operation: "direct-edit", targetFaceRole: "face.top", moveFaceDeltaMm: [0, 0, 2] }),
    step(sketch, "offset-face", "offsetface", { operation: "direct-edit", targetFaceRole: "face.top", offsetFaceMm: 1 }),
    step(sketch, "emboss", "emboss", { operation: "direct-edit", targetFaceRole: "face.top", embossHeightMm: 1 })
  ];
})();

export const domeParamsStretchFlatTests: readonly TestCase[] = [
  {
    name: "a circular dome is a true half-ellipsoid: volume 2/3 pi r^3, closed, outward, and the apex sits at the height",
    run: () => {
      const mesh = tessellateDome(circlePolygon(10), 10, "xy");
      assert(closedAndOriented(mesh.indices), "closed and consistently wound");
      const metrics = solidMetrics(mesh.positionsMm, mesh.indices);
      assert(metrics.outward, "outward");
      near(metrics.volumeMm3, (2 / 3) * Math.PI * 1000, (2 / 3) * Math.PI * 1000 * 0.05, "volume of a hemisphere");
      near(metrics.boundsMm.max[2], 10, 1e-9, "apex at the dome height");
      near(metrics.boundsMm.min[2], 0, 1e-9, "flat base on the plane");
    }
  },
  {
    name: "a negative dome height builds below the plane and a clockwise profile still gives an outward solid",
    run: () => {
      const below = tessellateDome(circlePolygon(10), -6, "xy");
      const belowMetrics = solidMetrics(below.positionsMm, below.indices);
      near(belowMetrics.boundsMm.min[2], -6, 1e-9, "apex below the plane");
      assert(belowMetrics.outward && closedAndOriented(below.indices), "outward and closed");
      const clockwise = tessellateDome([...circlePolygon(10)].reverse(), 5, "xy");
      assert(solidMetrics(clockwise.positionsMm, clockwise.indices).outward, "clockwise profile corrected");
      assert(tessellateDome(circlePolygon(10), 0, "xy").positionsMm.length === 0, "zero height refused");
      const squareDome = tessellateDome([[0, 0], [20, 0], [20, 20], [0, 20]], 8, "xz");
      assert(closedAndOriented(squareDome.indices), "a rectangular profile domes too");
    }
  },
  {
    name: "every editable step kind lists its parameters; extrude, revolve and indent use no table",
    run: () => {
      for (const sample of SAMPLES) {
        const fields = parameterFieldsOf(sample);
        assert(fields !== undefined && fields.length > 0, `${sample.kind} has fields`);
        const unchanged = applyParameterValues(sample, parameterValuesOf(sample));
        assert(unchanged.ok, `${sample.kind} accepts its own values: ${unchanged.ok ? "" : unchanged.message}`);
      }
      const sketch = { id: "feature:sketch-1" } as DesignSketchFeature;
      assert(parameterFieldsOf(step(sketch, "extrude", "x")) === undefined && parameterFieldsOf(step(sketch, "revolve", "y")) === undefined, "extrude and revolve keep their own dialog");
      assert(parameterFieldsOf(step(sketch, "indent", "z", { indentToolBodyId: "general-body:t" })) === undefined, "an indent has no numbers");
    }
  },
  {
    name: "editing a parameter changes that value, and bad input is refused with a message naming the field",
    run: () => {
      const helix = SAMPLES.find((sample) => sample.kind === "helix")!;
      const edited = applyParameterValues(helix, { ...parameterValuesOf(helix), turns: "5.5", hand: "left" });
      assert(edited.ok && edited.feature.helixTurns === 5.5 && edited.feature.helixHandedness === "left", "turns and handedness change");
      const move = SAMPLES.find((sample) => sample.kind === "move-body")!;
      const moved = applyParameterValues(move, { delta: "1, 2, 3" });
      assert(moved.ok && moved.feature.moveDeltaMm?.join() === "1,2,3" && Math.abs((moved.feature.valueMm) - Math.hypot(1, 2, 3)) < 1e-9, "a vector parses and valueMm follows");
      const bad = [
        applyParameterValues(helix, { ...parameterValuesOf(helix), radius: "-3" }),
        applyParameterValues(helix, { ...parameterValuesOf(helix), pitch: "abc" }),
        applyParameterValues(helix, { ...parameterValuesOf(helix), turns: "" }),
        applyParameterValues(move, { delta: "1, 2" }),
        applyParameterValues(move, { delta: "0, 0, 0" }),
        applyParameterValues(SAMPLES.find((sample) => sample.kind === "sheet-edge-flange")!, { edge: "1.5", radius: "2", length: "12", angle: "90", relief: "0" }),
        applyParameterValues(SAMPLES.find((sample) => sample.kind === "sheet-flange")!, { ...parameterValuesOf(SAMPLES.find((sample) => sample.kind === "sheet-flange")!), angle: "200" }),
        applyParameterValues(SAMPLES.find((sample) => sample.kind === "dome")!, { height: "0" })
      ];
      for (const result of bad) assert(!result.ok && result.message.length > 0, `refused: ${result.ok ? "accepted" : result.message}`);
      assert(!bad[0]!.ok && (bad[0] as { fieldId?: string }).fieldId === "radius", "the refusal names the field");
    }
  },
  {
    name: "editing creation steps updates the real body through update-design-solid (helix turns, thread depth, dome height, sheet flange length)",
    run: async () => {
      const { project, sketch } = withSketch();
      const cases: { readonly sample: DesignSolidFeature; readonly values: Record<string, string>; readonly grows: boolean }[] = [
        { sample: step(sketch, "helix", "helix", { helixRadiusMm: 20, helixPitchMm: 5, helixTurns: 3, helixHandedness: "right" }), values: { turns: "6" }, grows: true },
        { sample: step(sketch, "thread", "thread", { threadPitchMm: 2, threadTurns: 4, threadDepthMm: 10, threadHandedness: "right" }), values: { turns: "8" }, grows: true },
        { sample: step(sketch, "dome", "dome", { domeHeightMm: 8 }), values: { height: "-8" }, grows: false },
        { sample: step(sketch, "sheet-flange", "flange", { sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 10, flangeAngleDeg: 90 }), values: { length: "25" }, grows: false }
      ];
      for (const entry of cases) {
        const built = await rebuildSolidFeature(entry.sample, sketch);
        assert(built.ok, `${entry.sample.kind} builds`);
        if (!built.ok) continue;
        let current = run(project, { kind: "add-design-solid", feature: entry.sample, body: built.body });
        const edited = applyParameterValues(entry.sample, { ...parameterValuesOf(entry.sample), ...entry.values });
        assert(edited.ok, `${entry.sample.kind} edit applies`);
        if (!edited.ok) continue;
        const rebuilt = await rebuildSolidFeature(edited.feature, sketch);
        assert(rebuilt.ok, `${entry.sample.kind} rebuilds after the edit`);
        if (!rebuilt.ok) continue;
        current = run(current, { kind: "update-design-solid", feature: edited.feature, body: rebuilt.body });
        assert(validateWorkbenchProject(current).ok, "the edited project validates");
        const before = solidMetrics(built.body.positionsMm, built.body.indices);
        const after = solidMetrics(rebuilt.body.positionsMm, rebuilt.body.indices);
        assert(entry.grows ? rebuilt.body.positionsMm.length > built.body.positionsMm.length : Math.abs(after.volumeMm3 - before.volumeMm3) > 1e-6 || after.boundsMm.min[2] !== before.boundsMm.min[2], `${entry.sample.kind} geometry changed`);
      }
    }
  },
  {
    name: "editing a step brings the numbers in its generated name up to date and leaves a name the user wrote alone",
    run: () => {
      const sketch = { id: "feature:sketch-1" } as DesignSketchFeature;
      const flange = step(sketch, "sheet-edge-flange", "ef", { name: "Edge flange 0 (90°, 15 mm)", operation: "direct-edit", flangeEdgeIndex: 0, sheetBendRadiusMm: 2, flangeLengthMm: 15, flangeAngleDeg: 90 });
      const edited = applyParameterValues(flange, { edge: "3", radius: "2", length: "25", angle: "120", relief: "0" });
      assert(edited.ok && edited.feature.name === "Edge flange 3 (120°, 25 mm)", `flange name: ${edited.ok ? edited.feature.name : edited.message}`);
      const renamed = applyParameterValues({ ...flange, name: "Left lip" }, { edge: "1", radius: "2", length: "20", angle: "90", relief: "0" });
      assert(renamed.ok && renamed.feature.name === "Left lip", "a user's name is kept");
      const move = step(sketch, "move-body", "mv", { name: "Move Sheet base 2 (10.0, 0.0, 0.0 mm)", operation: "direct-edit", moveDeltaMm: [10, 0, 0] });
      assert(refreshedName({ ...move, moveDeltaMm: [1, 2, 3] }) === "Move Sheet base 2 (1.0, 2.0, 3.0 mm)", "move name");
      const scale = step(sketch, "scale-body", "sc", { name: "Scale Sheet base 2 ×1.200", operation: "direct-edit", scaleFactor: 1.2 });
      assert(refreshedName({ ...scale, scaleFactor: 2 }) === "Scale Sheet base 2 ×2.000", "scale name");
      const offset = step(sketch, "offset-face", "of", { name: "Offset face face.top 2.00 mm", operation: "direct-edit", targetFaceRole: "face.top", offsetFaceMm: 2 });
      assert(refreshedName({ ...offset, offsetFaceMm: -1.5 }) === "Offset face face.top -1.50 mm", "offset name");
      const emboss = step(sketch, "emboss", "em", { name: "Emboss face.top 1.00 mm", operation: "direct-edit", targetFaceRole: "face.top", embossHeightMm: 1 });
      assert(refreshedName({ ...emboss, embossHeightMm: 3 }) === "Emboss face.top 3.00 mm", "emboss name");
    }
  },
  {
    name: "Stretch moves only the line end inside the window, and stretches a rectangle by the side that lies inside",
    run: () => {
      const { context } = editContext([line("a", [0, 0], [10, 0]), rect("r", [10, 5], 20, 10)]);
      const stretched = stretchEntities(context, ["entity:a", "entity:r"], { x1: 15, y1: -1, x2: 25, y2: 11 }, 6, 0);
      assert(stretched.ok, "stretch accepted");
      if (!stretched.ok) return;
      assert(stretched.value.updateEntities.length === 1, "the line has no end in the window, so only the rectangle changes");
      const widened = stretched.value.updateEntities[0]!;
      assert(widened.kind === "rectangle" && Math.abs(widened.widthMm - 26) < 1e-9 && Math.abs(widened.center[0] - 13) < 1e-9 && widened.heightMm === 10, "the right side moved 6 mm, widening it");
      const lengthened = stretchEntities(context, ["entity:a"], { x1: 8, y1: -1, x2: 12, y2: 1 }, 5, 0);
      assert(lengthened.ok && lengthened.value.updateEntities[0]!.kind === "line" && (lengthened.value.updateEntities[0] as { end: readonly number[] }).end[0] === 15 && (lengthened.value.updateEntities[0] as { start: readonly number[] }).start[0] === 0, "only the end inside moved");
    }
  },
  {
    name: "Stretch moves a rectangle whole when every corner is inside, follows a rotated rectangle's own axes, and ignores a lone corner",
    run: () => {
      const { context } = editContext([rect("r", [10, 5], 20, 10), rect("turned", [50, 50], 20, 10, 90)]);
      const whole = stretchEntities(context, ["entity:r"], { x1: -5, y1: -5, x2: 25, y2: 15 }, 3, 4);
      assert(whole.ok && whole.value.updateEntities[0]!.kind === "rectangle" && (whole.value.updateEntities[0] as { center: readonly number[] }).center[0] === 13 && (whole.value.updateEntities[0] as { widthMm: number }).widthMm === 20, "moved whole");
      // A rectangle turned 90 degrees has its width along world Y: its top world side lies at y = 60.
      const turned = stretchEntities(context, ["entity:turned"], { x1: 30, y1: 58, x2: 70, y2: 62 }, 0, 5);
      assert(turned.ok, "the turned rectangle's side stretches");
      if (turned.ok) {
        const result = turned.value.updateEntities[0] as { widthMm: number; heightMm: number };
        assert(Math.abs(result.widthMm - 25) < 1e-9 && result.heightMm === 10, `its width (along world Y) grows by 5: ${result.widthMm} x ${result.heightMm}`);
      }
      assert(!stretchEntities(context, ["entity:r"], { x1: 19, y1: -1, x2: 21, y2: 1 }, 5, 0).ok, "a lone corner inside changes nothing and is reported");
      assert(!stretchEntities(context, ["entity:r"], { x1: 0, y1: 0, x2: 1, y2: 1 }, 0, 0).ok, "zero distance refused");
      assert(!stretchEntities(context, ["entity:r"], { x1: 0, y1: 0, x2: 0, y2: 5 }, 1, 0).ok, "a flat window refused");
    }
  },
  {
    name: "a stretch goes through apply-sketch-edit and changes the real sketch; selectionBounds frames the selection",
    run: () => {
      const { project, context } = editContext([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])]);
      const bounds = selectionBounds(project.sketch, ["entity:a", "entity:b"]);
      assert(bounds !== undefined && bounds.x1 === 0 && bounds.x2 === 10 && bounds.y2 === 10, "bounds of the selection");
      const stretch = stretchEntities(context, ["entity:a", "entity:b"], { x1: 9, y1: -1, x2: 11, y2: 11 }, 4, 0);
      assert(stretch.ok, "plan");
      if (!stretch.ok) return;
      const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", ...stretch.value, operationId: "operation:test-stretch", expectedRevision: project.revision });
      assert(applied.ok, `applied: ${applied.ok ? "" : applied.diagnostics[0]?.message}`);
      if (!applied.ok) return;
      const [a, b] = applied.value.project.sketch.entities;
      assert(a?.kind === "line" && a.end[0] === 14 && a.start[0] === 0 && b?.kind === "line" && b.start[0] === 14 && b.end[0] === 14, "the shared corner moved with both lines");
    }
  },
  {
    name: "a flat pattern adds each flange as (bend allowance + length) x edge length, with a bend line per flange, on every sketch plane",
    run: () => {
      const allowance = sheetBendAllowanceMm(90, 2, 2);
      for (const plane of ["xy", "xz", "yz"] as const) {
        const normal = plane === "xy" ? [0, 0, 1] as const : plane === "xz" ? [0, -1, 0] as const : [1, 0, 0] as const;
        const frame = sheetFrameOf(plate(40, 30, 2, plane), normal)!;
        const flat = flatPatternOfPlate(frame, plane, []);
        assert(!("error" in flat), `${plane} unfolds`);
        if ("error" in flat) continue;
        near(area(flat.outlinesMm[0]!), 1200, 1e-6, `${plane} plate blank is 40 x 30`);
        const edgeIndexes = frame.edges.map((edge) => edge.index);
        const opposite = [edgeIndexes[0]!, edgeIndexes.find((index) => index !== edgeIndexes[0] && Math.abs(frame.edges[index]!.outward[0] + frame.edges[edgeIndexes[0]!]!.outward[0]) + Math.abs(frame.edges[index]!.outward[1] + frame.edges[edgeIndexes[0]!]!.outward[1]) + Math.abs(frame.edges[index]!.outward[2] + frame.edges[edgeIndexes[0]!]!.outward[2]) < 1e-6)!];
        const flanged = flatPatternOfPlate(frame, plane, opposite.map((edgeIndex) => ({ edgeIndex, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90 })));
        assert(!("error" in flanged), `${plane} flanged unfolds`);
        if ("error" in flanged) continue;
        const expected = 1200 + opposite.reduce((sum, index) => sum + (allowance + 15) * frame.edges[index]!.lengthMm, 0);
        near(area(flanged.outlinesMm[0]!), expected, 1e-6, `${plane} blank area = plate + flanges`);
        assert(flanged.bendCount === 2 && flanged.bendLinesMm.length === 2, "one bend line per flange");
        near(flanged.totalBendAllowanceMm, 2 * allowance, 1e-9, "allowances add");
        assert(flanged.notes.length === 0, "opposite flanges need no corner note");
      }
    }
  },
  {
    name: "flat patterns reject a missing edge or a repeated one, and note flanges on neighbouring edges",
    run: () => {
      const frame = sheetFrameOf(plate(40, 30, 2), [0, 0, 1])!;
      const flange = (edgeIndex: number) => ({ edgeIndex, innerRadiusMm: 2, flangeLengthMm: 10, angleDeg: 90 });
      assert("error" in flatPatternOfPlate(frame, "xy", [flange(9)]), "edge 9 does not exist");
      assert("error" in flatPatternOfPlate(frame, "xy", [flange(0), flange(0)]), "one flange per edge");
      const neighbours = flatPatternOfPlate(frame, "xy", [flange(0), flange(1)]);
      assert(!("error" in neighbours) && neighbours.notes.length === 1, "neighbouring flanges carry a corner-relief note");
    }
  },
  {
    name: "the DXF has an OUTLINE and a BEND layer with a LINE per segment, and the SVG draws both classes at the pattern's size",
    run: () => {
      const frame = sheetFrameOf(plate(40, 30, 2), [0, 0, 1])!;
      const flat = flatPatternOfPlate(frame, "xy", [{ edgeIndex: 0, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90 }]);
      assert(!("error" in flat), "unfolds");
      if ("error" in flat) return;
      const dxf = flatLayoutDxf(flat);
      const lines = dxf.split("\n");
      assert(lines.filter((text) => text === "LINE").length === flat.outlinesMm[0]!.length + flat.bendLinesMm.length, "a LINE per outline segment and bend line");
      assert(lines.includes("OUTLINE") && lines.includes("BEND") && lines[lines.length - 2] === "EOF" && dxf.includes("SECTION") && dxf.includes("ENTITIES"), "layers and structure present");
      const svg = flatLayoutSvg(flat);
      assert(svg.includes("flat-outline") && svg.includes("bend-line") && svg.includes("viewBox"), "svg has outline, bend line and a viewBox");
      const single = flatPatternOf({ legMm: 30, flangeLengthMm: 20, angleDeg: 90, innerRadiusMm: 2, thicknessMm: 2, widthMm: 40 });
      assert(layoutOfFlatPattern(single).outlinesMm.length === 1 && flatLayoutDxf(layoutOfFlatPattern(single)).includes("BEND"), "a single-bend pattern uses the same writers");
      near(planeCoordinates([1, 2, 3], "xz")[1], 3, 0, "xz maps z to v");
    }
  },
  {
    name: "flatPatternForBody unfolds a project's sheet base with two live flanges, drops a suppressed one, and refuses a non-sheet body",
    run: async () => {
      const { project, sketch } = withSketch();
      const base = step(sketch, "sheet-base", "sheet", { sheetThicknessMm: 2, valueMm: 2 });
      const built = await rebuildSolidFeature(base, sketch);
      assert(built.ok, "base builds");
      if (!built.ok) return;
      let current = run(project, { kind: "add-design-solid", feature: base, body: built.body });
      const plain = await flatPatternForBody(current, "general-body:sheet");
      assert(plain.ok && plain.layout.bendLinesMm.length === 0, "a plain plate unfolds with no bends");
      const bodyId = "general-body:sheet";
      for (const [id, edge] of [["fa", 0], ["fb", 2]] as const) {
        const flange = step(sketch, "sheet-edge-flange", id, { bodyId, operation: "direct-edit", flangeEdgeIndex: edge, sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90 });
        const added = run(current, { kind: "add-design-solid", feature: flange, body: current.part.generalBodies!.find((body) => body.id === bodyId)! });
        current = run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
      }
      const flat = await flatPatternForBody(current, bodyId);
      assert(flat.ok, `flat pattern: ${flat.ok ? "" : flat.message}`);
      if (!flat.ok) return;
      assert(flat.layout.bendLinesMm.length === 2 && flat.summary.includes("2 bends"), `two bends (${flat.summary})`);
      const withoutFlanges = plain.ok ? area(plain.layout.outlinesMm[0]!) : 0;
      assert(area(flat.layout.outlinesMm[0]!) > withoutFlanges, "the flanges add blank area");
      const suppressed = run(current, { kind: "set-design-feature-suppressed", featureId: "feature:fb", suppressed: true });
      const one = await flatPatternForBody(suppressed, bodyId);
      assert(one.ok && one.layout.bendLinesMm.length === 1, "a suppressed flange is left out of the pattern");
      const helix = step(sketch, "helix", "coil", { helixRadiusMm: 20, helixPitchMm: 5, helixTurns: 3, helixHandedness: "right" });
      const coil = await rebuildSolidFeature(helix, sketch);
      assert(coil.ok, "helix builds");
      if (!coil.ok) return;
      const withCoil = run(current, { kind: "add-design-solid", feature: helix, body: coil.body });
      const refused = await flatPatternForBody(withCoil, "general-body:coil");
      assert(!refused.ok && refused.message.includes("sheet-metal"), "a helix is not unfoldable");
    }
  },
  {
    name: "flatPatternForBody unfolds a standalone flange and hem to a single-bend blank of leg + bend allowance + flange",
    run: async () => {
      const { project, sketch } = withSketch();
      const flange = step(sketch, "sheet-flange", "flange", { valueMm: 10, sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 20, flangeAngleDeg: 90 });
      const built = await rebuildSolidFeature(flange, sketch);
      assert(built.ok, "flange builds");
      if (!built.ok) return;
      const current = run(project, { kind: "add-design-solid", feature: flange, body: built.body });
      const flat = await flatPatternForBody(current, "general-body:flange");
      assert(flat.ok && flat.layout.bendLinesMm.length === 1, "one bend");
      if (!flat.ok) return;
      const xs = flat.layout.outlinesMm[0]!.map((point) => point[0]);
      const length = Math.max(...xs) - Math.min(...xs);
      assert(length > 20 + sheetBendAllowanceMm(90, 2, 2), `blank is longer than flange plus bend (${length})`);
    }
  }
];
