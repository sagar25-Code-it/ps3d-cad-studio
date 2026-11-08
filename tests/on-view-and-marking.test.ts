import { buildWorkbenchMenus, type WorkbenchMenuActions, type WorkbenchMenuState } from "../apps/studio-web/src/ui/menu-model.js";
import { evaluateOnViewText, formatOnViewValue, onViewLimitMessage, placeNearCursor, stepOnViewValue } from "../apps/studio-web/src/ui/on-view-input.js";
import { MARKING_SLOTS, buildMarkingMenu, clampMenuCenter, markingContextOf, nextSlot, slotAngleDeg, slotFromPointer, slotOffset } from "../apps/studio-web/src/ui/marking-menu.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const value = (text: string, quantity: "length" | "angle" | "count" | "scale" = "length", variables: Record<string, number> = {}): number => {
  const result = evaluateOnViewText(text, quantity, variables);
  assert(result.ok, `"${text}" should evaluate: ${result.ok ? "" : result.message}`);
  return result.value;
};
const message = (text: string, quantity: "length" | "angle" | "count" | "scale" = "length", variables: Record<string, number> = {}): string => {
  const result = evaluateOnViewText(text, quantity, variables);
  assert(!result.ok, `"${text}" should be rejected`);
  return result.message;
};

export const onViewAndMarkingTests: readonly TestCase[] = [
  {
    name: "on-view input evaluates numbers, arithmetic, units and parameters the way a CAD field should",
    run: () => {
      near(value("12.5"), 12.5, 1e-12, "plain number");
      near(value("12,5"), 12.5, 1e-12, "decimal comma");
      near(value("2*3.5"), 7, 1e-12, "multiplication");
      near(value("(10+5)/3"), 5, 1e-12, "brackets and division");
      near(value("2^3"), 8, 1e-12, "power");
      near(value("-4+10"), 6, 1e-12, "unary minus");
      near(value("1/2 in"), 12.7, 1e-9, "a unit applies to the whole expression, so 1/2 in is half an inch");
      near(value("(10 + 5) cm"), 150, 1e-9, "centimetres");
      near(value("2 m"), 2000, 1e-9, "metres");
      near(value("0.25\""), 6.35, 1e-9, "inch mark");
      near(value("1 ft"), 304.8, 1e-9, "feet");
      near(value("90 deg", "angle"), 90, 1e-12, "degrees");
      near(value("90°", "angle"), 90, 1e-12, "degree sign");
      near(value("3.14159265358979 rad", "angle"), 180, 1e-9, "radians");
      near(value("45", "angle"), 45, 1e-12, "bare angle is degrees");
      near(value("2 * pin_r", "length", { pin_r: 4 }), 8, 1e-12, "a named parameter");
      near(value("hole_d / 2", "length", { hole_d: 9 }), 4.5, 1e-12, "another");
      near(value("5", "count"), 5, 1e-12, "count");
      equal(message("2.5", "count"), "Type a whole number.", "counts must be whole");
      assert(message("5 deg").includes("not a length unit"), "an angle unit in a length field is refused");
      assert(message("5 mm", "angle").includes("not an angle unit"), "and the other way round");
      assert(message("5 mm", "scale").includes("plain number"), "scale takes no unit");
      assert(message("").includes("Type a value"), "empty");
      assert(message("1/0").includes("divide by zero"), "division by zero");
      assert(message("(2+3").includes("bracket"), "unclosed bracket");
      assert(message("2 +").includes("ends too early"), "dangling operator");
      assert(message("3 * radius").includes("not a known parameter"), "unknown name");
      assert(message("2 # 3").includes("Unexpected"), "stray symbol");
      assert(message("mm").includes("Type a number before the unit") || message("mm").includes("not a known parameter"), "a unit alone is not a value");
    }
  },
  {
    name: "on-view input checks limits, steps with the arrow keys and keeps its box on screen",
    run: () => {
      const request = { min: 0, exclusiveMin: true, max: 100, quantity: "length" as const };
      equal(onViewLimitMessage(request, 5), undefined, "inside the limits");
      equal(onViewLimitMessage(request, 0), "Must be greater than 0 mm.", "zero is refused when the minimum is exclusive");
      equal(onViewLimitMessage(request, -1), "Must be greater than 0 mm.", "negative too");
      equal(onViewLimitMessage(request, 101), "Must be at most 100 mm.", "above the maximum");
      equal(onViewLimitMessage({ min: 1, quantity: "angle" }, 0.5), "Must be at least 1 °.", "inclusive minimum, in degrees");
      near(stepOnViewValue(2, 1, 0.5), 2.5, 1e-12, "step up");
      near(stepOnViewValue(2, -1, 0.5), 1.5, 1e-12, "step down");
      near(stepOnViewValue(2, 1, 0.5, { shift: true }), 7, 1e-12, "shift is ten times");
      near(stepOnViewValue(2, 1, 0.5, { alt: true }), 2.05, 1e-12, "alt is a tenth");
      near(stepOnViewValue(0.1, 1, 0.1) + stepOnViewValue(0.2, 1, 0.1), 0.2 + 0.3, 1e-12, "no floating-point drift");
      equal(formatOnViewValue(2.5000000001), "2.5", "display trims noise");

      const viewport = { width: 1000, height: 700 };
      const size = { width: 190, height: 60 };
      const nearby = placeNearCursor({ x: 300, y: 200 }, size, viewport);
      equal(`${nearby.left},${nearby.top}`, "316,216", "beside the cursor, down and to the right");
      const rightEdge = placeNearCursor({ x: 980, y: 200 }, size, viewport);
      assert(rightEdge.left + size.width <= viewport.width && rightEdge.left < 980, "flips to the left of the cursor at the right edge");
      const bottomEdge = placeNearCursor({ x: 300, y: 690 }, size, viewport);
      assert(bottomEdge.top + size.height <= viewport.height && bottomEdge.top < 690, "flips above the cursor at the bottom");
      const corner = placeNearCursor({ x: 995, y: 695 }, size, viewport);
      assert(corner.left >= 4 && corner.top >= 4 && corner.left + size.width <= viewport.width && corner.top + size.height <= viewport.height, "always fully inside the viewport");
    }
  },
  {
    name: "marking menu offers the eight most relevant commands for a sketch curve, a body, a face and empty space",
    run: () => {
      const base = { canUndo: true, canRedo: false, bodyCount: 2 };
      const sketch = buildMarkingMenu({ ...base, workspace: "sketch", selectionId: "entity:line-1", selectionKind: "sketch" });
      equal(sketch.context, "sketch", "sketch context");
      equal(sketch.items.length, MARKING_SLOTS, "eight items");
      assert(sketch.items.some((item) => item.id === "sketch.dimension") && sketch.items.some((item) => item.id === "sketch.finish"), "sketch commands lead");
      assert(!sketch.items.some((item) => item.id.startsWith("analysis:")), "no analysis tools in a sketch");

      const body = buildMarkingMenu({ ...base, workspace: "part", selectionId: "general-body:a", selectionKind: "body" });
      equal(body.context, "body", "body context");
      equal(body.items.length, MARKING_SLOTS, "eight items");
      assert(body.items.some((item) => item.id === "analysis:geometry-check" && item.enabled), "the geometry check is offered and enabled with bodies present");
      assert(body.items.some((item) => item.id === "body.boolean-join" && item.enabled), "Unite is offered");
      assert(body.items.slice(0, 5).every((item) => item.enabled), "enabled commands take the first slots");

      const face = buildMarkingMenu({ ...base, workspace: "part", selectionId: "general-body:a", selectionKind: "body", faceSelected: true });
      equal(face.context, "face", "face context");
      equal(face.title, "Face", "titled");
      assert(face.items.some((item) => item.id === "analysis:draft"), "draft analysis is offered on a face");
      assert(face.items.some((item) => item.id === "body.offset-face" || item.id === "body.move-face"), "face edits are present (disabled for mesh solids, with a reason)");
      const disabled = face.items.find((item) => !item.enabled);
      assert(disabled === undefined || (disabled.disabledReason ?? "") !== "", "a disabled item says why");

      const empty = buildMarkingMenu({ ...base, workspace: "part", selectionId: null, selectionKind: "empty" });
      equal(empty.context, "empty", "empty context");
      equal(empty.items.length, MARKING_SLOTS, "eight items");
      assert(empty.items.some((item) => item.id === "sketch.create") && empty.items.some((item) => item.id === "view.fit"), "create a sketch and fit are there");
      const noBodies = buildMarkingMenu({ ...base, bodyCount: 0, workspace: "part", selectionId: null, selectionKind: "empty" });
      const check = noBodies.items.find((item) => item.id === "analysis:geometry-check");
      assert(check === undefined || (!check.enabled && check.disabledReason === "Create a solid body first."), "with no bodies the analysis entry is disabled and says why");
      const assembly = buildMarkingMenu({ ...base, workspace: "assembly", selectionId: null, selectionKind: "empty" });
      assert(!assembly.items.some((item) => item.id.startsWith("analysis:")), "analysis tools belong to the Part workspace");
      equal(markingContextOf({ workspace: "part", selectionId: "profile:a", selectionKind: "profile" }), "sketch", "a profile counts as sketch context");
      const ids = new Set(body.items.map((item) => item.id));
      equal(ids.size, body.items.length, "no command appears twice");
    }
  },
  {
    name: "marking menu geometry: slots run clockwise from the top, pointer flicks pick a slot, keys move between enabled slots",
    run: () => {
      equal(slotAngleDeg(0), 0, "slot 0 is straight up");
      equal(slotAngleDeg(2), 90, "slot 2 is right");
      equal(slotAngleDeg(4), 180, "slot 4 is down");
      const up = slotOffset(0, 100); const right = slotOffset(2, 100); const down = slotOffset(4, 100); const left = slotOffset(6, 100);
      equal(`${up.x},${up.y}`, "0,-100", "up is negative y on screen");
      equal(`${right.x},${right.y}`, "100,0", "right");
      equal(`${down.x},${down.y}`, "0,100", "down");
      equal(`${left.x},${left.y}`, "-100,0", "left");
      equal(slotFromPointer(0, -80, 8), 0, "flick up");
      equal(slotFromPointer(80, 0, 8), 2, "flick right");
      equal(slotFromPointer(60, 60, 8), 3, "flick down-right");
      equal(slotFromPointer(-70, 0, 8), 6, "flick left");
      equal(slotFromPointer(5, 5, 8), null, "inside the dead zone nothing is picked");
      equal(slotFromPointer(0, -80, 0), null, "an empty menu picks nothing");
      equal(slotFromPointer(-60, -60, 5), null, "a flick towards an empty slot picks nothing");

      const items = [true, true, false, true, true, false, true, true].map((enabled) => ({ enabled }));
      equal(nextSlot(0, "Tab", items), 1, "Tab walks clockwise");
      equal(nextSlot(1, "Tab", items), 3, "skipping the disabled slot");
      equal(nextSlot(0, "Shift+Tab", items), 7, "Shift+Tab walks back and wraps");
      equal(nextSlot(0, "ArrowRight", items), 3, "right wants slot 2, which is disabled, so the nearest enabled neighbour clockwise is used");
      equal(nextSlot(0, "ArrowDown", items), 4, "down is slot 4");
      equal(nextSlot(0, "ArrowLeft", items), 6, "left is slot 6");
      equal(nextSlot(3, "ArrowUp", items), 0, "up is slot 0");
      equal(nextSlot(0, "End", items), 7, "End is the last slot");
      equal(nextSlot(5, "Home", items), 0, "Home is the first");
      equal(nextSlot(2, "Tab", [{ enabled: false }, { enabled: false }, { enabled: false }]), 2, "with nothing enabled focus stays put");

      const clamped = clampMenuCenter(10, 10, { width: 1000, height: 700 });
      equal(`${clamped.x},${clamped.y}`, "182,182", "near a corner the menu is pulled in so all eight items fit");
      const middle = clampMenuCenter(500, 350, { width: 1000, height: 700 });
      equal(`${middle.x},${middle.y}`, "500,350", "in the middle it stays where it was clicked");
      const tiny = clampMenuCenter(10, 10, { width: 300, height: 300 });
      equal(`${tiny.x},${tiny.y}`, "150,150", "in a window too small it centres");
    }
  },
  {
    name: "the Inspect menu lists the analysis tools only when they are wired and only runs them in a Part workspace that has bodies",
    run: () => {
      const calls: string[] = [];
      const noop = (): void => undefined;
      const actions: WorkbenchMenuActions = {
        onUndo: noop, onRedo: noop, onCommandPalette: noop, onNewSketch: noop, onCreateSolidFromSketch: noop, onCreatePrimitive: noop, onCombine: noop, onInsertToAssembly: noop,
        onMasterCart: noop, onRenderStudio: noop, onEditSelectedFeature: noop, onToggleSuppressSelected: noop, onDeleteSelected: noop, onMoveSelectedBody: noop, onResizeSelectedBody: noop,
        onModifyGeneralBody: noop, onFit: noop, onHome: noop, onToggleGrid: noop, onWorkspace: noop, onDesignHealth: noop, onMeasure: noop, onExchange: noop, onAccess: noop,
        onConnectAi: noop, onExportStl: noop, onPlateJson: noop, onLearning: noop, onShortcuts: noop, onChangeParameters: noop, onPattern: noop,
        onAnalysis: (mode) => { calls.push(mode); }
      };
      const state: WorkbenchMenuState = { workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 0, analysisBodyCount: 2, previewBodySelected: false, generalBodySelected: false, selectionDeletable: false };
      const inspect = buildWorkbenchMenus(state, actions).find((menu) => menu.id === "inspect")!;
      const ids = inspect.items.map((entry) => entry.id);
      assert(ids.includes("inspect.analysis.geometry-check") && ids.includes("inspect.analysis.interference") && ids.includes("inspect.analysis.draft") && ids.includes("inspect.analysis.wall-thickness") && ids.includes("inspect.analysis.gaussian-curvature") && ids.includes("inspect.analysis.section-comb"), "all six analyses are listed: " + ids.join(","));
      for (const entry of inspect.items.filter((candidate) => candidate.id.startsWith("inspect.analysis."))) {
        assert(entry.disabled === false, `${entry.id} is enabled with bodies in the Part workspace`);
        entry.action();
      }
      equal(calls.join(","), "geometry-check,interference,draft,wall-thickness,gaussian-curvature,section-comb", "each entry opens its own analysis");
      const empty = buildWorkbenchMenus({ ...state, analysisBodyCount: 0 }, actions).find((menu) => menu.id === "inspect")!.items.filter((entry) => entry.id.startsWith("inspect.analysis."));
      assert(empty.every((entry) => entry.disabled === true && entry.hint === "Create a solid body first"), "no bodies: disabled, with the reason");
      const assembly = buildWorkbenchMenus({ ...state, workspace: "assembly" }, actions).find((menu) => menu.id === "inspect")!.items.filter((entry) => entry.id.startsWith("inspect.analysis."));
      assert(assembly.every((entry) => entry.disabled === true && entry.hint === "Open the Part workspace first"), "other workspaces: disabled, with the reason");
      const unwired = buildWorkbenchMenus(state, { ...actions, onAnalysis: undefined } as unknown as WorkbenchMenuActions).find((menu) => menu.id === "inspect")!.items;
      assert(!unwired.some((entry) => entry.id.startsWith("inspect.analysis.")), "without the action nothing inert is listed");
    }
  }
];
