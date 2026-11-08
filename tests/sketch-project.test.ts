import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchEntity, SketchPlaneFrame, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, CAD_COMMANDS, createWorkbenchProject, designOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { fitPolyline, type FitPrimitive, type Pt } from "../packages/workbench-geometry/src/curve-fit.js";
import { meshHole, nearestPickableEdge, pickableEdges } from "../packages/workbench-geometry/src/mesh-modify.js";
import { frameThroughPoints, placePoint } from "../packages/workbench-geometry/src/sketch-placement.js";
import { chooseFace, planProjection, projectBodyEdges, sketchFrameOf, sketchToWorld, worldToSketch, type ProjectionMode, type SketchFrameSource } from "../packages/workbench-geometry/src/sketch-project.js";
import { replayAllBodies, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { edgesToPick, isSketchProjectCommand, needsPick, pickedEdgeRun, planSketchProject, sourceBodyOf, type SketchProjectCommand } from "../apps/studio-web/src/sketch-project-command.js";
import { assert, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-project-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

type PlaneSpec = Pick<SketchFrameSource, "plane" | "planeOffsetMm" | "planeTilt" | "planeFrame">;
const XY: PlaneSpec = { plane: "datum:xy" };

function startSketch(project: WorkbenchProject, spec: PlaneSpec): WorkbenchProject {
  return run(project, { kind: "new-design-sketch", plane: spec.plane, ...(spec.planeOffsetMm === undefined ? {} : { offsetMm: spec.planeOffsetMm }), ...(spec.planeTilt === undefined ? {} : { tilt: spec.planeTilt }), ...(spec.planeFrame === undefined ? {} : { frame: spec.planeFrame as SketchPlaneFrame }) });
}

const rectangle = (id: string, cx: number, cy: number, w: number, h: number): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center: [cx, cy], widthMm: w, heightMm: h, rotationDeg: 0, construction: false });
const circle = (id: string, cx: number, cy: number, r: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center: [cx, cy], radiusMm: r, construction: false });
const lineOf = (id: string, a: Pt, b: Pt): SketchEntity => ({ id: `entity:${id}`, kind: "line", start: [a[0], a[1]], end: [b[0], b[1]], construction: false });

function addEntities(project: WorkbenchProject, entities: readonly SketchEntity[]): WorkbenchProject {
  return run(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [], label: "Test entities" });
}

/** Finishes the working sketch and extrudes its profile, returning the project with the new body and the body. */
async function extrudeWorking(project: WorkbenchProject, name: string, valueMm: number): Promise<{ readonly project: WorkbenchProject; readonly body: GeneralSolidBody }> {
  const committed = run(project, { kind: "commit-design-sketch", featureId: `feature:sketch-${name}`, name: `Sketch ${name}` });
  const sketch = designOf(committed).features.find((feature) => feature.id === `feature:sketch-${name}`) as DesignSketchFeature;
  const feature: DesignSolidFeature = { id: `feature:${name}`, name, kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm, bodyId: `general-body:${name}` };
  const built = await rebuildSolidFeature(feature, sketch);
  if (!built.ok) throw new Error(`${name} does not build: ${built.message}`);
  const next = run(committed, { kind: "add-design-solid", feature, body: built.body });
  return { project: next, body: next.part.generalBodies!.find((body) => body.id === built.body.id)! };
}

/** A body made by extruding `entities` drawn on the plane `spec`. */
async function makeBody(name: string, spec: PlaneSpec, entities: readonly SketchEntity[], valueMm: number, base?: WorkbenchProject): Promise<{ readonly project: WorkbenchProject; readonly body: GeneralSolidBody }> {
  return extrudeWorking(addEntities(startSketch(base ?? createWorkbenchProject("project:test-sketch-project"), spec), entities), name, valueMm);
}

