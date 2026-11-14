import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chainsOfSelection, chainsToToggle, nextEdgeSelection, straightEdgeFromTarget, vertexCrossSegments, vertexPickText, type SelectedEdgePick } from "../apps/studio-web/src/edge-pick-wiring.js";
import { EdgePickForm, placeAbove, CREASE_CHOICES, TOLERANCE_CHOICES } from "../apps/studio-web/src/ui/EdgePickMenu.js";
import { ViewportChrome } from "../apps/studio-web/src/ui/ViewportChrome.js";
import { reachTargetFromClick } from "../apps/studio-web/src/reach-pick.js";
import type { HoverTarget, ViewportViewState } from "../packages/viewport-three/src/index.js";
import type { GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

type EdgeTarget = Extract<HoverTarget, { readonly kind: "edge" }>;
const segment = (a: readonly [number, number, number], b: readonly [number, number, number], chain: number) => ({ a, b, chain });
const edgeTarget = (chain: number, extra: Partial<EdgeTarget> = {}): EdgeTarget => ({ kind: "edge", bodyId: "body", chain, segments: [segment([0, 0, 0], [10, 0, 0], chain)], distanceMm: 0, concave: false, ...extra });
const none = { ctrl: false, shift: false };

const VIEW: ViewportViewState = { orientation: "isometric", projection: "perspective", navigationMode: "select", selectionFilter: "edge", shadingMode: "shaded-edges", bodyColor: "#aeb3b8", backgroundTone: "dark-gray", gridVisible: true, axesVisible: true, azimuthDeg: -45, elevationDeg: 35 };

export const edgePickWiringTests: readonly TestCase[] = [
  {
    name: "Edge selection: a click replaces, Ctrl adds, the same single edge toggles off, and a double-click puts the whole tangent chain in without toggling it away",
    run: () => {
      const first = nextEdgeSelection([], edgeTarget(1), none);
      equal(first.length, 1, "one pick");
      equal(nextEdgeSelection(first, edgeTarget(1), none).length, 0, "the same single edge again clears it");
      equal(nextEdgeSelection(first, edgeTarget(2), none).map((entry) => entry.chain).join(","), "2", "another edge replaces it");
      equal(nextEdgeSelection(first, edgeTarget(2), { ctrl: true, shift: false }).map((entry) => entry.chain).join(","), "1,2", "Ctrl adds");
      const tangent = nextEdgeSelection(first, edgeTarget(1, { tangent: true, chains: [1, 4, 5], segments: [segment([0, 0, 0], [10, 0, 0], 1), segment([10, 0, 0], [20, 0, 0], 4), segment([20, 0, 0], [30, 0, 0], 5)] }), none);
      equal(tangent.length, 1, "the double-click replaces the first click's single edge");
      equal((tangent[0]!.chains ?? []).join(","), "1,4,5", "with every chain of the tangent run");
      equal(tangent[0]!.segments.length, 3, "and all its segments");
      const again = nextEdgeSelection(tangent, edgeTarget(4, { tangent: true, chains: [1, 4, 5] }), none);
      assert(again.length === 1, "a second double-click on the run keeps it picked instead of toggling it off");
      equal(nextEdgeSelection(first, { ...edgeTarget(9), bodyId: "other" }, { ctrl: true, shift: false }).map((entry) => entry.bodyId).join(","), "other", "a pick on another body restarts the set");
    }
  },
  {
    name: "Chains of a selection (for seeding Fillet) include every chain of a tangent pick, and a panel click toggles all of a tangent chain at once",
    run: () => {
      const selection: SelectedEdgePick[] = [{ bodyId: "b", chain: 1, chains: [1, 4], segments: [] }, { bodyId: "b", chain: 7, segments: [] }, { bodyId: "c", chain: 2, segments: [] }];
      equal(chainsOfSelection(selection, "b").join(","), "1,4,7", "the chains of the first body, tangent ones included");
      equal(chainsToToggle([], edgeTarget(3, { chains: [3, 4] })).join(","), "3,4", "nothing picked yet: add both");
      equal(chainsToToggle([{ bodyId: "body", chain: 3 }], edgeTarget(3, { chains: [3, 4] })).join(","), "4", "one already there: add the other");
      equal(chainsToToggle([{ bodyId: "body", chain: 3 }, { bodyId: "body", chain: 4 }], edgeTarget(3, { chains: [3, 4] })).join(","), "3,4", "all there: toggle them off");
    }
  },
  {
    name: "A straight picked edge becomes a construction edge reference; a curved or bent outline is refused with a reason",
    run: () => {
      const body = { id: "body", name: "Block" } as unknown as GeneralSolidBody;
      const straight = straightEdgeFromTarget(body, edgeTarget(0, { segments: [segment([0, 0, 0], [10, 0, 0], 0), segment([10, 0, 0], [30, 0, 0], 0)] }));
      assert(straight.ok && straight.value.a[0] === 0 && straight.value.b[0] === 30, "the two ends of the straight run");
      const bent = straightEdgeFromTarget(body, edgeTarget(0, { segments: [segment([0, 0, 0], [10, 0, 0], 0), segment([10, 0, 0], [10, 10, 0], 0)] }));
      assert(!bent.ok && /curved|straight/.test(bent.message), "a corner is not a straight edge");
    }
  },
  {
    name: "Vertex picks: the sentence names the body and the point, and the cross has three arms",
    run: () => {
      equal(vertexPickText({ kind: "vertex", bodyId: "b", pointMm: [1, 2.345, -3], distancePx: 2 }, "Block"), "Vertex of Block at (1.00, 2.35, -3.00) mm.", "the sentence");
      equal(vertexCrossSegments([0, 0, 0], 2).length, 3, "x, y and z arms");
    }
  },
  {
    name: "The Reach vertex mode takes the corner the view found on screen, and still falls back to the nearest corner without one",
    run: () => {
      const body = { id: "b", name: "Block", positionsMm: [], indices: [] } as unknown as GeneralSolidBody;
      const found = reachTargetFromClick("vertex", { pointMm: [0, 0, 0], semanticId: null, vertexTarget: { kind: "vertex", bodyId: "b", pointMm: [5, 6, 7] } }, [body]);
      assert(found.ok && found.target.kind === "vertex" && found.target.pointMm?.[0] === 5, "the screen-found corner");
      const fallback = reachTargetFromClick("vertex", { pointMm: [0, 0, 0], semanticId: null }, [body]);
      assert(!fallback.ok && /corner vertex/.test(fallback.message), "no corners to fall back on: says so");
    }
  },
  {
    name: "The Edge pick pop-up opens beside its button inside the window with its height bounded, above when it fits, else below, else the roomier side",
    run: () => {
      const viewport = { width: 1000, height: 700 };
      const size = { width: 304, height: 200 };
      const bottomBar = placeAbove({ left: 400, top: 660, bottom: 690 }, size, viewport);
      assert(bottomBar.top + size.height <= 660 && bottomBar.top >= 8, "above a bar at the bottom of the window");
      const topBar = placeAbove({ left: 400, top: 20, bottom: 50 }, size, viewport);
      assert(topBar.top >= 50, "below a button at the top, because it does not fit above");
      const tight = placeAbove({ left: 400, top: 120, bottom: 150 }, { width: 304, height: 900 }, { width: 1000, height: 300 });
      assert(tight.maxHeight <= 300 - 16 && tight.top >= 8 && tight.maxHeight > 0, `taller than the window: bounded and scrolls (maxHeight ${tight.maxHeight})`);
      const rightEdge = placeAbove({ left: 950, top: 660, bottom: 690 }, size, viewport);
      assert(rightEdge.left + size.width <= 1000 - 8, "kept inside the right edge");
      const narrow = placeAbove({ left: 10, top: 600, bottom: 630 }, { width: 304, height: 100 }, { width: 200, height: 700 });
      assert(narrow.left >= 8, "and the left edge of a narrow window");
    }
  },
  {
    name: "The Edge pick form shows both settings with the current values and explains double-click and cycling; the view bar offers Vertex and Edge pick in Part only",
    run: () => {
      const form = renderToStaticMarkup(createElement(EdgePickForm, { settings: { creaseAngleDeg: 45, tolerancePx: 12 }, onChange: () => undefined }));
      assert(/Crease angle/.test(form) && /Pick radius/.test(form), "both rows");
      assert(/<option value="45" selected="">45°<\/option>/.test(form) && /<option value="12" selected="">12 px<\/option>/.test(form), "the current values are selected");
      assert(/tangent chain/.test(form) && /same spot again/.test(form), "the two gestures are explained");
      assert(CREASE_CHOICES.every((value) => value >= 2 && value <= 89) && TOLERANCE_CHOICES.every((value) => value >= 3 && value <= 24), "every choice is within what the picker accepts");
      const odd = renderToStaticMarkup(createElement(EdgePickForm, { settings: { creaseAngleDeg: 33, tolerancePx: 8 }, onChange: () => undefined }));
      assert(/<option value="33" selected="">33°<\/option>/.test(odd), "a value saved with an earlier setting is still shown");
      const props = { state: VIEW, measurePoints: [], onNavigationMode: () => undefined, onSelectionFilter: () => undefined, onOrientation: () => undefined, onViewAngles: () => undefined, onProjection: () => undefined, onGrid: () => undefined, onAxes: () => undefined, onShadingMode: () => undefined, onBodyColor: () => undefined, onBackgroundTone: () => undefined, onFit: () => undefined, onHome: () => undefined, onClearMeasure: () => undefined, onEdgePick: () => undefined };
      const part = renderToStaticMarkup(createElement(ViewportChrome, { ...props, workspace: "part" }));
      assert(/aria-label="Vertex"/.test(part) && /Edge pick/.test(part), "Part has the Vertex intent and the Edge pick button");
      const assembly = renderToStaticMarkup(createElement(ViewportChrome, { ...props, workspace: "assembly" }));
      assert(!/Edge pick/.test(assembly) && /aria-label="Vertex"[^>]*disabled/.test(assembly), "other workspaces have no Edge pick button and the Vertex intent is disabled");
    }
  }
];
