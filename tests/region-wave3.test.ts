import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { triangulateLoops } from "../packages/occt-kernel-adapter/src/polygon.js";
import { detectSketchProfiles, type SketchProfile } from "../packages/workbench-sketch/src/index.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import * as editKit from "./sketch-edit-kit.js";
import type { SketchEntity } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circ, line, rect, sketchFeatureOf, sketchOf, solidFeature } from "./region-wave2-kit.js";
import { meshReport } from "./region-wave3-kit.js";
import { regionWave3SelectTests } from "./region-wave3-select.test.js";
import { applyWorkbenchOperation, designOf, solidEnvelopeProblem, type DesignSketchFeature, type GeneralSolidBody, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { commitWorkingSketchAtomically } from "../apps/studio-web/src/sketch-session.js";
import { rebuildSolidFeature as rebuildFeature } from "../apps/studio-web/src/design-regeneration.js";
import { sketchLookupOf } from "../apps/studio-web/src/design-regeneration.js";
import { buildSolid, circ as pipelineCirc, line as pipelineLine, committedSketch, pipelineApply, pipelineRun, rect as pipelineRect, solidOf } from "./pipeline-kit.js";

/**
 * Region engine, wave 3: the second re-audit found plates with a row of four equal holes (or a 12-hole bolt circle) that extrude to
 * a mesh with open edges, near-coincident intersections that dropped faces, stored references that lost or shrank holes, twisted
 * sweeps that built two stations, and plates that could not hold more than about 80 holes.
 */

interface Layout { readonly name: string; readonly entities: readonly SketchEntity[]; readonly area: number; readonly rotationDeg?: number }

function plateWith(name: string, plate: { readonly width: number; readonly height: number; readonly rotationDeg?: number; readonly center?: readonly [number, number] }, holes: readonly { readonly at: readonly [number, number]; readonly radius: number }[]): Layout {
  const center = plate.center ?? [0, 0];
  const turn = (point: readonly [number, number]): readonly [number, number] => {
    const angle = ((plate.rotationDeg ?? 0) * Math.PI) / 180;
    return [center[0] + point[0] * Math.cos(angle) - point[1] * Math.sin(angle), center[1] + point[0] * Math.sin(angle) + point[1] * Math.cos(angle)];
  };
  const base = rect("plate", center, plate.width, plate.height);
  const entities: SketchEntity[] = [plate.rotationDeg ? { ...base, rotationDeg: plate.rotationDeg } as SketchEntity : base];
  holes.forEach((hole, index) => entities.push(circ(`h${index}`, turn(hole.at), hole.radius)));
  return { name, entities, area: plate.width * plate.height - holes.reduce((total, hole) => total + Math.PI * hole.radius * hole.radius, 0) };
}

function layouts(): Layout[] {
  const all: Layout[] = [];
  // Rows and grids of equal holes, in every size the audit tried and more.
  for (const cols of [1, 2, 3, 4, 5, 6, 7, 8, 12]) for (const rows of [1, 2, 3]) for (const pitch of [9, 12.5]) {
    const holes: { at: [number, number]; radius: number }[] = [];
    for (let i = 0; i < cols; i += 1) for (let j = 0; j < rows; j += 1) holes.push({ at: [(i - (cols - 1) / 2) * pitch, (j - (rows - 1) / 2) * pitch], radius: 3 });
    all.push(plateWith(`grid ${cols}x${rows}@${pitch}`, { width: cols * pitch + 20, height: rows * pitch + 20 }, holes));
  }
  // Bolt circles of 3 to 24 holes, some turned by an angle so no hole sits on an axis.
  for (let count = 3; count <= 24; count += 1) for (const turnDeg of [0, 7.5]) {
    const holes = Array.from({ length: count }, (_, index) => {
      const angle = ((index * 360) / count + turnDeg) * (Math.PI / 180);
      return { at: [35 * Math.cos(angle), 35 * Math.sin(angle)] as const, radius: Math.min(4, 35 * Math.sin(Math.PI / count) * 0.6) };
    });
    all.push(plateWith(`bolt circle ${count} turned ${turnDeg}`, { width: 100, height: 100 }, holes));
  }
  // The plate itself turned, so no edge is axis-aligned.
  for (const turnDeg of [15, 30, 45, 90]) for (const cols of [4, 6]) {
    const holes = Array.from({ length: cols }, (_, index) => ({ at: [(index - (cols - 1) / 2) * 14, 0] as const, radius: 4 }));
    all.push(plateWith(`row of ${cols} on a plate turned ${turnDeg}`, { width: cols * 14 + 20, height: 40, rotationDeg: turnDeg, center: [10, -5] }, holes));
  }
  // Mixed radii and holes close to the edge.
  for (const radii of [[3, 4, 5, 3], [2, 2, 3, 3, 2, 2], [5, 3, 3, 5, 3, 3, 5]]) {
    const total = radii.reduce((sum, radius) => sum + radius * 2 + 4, -4);
    let x = -total / 2;
    const holes = radii.map((radius) => { const at = [x + radius, 0] as const; x += radius * 2 + 4; return { at, radius }; });
    all.push(plateWith(`mixed radii ${radii.join("-")}`, { width: total + 20, height: 30 }, holes));
  }
  for (const wall of [0.5, 1, 2]) {
    const holes = [0, 1, 2, 3].map((index) => ({ at: [-30 + index * 20, 15 - 4 - wall] as const, radius: 4 }));
    all.push(plateWith(`row of 4 with a ${wall} mm wall to the edge`, { width: 100, height: 30 }, holes));
  }
  return all;
}

async function closedBodyOf(layout: Layout, extra: Parameters<typeof solidFeature>[1] = {}) {
  const built = await rebuildSolidFeature(solidFeature("extrude", extra), sketchFeatureOf(sketchOf(layout.entities)));
  assert(built.ok, `${layout.name}: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  return built.body;
}

export const regionWave3Tests: readonly TestCase[] = [
  {
    name: "region R2-01: a row of four equal holes extrudes to a closed manifold (was 6 open edges)",
    run: async () => {
      const layout = plateWith("row of 4", { width: 100, height: 40, center: [50, 20] }, [0, 1, 2, 3].map((index) => ({ at: [15 + (index * 70) / 3 - 50, 0] as const, radius: 4 })));
      const body = await closedBodyOf(layout);
      const report = meshReport(body.positionsMm, body.indices);
      equal(report.badEdges, 0, "every edge is shared by exactly two triangles");
      equal(report.sameDirectionEdges, 0, "the winding is consistent");
      assert(report.signedVolume > 0, "the volume is positive");
    }
  },
  {
    name: "region R2-01: a 12-hole bolt circle extrudes to a closed manifold (was 24 open edges)",
    run: async () => {
      const holes = Array.from({ length: 12 }, (_, index) => ({ at: [14 * Math.cos((index * Math.PI) / 6), 14 * Math.sin((index * Math.PI) / 6)] as const, radius: 2 }));
      const body = await closedBodyOf(plateWith("bolt circle", { width: 100, height: 40 }, holes));
      const report = meshReport(body.positionsMm, body.indices);
      equal(report.badEdges, 0, "every edge is shared by exactly two triangles");
      equal(report.sameDirectionEdges, 0, "the winding is consistent");
    }
  },
  {
    name: "region R2-01: every body of the layout sweep (rows, grids, bolt circles, turned plates, mixed radii, holes near edges, fillets) is a closed manifold of the analytic volume",
    run: async () => {
      let tried = 0;
      const problems: string[] = [];
      for (const layout of layouts()) {
        for (const treatment of [undefined, { kind: "fillet" as const, sizeMm: 1.5 }, { kind: "chamfer" as const, sizeMm: 1 }]) {
          // Fillets and chamfers on every layout would triple the time; the corner treatment is sampled on a third of them.
          if (treatment !== undefined && tried % 3 !== 0) { tried += 1; continue; }
          tried += 1;
          const built = await rebuildSolidFeature(solidFeature("extrude", treatment === undefined ? {} : { edge: treatment }), sketchFeatureOf(sketchOf(layout.entities)));
          if (!built.ok) { problems.push(`${layout.name}${treatment ? " " + treatment.kind : ""}: ${built.message}`); continue; }
          const report = meshReport(built.body.positionsMm, built.body.indices);
          const label = `${layout.name}${treatment ? " " + treatment.kind : ""}`;
          if (report.badEdges !== 0) problems.push(`${label}: ${report.badEdges} open or over-shared edges`);
          if (report.sameDirectionEdges !== 0) problems.push(`${label}: ${report.sameDirectionEdges} edges wound the same way`);
          if (!(report.signedVolume > 0)) problems.push(`${label}: volume ${report.signedVolume}`);
          if (treatment === undefined) {
            const expected = layout.area * 10;
            if (Math.abs(report.signedVolume - expected) > expected * 0.012) problems.push(`${label}: volume ${report.signedVolume.toFixed(1)} against ${expected.toFixed(1)}`);
          }
        }
      }
      assert(tried >= 150, `the sweep covers at least 150 builds (${tried})`);
      equal(problems.length, 0, `no body is open, mis-wound or the wrong size: ${problems.slice(0, 4).join(" | ")}`);
    }
  },
  {
    name: "region R2-01: triangulating loops whose bridges pass through another hole's extreme point keeps every boundary edge",
    run: () => {
      const ring = (cx: number, cy: number, r: number, count: number): (readonly [number, number])[] => Array.from({ length: count }, (_, index) => [cx + r * Math.cos((2 * Math.PI * index) / count), cy + r * Math.sin((2 * Math.PI * index) / count)] as const).reverse();
      const outer: (readonly [number, number])[] = [[0, 0], [100, 0], [100, 40], [0, 40]];
      const holes = [0, 1, 2, 3].map((index) => ring(15 + (index * 70) / 3, 20, 4, 64));
      const triangles = triangulateLoops(outer, holes);
      const loops = [outer, ...holes];
      const directed = new Map<string, number>();
      for (let index = 0; index < triangles.length; index += 3) for (let edge = 0; edge < 3; edge += 1) {
        const key = `${triangles[index + edge]}>${triangles[index + ((edge + 1) % 3)]}`;
        directed.set(key, (directed.get(key) ?? 0) + 1);
      }
      let offset = 0;
      for (const loop of loops) {
        for (let index = 0; index < loop.length; index += 1) {
          const a = offset + index;
          const b = offset + ((index + 1) % loop.length);
          // Every boundary edge is used by exactly one triangle, in one direction.
          equal((directed.get(`${a}>${b}`) ?? 0) + (directed.get(`${b}>${a}`) ?? 0), 1, `boundary edge ${a}-${b} is used once`);
        }
        offset += loop.length;
      }
    }
  },
  {
    name: "region R2-06 / N2-02: plates with 100, 200 and 400 round holes are built closed, added to the timeline and finish in a few seconds (was refused above 83 holes)",
    run: async () => {
      for (const count of [100, 200, 400]) {
        const started = Date.now();
        const side = Math.ceil(Math.sqrt(count));
        const holes = Array.from({ length: count }, (_, index) => pipelineCirc(`h${index}`, (index % side) * 8 + 6, Math.floor(index / side) * 8 + 6, 2));
        const size = side * 8 + 4;
        const { project, sketch } = committedSketch("datum:xy", [pipelineRect("plate", size / 2, size / 2, size, size), ...holes]);
        const rebuilt = await buildSolid(sketch, "extrude");
        const body = solidOf(rebuilt);
        const notes = rebuilt.ok ? rebuilt.warnings ?? [] : [];
        if (count === 400) assert(notes.some((note) => note.includes("edges instead of")), `thinned holes are announced: ${notes.join(" | ")}`);
        else if (count === 100) assert(notes.length === 0, "a plate within the budget keeps full-roundness holes and says nothing");
        const report = meshReport(body.positionsMm, body.indices);
        equal(report.badEdges, 0, `${count} holes: every edge is shared by exactly two triangles`);
        const expected = (size * size - count * Math.PI * 4) * 10;
        assert(Math.abs(report.signedVolume - expected) < expected * 0.02, `${count} holes: volume ${report.signedVolume.toFixed(0)} against ${expected.toFixed(0)}`);
        const feature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude" as const, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: "general-body:extrude-1" };
        const added = pipelineApply(project, { kind: "add-design-solid", feature, body });
        assert(added.ok, `${count} holes: the solid is stored: ${added.ok ? "" : added.diagnostics[0]?.message ?? ""}`);
        assert(Date.now() - started < 15_000, `${count} holes build and store in under 15 s (took ${Date.now() - started} ms)`);
      }
    }
  },
  {
    name: "region N2-02: adding 100 holes to a stored 8x8 perforated plate and finishing the sketch rebuilds the solid (was refused with 'The rebuild results are invalid')",
    run: async () => {
      const holes = Array.from({ length: 64 }, (_, index) => pipelineCirc(`h${index}`, (index % 8) * 30 + 20, Math.floor(index / 8) * 30 + 20, 3));
      const { project, sketch } = committedSketch("datum:xy", [pipelineRect("plate", 130, 130, 260, 260), ...holes]);
      const body = solidOf(await buildSolid(sketch, "extrude"));
      const feature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude" as const, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: "general-body:extrude-1" };
      let current: WorkbenchProject = pipelineRun(project, { kind: "add-design-solid", feature, body });
      current = pipelineRun(current, { kind: "edit-design-sketch", featureId: sketch.id });
      const extra = Array.from({ length: 100 }, (_, index) => pipelineCirc(`x${index}`, (index % 10) * 24 + 8, Math.floor(index / 10) * 24 + 8 + 0 * index, 1));
      current = pipelineRun(current, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: extra, addConstraints: [], label: "More holes" });
      const finished = await commitWorkingSketchAtomically(current, { featureId: "feature:sketch-9", name: "Sketch 9" });
      assert(finished.ok, `Finish Sketch is accepted: ${finished.ok ? "" : finished.message}`);
      if (!finished.ok) return;
      equal(finished.value.failed.length, 0, "no dependent solid failed to rebuild");
      const stored = (finished.value.project.part.generalBodies ?? []).find((candidate: GeneralSolidBody) => candidate.id === "general-body:extrude-1");
      assert(stored !== undefined && stored.positionsMm.length / 3 > 100_000, "the rebuilt plate holds more than the old 100,000-vertex limit");
      assert(finished.value.rebuilt.every((result) => result.body !== undefined), "the rebuilt solid travels with the result");
      void designOf; void applyWorkbenchOperation;
    }
  },
  {
    name: "region R2-06: a solid over the stored-vertex limit is refused with the real limit and the reason, and a batch of rebuild results names the feature",
    run: () => {
      const huge = { id: "general-body:x", name: "x", visible: true, color: "#b9c2c8", positionsMm: new Array(1_900_000).fill(1), indices: [0, 1, 2] };
      const problem = solidEnvelopeProblem({ kind: "extrude", valueMm: 5 }, huge);
      assert(problem !== undefined && problem.message.includes("600,000") && problem.message.includes("round holes"), `the message names the limit and the cause: ${problem?.message ?? "none"}`);
      const project = committedSketch("datum:xy", [pipelineRect("p", 0, 0, 10, 10)]).project;
      const refused = pipelineApply(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: huge as unknown as GeneralSolidBody }] });
      assert(!refused.ok, "the oversize rebuild result is refused");
      const text = refused.ok ? "" : refused.diagnostics[0]?.message ?? "";
      assert(text.includes("feature:extrude-1") && text.includes("600,000"), `the refusal names the feature and the limit instead of 'The rebuild results are invalid': ${text}`);
    }
  },
  {
    name: "region R2-05 / N2-01: a straight sweep with Twist builds enough stations for the volume and a closed shape (was two rings: 5333 for 16000)",
    run: async () => {
      const bar = committedSketch("datum:xy", [pipelineRect("bar", 0, 0, 20, 40)]).sketch;
      for (const twist of [5, 20, 45, 90, 180, 360, -90]) {
        const built = solidOf(await buildSolid(bar, "sweep", { sweepDirectionMm: [0, 0, 1], valueMm: 20, sweepTwistDeg: twist }));
        const report = meshReport(built.positionsMm, built.indices);
        near(report.signedVolume, 16000, 16000 * 0.002, `twist ${twist}: the twisted bar keeps its volume`);
        equal(report.badEdges, 0, `twist ${twist}: closed`);
        assert(report.triangles > 12 + Math.abs(twist) / 2, `twist ${twist}: stations between the ends (${report.triangles} triangles)`);
      }
      const disc = committedSketch("datum:xy", [pipelineCirc("c", 0, 0, 10)]).sketch;
      const discBody = solidOf(await buildSolid(disc, "sweep", { sweepDirectionMm: [0, 0, 1], valueMm: 20, sweepTwistDeg: 90 }));
      const turned = meshReport(discBody.positionsMm, discBody.indices);
      near(turned.signedVolume, Math.PI * 100 * 20, Math.PI * 100 * 20 * 0.003, "a twisted disc keeps its volume");
      const holed = committedSketch("datum:xy", [pipelineRect("bar", 0, 0, 20, 40), pipelineCirc("hole", 3, 5, 4)]).sketch;
      const profile = [...detectSketchProfiles(holed.sketch)].sort((a: SketchProfile, b: SketchProfile) => b.areaMm2 - a.areaMm2).find((candidate: SketchProfile) => (candidate.holes?.length ?? 0) > 0)!;
      const perforated = solidOf(await buildSolid(holed, "sweep", { sweepDirectionMm: [0, 0, 1], valueMm: 20, sweepTwistDeg: 90, profileIds: [profile.ref!] }));
      const perforatedReport = meshReport(perforated.positionsMm, perforated.indices);
      near(perforatedReport.signedVolume, (800 - Math.PI * 16) * 20, 800 * 20 * 0.004, "a twisted bar with a hole keeps its volume");
      equal(perforatedReport.badEdges, 0, "the twisted bar with a hole is closed");
    }
  },
  {
    name: "region R2-05: a twisted sweep along a path in another sketch is built from stations along the path too",
    run: async () => {
      const first = committedSketch("datum:xy", [pipelineRect("bar", 0, 0, 20, 10)]);
      const second = committedSketch("datum:xz", [pipelineLine("p1", [0, 0], [0, 60])], { project: first.project, featureId: "feature:p" });
      const lookup = sketchLookupOf(designOf(second.project));
      const profile = detectSketchProfiles(first.sketch.sketch)[0]!;
      for (const twist of [30, 90, 180]) {
        const built = await rebuildFeature({ id: "feature:x", name: "x", kind: "sweep", suppressed: false, sketchFeatureId: first.sketch.id, valueMm: 60, bodyId: "general-body:x", profileIds: [profile.id], sweepPath: { sketchFeatureId: "feature:p", entityIds: ["entity:p1"] }, sweepTwistDeg: twist }, first.sketch, "#b9c2c8", lookup);
        const body = solidOf(built);
        const report = meshReport(body.positionsMm, body.indices);
        near(report.signedVolume, 12000, 24, `path sweep twist ${twist}: volume`);
        assert(report.triangles > 12 + twist / 2, `path sweep twist ${twist}: stations between the ends (${report.triangles} triangles)`);
      }
    }
  },
  {
    name: "region R2-08: a sweep and a loft of a region with a crossing circle say so (the warnings were dropped on the special builder path)",
    run: async () => {
      const entities = [rect("p", [20, 20], 20, 40), circ("c", [29, 20], 3), circ("t", [20, 8], 3)];
      const sketch = sketchFeatureOf(sketchOf(entities));
      for (const extra of [{ kind: "sweep" as const, valueMm: 10, sweepDirectionMm: [0, 0, 1] as const }, { kind: "loft" as const, valueMm: 10, loftTopScale: 0.7 }]) {
        const built = await rebuildSolidFeature(solidFeature(extra.kind, extra), sketch);
        assert(built.ok, `${extra.kind} builds: ${built.ok ? "" : built.message}`);
        if (!built.ok) continue;
        assert((built.warnings ?? []).some((note) => note.includes("crosses the outline")), `the ${extra.kind} reports the circle that was left out: ${JSON.stringify(built.warnings ?? null)}`);
      }
    }
  },
  {
    name: "region N2-08: lofting two profiles on one plane is refused by name instead of adding a zero-volume body, and perpendicular profiles get a message that explains the elbow",
    run: async () => {
      const first = committedSketch("datum:xy", [pipelineCirc("c", 0, 0, 10)]);
      const loftOf = async (second: ReturnType<typeof committedSketch>) => {
        const lookup = sketchLookupOf(designOf(second.project));
        const target = detectSketchProfiles(second.sketch.sketch)[0]!;
        return rebuildFeature({ id: "feature:l", name: "l", kind: "loft", suppressed: false, sketchFeatureId: first.sketch.id, valueMm: 50, bodyId: "general-body:l", profileIds: [detectSketchProfiles(first.sketch.sketch)[0]!.id], loftSecondarySketchFeatureId: second.sketch.id, loftSecondaryProfileIds: [target.id] }, first.sketch, "#b9c2c8", lookup);
      };
      const samePlane = await loftOf(committedSketch("datum:xy", [pipelineRect("r", 0, 0, 30, 30)], { project: first.project, featureId: "feature:b" }));
      assert(!samePlane.ok && samePlane.message.includes("same plane") && samePlane.message.includes("no height"), `same plane: ${samePlane.ok ? "accepted" : samePlane.message}`);
      const elbow = await loftOf(committedSketch("datum:xz", [pipelineRect("r", 0, 0, 30, 30)], { project: first.project, featureId: "feature:b", offsetMm: -60 }));
      assert(!elbow.ok && elbow.message.includes("perpendicular") && elbow.message.includes("sweep along a path") && !elbow.message.includes("no area"), `elbow: ${elbow.ok ? "accepted" : elbow.message}`);
      const facing = await loftOf(committedSketch("datum:xy", [pipelineRect("r", 0, 0, 30, 30)], { project: first.project, featureId: "feature:b", offsetMm: 60 }));
      assert(facing.ok, `parallel planes still loft: ${facing.ok ? "" : facing.message}`);
      const tilted = await loftOf(committedSketch("datum:xy", [pipelineRect("r", 0, 0, 30, 30)], { project: first.project, featureId: "feature:b", offsetMm: 60, tilt: { axis: "y", angleDeg: 30 } }));
      assert(tilted.ok, `a tilted second profile still lofts: ${tilted.ok ? "" : tilted.message}`);
      if (tilted.ok) near(meshReport(tilted.body.positionsMm, tilted.body.indices).signedVolume, 33274, 100, "the tilted loft keeps its volume");
    }
  },
  {
    name: "region N2-09: sweepDirectionMm is a WORLD direction on a tilted sketch plane: the world normal is a plain extrude and (0, 0, 1) is a sheared sweep",
    run: async () => {
      const ring = [pipelineCirc("o", 0, 0, 10), pipelineCirc("i", 0, 0, 6)];
      const tilted = committedSketch("datum:xy", ring, { tilt: { axis: "y", angleDeg: 30 } }).sketch;
      const profile = [...detectSketchProfiles(tilted.sketch)].sort((a: SketchProfile, b: SketchProfile) => b.areaMm2 - a.areaMm2).find((candidate: SketchProfile) => (candidate.holes?.length ?? 0) > 0)!;
      const area = Math.PI * (100 - 36);
      const along = async (direction: readonly [number, number, number]) => {
        const body = solidOf(await buildSolid(tilted, "sweep", { sweepDirectionMm: direction, valueMm: 50, profileIds: [profile.ref!] }));
        return meshReport(body.positionsMm, body.indices).signedVolume;
      };
      const normal: readonly [number, number, number] = [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)];
      near(await along(normal), area * 50, area * 50 * 0.01, "the world normal of the tilted plane sweeps straight (the volume of an extrude)");
      near(await along([0, 0, 1]), area * 50 * Math.cos(Math.PI / 6), area * 50 * 0.01, "(0, 0, 1) is oblique to the tilted plane: the volume is the section times the height along the normal");
      const flat = committedSketch("datum:xy", ring).sketch;
      const flatProfile = [...detectSketchProfiles(flat.sketch)].sort((a: SketchProfile, b: SketchProfile) => b.areaMm2 - a.areaMm2).find((candidate: SketchProfile) => (candidate.holes?.length ?? 0) > 0)!;
      const flatBody = solidOf(await buildSolid(flat, "sweep", { sweepDirectionMm: [0, 0, 1], valueMm: 50, profileIds: [flatProfile.ref!] }));
      near(meshReport(flatBody.positionsMm, flatBody.indices).signedVolume, area * 50, area * 50 * 0.01, "on a plain datum plane the direction is unchanged");
    }
  },
  {
    name: "region R2-02: a line a few microns off the crossing of two circles keeps every face (x = 6.007 gave 2 faces and half the area), and Validate says the intersections were merged",
    run: () => {
      const circles = [circ("a", [0, 0], 10), circ("b", [12, 0], 10)];
      const exact = detectSketchProfiles(sketchOf([...circles, line("l", [6, -15], [6, 15])]));
      const total = exact.reduce((sum, profile) => sum + profile.areaMm2, 0);
      equal(exact.length, 4, "the exactly concurrent scene has four faces");
      for (const x of [6.001, 6.003, 6.004, 6.005, 6.006, 6.007, 6.008, 6.0085, 6.009, 6.0095, 6.01, 6.012, 6.02]) {
        const profiles = detectSketchProfiles(sketchOf([...circles, line("l", [x, -15], [x, 15])]));
        assert(profiles.length === 4 || profiles.length === 6, `x = ${x}: four faces (merged) or six (apart), got ${profiles.length}`);
        near(profiles.reduce((sum, profile) => sum + profile.areaMm2, 0), total, 0.6, `x = ${x}: the faces still cover the same area`);
      }
      const report = analyzeSketch(editKit.context(editKit.projectWith([editKit.circle("a", [0, 0], 10), editKit.circle("b", [12, 0], 10), editKit.line("l", [6.004, -15], [6.004, 15])])));
      assert(report.issues.some((issue) => issue.category === "region" && /only [0-9.]+ mm apart/u.test(issue.detail)), `Validate reports the merged intersections: ${report.issues.map((issue) => issue.title).join(" | ")}`);
      const clean = analyzeSketch(editKit.context(editKit.projectWith([editKit.circle("a", [0, 0], 10), editKit.circle("b", [12, 0], 10), editKit.line("l", [6, -15], [6, 15])])));
      assert(!clean.issues.some((issue) => /only [0-9.]+ mm apart/u.test(issue.detail)), "an exact concurrency is not reported");
    }
  },
  {
    name: "region R2-02: a circle that passes 0.013 mm from a rectangle corner keeps its three faces (the order of curves leaving a vertex was decided by a direction measured a millimetre away)",
    run: () => {
      const profiles = detectSketchProfiles(sketchOf([circ("c", [-7.262, -23.823], 5.457), { ...rect("r", [-16.94, -22.33], 19.679, 13.869) }]));
      equal(profiles.length, 3, "rectangle minus circle, circle inside the rectangle and the bulge outside it");
      const union = 19.679 * 13.869 + Math.PI * 5.457 ** 2;
      const covered = profiles.reduce((sum, profile) => sum + profile.areaMm2, 0);
      assert(covered < union && covered > union - 100, `the faces cover the union (${covered.toFixed(1)})`);
    }
  },
  ...regionWave3SelectTests
];

