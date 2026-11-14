import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { describePickedEdge, pickableEdges, type PickableEdge } from "../packages/workbench-geometry/src/index.js";
import { deltaMmFromDrag, END_ON_RATIO, hitHandle, pointToSegmentPx, projectHandleAxis, valueFromDrag, type Mm3, type Pixel } from "../packages/viewport-three/src/handle-drag.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { facesOfBody } from "../apps/studio-web/src/edge-blend-step.js";
import { openCommandPanel, openCommandPanelForEdit, panelAddFace, panelSetHolePoint, panelToggleEdge, panelWithValue, type PanelEdgeSet } from "../apps/studio-web/src/command-panel.js";
import { createPreviewController, previewNote, type PreviewBuild, type PreviewGhost, type PreviewRequest, type PreviewState } from "../apps/studio-web/src/part-preview.js";
import { featurePreviewRequest, panelCandidate, panelPreviewRequest } from "../apps/studio-web/src/part-preview-build.js";
import { edgeBlendDirection, extrudeHandleSpec, handleDragValue, handleTipDistanceMm, handleValueText, normalsAlongEdge, previewHandleSpec } from "../apps/studio-web/src/part-preview-handle.js";
import { createValueBridge, dockPreviewFor, dockPreviewOf } from "../apps/studio-web/src/part-preview-bridge.js";
import { dockCandidate } from "../apps/studio-web/src/edit-dock-candidate.js";
import { CommandPanel } from "../apps/studio-web/src/ui/CommandPanel.js";
import { FeatureEditDialog } from "../apps/studio-web/src/ui/FeatureEditDialog.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Live preview of features: the controller (debounce, stale cancellation, time budget, failure keeps the last ghost, invalid inputs show
 * none), the ghost builder (the result of the typed values on a COPY of the project, never the project), and the drag arrow's maths and
 * placement. The 3D view itself (pointer events, drawing) is not rendered here; see the report for what a real browser must still confirm.
 */

// ---------------------------------------------------------------------------------------------------- controller harness

interface Timer { readonly at: number; readonly fn: () => void; readonly id: number }

