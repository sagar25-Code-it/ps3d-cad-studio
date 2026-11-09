import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { detectSketchProfiles, type SketchProfile } from "../packages/workbench-sketch/src/index.js";
import type { SketchEntity } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circ, line, rect, sketchFeatureOf, sketchOf, solidFeature } from "./region-wave2-kit.js";
import { meshReport } from "./region-wave3-kit.js";
import { designOf, type DesignSketchFeature, type DesignSolidFeature } from "../packages/workbench-core/src/index.js";
import { filletCorners } from "../packages/workbench-sketch/src/edit-tools.js";
import { profileBaseOf } from "../packages/workbench-sketch/src/profile-regions.js";
import { commitWorkingSketchAtomically } from "../apps/studio-web/src/sketch-session.js";
import { isLegacyProfileId } from "../apps/studio-web/src/legacy-profile-refs.js";
import * as editKit from "./sketch-edit-kit.js";
import { breakAtIntersections } from "../packages/workbench-sketch/src/break-intersections.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { buildSolid, committedSketch, pipelineRun, solidOf } from "./pipeline-kit.js";

/**
 * Region engine, wave 3, stored references: what a feature keeps when the sketch under it changes (a hole that gets an outline drawn
 * around it or is redrawn, a region divided by a new line), and how a selection that touches itself at a corner is handled.
 */

const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => meshReport(body.positionsMm, body.indices).signedVolume;

