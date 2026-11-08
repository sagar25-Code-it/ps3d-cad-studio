import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { flatPatternOfPlate } from "../packages/workbench-geometry/src/flat-pattern.js";
import { attachEdgeFlange, flangeReliefs, nearestFrameEdge, sharedFlangeEnds, sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { flatPatternForBody, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-rphd-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function withSketch(): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  const project = run(createWorkbenchProject("project:test-rphd"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  return { project, sketch: designOf(project).features[0] as DesignSketchFeature };
}

const step = (sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra });

/** Every edge is used once in each direction, which is what a closed, consistently wound solid looks like. */
export function isClosedAndOriented(indices: readonly number[]): boolean {
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

/** Two edge numbers of a plate that meet at a corner, and two that are opposite each other. */
function neighbourPair(base: { positionsMm: number[]; indices: number[] }): { readonly first: number; readonly second: number; readonly opposite: number } {
  const frame = sheetFrameOf(base, [0, 0, 1])!;
  for (const edge of frame.edges) {
    const touching = frame.edges.filter((other) => other.index !== edge.index && sharedFlangeEnds(frame, edge.index, [other.index]).start);
    const neighbour = touching[0];
    if (neighbour !== undefined) {
      const opposite = frame.edges.find((other) => other.index !== edge.index && other.index !== neighbour.index && !sharedFlangeEnds(frame, edge.index, [other.index]).start && !sharedFlangeEnds(frame, edge.index, [other.index]).end);
      return { first: edge.index, second: neighbour.index, opposite: opposite?.index ?? -1 };
    }
  }
  throw new Error("no neighbouring edges");
}

export const reliefPickHoleDragTests: readonly TestCase[] = [
  {
    name: "nearestFrameEdge picks the plate edge closest to a click, on the top face or on a side wall",
    run: () => {
      const frame = sheetFrameOf(plate(40, 30, 2), [0, 0, 1])!;
      const nearTo = (point: readonly [number, number, number]): { readonly index: number; readonly distanceMm: number } => nearestFrameEdge(frame, point)!;
      const edgeAt = (x: number, y: number): number => frame.edges.find((edge) => Math.abs((edge.startMm[0] + edge.endMm[0]) / 2 - x) < 1e-6 && Math.abs((edge.startMm[1] + edge.endMm[1]) / 2 - y) < 1e-6)!.index;
      const left = nearTo([1.5, 14, 2]);
      assert(left.index === edgeAt(0, 15), "a click near the left side picks the left edge");
      near(left.distanceMm, 1.5, 1e-9, "distance to the edge");
      assert(nearTo([20, 28.5, 2]).index === edgeAt(20, 30), "a click near the top side picks the top edge");
      assert(nearTo([40, 10, 0.5]).index === edgeAt(40, 15), "a click on the side wall picks the edge above it");
      assert(nearestFrameEdge({ ...frame, edges: [] }, [0, 0, 0]) === undefined, "no edges, no pick");
    }
  },
  {
    name: "sharedFlangeEnds and flangeReliefs shorten a flange only where another flange meets it",
    run: () => {
      const base = plate(40, 30, 2);
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      const { first, second, opposite } = neighbourPair(base);
      const ends = sharedFlangeEnds(frame, first, [first, second]);
      assert(ends.start !== ends.end, "a neighbour meets exactly one end of the edge");
      assert(!sharedFlangeEnds(frame, first, [opposite]).start && !sharedFlangeEnds(frame, first, [opposite]).end, "the opposite edge meets neither end");
      const relief = flangeReliefs(frame, first, [{ edgeIndex: first, reliefMm: 2 }, { edgeIndex: second, reliefMm: 0 }]);
      near(relief.startMm + relief.endMm, 1, 1e-9, "half the relief on the one shared end");
      const asked = flangeReliefs(frame, first, [{ edgeIndex: first, reliefMm: 0 }, { edgeIndex: second, reliefMm: 2 }]);
      near(asked.startMm + asked.endMm, 1, 1e-9, "a relief asked for by the neighbour counts too, so the earlier flange gives way as well");
      const larger = flangeReliefs(frame, first, [{ edgeIndex: first, reliefMm: 2 }, { edgeIndex: second, reliefMm: 4 }]);
      near(larger.startMm + larger.endMm, 2, 1e-9, "the larger of the two reliefs sets the gap");
      const none = flangeReliefs(frame, first, [{ edgeIndex: first, reliefMm: 2 }, { edgeIndex: opposite, reliefMm: 2 }]);
      assert(none.startMm === 0 && none.endMm === 0, "no relief without a neighbouring flange");
      assert(flangeReliefs(frame, first, [{ edgeIndex: first, reliefMm: 0 }, { edgeIndex: second, reliefMm: 0 }]).startMm === 0, "a relief of 0 leaves the flange whole");
      assert(flangeReliefs(frame, first, [{ edgeIndex: second, reliefMm: 2 }]).startMm === 0, "a flange that is not in the list gets no relief");
    }
  },
  {
    name: "An edge flange with corner relief is still a closed, outward solid and has less flange by exactly the relief",
    run: () => {
      const base = plate(40, 30, 2);
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      for (const edge of frame.edges) {
        for (const [start, end] of [[1, 0], [0, 1.5], [1, 1.5]] as const) {
          const result = attachEdgeFlange(base, base, [0, 0, 1], { edgeIndex: edge.index, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90, reliefStartMm: start, reliefEndMm: end });
          assert(result.ok, `edge ${edge.index} relief ${start}/${end} accepted: ${result.ok ? "" : result.message}`);
          if (!result.ok) return;
          assert(isClosedAndOriented(result.indices), `edge ${edge.index} relief ${start}/${end} stays closed and consistently wound`);
          const metrics = solidMetrics(result.positionsMm, result.indices);
          assert(metrics.outward, "winding points outward");
          const expected = 40 * 30 * 2 + (15 * 2 + quarterBendArea(2, 2)) * (edge.lengthMm - start - end);
          near(metrics.volumeMm3, expected, expected * 0.02, `edge ${edge.index} relief ${start}/${end} volume`);
        }
      }
      const tooMuch = attachEdgeFlange(base, base, [0, 0, 1], { edgeIndex: 0, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90, reliefStartMm: 100, reliefEndMm: 0 });
      assert(!tooMuch.ok && tooMuch.message.includes("relief"), "a relief longer than the edge is refused");
      assert(!attachEdgeFlange(base, base, [0, 0, 1], { edgeIndex: 0, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90, reliefStartMm: -1 }).ok, "a negative relief is refused");
    }
  },
  {
    name: "Two flanges on neighbouring edges, each with its corner relief, give a closed solid with a gap between them",
    run: () => {
      const base = plate(40, 30, 2);
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      const { first, second } = neighbourPair(base);
      const edges = [first, second];
      const flanges = edges.map((edgeIndex) => ({ edgeIndex, reliefMm: 2 }));
      let current: { positionsMm: readonly number[]; indices: readonly number[] } = base;
      for (const index of edges) {
        const relief = flangeReliefs(frame, index, flanges);
        const result = attachEdgeFlange(current, base, [0, 0, 1], { edgeIndex: index, innerRadiusMm: 2, flangeLengthMm: 12, angleDeg: 90, reliefStartMm: relief.startMm, reliefEndMm: relief.endMm });
        assert(result.ok, `flange on edge ${index}: ${result.ok ? "" : result.message}`);
        if (!result.ok) return;
        current = result;
      }
      assert(isClosedAndOriented(current.indices), "closed after both flanges");
      const metrics = solidMetrics(current.positionsMm, current.indices);
      assert(metrics.outward, "outward");
      const expected = 40 * 30 * 2 + (12 * 2 + quarterBendArea(2, 2)) * (frame.edges[first]!.lengthMm - 1 + frame.edges[second]!.lengthMm - 1);
      near(metrics.volumeMm3, expected, expected * 0.02, "volume is plate plus the two shortened flanges");
    }
  },
  {
    name: "The flat pattern leaves the corner relief gap between neighbouring flanges and no longer warns once it is there",
    run: () => {
      const base = plate(40, 30, 2);
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      const { first, second } = neighbourPair(base);
      const flange = (edgeIndex: number, reliefMm: number) => ({ edgeIndex, innerRadiusMm: 2, flangeLengthMm: 12, angleDeg: 90, reliefMm });
      const without = flatPatternOfPlate(frame, "xy", [flange(first, 0), flange(second, 0)]);
      assert(!("error" in without) && without.notes.length === 1, "no relief: the pattern says a relief is needed");
      const withRelief = flatPatternOfPlate(frame, "xy", [flange(first, 3), flange(second, 3)]);
      assert(!("error" in withRelief), "pattern with relief");
      if ("error" in withRelief || "error" in without) return;
      assert(withRelief.notes.length === 0, "no warning once the relief is there");
      const gap = (pattern: typeof withRelief): number => {
        // Distance between the two flange rectangles along the line that passes through the corner.
        const pointsA = pattern.bendLinesMm.map(([from, to]) => [from, to] as const);
        return Math.min(...pointsA.flatMap(([a1, a2], i) => pointsA.slice(i + 1).flatMap(([b1, b2]) => [Math.hypot(a1[0] - b1[0], a1[1] - b1[1]), Math.hypot(a1[0] - b2[0], a1[1] - b2[1]), Math.hypot(a2[0] - b1[0], a2[1] - b1[1]), Math.hypot(a2[0] - b2[0], a2[1] - b2[1])])));
      };
      assert(gap(withRelief) > gap(without) + 1, `the flanges are further apart with a relief (${gap(without).toFixed(2)} → ${gap(withRelief).toFixed(2)} mm)`);
      const lengthOf = (pattern: typeof withRelief, i: number): number => Math.hypot(pattern.bendLinesMm[i]![1][0] - pattern.bendLinesMm[i]![0][0], pattern.bendLinesMm[i]![1][1] - pattern.bendLinesMm[i]![0][1]);
      const total = (pattern: typeof withRelief): number => pattern.bendLinesMm.reduce((sum, _line, i) => sum + lengthOf(pattern, i), 0);
      near(total(without) - total(withRelief), 3, 1e-6, "the bend lines are shorter by the relief (1.5 mm from each flange)");
      assert(withRelief.outlinesMm[0]!.length > without.outlinesMm[0]!.length, "the relief adds outline points");
    }
  },
  {
    name: "Relief round-trips through the real timeline: the replayed mesh is closed, the unfolded blank shrinks, and bad values are refused",
    run: async () => {
      const { project, sketch } = withSketch();
      const base = step(sketch, "sheet-base", "sheet", { sheetThicknessMm: 2, valueMm: 2 });
      const built = await rebuildSolidFeature(base, sketch);
      assert(built.ok, "base builds");
      if (!built.ok) return;
      const bodyId = "general-body:sheet";
      let current = run(project, { kind: "add-design-solid", feature: base, body: built.body });
      const plateOnly = sheetFrameOf(built.body, [0, 0, 1]);
      assert(plateOnly !== undefined, "plate frame");
      if (plateOnly === undefined) return;
      const { first, second } = neighbourPair({ positionsMm: Array.from(built.body.positionsMm), indices: Array.from(built.body.indices) });
      const volumes: number[] = [];
      for (const relief of [0, 2]) {
        let project2 = current;
        for (const [id, edge] of [[`fa${relief}`, first], [`fb${relief}`, second]] as const) {
          const flange = step(sketch, "sheet-edge-flange", id, { bodyId, operation: "direct-edit", flangeEdgeIndex: edge, sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90, ...(relief > 0 ? { flangeReliefMm: relief } : {}) });
          const added = run(project2, { kind: "add-design-solid", feature: flange, body: project2.part.generalBodies!.find((body) => body.id === bodyId)! });
          project2 = run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
        }
        const body = project2.part.generalBodies!.find((candidate) => candidate.id === bodyId)!;
        assert(isClosedAndOriented(body.indices), `relief ${relief}: the replayed mesh is closed`);
        volumes.push(solidMetrics(body.positionsMm, body.indices).volumeMm3);
        const flat = await flatPatternForBody(project2, bodyId);
        assert(flat.ok, `relief ${relief}: flat pattern ${flat.ok ? "" : flat.message}`);
        if (flat.ok) assert(relief === 0 ? flat.notes.length === 1 : flat.notes.length === 0, `relief ${relief}: warning only when there is no relief`);
      }
      assert(volumes[1]! < volumes[0]! - 1, `the relieved part has less material (${volumes[0]!.toFixed(1)} → ${volumes[1]!.toFixed(1)} mm³)`);
      const good = { id: "feature:sef", name: "Edge flange", kind: "sheet-edge-flange", suppressed: false, sketchFeatureId: "feature:s", profileIds: [], valueMm: 15, bodyId: "general-body:b", operation: "direct-edit", flangeEdgeIndex: 2, sheetBendRadiusMm: 2, flangeLengthMm: 15, flangeAngleDeg: 90, flangeReliefMm: 2 };
      assert(validSolidFeaturePayload(good), "a relief on an edge flange is accepted");
      assert(!validSolidFeaturePayload({ ...good, flangeReliefMm: -1 }), "a negative relief is rejected");
      assert(!validSolidFeaturePayload({ ...good, flangeReliefMm: "2" }), "a non-numeric relief is rejected");
      assert(!validSolidFeaturePayload({ ...good, kind: "sheet-flange", operation: "new-body", sheetThicknessMm: 2 }), "a relief on any other kind is rejected");
    }
  }
];