function harness(options: { readonly debounceMs?: number; readonly maxWaitMs?: number; readonly budgetMs?: number } = {}) {
  let clock = 1000;
  let nextId = 0;
  let timers: Timer[] = [];
  const ghosts: { readonly ghost: PreviewGhost | null; readonly stale: boolean }[] = [];
  const states: PreviewState[] = [];
  const controller = createPreviewController({
    ...options,
    now: () => clock,
    setTimer: (fn, ms) => { const timer = { at: clock + ms, fn, id: nextId += 1 }; timers.push(timer); return timer; },
    clearTimer: (handle) => { timers = timers.filter((timer) => timer !== handle); },
    onGhost: (ghost, meta) => { ghosts.push({ ghost, stale: meta.stale }); },
    onState: (state) => { states.push(state); }
  });
  const flush = async (): Promise<void> => { for (let turn = 0; turn < 6; turn += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
  const advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (due === undefined) break;
      timers = timers.filter((timer) => timer !== due);
      clock = Math.max(clock, due.at);
      due.fn();
      await flush();
    }
    clock = target;
    await flush();
  };
  return { controller, ghosts, states, advance, flush, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

const ghostOf = (tag: number): PreviewGhost => ({ positionsMm: [0, 0, 0, tag, 0, 0, 0, tag, 0], indices: [0, 1, 2] });
const request = (key: string, build: PreviewRequest["build"]): PreviewRequest => ({ key, build });
const lastShown = (ghosts: readonly { readonly ghost: PreviewGhost | null }[]): PreviewGhost | null => ghosts.length === 0 ? null : ghosts[ghosts.length - 1]!.ghost;

// ---------------------------------------------------------------------------------------------------- project fixtures

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-preview-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const BODY = "general-body:preview-block";
const rectangle = (width: number, height: number): SketchEntity => ({ id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;

/** A 60 x 40 x 20 block from one sketch and one extrude, the base of every ghost below. */
async function blockProject(): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature; extrude: DesignSolidFeature }> {
  let project = createWorkbenchProject(`project:test-preview-${serial += 1}`);
  project = { ...project, sketch: { ...project.sketch, entities: [rectangle(60, 40)], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, `the block builds: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  return { project, sketch, extrude };
}

function edgePickOf(project: WorkbenchProject, chainOrdinal: number): PanelEdgeSet {
  const body = bodyOf(project);
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices }, 5, { includeConcave: true });
  assert(typeof edges !== "string", typeof edges === "string" ? edges : "");
  if (typeof edges === "string") throw new Error("unreachable");
  const chains = [...new Set(edges.map((edge) => edge.chain))];
  const chain = chains[chainOrdinal]!;
  const chainEdges: readonly PickableEdge[] = edges.filter((edge) => edge.chain === chain);
  return { bodyId: body.id, chain, group: describePickedEdge(chainEdges, facesOfBody(body)), segments: chainEdges.map((edge) => [edge.a, edge.b] as const), summary: "an edge" };
}

const run2 = async (candidate: PreviewRequest | { readonly invalid: string }): Promise<PreviewBuild> => {
  assert(!("invalid" in candidate), `the request is buildable: ${"invalid" in candidate ? candidate.invalid : ""}`);
  if ("invalid" in candidate) throw new Error("unreachable");
  return candidate.build({ isStale: () => false });
};

const centreOf = (body: { readonly positionsMm: readonly number[] }): Mm3 => {
  let x = 0; let y = 0; let z = 0; const count = body.positionsMm.length / 3;
  for (let index = 0; index < body.positionsMm.length; index += 3) { x += body.positionsMm[index]!; y += body.positionsMm[index + 1]!; z += body.positionsMm[index + 2]!; }
  return [x / count, y / count, z / count];
};

// ---------------------------------------------------------------------------------------------------- tests

export const partPreviewTests: readonly TestCase[] = [
  {
    name: "Preview controller: a burst of changes builds once after the pause, with the newest inputs",
    run: async () => {
      const h = harness({ debounceMs: 120, maxWaitMs: 1000 });
      const built: string[] = [];
      for (let index = 1; index <= 5; index += 1) {
        h.controller.preview(request(`radius ${index}`, () => { built.push(`radius ${index}`); return { ok: true, ghost: ghostOf(index) }; }));
        await h.advance(30);
      }
      equal(built.length, 0, "nothing is built while the changes keep coming");
      await h.advance(200);
      equal(built.join(","), "radius 5", "one build, for the newest inputs");
      equal(lastShown(h.ghosts)?.positionsMm[3], 5, "the ghost on screen is the newest result");
      assert(h.states.some((state) => state.state === "ready"), "the panel is told the preview is ready");
    }
  },
  {
    name: "Preview controller: a continuous stream of changes (a drag) still refreshes the ghost every so often",
    run: async () => {
      const h = harness({ debounceMs: 120, maxWaitMs: 250 });
      let builds = 0;
      for (let index = 0; index < 20; index += 1) {
        h.controller.preview(request(`drag ${index}`, () => { builds += 1; return { ok: true, ghost: ghostOf(index + 1) }; }));
        await h.advance(50);
      }
      assert(builds >= 3, `the ghost kept up during one second of dragging: ${builds} builds`);
      assert(builds <= 6, `but not one build per change: ${builds} builds for 20 changes`);
    }
  },
  {
    name: "Preview controller: a result for inputs that were replaced meanwhile is never shown, and builds run one at a time",
    run: async () => {
      const h = harness({ debounceMs: 100, maxWaitMs: 1000 });
      const resolvers = new Map<string, (build: PreviewBuild) => void>();
      let running = 0;
      let overlap = 0;
      const slow = (key: string, tag: number): PreviewRequest => request(key, () => new Promise<PreviewBuild>((resolve) => {
        running += 1; overlap = Math.max(overlap, running);
        resolvers.set(key, (build) => { running -= 1; resolve(build); void tag; });
      }));
      h.controller.preview(slow("A", 1));
      await h.advance(150);
      assert(resolvers.has("A"), "A is being built");
      h.controller.preview(slow("B", 2));
      await h.advance(150);
      assert(!resolvers.has("B"), "B waits for the running build instead of running beside it");
      resolvers.get("A")!({ ok: true, ghost: ghostOf(1) });
      await h.flush();
      assert(lastShown(h.ghosts) === null || lastShown(h.ghosts)?.positionsMm[3] !== 1, "the result of A is stale and is not drawn");
      assert(resolvers.has("B"), "B starts as soon as A is done");
      resolvers.get("B")!({ ok: true, ghost: ghostOf(2) });
      await h.flush();
      equal(lastShown(h.ghosts)?.positionsMm[3], 2, "only the newest result reaches the view");
      equal(overlap, 1, "never two builds at once");
    }
  },
  {
    name: "Preview controller: a build that fails keeps the last good ghost (greyed) and says why; the same inputs are not retried",
    run: async () => {
      const h = harness();
      let failures = 0;
      h.controller.preview(request("good", () => ({ ok: true, ghost: ghostOf(7) })));
      await h.advance(200);
      equal(lastShown(h.ghosts)?.positionsMm[3], 7, "the good ghost is shown");
      equal(h.ghosts[h.ghosts.length - 1]!.stale, false, "and drawn as current");
      const bad = request("bad", () => { failures += 1; return { ok: false, message: "A fillet of 30 mm does not fit on this edge." }; });
      h.controller.preview(bad);
      await h.advance(200);
      equal(lastShown(h.ghosts)?.positionsMm[3], 7, "the view still shows the last good ghost");
      equal(h.ghosts[h.ghosts.length - 1]!.stale, true, "drawn greyed so it is not taken for the result");
      const state = h.states[h.states.length - 1]!;
      assert(state.state === "refused" && state.showingLast, "the panel is told the preview was refused");
      assert(/does not fit/.test(previewNote(state) ?? "") && /last result that worked/.test(previewNote(state) ?? ""), `the note names the reason and the kept ghost: ${previewNote(state)}`);
      h.controller.preview(bad);
      await h.advance(200);
      equal(failures, 1, "the same failing inputs are not built again");
      h.controller.preview(request("fixed", () => ({ ok: true, ghost: ghostOf(9) })));
      await h.advance(200);
      equal(h.ghosts[h.ghosts.length - 1]!.stale, false, "a later good build replaces the greyed ghost");
      equal(lastShown(h.ghosts)?.positionsMm[3], 9, "with the new result");
    }
  },
  {
    name: "Preview controller: a build over the time budget is refused with the time named, and the last ghost stays",
    run: async () => {
      const h = harness({ budgetMs: 300 });
      h.controller.preview(request("quick", () => ({ ok: true, ghost: ghostOf(1) })));
      await h.advance(200);
      let heavyBuilds = 0;
      const heavy = request("heavy", () => { heavyBuilds += 1; h.tick(480); return { ok: true, ghost: ghostOf(2) }; });
      h.controller.preview(heavy);
      await h.advance(200);
      equal(lastShown(h.ghosts)?.positionsMm[3], 1, "the slow result is not drawn");
      const state = h.states[h.states.length - 1]!;
      assert(state.state === "slow" && state.ms >= 480 && state.budgetMs === 300, "the state records the time and the budget");
      assert(/480 ms/.test(previewNote(state) ?? "") && /300 ms/.test(previewNote(state) ?? "") && /OK still builds/.test(previewNote(state) ?? ""), `the note says so: ${previewNote(state)}`);
      h.controller.preview(heavy);
      await h.advance(200);
      equal(heavyBuilds, 1, "the slow inputs are not retried until they change");
    }
  },
  {
    name: "Preview controller: invalid inputs build nothing and show no ghost; clear removes the ghost and drops work still running",
    run: async () => {
      const h = harness();
      let builds = 0;
      h.controller.preview(request("ok", () => { builds += 1; return { ok: true, ghost: ghostOf(3) }; }));
      await h.advance(200);
      equal(builds, 1, "a valid request builds");
      h.controller.preview({ invalid: "Radius: enter a number." });
      await h.flush();
      equal(builds, 1, "invalid inputs build nothing");
      equal(lastShown(h.ghosts), null, "and the ghost is removed (a wrong ghost would mislead more than none)");
      const state = h.states[h.states.length - 1]!;
      assert(state.state === "invalid" && /enter a number/.test(previewNote(state) ?? ""), "the reason is reported");
      // Clear while a build is in flight: its late result must not bring the ghost back.
      let release: ((build: PreviewBuild) => void) | undefined;
      h.controller.preview(request("late", () => new Promise<PreviewBuild>((resolve) => { release = resolve; })));
      await h.advance(200);
      assert(release !== undefined, "the build is running");
      h.controller.clear();
      release!({ ok: true, ghost: ghostOf(5) });
      await h.flush();
      equal(lastShown(h.ghosts), null, "a result that arrives after clear is dropped");
      equal(h.states[h.states.length - 1]!.state, "idle", "the controller is idle again");
      h.controller.dispose();
      h.controller.preview(request("after dispose", () => { builds += 1; return { ok: true, ghost: ghostOf(1) }; }));
      await h.advance(300);
      equal(builds, 1, "a disposed controller does nothing");
    }
  },
  {
    name: "Preview controller: unchanged inputs are not rebuilt and the panel hears the earlier outcome again",
    run: async () => {
      const h = harness();
      let builds = 0;
      const same = request("same", () => { builds += 1; return { ok: true, ghost: ghostOf(4) }; });
      h.controller.preview(same);
      await h.advance(200);
      h.controller.preview(request("other", () => ({ ok: true, ghost: ghostOf(8) })));
      h.controller.preview(same);
      await h.advance(200);
      equal(builds, 1, "back to the settled inputs needs no rebuild");
      equal(h.states[h.states.length - 1]!.state, "ready", "and the panel is not left on 'updating'");
    }
  },
  {
    name: "Preview controller: a build that throws is a refusal with its message, not a crash",
    run: async () => {
      const h = harness();
      h.controller.preview(request("boom", () => { throw new Error("the kernel gave up"); }));
      await h.advance(200);
      const state = h.states[h.states.length - 1]!;
      assert(state.state === "refused" && /kernel gave up/.test(previewNote(state) ?? ""), "the failure is reported");
    }
  },
  {
    name: "Drag arrow maths: screen movement along the arrow becomes millimetres, and a field value that is stepped and held inside its limits",
    run: () => {
      // A view where 1 mm is 4 px and model +X runs right on the screen, +Z runs up.
      const project = (point: Mm3): Pixel => [100 + point[0] * 4, 300 - point[2] * 4];
      const axis = projectHandleAxis(project, [0, 0, 0], [0, 0, 1], 20, 4);
      assert(!axis.degenerate, "a vertical arrow in this view can be dragged");
      near(axis.pxPerMm, 4, 1e-9, "4 px per mm");
      near(axis.unitPx[1], -1, 1e-9, "model up is screen up (negative y)");
      near(deltaMmFromDrag(axis, [0, -40]), 10, 1e-9, "40 px up is 10 mm along the arrow");
      near(deltaMmFromDrag(axis, [0, 20]), -5, 1e-9, "20 px down is 5 mm back");
      near(deltaMmFromDrag(axis, [80, 0]), 0, 1e-9, "sideways movement does nothing");
      near(deltaMmFromDrag(axis, [30, -40]), 10, 1e-9, "only the part along the arrow counts");
      const slanted = projectHandleAxis(project, [0, 0, 0], [1, 0, 1], 10, 4);
      near(deltaMmFromDrag(slanted, [4 * Math.SQRT1_2 * 10, -4 * Math.SQRT1_2 * 10]), 10, 1e-6, "a slanted arrow measures along its own picture");
      // Value rules.
      equal(valueFromDrag({ startValue: 2, valuePerMm: 1, step: 0.1 }, 3.04), 5, "2 + 3.04 rounds to the tenth: 5");
      equal(valueFromDrag({ startValue: 2, valuePerMm: 0.5, step: 0.1 }, 3), 3.5, "a diameter shown as a radius changes by half");
      equal(valueFromDrag({ startValue: 2, valuePerMm: 1, min: 0, exclusiveMin: true, step: 0.1 }, -50), 0.1, "a radius never drags to zero or below");
      equal(valueFromDrag({ startValue: 2, valuePerMm: 1, min: 0, exclusiveMin: true }, -50), 0.001, "without a step the floor is a thousandth");
      equal(valueFromDrag({ startValue: 2, valuePerMm: 1, min: 0, max: 10, step: 0.1 }, 400), 10, "and never past the field's maximum");
      equal(valueFromDrag({ startValue: 2, valuePerMm: 1, step: 0.1 }, Number.NaN), 2, "a NaN movement leaves the value alone");
      equal(valueFromDrag({ startValue: 2, valuePerMm: 1, step: 0.01 }, 0.1 + 0.2), 2.3, "no floating-point noise in the result");
    }
  },
  {
    name: "Drag arrow hit test: the knob and the outer shaft grab it, the stretch beside the anchor does not (the edge stays pickable), and an arrow pointing at the viewer cannot be grabbed",
    run: () => {
      const project = (point: Mm3): Pixel => [100 + point[0] * 4, 300 - point[2] * 4];
      const axis = projectHandleAxis(project, [0, 0, 0], [0, 0, 1], 25, 4);
      assert(hitHandle(axis, [100, 200]), "the knob at the tip (100 px up) grabs it");
      assert(hitHandle(axis, [104, 215]), "a press near the tip within the knob grabs it");
      assert(hitHandle(axis, [103, 240]), "a press on the middle of the shaft grabs it");
      assert(!hitHandle(axis, [100, 295]), "a press at the anchor goes to the model underneath");
      assert(!hitHandle(axis, [140, 250]), "a press 40 px beside the shaft does not");
      near(pointToSegmentPx([5, 5], [0, 0], [10, 0]), 5, 1e-9, "point to segment distance");
      near(pointToSegmentPx([-3, 4], [0, 0], [10, 0]), 5, 1e-9, "beyond the end it is the distance to the end point");
      // End-on: the arrow runs along the line of sight, so one mm moves the tip less than END_ON_RATIO of a flat one.
      const endOn = projectHandleAxis((point) => [100 + point[0] * 4 + point[1] * 0.2, 300 - point[2] * 4], [0, 0, 0], [0, 1, 0], 20, 4);
      assert(endOn.degenerate && 0.2 < END_ON_RATIO * 4 + 1, "an end-on arrow is degenerate");
      assert(!hitHandle(endOn, endOn.tipPx), "and is never grabbed");
      near(deltaMmFromDrag(endOn, [50, 50]), 0, 1e-12, "dragging it changes nothing");
    }
  },
  {
    name: "Ghost builder: a fillet's ghost is the filleted block built on a copy of the project; the project, its history and its revision are untouched",
    run: async () => {
      const { project, sketch } = await blockProject();
      const revision = project.revision;
      const historyBefore = JSON.stringify(designOf(project).features);
      const solid = volumeOf(bodyOf(project));
      let state = openCommandPanel("fillet");
      state = panelToggleEdge(state, edgePickOf(project, 0), "Block");
      state = panelWithValue(state, "size", "2");
      const candidate = panelCandidate(project, state);
      assert(candidate.ok && candidate.timelineSketchId === sketch.id && candidate.feature.kind === "edge-blend", "the panel's values make a candidate step");
      const built = await run2(panelPreviewRequest(project, state));
      assert(built.ok, built.ok ? "" : built.message);
      if (!built.ok) return;
      assert(built.ghost.replacesBodyId === BODY, "the ghost stands in for the filleted solid");
      assert(volumeOf(built.ghost) < solid - 10, `the ghost has the fillet's material removed: ${volumeOf(built.ghost).toFixed(0)} < ${solid}`);
      assert(solidMetrics(built.ghost.positionsMm, built.ghost.indices).outward, "and is a closed outward solid");
      equal(project.revision, revision, "the project revision did not move");
      equal(JSON.stringify(designOf(project).features), historyBefore, "the history did not change");
      equal(volumeOf(bodyOf(project)), solid, "the real body is untouched");
      // A bigger radius removes more.
      const bigger = await run2(panelPreviewRequest(project, panelWithValue(state, "size", "4")));
      assert(bigger.ok && volumeOf(bigger.ghost) < volumeOf(built.ghost), "the ghost follows the typed value");
      // An expression works exactly as it does at commit.
      const typed = await run2(panelPreviewRequest(project, panelWithValue(state, "size", "1 + 1")));
      assert(typed.ok && Math.abs(volumeOf(typed.ghost) - volumeOf(built.ghost)) < 1e-6, "an arithmetic value previews like the number it makes");
    }
  },
  {
    name: "Ghost builder: no ghost for invalid inputs (nothing picked, not a number, out of range) and a refusal with the kernel's reason when it cannot build",
    run: async () => {
      const { project } = await blockProject();
      const empty = panelPreviewRequest(project, openCommandPanel("fillet"));
      assert("invalid" in empty && /edge/i.test(empty.invalid), "no edge picked: no request, and it says to click an edge");
      let state = openCommandPanel("fillet");
      state = panelToggleEdge(state, edgePickOf(project, 0), "Block");
      const junk = panelPreviewRequest(project, panelWithValue(state, "size", "abc"));
      assert("invalid" in junk && junk.invalid.length > 0, `a value that is not a number is invalid: ${"invalid" in junk ? junk.invalid : ""}`);
      const negative = panelPreviewRequest(project, panelWithValue(state, "size", "-3"));
      assert("invalid" in negative, "a negative radius is invalid");
      const huge = await run2(panelPreviewRequest(project, panelWithValue(state, "size", "400")));
      assert(!huge.ok && huge.message.length > 0, `a fillet far larger than the block is refused with a reason: ${huge.ok ? "" : huge.message}`);
      const noHolePoint = panelPreviewRequest(project, openCommandPanel("hole"));
      assert("invalid" in noHolePoint && /face/i.test(noHolePoint.invalid), "a hole with no start point asks for a face");
    }
  },
  {
    name: "Ghost builder: Shell and Hole previews are the shelled block and the drilled block; Edit Feature previews the edited value against the stored step without changing it",
    run: async () => {
      const { project } = await blockProject();
      const solid = volumeOf(bodyOf(project));
      const top = { pointMm: [0, 0, 20] as const, normalMm: [0, 0, 1] as const };
      let shell = openCommandPanel("shell");
      shell = { ...panelAddFace(shell, { ref: top, summary: "face" }), bodyId: BODY, bodyName: "Block" };
      shell = panelWithValue(shell, "wall", "2");
      const shelled = await run2(panelPreviewRequest(project, shell));
      assert(shelled.ok && volumeOf(shelled.ghost) < solid * 0.5, `the shelled block is mostly hollow: ${shelled.ok ? volumeOf(shelled.ghost).toFixed(0) : ""}`);
      let hole = openCommandPanel("hole");
      hole = panelSetHolePoint(hole, [10, 5, 20], [0, 0, 1], BODY, "Block");
      hole = panelWithValue(panelWithValue(hole, "diameter", "8"), "depth", "0");
      const drilled = await run2(panelPreviewRequest(project, hole));
      assert(drilled.ok, drilled.ok ? "" : drilled.message);
      if (drilled.ok) near(solid - volumeOf(drilled.ghost), Math.PI * 16 * 20, 120, `an 8 mm hole through 20 mm removes about ${(Math.PI * 16 * 20).toFixed(0)} mm³`);
      // Edit Feature: a fillet already on the timeline, the ghost of a different value; the stored step is not changed.
      const feature = await filletStep(project, 2);
      const withStep = run(project, { kind: "add-design-solid", feature, body: bodyOf(project) });
      const stored = JSON.stringify(designOf(withStep).features);
      const edited = openCommandPanelForEdit(feature, "Block");
      assert(edited !== undefined && edited.mode === "edit", "the stored fillet reopens in the panel");
      if (edited === undefined) return;
      const same = await run2(panelPreviewRequest(withStep, edited));
      const stronger = await run2(panelPreviewRequest(withStep, panelWithValue(edited, "size", "4")));
      assert(same.ok && stronger.ok, "the edit previews: " + (same.ok ? (stronger.ok ? "" : stronger.message) : same.message));
      if (!same.ok || !stronger.ok) return;
      assert(volumeOf(stronger.ghost) < volumeOf(same.ghost) - 1, "a bigger stored radius removes more in the ghost");
      equal(JSON.stringify(designOf(withStep).features), stored, "the stored step is unchanged by previewing the edit");
      // The finished-step entry point (what Extrude and Revolve use) gives the same ghost as the panel.
      const direct = await run2(featurePreviewRequest(withStep, { ...feature, valueMm: 4 }, "edit"));
      assert(direct.ok && Math.abs(volumeOf(direct.ghost) - volumeOf(stronger.ghost)) < 1e-6, "featurePreviewRequest gives the same ghost as the panel path");
    }
  },
  {
    name: "Drag arrow placement: a fillet arrow stands on the edge and points into the solid, a shell arrow into the wall, a hole arrow shows the radius; each is as long as its value",
    run: async () => {
      const { project } = await blockProject();
      const body = bodyOf(project);
      const centre = centreOf(body);
      let fillet = openCommandPanel("fillet");
      fillet = panelToggleEdge(fillet, edgePickOf(project, 0), "Block");
      fillet = panelWithValue(fillet, "size", "3");
      const candidate = panelCandidate(project, fillet);
      assert(candidate.ok, "the fillet candidate builds");
      if (!candidate.ok) return;
      const spec = previewHandleSpec(project, fillet, candidate.feature);
      assert(spec !== undefined, "a picked edge gets an arrow");
      if (spec === undefined) return;
      equal(spec.fieldId, "size", "it drives the radius field");
      const towards: Mm3 = [centre[0] - spec.anchorMm[0], centre[1] - spec.anchorMm[1], centre[2] - spec.anchorMm[2]];
      assert(towards[0] * spec.directionMm[0] + towards[1] * spec.directionMm[1] + towards[2] * spec.directionMm[2] > 0, "the arrow points into the solid, away from the edge");
      near(Math.hypot(...spec.directionMm), 1, 1e-9, "the direction is a unit vector");
      near(handleTipDistanceMm(spec), 3 * Math.SQRT2, 1e-9, "the arrow is as long as the radius reaches along the bisector");
      // Dragging the knob 1 mm further along the arrow grows the radius by 1/sqrt 2 mm, rounded to a tenth; Shift is ten times finer.
      near(handleDragValue(spec, 3, 1, false), 3.7, 1e-9, "1 mm of knob travel is 0.7 mm of radius");
      near(handleDragValue(spec, 3, 1, true), 3.71, 1e-9, "Shift gives hundredths");
      equal(handleDragValue(spec, 3, -100, false), 0.1, "dragging back past the edge stops at the smallest radius");
      equal(handleValueText(3.7000000000000002), "3.7", "the field gets clean text");
      // Two faces were found beside the picked run.
      const picked = edgePickOf(project, 0).segments[0]!;
      equal(normalsAlongEdge(body, picked[0], picked[1]).length, 2, "the mesh gives the two faces that meet at the edge");

      let shell = openCommandPanel("shell");
      shell = { ...panelAddFace(shell, { ref: { pointMm: [0, 0, 20], normalMm: [0, 0, 1] }, summary: "face" }), bodyId: BODY, bodyName: "Block" };
      const shellCandidate = panelCandidate(project, panelWithValue(shell, "wall", "2"));
      assert(shellCandidate.ok, "the shell candidate builds");
      if (!shellCandidate.ok) return;
      const wall = previewHandleSpec(project, panelWithValue(shell, "wall", "2"), shellCandidate.feature);
      assert(wall !== undefined && wall.fieldId === "wall", "an open face gets an arrow for the wall");
      if (wall === undefined) return;
      equal(wall.directionMm[2], -1, "an inside wall grows down from the open top face");
      near(handleTipDistanceMm(wall), 2, 1e-9, "as long as the wall");
      const outward = previewHandleSpec(project, panelWithValue(panelWithValue(shell, "wall", "2"), "side", "outside"), shellCandidate.feature);
      equal(outward?.directionMm[2], 1, "an outside wall grows out of the face");
      assert(previewHandleSpec(project, openCommandPanel("shell"), shellCandidate.feature) === undefined, "a shell with no face picked has no arrow");

      let hole = openCommandPanel("hole");
      hole = panelSetHolePoint(hole, [10, 5, 20], [0, 0, 1], BODY, "Block");
      hole = panelWithValue(hole, "diameter", "8");
      const holeCandidate = panelCandidate(project, hole);
      assert(holeCandidate.ok, "the hole candidate builds");
      if (!holeCandidate.ok) return;
      const radius = previewHandleSpec(project, hole, holeCandidate.feature);
      assert(radius !== undefined && radius.fieldId === "diameter", "a hole point gets an arrow for the diameter");
      if (radius === undefined) return;
      near(handleTipDistanceMm(radius), 4, 1e-9, "its length is the radius");
      near(Math.abs(radius.directionMm[2]), 0, 1e-9, "lying in the face");
      near(handleDragValue(radius, 8, 1, false), 10, 1e-9, "1 mm of radius is 2 mm of diameter");
    }
  },
  {
    name: "Drag arrow placement: an extrude's arrow stands on its start plane and runs along the extrusion for the distance; symmetric and two-sided extrusions have none",
    run: async () => {
      const { project, extrude } = await blockProject();
      const spec = await extrudeHandleSpec(project, extrude, 20);
      assert(spec !== undefined, "a one-side extrude has an arrow");
      if (spec === undefined) return;
      equal(spec.fieldId, "distance", "it drives the distance");
      near(spec.anchorMm[2], 0, 1e-6, "on the sketch plane");
      near(spec.directionMm[2], 1, 1e-9, "along the extrusion");
      near(handleTipDistanceMm(spec), 20, 1e-9, "as long as the distance");
      near(handleDragValue(spec, 20, 5.04, false), 25, 1e-9, "5 mm of travel adds 5 mm (rounded to a tenth)");
      const flipped = await extrudeHandleSpec(project, { ...extrude, direction: "flipped" }, 20);
      equal(flipped?.directionMm[2], -1, "a flipped extrude points the other way");
      assert(await extrudeHandleSpec(project, { ...extrude, direction: "symmetric" }, 20) === undefined, "symmetric: no single end to drag");
      assert(await extrudeHandleSpec(project, { ...extrude, direction: "two-side", secondValueMm: 5 }, 20) === undefined, "two sides: none");
      assert(await extrudeHandleSpec(project, { ...extrude, extent: "through-all" }, 20) === undefined, "through all: none");
    }
  },
  {
    name: "Edge direction: a run with no two faces beside it has no bisector",
    run: async () => {
      const { project } = await blockProject();
      const body = bodyOf(project);
      assert(edgeBlendDirection(body, [500, 500, 500], [510, 500, 500], false) === undefined, "an edge that is not on the mesh has no direction");
    }
  },
  {
    name: "Edit Feature dock: the candidate it previews is exactly what Update would apply, an unchanged form is flagged, a bad value is an invalid preview",
    run: async () => {
      const { project, extrude } = await blockProject();
      const form = { value: "20", direction: "one-side" as const, second: "10", extent: "distance" as const, thin: false, thinWall: "2", thinSide: "inside" as const, operation: "join" as const, values: {} };
      const same = dockCandidate(extrude, form, project);
      assert(same !== undefined && same.ok, "the stored form makes the stored step");
      if (same === undefined) return;
      const unchanged = dockPreviewOf(extrude, same);
      assert("feature" in unchanged && !unchanged.changed, "an unchanged form is flagged unchanged (no ghost, but the arrow still shows)");
      const longer = dockCandidate(extrude, { ...form, value: "35" }, project);
      assert(longer !== undefined && longer.ok && longer.feature.valueMm === 35, "35 in the form is 35 in the step");
      if (longer === undefined) return;
      const changed = dockPreviewOf(extrude, longer);
      assert("feature" in changed && changed.changed, "a changed form is flagged changed");
      const ghost = await run2(featurePreviewRequest(project, longer.ok ? longer.feature : extrude, "edit"));
      assert(ghost.ok, ghost.ok ? "" : ghost.message);
      if (ghost.ok) near(volumeOf(ghost.ghost), 60 * 40 * 35, 60 * 40 * 35 * 0.01, "the ghost is the block 35 mm tall");
      equal(bodyOf(project).positionsMm.length > 0 && volumeOf(bodyOf(project)) > 47_000 && volumeOf(bodyOf(project)) < 49_000, true, "while the real block is still 20 mm tall");
      assert(dockPreviewFor(undefined, changed) === undefined, "a closed dock has no preview");
      assert(dockPreviewFor(extrude, changed) === changed, "the open step's own preview is used");
      assert(dockPreviewFor({ ...extrude, id: "feature:extrude-9" }, changed) === undefined, "a preview told for another step is ignored");
      const junk = dockCandidate(extrude, { ...form, value: "tall" }, project);
      assert(junk !== undefined, "a typed word reaches the same parser");
      if (junk === undefined) return;
      const invalid = dockPreviewOf(extrude, junk);
      assert("invalid" in invalid && invalid.invalid.length > 0, "and is an invalid preview with the parser's message");
    }
  },
  {
    name: "Value bridge: the arrow's writes reach the dock while it listens and stop when it unsubscribes",
    run: () => {
      const bridge = createValueBridge();
      const seen: string[] = [];
      const stop = bridge.subscribe((fieldId, text) => seen.push(`${fieldId}=${text}`));
      bridge.push("distance", "12.5");
      stop();
      bridge.push("distance", "30");
      equal(seen.join(";"), "distance=12.5", "one write heard, none after unsubscribe");
    }
  },
  {
    name: "Panel and dock show the preview line only when they are given one, and the new props leave the existing markup alone",
    run: async () => {
      const { project, extrude } = await blockProject();
      let state = openCommandPanel("fillet");
      state = panelToggleEdge(state, edgePickOf(project, 0), "Block");
      const props = { state, busy: false, onValue: () => undefined, onClearSelection: () => undefined, onCommit: () => undefined, onCancel: () => undefined };
      const plain = renderToStaticMarkup(createElement(CommandPanel, props));
      assert(!/command-panel-preview/.test(plain), "no preview line without a note");
      const noted = renderToStaticMarkup(createElement(CommandPanel, { ...props, previewNote: "The ghost in the view is the result of these values." }));
      assert(/class="command-panel-preview"[^>]*role="status"[^>]*>The ghost in the view/.test(noted), "the panel shows the note");
      const dockProps = { feature: extrude, project, busy: false, onApply: () => undefined, onClose: () => undefined };
      const dock = renderToStaticMarkup(createElement(FeatureEditDialog, { ...dockProps, previewNote: "Updating the preview…" }));
      assert(/feature-edit-preview/.test(dock) && /Updating the preview/.test(dock), "the dock shows the note under its form");
      assert(!/feature-edit-preview/.test(renderToStaticMarkup(createElement(FeatureEditDialog, dockProps))), "and nothing without one");
    }
  }
];

// ---------------------------------------------------------------------------------------------------- local helpers used above

function openCommandPanelFilledForFillet(project: WorkbenchProject): ReturnType<typeof openCommandPanel> {
  return panelToggleEdge(openCommandPanel("fillet"), edgePickOf(project, 0), "Block");
}

/** The edge-blend step a commit of the panel would record (built by hand here so the Edit preview has a stored step to start from). */
async function filletStep(project: WorkbenchProject, size: number): Promise<DesignSolidFeature> {
  const state = panelWithValue(openCommandPanelFilledForFillet(project), "size", String(size));
  const candidate = panelCandidate(project, state);
  assert(candidate.ok, "the fillet step builds");
  if (!candidate.ok) throw new Error("unreachable");
  return candidate.feature;
}