export const regionWave3SelectTests: readonly TestCase[] = [
  {
    name: "region R2-03: a stored plate-with-hole reference keeps its hole when an outline is drawn around it or the hole is redrawn (was a solid plate, no message)",
    run: async () => {
      const base = [rect("plate", [0, 0], 80, 40), circ("c", [-18, 0], 3)];
      const plate = detectSketchProfiles(sketchOf(base)).find((profile) => (profile.holes?.length ?? 0) === 1 && profile.areaMm2 > 3000)!;
      const ref = plate.ref!;
      const expected = (3200 - Math.PI * 9) * 10;
      const build = async (entities: readonly SketchEntity[]) => {
        const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf(entities)));
        assert(built.ok, `the feature rebuilds: ${built.ok ? "" : built.message}`);
        if (!built.ok) throw new Error("unreachable");
        return { volume: volumeOf(built.body), warnings: built.warnings ?? [] };
      };
      near((await build(base)).volume, expected, expected * 0.002, "the original plate");
      const variants: readonly (readonly [string, readonly SketchEntity[]])[] = [
        ["a concentric circle r8", [circ("big", [-18, 0], 8)]],
        ["a concentric circle r3.5", [circ("ring", [-18, 0], 3.5)]],
        ["an inner rectangle 74 x 34", [rect("inner", [0, 0], 74, 34)]],
        ["a counterbore circle r8 and an inner rectangle", [circ("big", [-18, 0], 8), rect("inner", [0, 0], 74, 34)]]
      ];
      for (const [name, extra] of variants) {
        const result = await build([...base, ...extra]);
        near(result.volume, expected, expected * 0.002, `${name} drawn around the hole: the through hole stays`);
      }
      const hexagon = Array.from({ length: 6 }, (_, index) => line(`x${index}`, [-18 + 3 * Math.cos((index * Math.PI) / 3), 3 * Math.sin((index * Math.PI) / 3)], [-18 + 3 * Math.cos(((index + 1) * Math.PI) / 3), 3 * Math.sin(((index + 1) * Math.PI) / 3)]));
      const redrawn = await build([rect("plate", [0, 0], 80, 40), ...hexagon]);
      near(redrawn.volume, (3200 - ((3 * Math.sqrt(3)) / 2) * 9) * 10, 40, "the hole redrawn as a hexagon is still a hole (the new shape)");
      assert(redrawn.warnings.some((note) => /drawn again/u.test(note)), `and the replacement is announced: ${redrawn.warnings.join(" | ")}`);
    }
  },
  {
    name: "region R2-04: after the outline is replaced by new lines and an inner loop is added, a reference to the plate does not turn into the 3 mm frame (was 6840)",
    run: async () => {
      const plateSketch = sketchOf([rect("plate", [0, 0], 80, 40), circ("c", [-18, 0], 3)]);
      const ref = detectSketchProfiles(plateSketch).find((profile) => (profile.holes?.length ?? 0) === 1 && profile.areaMm2 > 3000)!.ref!;
      const outline = [line("a", [-40, -20], [40, -20]), line("b", [40, -20], [40, 20]), line("c2", [40, 20], [-40, 20]), line("d", [-40, 20], [-40, -20])];
      const inner = [line("ia", [-37, -17], [37, -17]), line("ib", [37, -17], [37, 17]), line("ic", [37, 17], [-37, 17]), line("id", [-37, 17], [-37, -17])];
      const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([...outline, ...inner, circ("c", [-18, 0], 3)])));
      const expected = (3200 - Math.PI * 9) * 10;
      if (built.ok) near(volumeOf(built.body), expected, expected * 0.002, "the plate keeps its full area and its hole");
      else assert(/region|plate/iu.test(built.message), `or the feature refuses by naming the region: ${built.message}`);
      assert(!built.ok || volumeOf(built.body) > 30000, "never the 3 mm frame");
    }
  },
  {
    name: "region R2-09: regions whose union touches itself at a corner are refused with the corner named, and pieces that only meet at a corner are warned about",
    run: async () => {
      const grid: SketchEntity[] = [];
      for (let index = 0; index <= 3; index += 1) { grid.push(line(`h${index}`, [0, index * 10], [30, index * 10])); grid.push(line(`v${index}`, [index * 10, 0], [index * 10, 30])); }
      const sketch = sketchOf(grid);
      const faces = detectSketchProfiles(sketch);
      const cell = (i: number, j: number): SketchProfile => faces.find((face) => Math.abs(face.centroid[0] - (i * 10 + 5)) < 1 && Math.abs(face.centroid[1] - (j * 10 + 5)) < 1)!;
      const all = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [i, j] as const));
      const pick = (skip: readonly (readonly [number, number])[]): string[] => all.filter(([i, j]) => !skip.some(([a, b]) => a === i && b === j)).map(([i, j]) => cell(i, j).ref!);
      const pinched = await rebuildSolidFeature(solidFeature("extrude", { profileIds: pick([[0, 0], [1, 1]]) }), sketchFeatureOf(sketch));
      assert(!pinched.ok && /corner \(10, 10\)/u.test(pinched.message) && !/crosses itself/u.test(pinched.message), `the pinch names the corner: ${pinched.ok ? "accepted" : pinched.message}`);
      const diagonal = await rebuildSolidFeature(solidFeature("extrude", { profileIds: pick([[1, 0], [0, 1]]) }), sketchFeatureOf(sketch));
      assert(diagonal.ok && (diagonal.warnings ?? []).some((note) => /meet only at a corner/u.test(note)), `separate pieces that meet at a corner are warned about: ${diagonal.ok ? (diagonal.warnings ?? []).join(" | ") : diagonal.message}`);
      const ring = await rebuildSolidFeature(solidFeature("extrude", { profileIds: pick([[1, 1]]) }), sketchFeatureOf(sketch));
      assert(ring.ok, "a ring of eight cells with the middle one left out still builds");
    }
  },
  {
    name: "region R2-10: a hole that touches the outline is named by its curves, not by an internal region hash",
    run: async () => {
      const sketch = sketchOf([rect("plate", [0, 0], 40, 40), circ("a", [14.995, 0], 5)]);
      const ref = [...detectSketchProfiles(sketch)].sort((left, right) => right.areaMm2 - left.areaMm2)[0]!.ref!;
      const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketch));
      const text = built.ok ? (built.warnings ?? []).join(" ") : built.message;
      assert(/hole a touches the outline of/u.test(text), `the message names the hole: ${text}`);
      assert(!/rg-[0-9a-f]{6}|region-[0-9a-f]{6}|profile:[a-z]/u.test(text), `and no internal id: ${text}`);
    }
  },
  {
    name: "region N-04: a reference whose region a new line or circle divided says so by name, with the part the feature no longer covers (1 mm from the edge and a circle across the edge were silent)",
    run: async () => {
      const sketch = sketchOf([rect("plate", [0, 0], 80, 10)]);
      const ref = detectSketchProfiles(sketch)[0]!.ref!;
      const cases: readonly (readonly [string, readonly SketchEntity[]])[] = [
        ["a line 1 mm from the edge", [line("cut", [39, -5], [39, 5])]],
        ["a line 0.2 mm from the edge", [line("cut", [39.8, -5], [39.8, 5])]],
        ["a circle across the edge", [circ("x", [40, 0], 3)]]
      ];
      for (const [name, extra] of cases) {
        const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([rect("plate", [0, 0], 80, 10), ...extra])));
        assert(built.ok, `${name}: still builds on the best-matching part`);
        if (!built.ok) continue;
        assert((built.warnings ?? []).some((note) => /divided by new geometry/u.test(note) && /no longer in this feature/u.test(note)), `${name}: the division is reported: ${(built.warnings ?? []).join(" | ") || "silent"}`);
      }
      const quiet = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([rect("plate", [0, 0], 80, 10)])));
      assert(quiet.ok && (quiet.warnings ?? []).length === 0, "an unchanged sketch says nothing");
    }
  },
  {
    name: "region P-05: a feature that stored a bare legacy profile id is upgraded from the committed sketch when the sketch is finished, so it survives a fillet with two regions left (was 'no longer exists')",
    run: async () => {
      const square = (prefix: string, at: number): SketchEntity[] => [
        line(`${prefix}0`, [at, 0], [at + 20, 0]), line(`${prefix}1`, [at + 20, 0], [at + 20, 20]), line(`${prefix}2`, [at + 20, 20], [at, 20]), line(`${prefix}3`, [at, 20], [at, 0])
      ];
      const joints = (prefix: string) => [["j0", "0", "1"], ["j1", "1", "2"], ["j2", "2", "3"], ["j3", "3", "0"]].map(([id, a, b]) => editKit.constraint(`${prefix}${id!}`, "coincident", [`${prefix}${a!}`, `${prefix}${b!}`], { points: ["end", "start"] }));
      const { project, sketch } = committedSketch("datum:xy", [...square("s", 0), ...square("t", 40)], { constraints: [...joints("s"), ...joints("t")] });
      const first = detectSketchProfiles(sketch.sketch).find((profile) => profile.centroid[0] < 20)!;
      const legacy = profileBaseOf(first.id);
      assert(isLegacyProfileId(legacy) && !isLegacyProfileId(first.id), `${legacy} is a bare id and ${first.id} is a full one`);
      const feature: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [legacy], valueMm: 10, bodyId: "general-body:extrude-1" };
      const body = solidOf(await buildSolid(sketch, "extrude", { profileIds: [legacy] }));
      let current = pipelineRun(project, { kind: "add-design-solid", feature, body });
      current = pipelineRun(current, { kind: "edit-design-sketch", featureId: sketch.id });
      const fillet = filletCorners(editKit.context(current), ["entity:s0", "entity:s1"], 3);
      const edited = editKit.commitOk(current, fillet);
      const finished = await commitWorkingSketchAtomically(edited, { featureId: "feature:sketch-9", name: "Sketch 9" });
      assert(finished.ok, `Finish is accepted: ${finished.ok ? "" : finished.message}`);
      if (!finished.ok) return;
      equal(finished.value.failed.length, 0, `the feature rebuilds after the fillet: ${finished.value.failed.map((result) => result.message).join(" | ")}`);
      const stored = designOf(finished.value.project).features.find((candidate): candidate is DesignSolidFeature => candidate.id === "feature:extrude-1" && candidate.kind !== "sketch")!;
      assert(!stored.profileIds.some(isLegacyProfileId), `the stored id was upgraded to a full reference: ${stored.profileIds.join(", ")}`);
      const rebuilt = (finished.value.project.part.generalBodies ?? []).find((candidate) => candidate.id === "general-body:extrude-1")!;
      near(volumeOf(rebuilt), (400 - ((4 - Math.PI) * 9) / 4) * 10, 5, "and it is the filleted plate, not the other square");
    }
  },
  {
    name: "region P-05: a bare id whose curves are already gone is reported by feature name with the reason, never guessed (two regions left)",
    run: async () => {
      const filletedSquare: SketchEntity[] = [line("a", [3, 0], [17, 0]), line("b", [17, 0], [17, 14]), line("c", [17, 14], [3, 14]), line("d", [3, 14], [3, 0])];
      const other: SketchEntity[] = [line("o0", [40, 0], [60, 0]), line("o1", [60, 0], [60, 20]), line("o2", [60, 20], [40, 20]), line("o3", [40, 20], [40, 0])];
      const sketch = sketchFeatureOf(sketchOf([...filletedSquare, ...other]));
      const built = await rebuildSolidFeature({ ...solidFeature("extrude", { profileIds: ["profile:loop-0badc0de"] }), name: "Extrude 7" }, sketch);
      assert(!built.ok && built.message.includes("Extrude 7") && /older file stored it by name only/u.test(built.message) && /pick the profile again/u.test(built.message), `the message names the feature, the reason and the fix: ${built.ok ? "accepted" : built.message}`);
      void ({} as DesignSketchFeature);
    }
  },
  {
    name: "region R2-07: break at intersections joins the pieces that meet at a crossing, so resizing the divider keeps its regions, and Validate no longer calls the square an open chain",
    run: () => {
      const square = [editKit.line("s0", [0, 0], [20, 0]), editKit.line("s1", [20, 0], [20, 20]), editKit.line("s2", [20, 20], [0, 20]), editKit.line("s3", [0, 20], [0, 0])];
      const joints = [["j0", "s0", "s1"], ["j1", "s1", "s2"], ["j2", "s2", "s3"], ["j3", "s3", "s0"]].map(([id, a, b]) => editKit.constraint(id!, "coincident", [a!, b!], { points: ["end", "start"] }));
      const project = editKit.projectWith([...square, editKit.line("d", [-3, 10], [23, 10])], joints);
      assert(detectSketchProfiles(project.sketch).length === 2, "the divider splits the square into two regions");
      const broken = editKit.commitOk(project, breakAtIntersections(editKit.context(project)));
      const lines = broken.sketch.entities.filter((entity) => entity.kind === "line");
      // Every end that lies at a crossing is tied to the others there.
      const coincident = broken.sketch.constraints.filter((constraint) => constraint.kind === "coincident" && constraint.points !== undefined);
      const key = (id: string, point: string): string => `${id}|${point}`;
      const parent = new Map<string, string>();
      const find = (value: string): string => { let current = value; while ((parent.get(current) ?? current) !== current) current = parent.get(current)!; return current; };
      for (const constraint of coincident) parent.set(find(key(constraint.entityIds[0]!, constraint.points![0]!)), find(key(constraint.entityIds[1]!, constraint.points![1]!)));
      for (const crossing of [[0, 10], [20, 10]] as const) {
        const here: string[] = [];
        for (const entity of lines) {
          if (entity.kind !== "line") continue;
          if (Math.hypot(entity.start[0] - crossing[0], entity.start[1] - crossing[1]) < 0.05) here.push(key(entity.id, "start"));
          if (Math.hypot(entity.end[0] - crossing[0], entity.end[1] - crossing[1]) < 0.05) here.push(key(entity.id, "end"));
        }
        assert(here.length >= 4, `four line ends meet at (${crossing.join(", ")}): ${here.length}`);
        equal(new Set(here.map(find)).size, 1, `the ends at (${crossing.join(", ")}) are one joint`);
      }
      // The middle piece of the divider is resized: the regions must follow it.
      const middle = lines.find((entity) => entity.kind === "line" && Math.abs(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]) - 20) < 0.01 && Math.abs(entity.start[1] - 10) < 0.01 && Math.abs(entity.end[1] - 10) < 0.01)!;
      const resized = applyWorkbenchOperation(broken, { kind: "set-sketch-dimension", operationId: "operation:r2-07-resize", expectedRevision: broken.revision, entityId: middle.id, dimension: "length", valueMm: 30 });
      assert(resized.ok, `the divider is resized: ${resized.ok ? "" : resized.diagnostics[0]?.message}`);
      if (!resized.ok) return;
      const faces = detectSketchProfiles(resized.value.project.sketch);
      equal(faces.length, 2, "the two regions are still there after the resize");
      const report = analyzeSketch(editKit.context(broken));
      assert(!report.issues.some((issue) => issue.category === "open-chain" && issue.severity === "warning"), `Validate does not report an open chain: ${report.issues.map((issue) => issue.title).join(" | ")}`);
    }
  }
];