/** Closed and consistently wound once coincident corners are welded (kernel bodies keep a separate vertex list per face). */
function isClosedAndOriented(body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): boolean {
  const ids = new Map<string, number>();
  const idOf = (index: number): number => {
    const key = [0, 1, 2].map((axis) => Math.round(body.positionsMm[index * 3 + axis]! * 1e4)).join(",");
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    ids.set(key, ids.size);
    return ids.size - 1;
  };
  const directed = new Map<string, number>();
  for (let corner = 0; corner + 2 < body.indices.length; corner += 3) {
    for (let side = 0; side < 3; side += 1) {
      const key = `${idOf(body.indices[corner + side]!)}>${idOf(body.indices[corner + (side + 1) % 3]!)}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split(">");
    if (count !== 1 || directed.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const idMaker = (): (() => string) => { let n = 0; return () => `entity:proj-${(n += 1)}`; };

/** A 40 x 30 x 10 box standing on the XY plane with its corner at the origin. */
async function box(): Promise<{ readonly project: WorkbenchProject; readonly body: GeneralSolidBody }> {
  return makeBody("box", XY, [rectangle("box", 20, 15, 40, 30)], 10);
}

interface Brought {
  readonly project: WorkbenchProject;
  readonly entities: readonly SketchEntity[];
  readonly summary: string;
}

/** Starts a sketch on `spec` and brings `body` into it with the given mode. */
function bring(project: WorkbenchProject, body: GeneralSolidBody, spec: PlaneSpec, mode: ProjectionMode, extra: Partial<Parameters<typeof planProjection>[0]> = {}): Brought {
  const started = startSketch(project, spec);
  const planned = planProjection({ mode, body, sketch: started.sketch, newId: idMaker(), ...extra });
  if (!planned.ok) throw new Error(`${mode} should succeed but said: ${planned.message}`);
  return { project: addEntities(started, planned.plan.entities), entities: planned.plan.entities, summary: planned.plan.summary };
}

function failure(project: WorkbenchProject, body: GeneralSolidBody, spec: PlaneSpec, mode: ProjectionMode, extra: Partial<Parameters<typeof planProjection>[0]> = {}): string {
  const started = startSketch(project, spec);
  const planned = planProjection({ mode, body, sketch: started.sketch, newId: idMaker(), ...extra });
  if (planned.ok) throw new Error(`${mode} should have been refused`);
  return planned.message;
}

const kindsOf = (entities: readonly SketchEntity[]): string => entities.map((entity) => entity.kind).sort().join(",");
const endpointKeys = (entities: readonly SketchEntity[]): Set<string> => {
  const keys = new Set<string>();
  for (const entity of entities) if (entity.kind === "line") { keys.add(entity.start.map((v) => v.toFixed(4)).join(",")); keys.add(entity.end.map((v) => v.toFixed(4)).join(",")); }
  return keys;
};
const keyOf = (p: readonly number[]): string => p.map((v) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4)).join(",");

function polygonArea(points: readonly Pt[]): number {
  let twice = 0;
  points.forEach((p, i) => { const q = points[(i + 1) % points.length]!; twice += p[0] * q[1] - q[0] * p[1]; });
  return Math.abs(twice) / 2;
}

const BOX_VERTICES: readonly (readonly [number, number, number])[] = [0, 40].flatMap((x) => [0, 30].flatMap((y) => [0, 10].map((z) => [x, y, z] as const)));
const SLANTED: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]] = [[20, 10, 5], [30, 10, 10], [20, 20, 5]];
/** A plane whose normal leans along all three axes, so a box casts a hexagonal shadow on it. */
const LEANING: typeof SLANTED = [[5, 5, 5], [15, 7, 8], [6, 17, 3]];
const slantedFrame = (points: typeof SLANTED = SLANTED): SketchPlaneFrame => {
  const frame = frameThroughPoints(points);
  if ("error" in frame) throw new Error(frame.error);
  return frame;
};

/** Every sketch plane the tests run on: datum planes, an offset one, tilted ones and a three-point one. */
const PLANES: readonly { readonly name: string; readonly spec: PlaneSpec }[] = [
  { name: "XY", spec: XY },
  { name: "XZ", spec: { plane: "datum:xz" } },
  { name: "YZ", spec: { plane: "datum:yz" } },
  { name: "YZ offset 7", spec: { plane: "datum:yz", planeOffsetMm: 7 } },
  { name: "XZ offset -3", spec: { plane: "datum:xz", planeOffsetMm: -3 } },
  { name: "XY tilted 30° about X", spec: { plane: "datum:xy", planeOffsetMm: 4, planeTilt: { axis: "x", angleDeg: 30 } } },
  { name: "XZ tilted 20° about Z", spec: { plane: "datum:xz", planeTilt: { axis: "z", angleDeg: 20 } } },
  { name: "three points", spec: { plane: "datum:xy", planeFrame: slantedFrame() } }
];

export const sketchProjectTests: readonly TestCase[] = [
  {
    name: "Curve fitting turns tessellated polylines back into lines, arcs, circles, ellipses and splines, and leaves polygons as polygons",
    run: () => {
      const around = (n: number, f: (angle: number) => Pt): Pt[] => Array.from({ length: n }, (_, i) => f((2 * Math.PI * i) / n));
      const circleCurves = fitPolyline(around(72, (a) => [5 + 10 * Math.cos(a), -3 + 10 * Math.sin(a)]), { closed: true });
      assert(circleCurves.length === 1 && circleCurves[0]!.kind === "circle", `72 points round a centre are one circle: ${circleCurves.map((c) => c.kind)}`);
      const circ = circleCurves[0] as Extract<FitPrimitive, { kind: "circle" }>;
      near(circ.radiusMm, 10, 1e-9, "radius");
      near(circ.center[0], 5, 1e-9, "centre x");
      const turn = (a: number): number => (a * Math.PI) / 180;
      const ellipse = fitPolyline(around(72, (a) => [1 + 10 * Math.cos(a) * Math.cos(turn(30)) - 4 * Math.sin(a) * Math.sin(turn(30)), 2 + 10 * Math.cos(a) * Math.sin(turn(30)) + 4 * Math.sin(a) * Math.cos(turn(30))]), { closed: true });
      assert(ellipse.length === 1 && ellipse[0]!.kind === "ellipse", `points on a tilted ellipse are one ellipse: ${ellipse.map((c) => c.kind)}`);
      const e = ellipse[0] as Extract<FitPrimitive, { kind: "ellipse" }>;
      near(e.majorRadiusMm, 10, 1e-6, "major radius");
      near(e.minorRadiusMm, 4, 1e-6, "minor radius");
      near(e.rotationDeg, 30, 1e-4, "the major axis points 30° from X");
      near(e.center[0], 1, 1e-6, "ellipse centre x");
      const hexagon = fitPolyline(around(6, (a) => [10 * Math.cos(a), 10 * Math.sin(a)]), { closed: true });
      assert(hexagon.length === 6 && hexagon.every((c) => c.kind === "line"), "a hexagon stays six lines, not a circle");
      assert(fitPolyline(around(20, (a) => [10 * Math.cos(a), 10 * Math.sin(a)]), { closed: true })[0]!.kind === "circle", "twenty points on a circle read as a circle");
      // A rounded rectangle 20 x 10 with corner radius 3, started in the middle of the bottom side: four lines and four arcs.
      const rounded: Pt[] = [];
      const corners: readonly (readonly [number, number, number])[] = [[17, 3, -90], [17, 7, 0], [3, 7, 90], [3, 3, 180]];
      rounded.push([10, 0]);
      for (const [cx, cy, start] of corners) for (let k = 0; k <= 18; k += 1) rounded.push([cx + 3 * Math.cos(turn(start + 5 * k)), cy + 3 * Math.sin(turn(start + 5 * k))]);
      const roundedCurves = fitPolyline(rounded, { closed: true });
      const lines = roundedCurves.filter((c) => c.kind === "line").length;
      const arcs = roundedCurves.filter((c) => c.kind === "arc") as Extract<FitPrimitive, { kind: "arc" }>[];
      assert(lines === 4 && arcs.length === 4, `a rounded rectangle is 4 lines and 4 arcs: ${roundedCurves.map((c) => c.kind)}`);
      assert(arcs.every((arc) => Math.abs(Math.hypot(arc.start[0] - arc.end[0], arc.start[1] - arc.end[1]) - 3 * Math.SQRT2) < 1e-6), "each corner arc spans a quarter turn of radius 3");
      const wave = fitPolyline(Array.from({ length: 40 }, (_, i): Pt => [i * 0.5, 3 * Math.sin(i * 0.2)]), { closed: false });
      assert(wave.length === 1 && wave[0]!.kind === "spline", `a smooth wave that is no arc is one spline: ${wave.map((c) => c.kind)}`);
      assert(fitPolyline([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], { closed: false }).length === 1, "collinear points are one line");
      assert(fitPolyline([[0, 0], [10, 0], [10, 10]], { closed: false }).length === 2, "an L is two lines");
      const edgeOn = fitPolyline(around(72, (a) => [10 * Math.cos(a), 0]), { closed: true });
      assert(edgeOn.length === 1 && edgeOn[0]!.kind === "line", "a circle seen edge-on is one line");
    }
  },
  {
    name: "The sketch frame matches where the real solid builder puts a sketch on every plane: datum, offset, tilted and three-point",
    run: async () => {
      for (const { name, spec } of PLANES) {
        const flat = await makeBody("slab", spec, [rectangle("slab", 10, 6, 12, 8)], 5);
        const sketch = flat.project.sketch;
        const frame = sketchFrameOf(sketch);
        near(Math.hypot(...frame.uAxis), 1, 1e-9, `${name}: X is a unit vector`);
        near(frame.uAxis[0] * frame.vAxis[0] + frame.uAxis[1] * frame.vAxis[1] + frame.uAxis[2] * frame.vAxis[2], 0, 1e-9, `${name}: X and Y are perpendicular`);
        const expected = new Set<string>();
        for (const [x, y] of [[4, 2], [16, 2], [16, 10], [4, 10]] as const) for (const h of [0, 5]) expected.add(keyOf(sketchToWorld([x, y], frame, h)));
        const actual = new Set<string>();
        for (let i = 0; i + 2 < flat.body.positionsMm.length; i += 3) actual.add(keyOf([flat.body.positionsMm[i]!, flat.body.positionsMm[i + 1]!, flat.body.positionsMm[i + 2]!]));
        assert(expected.size === 8 && actual.size === 8, `${name}: a slab has eight corners`);
        for (const key of actual) assert(expected.has(key), `${name}: the solid's corner ${key} is where the frame says (${[...expected].join(" | ")})`);
        // Going out and coming back is the identity, and the height is along the normal the solid rose along.
        const there = sketchToWorld([3, -2], frame, 7);
        const back = worldToSketch(there, frame);
        near(back.xy[0], 3, 1e-9, `${name}: round trip x`);
        near(back.xy[1], -2, 1e-9, `${name}: round trip y`);
        near(back.heightMm, 7, 1e-9, `${name}: round trip height`);
      }
    }
  },
  {
    name: "Project puts the edges of a box onto every datum plane as the right lines, and the outline extrudes back to the box",
    run: async () => {
      const { project, body } = await box();
      const xy = bring(project, body, XY, "project");
      assert(kindsOf(xy.entities) === "line,line,line,line", `XY: the top and bottom edges land on each other and the posts are points: ${kindsOf(xy.entities)}`);
      const expectedXy = new Set(["0.0000,0.0000", "40.0000,0.0000", "40.0000,30.0000", "0.0000,30.0000"]);
      assert([...endpointKeys(xy.entities)].every((key) => expectedXy.has(key)) && endpointKeys(xy.entities).size === 4, `XY outline corners: ${[...endpointKeys(xy.entities)].join(" | ")}`);
      assert(xy.summary.includes("snapshot") && xy.summary.includes("do not follow later edits"), "the result says it is a snapshot");
      assert(detectSketchProfiles(xy.project.sketch).length === 1, "the four lines close into one profile");
      const again = await extrudeWorking(xy.project, "copy", 6);
      near(volumeOf(again.body), 40 * 30 * 6, 1e-6, "extruding the projected outline gives 40 x 30 x 6");
      assert(isClosedAndOriented(again.body) && solidMetrics(again.body.positionsMm, again.body.indices).outward, "and it is a closed outward solid");
      const xz = bring(project, body, { plane: "datum:xz" }, "project");
      assert([...endpointKeys(xz.entities)].sort().join("|") === ["0.0000,0.0000", "40.0000,0.0000", "40.0000,10.0000", "0.0000,10.0000"].sort().join("|"), `XZ shows the 40 x 10 front: ${[...endpointKeys(xz.entities)].join(" | ")}`);
      const yz = bring(project, body, { plane: "datum:yz" }, "project");
      assert([...endpointKeys(yz.entities)].sort().join("|") === ["-10.0000,0.0000", "0.0000,0.0000", "0.0000,30.0000", "-10.0000,30.0000"].sort().join("|"), `YZ shows the 30 x 10 side (sketch X runs along -Z): ${[...endpointKeys(yz.entities)].join(" | ")}`);
      const offset = bring(project, body, { plane: "datum:yz", planeOffsetMm: 50 }, "project");
      assert(kindsOf(offset.entities) === "line,line,line,line", "a plane offset away from the body shows the same outline");
    }
  },
  {
    name: "Project on a tilted plane and on a three-point plane lands every box vertex where the inverse placement says",
    run: async () => {
      const { project, body } = await box();
      for (const { name, spec } of PLANES.filter(({ spec: s }) => s.planeTilt !== undefined || s.planeFrame !== undefined)) {
        const brought = bring(project, body, spec, "project");
        const lines = brought.entities.filter((entity) => entity.kind === "line");
        assert(lines.length === brought.entities.length, `${name}: a box projects to straight lines`);
        // Independent expectation: move each vertex back to the datum plane with the placement's own inverse and read off (u, v).
        const datumToSketch = (p: readonly [number, number, number]): string => {
          const d = placePoint(p, spec, true);
          return spec.plane === "datum:xy" ? keyOf([d[0], d[1]]) : spec.plane === "datum:xz" ? keyOf([d[0], d[2]]) : keyOf([-d[2], d[1]]);
        };
        const expected = new Set(BOX_VERTICES.map(datumToSketch));
        for (const key of endpointKeys(brought.entities)) assert(expected.has(key), `${name}: end ${key} is a projected corner (${[...expected].join(" | ")})`);
        assert(endpointKeys(brought.entities).size === expected.size, `${name}: all eight corners show (${endpointKeys(brought.entities).size})`);
        // Every one of the box's twelve edges, projected independently, lies along one of the lines. Edges that overlap on the sketch
        // (two parallel edges seen one behind the other) join into one longer line, so there can be fewer than twelve lines.
        const sketchPoint = (p: readonly [number, number, number]): readonly [number, number] => {
          const d = placePoint(p, spec, true);
          return spec.plane === "datum:xy" ? [d[0], d[1]] : spec.plane === "datum:xz" ? [d[0], d[2]] : [-d[2], d[1]];
        };
        const onSomeLine = (point: readonly [number, number]): boolean => lines.some((entity) => {
          if (entity.kind !== "line") return false;
          const [dx, dy] = [entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]];
          const t = ((point[0] - entity.start[0]) * dx + (point[1] - entity.start[1]) * dy) / (dx * dx + dy * dy);
          return t > -1e-9 && t < 1 + 1e-9 && Math.hypot(entity.start[0] + dx * t - point[0], entity.start[1] + dy * t - point[1]) < 1e-5;
        });
        const edges = BOX_VERTICES.flatMap((a, i) => BOX_VERTICES.slice(i + 1).filter((b) => a.filter((v, axis) => v !== b[axis]).length === 1).map((b) => [a, b] as const));
        assert(edges.length === 12, "a box has twelve edges");
        for (const [a, b] of edges) {
          const [pa, pb] = [sketchPoint(a), sketchPoint(b)];
          assert([pa, pb, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] as const].every(onSomeLine), `${name}: the edge ${a.join(",")} to ${b.join(",")} lies along a projected line`);
        }
        assert(lines.length >= 8 && lines.length <= 12, `${name}: between eight and twelve lines, got ${lines.length}`);
      }
    }
  },
  {
    name: "Silhouette of a box on tilted and three-point planes is the closed outline of its shadow, and extruding it gives shadow area times depth",
    run: async () => {
      const { project, body } = await box();
      // Tilted about X the normal has no X part, so the shadow is a rectangle; the leaning three-point plane makes it a hexagon.
      const cases: readonly { readonly name: string; readonly spec: PlaneSpec; readonly sides: number }[] = [
        { name: "tilted 30° about X", spec: { plane: "datum:xy", planeTilt: { axis: "x", angleDeg: 30 } }, sides: 4 },
        { name: "three points", spec: { plane: "datum:xy", planeFrame: slantedFrame(LEANING) }, sides: 6 }
      ];
      for (const { name, spec, sides } of cases) {
        const brought = bring(project, body, spec, "silhouette");
        assert(brought.entities.length === sides && brought.entities.every((entity) => entity.kind === "line"), `${name}: the shadow has ${sides} straight sides: ${kindsOf(brought.entities)}`);
        const profiles = detectSketchProfiles(brought.project.sketch);
        assert(profiles.length === 1, `${name}: the outline is one closed profile`);
        const normal = sketchFrameOf(brought.project.sketch).normal;
        const shadow = Math.abs(normal[0]) * 30 * 10 + Math.abs(normal[1]) * 40 * 10 + Math.abs(normal[2]) * 40 * 30;
        near(profiles[0]!.areaMm2, shadow, 1e-3, `${name}: the outline has the area of the box's shadow`);
        const solid = await extrudeWorking(brought.project, `shadow-${sides}`, 6);
        near(volumeOf(solid.body), shadow * 6, 1e-3, `${name}: extruded 6 mm along the plane's normal it is shadow area x depth`);
        assert(isClosedAndOriented(solid.body) && solidMetrics(solid.body.positionsMm, solid.body.indices).outward, `${name}: and it is a closed outward solid`);
      }
    }
  },
  {
    name: "Silhouette on a three-point plane returns the very rectangle the body was extruded from, and extruding it again doubles the volume",
    run: async () => {
      const spec: PlaneSpec = { plane: "datum:xy", planeFrame: slantedFrame() };
      const first = await makeBody("slab", spec, [rectangle("slab", 10, 6, 12, 8)], 5);
      const brought = bring(first.project, first.body, spec, "silhouette");
      assert(kindsOf(brought.entities) === "line,line,line,line", `looking along the normal the slab is a rectangle: ${kindsOf(brought.entities)}`);
      assert([...endpointKeys(brought.entities)].sort().join("|") === ["4.0000,2.0000", "16.0000,2.0000", "16.0000,10.0000", "4.0000,10.0000"].sort().join("|"), `the corners are exactly the drawn ones: ${[...endpointKeys(brought.entities)].join(" | ")}`);
      const second = await extrudeWorking(brought.project, "twin", 5);
      near(volumeOf(second.body), 12 * 8 * 5, 1e-6, "the copy has the slab's volume");
      // The copy sits where the slab sits: the same corners in space.
      const a = solidMetrics(first.body.positionsMm, first.body.indices).centroidMm;
      const b = solidMetrics(second.body.positionsMm, second.body.indices).centroidMm;
      near(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), 0, 1e-6, "and in the same place");
    }
  },
  {
    name: "Project recognises a hole as a circle and a rounded plate's rim as arcs, and the plate with its hole extrudes to the right volume",
    run: async () => {
      const plate = await makeBody("plate", XY, [rectangle("plate", 25, 20, 50, 40), circle("hole", 25, 20, 7)], 8);
      near(volumeOf(plate.body), 50 * 40 * 8 - Math.PI * 49 * 8, (50 * 40 * 8) * 0.01, "the plate has its hole");
      const brought = bring(plate.project, plate.body, XY, "project");
      assert(kindsOf(brought.entities) === "circle,line,line,line,line", `outline and hole: ${kindsOf(brought.entities)}`);
      const hole = brought.entities.find((entity) => entity.kind === "circle") as Extract<SketchEntity, { kind: "circle" }>;
      near(hole.radiusMm, 7, 1e-3, "the hole radius");
      near(hole.center[0], 25, 1e-3, "the hole centre x");
      near(hole.center[1], 20, 1e-3, "the hole centre y");
      const back = await extrudeWorking(brought.project, "again", 8);
      near(volumeOf(back.body), volumeOf(plate.body), volumeOf(plate.body) * 1e-6, "the plate and its hole come back with the same volume");
      // The same hole seen from a tilt is an ellipse with the foreshortened minor radius.
      const tilted = bring(plate.project, plate.body, { plane: "datum:xy", planeTilt: { axis: "x", angleDeg: 30 } }, "project");
      const ellipses = tilted.entities.filter((entity) => entity.kind === "ellipse") as Extract<SketchEntity, { kind: "ellipse" }>[];
      assert(ellipses.length === 2, `the hole seen at an angle shows its top and bottom rim as two ellipses: ${kindsOf(tilted.entities)}`);
      for (const ellipse of ellipses) {
        near(ellipse.majorRadiusMm, 7, 1e-3, "the long radius is the hole's");
        near(ellipse.minorRadiusMm, 7 * Math.cos((30 * Math.PI) / 180), 1e-3, "the short radius is foreshortened by cos(tilt)");
      }
    }
  },
  {
    name: "A slot (two lines and two arcs) is recognised as such by Project, Silhouette and Intersect, on a datum and on a tilted plane, and extrudes back to the same volume",
    run: async () => {
      const arc = (id: string, start: Pt, mid: Pt, end: Pt): SketchEntity => ({ id: `entity:${id}`, kind: "arc", start: [start[0], start[1]], mid: [mid[0], mid[1]], end: [end[0], end[1]], construction: false });
      const slotEntities = [lineOf("a", [0, 0], [20, 0]), arc("b", [20, 0], [25, 5], [20, 10]), lineOf("c", [20, 10], [0, 10]), arc("d", [0, 10], [-5, 5], [0, 0])];
      const slot = await makeBody("slot", XY, slotEntities, 6);
      const area = 20 * 10 + Math.PI * 25;
      near(volumeOf(slot.body), area * 6, area * 6 * 0.01, "the slot solid");
      for (const mode of ["project", "silhouette"] as const) {
        const brought = bring(slot.project, slot.body, XY, mode);
        assert(kindsOf(brought.entities) === "arc,arc,line,line", `${mode}: two lines and two arcs: ${kindsOf(brought.entities)}`);
        const arcs = brought.entities.filter((entity) => entity.kind === "arc") as Extract<SketchEntity, { kind: "arc" }>[];
        for (const a of arcs) near(Math.hypot(a.start[0] - a.end[0], a.start[1] - a.end[1]), 10, 1e-3, `${mode}: each end arc spans the 10 mm slot width`);
        const profiles = detectSketchProfiles(brought.project.sketch);
        assert(profiles.length === 1, `${mode}: the slot closes into one profile`);
        near(profiles[0]!.areaMm2, area, area * 0.01, `${mode}: the profile has the slot's area`);
        const copy = await extrudeWorking(brought.project, `slot-copy-${mode}`, 6);
        near(volumeOf(copy.body), volumeOf(slot.body), volumeOf(slot.body) * 0.01, `${mode}: it extrudes back to the slot's volume`);
      }
      const cut = bring(slot.project, slot.body, { plane: "datum:xy", planeOffsetMm: 3 }, "intersect");
      assert(kindsOf(cut.entities) === "arc,arc,line,line", `a level cut of the slot is the same slot: ${kindsOf(cut.entities)}`);
      const tilted = bring(slot.project, slot.body, { plane: "datum:xy", planeTilt: { axis: "y", angleDeg: 25 } }, "silhouette");
      assert(detectSketchProfiles(tilted.project.sketch).length === 1, `the slot's shadow on a tilted plane is one closed profile: ${kindsOf(tilted.entities)}`);
    }
  },
  {
    name: "Intersect cuts a body with the sketch plane: a loop for a box, a circle for a cylinder, a tilted rectangle of the right size, and nothing when the plane misses",
    run: async () => {
      const { project, body } = await box();
      const level = bring(project, body, { plane: "datum:xy", planeOffsetMm: 5 }, "intersect");
      assert(kindsOf(level.entities) === "line,line,line,line", `a level cut of a box is a rectangle: ${kindsOf(level.entities)}`);
      const profile = detectSketchProfiles(level.project.sketch)[0]!;
      near(profile.areaMm2, 1200, 1e-6, "40 x 30");
      const slice = await extrudeWorking(level.project, "slice", 2);
      near(volumeOf(slice.body), 2400, 1e-6, "extruding the cut gives the section area times depth");
      // A plane lying along a face of the body gives that face's outline once, not twice or not at all.
      for (const offset of [0, 10]) {
        const onFace = bring(project, body, { plane: "datum:xy", planeOffsetMm: offset }, "intersect");
        assert(kindsOf(onFace.entities) === "line,line,line,line", `a plane along the face at z = ${offset} gives its four edges: ${kindsOf(onFace.entities)}`);
      }
      const angle = (30 * Math.PI) / 180;
      const tilted = bring(project, body, { plane: "datum:xy", planeOffsetMm: 1, planeTilt: { axis: "x", angleDeg: 30 } }, "intersect");
      assert(kindsOf(tilted.entities) === "line,line,line,line", `a slanted cut of a box is a rectangle: ${kindsOf(tilted.entities)}`);
      const yTop = (10 * Math.cos(angle) - 1) / Math.sin(angle);
      const yBottom = 0;
      const long = Math.hypot(yTop - yBottom, 10 - 1 / Math.cos(angle));
      const section = detectSketchProfiles(tilted.project.sketch)[0]!;
      near(section.areaMm2, 40 * long, 1e-3, "the slanted section is 40 mm wide and as long as the plane runs between the box's faces");
      const cylinder = await makeBody("pin", XY, [circle("pin", 0, 0, 6)], 30);
      const round = bring(cylinder.project, cylinder.body, { plane: "datum:xy", planeOffsetMm: 12 }, "intersect");
      assert(kindsOf(round.entities) === "circle", `a cylinder cut across is one circle: ${kindsOf(round.entities)}`);
      near((round.entities[0] as Extract<SketchEntity, { kind: "circle" }>).radiusMm, 6, 1e-6, "its radius");
      const slantedCylinder = bring(cylinder.project, cylinder.body, { plane: "datum:xy", planeOffsetMm: 0, planeTilt: { axis: "x", angleDeg: 40 } }, "intersect");
      const slantedEllipse = slantedCylinder.entities.find((entity) => entity.kind === "ellipse") as Extract<SketchEntity, { kind: "ellipse" }> | undefined;
      assert(slantedEllipse !== undefined, `a cylinder cut at an angle is an ellipse: ${kindsOf(slantedCylinder.entities)}`);
      if (slantedEllipse !== undefined) {
        near(slantedEllipse.minorRadiusMm, 6, 1e-3, "the minor radius is the cylinder's");
        near(slantedEllipse.majorRadiusMm, 6 / Math.cos((40 * Math.PI) / 180), 1e-3, "the major radius is stretched by the slant");
      }
      assert(failure(project, body, { plane: "datum:xy", planeOffsetMm: 80 }, "intersect").includes("does not cut"), "a plane that misses the body says so");
    }
  },
  {
    name: "Silhouette finds the outline of curved and holed bodies: a cylinder from the side, a plate from above with its hole, and a tilted cylinder's outline closes into a profile of the right area",
    run: async () => {
      const cylinder = await makeBody("pin", XY, [circle("pin", 0, 0, 5)], 20);
      const side = bring(cylinder.project, cylinder.body, { plane: "datum:xz" }, "silhouette");
      assert(kindsOf(side.entities) === "line,line,line,line", `a standing cylinder seen from the side is a rectangle: ${kindsOf(side.entities)}`);
      near(detectSketchProfiles(side.project.sketch)[0]!.areaMm2, 10 * 20, 1e-3, "10 wide and 20 tall");
      const top = bring(cylinder.project, cylinder.body, XY, "silhouette");
      assert(kindsOf(top.entities) === "circle", `from above it is a circle: ${kindsOf(top.entities)}`);
      const plate = await makeBody("plate", XY, [rectangle("plate", 25, 20, 50, 40), circle("hole", 25, 20, 7)], 8);
      const plan = bring(plate.project, plate.body, XY, "silhouette");
      assert(kindsOf(plan.entities) === "circle,line,line,line,line", `a through hole is part of the outline: ${kindsOf(plan.entities)}`);
      const blind = await makeBody("blind", XY, [rectangle("blind", 25, 20, 50, 40)], 8);
      const slanted = bring(cylinder.project, cylinder.body, { plane: "datum:xy", planeTilt: { axis: "x", angleDeg: 45 } }, "silhouette");
      void blind;
      const profiles = detectSketchProfiles(slanted.project.sketch);
      assert(profiles.length === 1, `the outline of a tilted cylinder is one closed profile: ${kindsOf(slanted.entities)}`);
      const c = Math.cos(Math.PI / 4);
      const expected = Math.PI * 25 * c + 2 * 5 * 20 * c;
      near(profiles[0]!.areaMm2, expected, expected * 0.01, "its area is the end ellipse plus the side strip");
      const solid = await extrudeWorking(slanted.project, "shade", 3);
      near(volumeOf(solid.body), profiles[0]!.areaMm2 * 3, profiles[0]!.areaMm2 * 3 * 0.01, "and it extrudes");
    }
  },
  {
    name: "Convert takes the outline of a picked face, with its holes, by named face or by flat run, and says when a face is curved",
    run: async () => {
      const plate = await makeBody("plate", XY, [rectangle("plate", 25, 20, 50, 40), circle("hole", 25, 20, 7)], 8);
      const top = bring(plate.project, plate.body, { plane: "datum:xy", planeOffsetMm: 20 }, "convert", { pointMm: [5, 5, 8], faceIndex: null });
      assert(kindsOf(top.entities) === "circle,line,line,line,line", `the top face is its rectangle and the hole: ${kindsOf(top.entities)}`);
      const stripped = { ...plate.body } as { -readonly [K in keyof GeneralSolidBody]: GeneralSolidBody[K] };
      delete stripped.brep;
      const flat = bring(plate.project, stripped as GeneralSolidBody, XY, "convert", { pointMm: [5, 5, 8] });
      assert(kindsOf(flat.entities) === kindsOf(top.entities), "the same outline is found without named faces, from the flat run of triangles");
      assert(flat.summary.includes("flat run"), "and it says how it found the face");
      const faces = plate.body.brep!.faces;
      const topIndex = faces.findIndex((face) => face.role.includes("top") || face.key.includes("top"));
      assert(topIndex >= 0, `the kernel names a top face (${faces.map((f) => f.role).join(", ")})`);
      const named = bring(plate.project, plate.body, XY, "convert", { faceIndex: topIndex });
      assert(kindsOf(named.entities) === kindsOf(top.entities), "picking the named top face gives the same outline");
      const bottom = bring(plate.project, plate.body, XY, "convert", { pointMm: [5, 5, 0] });
      assert(kindsOf(bottom.entities) === kindsOf(top.entities), "the bottom face has the same outline");
      const back = await extrudeWorking(named.project, "face", 8);
      near(volumeOf(back.body), volumeOf(plate.body), volumeOf(plate.body) * 1e-6, "extruding the converted face rebuilds the plate");
      // A side face seen face-on from the matching plane is a 40-wide rectangle; picked on a flat plate of a wedge it keeps its true shape on a tilt.
      const sideFace = bring(plate.project, plate.body, { plane: "datum:xz" }, "convert", { pointMm: [25, 0, 4] });
      assert(kindsOf(sideFace.entities).startsWith("line") && sideFace.entities.length === 4, `the front side face is a rectangle: ${kindsOf(sideFace.entities)}`);
      const wall = chooseFace(plate.body, { pointMm: [0, 20, 4], faceTriangles: plate.body.brep!.faceTriangles });
      assert(typeof wall !== "string" && wall.planar && wall.named, "a wall of the plate is a planar named face");
      const cylinder = await makeBody("pin", XY, [circle("pin", 0, 0, 5)], 20);
      const side = chooseFace(cylinder.body, { pointMm: [5, 0, 10], faceTriangles: cylinder.body.brep!.faceTriangles });
      assert(typeof side !== "string" && !side.planar, "the wall of a cylinder is a curved face");
      const curved = bring(cylinder.project, cylinder.body, { plane: "datum:xz" }, "convert", { pointMm: [5, 0, 10] });
      assert(curved.summary.includes("curved"), "converting a curved face says it projected the boundary edges");
    }
  },
  {
    name: "Picked edges project on their own: a picked rim is a circle face-on and an ellipse on a tilt, and construction curves never bound a profile",
    run: async () => {
      const cylinder = await makeBody("pin", XY, [circle("pin", 10, 10, 6)], 15);
      const edges = pickableEdges({ positionsMm: cylinder.body.positionsMm, indices: cylinder.body.indices });
      assert(typeof edges !== "string" && edges.length > 0, "the cylinder has pickable edges");
      if (typeof edges === "string") return;
      const nearest = nearestPickableEdge(edges, [10 + 6, 10, 15]);
      assert(nearest !== undefined && nearest.chain.length >= 36, `the top rim is picked as a whole chain: ${nearest?.chain.length}`);
      if (nearest === undefined) return;
      const segments = nearest.chain.map((edge) => [edge.a, edge.b] as const);
      const flat = bring(cylinder.project, cylinder.body, XY, "project", { edges: segments });
      assert(kindsOf(flat.entities) === "circle", `the picked rim is one circle: ${kindsOf(flat.entities)}`);
      const angle = 35;
      const tilted = bring(cylinder.project, cylinder.body, { plane: "datum:xy", planeTilt: { axis: "y", angleDeg: angle } }, "project", { edges: segments });
      const ellipse = tilted.entities.find((entity) => entity.kind === "ellipse") as Extract<SketchEntity, { kind: "ellipse" }> | undefined;
      assert(ellipse !== undefined, `on a tilt it is an ellipse: ${kindsOf(tilted.entities)}`);
      if (ellipse !== undefined) {
        near(ellipse.majorRadiusMm, 6, 1e-3, "the long radius is the rim's");
        near(ellipse.minorRadiusMm, 6 * Math.cos((angle * Math.PI) / 180), 1e-3, "the short radius is foreshortened by cos(tilt)");
      }
      const reference = bring(cylinder.project, cylinder.body, XY, "project", { edges: segments, construction: true });
      assert(reference.entities.every((entity) => entity.construction), "construction curves are marked as such");
      assert(detectSketchProfiles(reference.project.sketch).length === 0, "and never bound a profile");
      const real = bring(cylinder.project, cylinder.body, XY, "project", { edges: segments });
      assert(detectSketchProfiles(real.project.sketch).length === 1, "while real curves do");
      const missing = projectBodyEdges({ positionsMm: cylinder.body.positionsMm, indices: cylinder.body.indices }, sketchFrameOf(XY as SketchFrameSource), { segments: [] });
      assert(!missing.ok, "no edges, nothing to project");
    }
  },
  {
    name: "A box drilled with the mesh hole tool (a Boolean result with noisy slivers) still gives a clean outline, hole circle and section",
    run: async () => {
      const { project, body } = await box();
      const drilled = meshHole(body, { diameterMm: 10, depthMm: 40, axis: "z", originMm: [20, 15, 10] });
      assert(drilled.ok, "the hole is cut");
      if (!drilled.ok) return;
      const holed: GeneralSolidBody = { ...body, positionsMm: Array.from(drilled.positionsMm), indices: Array.from(drilled.indices) };
      delete (holed as { brep?: unknown }).brep;
      for (const mode of ["project", "silhouette", "intersect"] as const) {
        const spec: PlaneSpec = mode === "intersect" ? { plane: "datum:xy", planeOffsetMm: 5 } : XY;
        const brought = bring(project, holed, spec, mode);
        assert(kindsOf(brought.entities) === "circle,line,line,line,line", `${mode}: the outline and the hole, nothing else: ${kindsOf(brought.entities)}`);
        const hole = brought.entities.find((entity) => entity.kind === "circle") as Extract<SketchEntity, { kind: "circle" }>;
        near(hole.radiusMm, 5, 0.01, `${mode}: the hole radius`);
        near(hole.center[0], 20, 1e-3, `${mode}: the hole centre x`);
        near(hole.center[1], 15, 1e-3, `${mode}: the hole centre y`);
      }
      const plate = bring(project, holed, XY, "silhouette");
      const solid = await extrudeWorking(plate.project, "drilled-copy", 10);
      near(volumeOf(solid.body), volumeOf(holed), volumeOf(holed) * 0.01, "the outline and hole extrude to the drilled box's volume");
    }
  },
  {
    name: "Brought-in curves are snapshots: they validate, survive replay and deleting the body, and the sketch limit is respected",
    run: async () => {
      const { project, body } = await box();
      const brought = bring(project, body, XY, "project");
      assert(validateWorkbenchProject(brought.project).ok, "a sketch holding projected curves validates");
      const solid = await extrudeWorking(brought.project, "copy", 4);
      const results = await replayAllBodies(solid.project);
      assert(results.every((result) => result.message === undefined), `the timeline replays: ${results.map((r) => r.message ?? "").join("; ")}`);
      const regenerated = run(solid.project, { kind: "regenerate-design", results });
      const replayed = regenerated.part.generalBodies!.find((candidate) => candidate.id === solid.body.id)!;
      near(volumeOf(replayed), volumeOf(solid.body), 1e-6, "the copy keeps its volume through a replay");
      const gone = run(regenerated, { kind: "delete-general-body", bodyId: body.id });
      assert(validateWorkbenchProject(gone).ok, "deleting the source body leaves a valid project");
      assert(gone.part.generalBodies!.every((candidate) => candidate.id !== body.id), "the source body is gone");
      assert(gone.sketch.entities.length === brought.project.sketch.entities.length, "and the curves stay in the sketch");
      assert(failure(project, body, XY, "project", { room: 2 }).includes("room for 2 more"), "a sketch with no room is told so before anything is added");
      assert(failure(project, { ...body, indices: [] }, XY, "project").includes("no solid geometry"), "a body with no triangles is refused");
      assert(failure(project, body, XY, "convert", {}).length > 0, "convert needs a pick");
    }
  }
  ,
  {
    name: "The Project group's commands choose the body, take a pick where one is needed, and bring the curves in through a real sketch edit",
    run: async () => {
      const { project, body } = await box();
      const second = await makeBody("pin", { plane: "datum:xy", planeOffsetMm: 40 }, [circle("pin", 60, 15, 4)], 12, project);
      assert(!sourceBodyOf(createWorkbenchProject("project:test-empty"), null).ok, "no body, no projection");
      assert(sourceBodyOf(project, null).ok && sourceBodyOf(project, "general-body:box").ok, "a lone body, or the selected one, is the source");
      assert(!sourceBodyOf(second.project, null).ok, "with two bodies and no selection the user is asked to choose");
      const chosen = sourceBodyOf(second.project, "general-body:pin");
      assert(chosen.ok && chosen.body.id === "general-body:pin", "the selected body wins");
      assert(CAD_COMMANDS.some((command) => command.id === "command:sketch-project" && command.level === "preview"), "the catalog's Project geometry command is live");
      assert(isSketchProjectCommand("silhouette-body") && !isSketchProjectCommand("fix-curve"), "the ribbon's project commands are told apart from the other sketch commands");
      assert(needsPick("project-edge") && needsPick("convert-face") && !needsPick("intersect-body"), "an edge and a face need a click");
      const started = startSketch(second.project, XY);
      let n = 0;
      const newId = (): string => `entity:proj-${(n += 1)}`;
      const apply = (current: WorkbenchProject, command: SketchProjectCommand, target: GeneralSolidBody, extra: Partial<Parameters<typeof planSketchProject>[3]> = {}): { readonly project: WorkbenchProject; readonly summary: string; readonly kinds: string } => {
        const planned = planSketchProject(current, target, command, { construction: false, newId, ...extra });
        if (!planned.ok) throw new Error(`${command}: ${planned.message}`);
        const next = run(current, planned.operation);
        return { project: next, summary: planned.summary, kinds: kindsOf(next.sketch.entities.slice(current.sketch.entities.length)) };
      };
      const projected = apply(started, "project-body", body);
      assert(projected.kinds === "line,line,line,line" && validateWorkbenchProject(projected.project).ok, `project-body adds the box outline and the project still validates: ${projected.kinds}`);
      assert(apply(started, "silhouette-body", body).kinds === "line,line,line,line", "silhouette-body");
      const cut = apply(startSketch(second.project, { plane: "datum:xy", planeOffsetMm: 6 }), "intersect-body", body);
      assert(cut.kinds === "line,line,line,line", "intersect-body with the plane inside the box");
      const pillCut = apply(startSketch(second.project, { plane: "datum:xy", planeOffsetMm: 46 }), "intersect-body", second.body);
      assert(pillCut.kinds === "circle", `and across the pin: ${pillCut.kinds}`);
      // Project edge: the click is near the top rim of the pin, which picks the whole rim.
      const run2 = pickedEdgeRun(second.body, [64, 15, 52]);
      assert(typeof run2 !== "string" && run2.pieces >= 36, `a click near the pin's rim picks the whole rim: ${typeof run2 === "string" ? run2 : run2.pieces}`);
      if (typeof run2 !== "string") {
        const edge = apply(started, "project-edge", second.body, { pick: { pointMm: [64, 15, 52], edges: run2.segments } });
        assert(edge.kinds === "circle" && edge.summary.includes("snapshot"), `project-edge adds the rim as one circle: ${edge.kinds}`);
        const reference = apply(started, "project-edge", second.body, { construction: true, pick: { pointMm: [64, 15, 52], edges: run2.segments } });
        assert(reference.project.sketch.entities.every((entity) => entity.construction), "as reference geometry when asked");
      }
      assert(typeof edgesToPick(body) !== "string" && (edgesToPick(body) as readonly unknown[]).length === 12, "a box offers its twelve edges to pick");
      // Convert face: the pin's top face, picked by a point on it.
      const face = apply(started, "convert-face", second.body, { pick: { pointMm: [60, 15, 52], faceIndex: null } });
      assert(face.kinds === "circle", `convert-face on the pin's top: ${face.kinds}`);
      assert(!planSketchProject(started, body, "convert-face", { construction: false, newId }).ok, "convert-face without a pick is refused");
      assert(!planSketchProject(started, body, "project-edge", { construction: false, newId }).ok, "project-edge without a pick is refused");
      // A sketch that is nearly full refuses before changing anything.
      const full = { ...started, sketch: { ...started.sketch, entities: Array.from({ length: 498 }, (_, i): SketchEntity => lineOf(`fill-${i}`, [i, 0], [i, 5])) } } as WorkbenchProject;
      const refused = planSketchProject(full, body, "project-body", { construction: false, newId });
      assert(!refused.ok && refused.message.includes("room for 2 more"), "a nearly full sketch says how much room it has");
    }
  }
];
