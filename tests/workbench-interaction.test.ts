import {
  applyWorkbenchOperation,
  classifyWorkbenchSelection,
  createWorkbenchProject,
  resolveWorkbenchContextCommands
} from "../packages/workbench-core/src/index.js";
import {
  selectConnectedSketchEntities,
  selectTangentSketchEntities
} from "../packages/workbench-sketch/src/index.js";
import {
  assemblyExplodeFromVerticalGesture,
  orbitViewAngles,
  projectWorldAxes,
  touchCentroidY,
  viewAnglesForOrientation
} from "../packages/viewport-three/src/index.js";
import {
  accumulateCameraBackgroundFrame,
  advanceCameraGestureState,
  calibrateCameraHandColor,
  calibrateCameraHandColorFromForeground,
  cameraAcquisitionSearchRegion,
  cameraDepthFraction,
  cameraExplodeDistanceFromHandDepth,
  cameraExplodeDistanceFromPalmDepth,
  cameraOrbitDelta,
  cameraPalmDepthFraction,
  cameraPinchPoint,
  cameraTrackingSearchRegion,
  createCameraBackgroundAccumulator,
  createCameraGestureState,
  createCameraDepthCalibration,
  createCameraPalmDepthCalibration,
  detectCalibratedCameraHands,
  finalizeCameraBackgroundModel,
  selectPrimaryCameraHand,
  type CameraTrackedHand
} from "../apps/studio-web/src/ui/camera-gesture.js";
import { selectWorkbenchHistoryLane } from "../apps/studio-web/src/ui/history-lane.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const workbenchInteractionTests: readonly TestCase[] = [
  {
    name: "ViewCube and WCS share one orthonormal camera convention",
    run: () => {
      const right = viewAnglesForOrientation("right");
      const rightProjection = projectWorldAxes(...right);
      near(rightProjection.x.depth, 1, 1e-12, "right view should look from positive world X");

      const front = viewAnglesForOrientation("front");
      const frontProjection = projectWorldAxes(...front);
      near(frontProjection.y.depth, -1, 1e-12, "front view should look from negative world Y");

      const top = viewAnglesForOrientation("top");
      const topProjection = projectWorldAxes(...top);
      near(topProjection.z.depth, 1, 2e-4, "top view should look from positive world Z");

      for (const projected of [rightProjection, frontProjection, topProjection]) {
        const axes = [projected.x, projected.y, projected.z];
        for (const axis of axes) near(axis.x ** 2 + axis.y ** 2 + axis.depth ** 2, 1, 1e-10, "projected WCS axes should remain unit vectors");
        near(dot(axes[0]!, axes[1]!), 0, 1e-10, "world X and Y should remain orthogonal on the shared camera basis");
        near(dot(axes[1]!, axes[2]!), 0, 1e-10, "world Y and Z should remain orthogonal on the shared camera basis");
      }

      const draggedRight = orbitViewAngles(10, 20, 20, 0);
      assert(draggedRight[0] > 10, "dragging right should increase azimuth instead of reversing the pointer");
      const draggedUp = orbitViewAngles(10, 20, 0, -20);
      assert(draggedUp[1] > 20, "dragging upward should raise camera elevation");
    }
  },
  {
    name: "assembly touch gestures map one-finger orbit and two-finger vertical travel deterministically",
    run: () => {
      const centroid = touchCentroidY([
        { pointerId: 1, x: 100, y: 300 },
        { pointerId: 2, x: 220, y: 340 }
      ]);
      equal(centroid, 320, "the explode controller should use the stable two-pointer centroid");
      const raised = assemblyExplodeFromVerticalGesture(18, centroid, 220, 600, 120);
      assert(raised > 18, "sliding both fingers upward should increase exploded distance");
      const lowered = assemblyExplodeFromVerticalGesture(raised, 220, 620, 600, 120);
      equal(lowered, 0, "sliding downward beyond the assembled stop should clamp exactly to zero");
      equal(assemblyExplodeFromVerticalGesture(110, 300, -200, 600, 120), 120, "the exploded stop should clamp at the reviewed maximum");
    }
  },
  {
    name: "camera tracking locks one index fingertip and maps calibrated depth without retaining a frame",
    run: () => {
      const width = 80;
      const height = 60;
      const centered = syntheticCameraFrame(width, height, 28, 15, 52, 48);
      const calibration = calibrateCameraHandColor(centered, width, height);
      assert(calibration !== null, "a well-lit hand in the calibration target should produce a bounded local color model");
      const hands = detectCalibratedCameraHands(centered, width, height, calibration);
      equal(hands.length, 1, "the calibrated frame should expose one connected tracked region");
      near(hands[0]!.x, 0.5, 0.05, "the tracked horizontal centroid should match the synthetic hand");
      near(hands[0]!.y, 0.52, 0.08, "the tracked vertical centroid should match the synthetic hand");
      near(hands[0]!.finger.x, 0.5, 0.05, "the first fingertip should be tracked independently from the hand centroid");
      assert(hands[0]!.finger.y < hands[0]!.y, "an upward index fingertip should remain above the palm centroid");

      const shifted = syntheticCameraFrame(width, height, 38, 11, 66, 44);
      const movedHands = detectCalibratedCameraHands(shifted, width, height, calibration);
      equal(movedHands.length, 1, "the calibrated tracker should follow the same region after motion");
      const locked = selectPrimaryCameraHand(movedHands, hands[0]);
      assert(locked !== undefined, "continuity selection should retain the same first-finger controller");
      const rejectedJump = selectPrimaryCameraHand([{ ...locked, x: 0.96, y: 0.96, finger: { ...locked.finger, x: 0.96, y: 0.96 }, palm: { ...locked.palm, x: 0.96, y: 0.96 } }], hands[0]);
      equal(rejectedJump, undefined, "a sudden distant hand or face region must not steal the active first-finger lock");
      const delta = cameraOrbitDelta(hands[0]!.finger, locked.finger);
      assert(delta !== null && delta.deltaX < 0 && delta.deltaY > 0, "right/up mirrored hand motion should directly manipulate the model in the same visible direction");

      const nearFrame = syntheticCameraFrame(width, height, 20, 5, 60, 55);
      const nearHand = detectCalibratedCameraHands(nearFrame, width, height, calibration)[0];
      assert(nearHand !== undefined, "a closer view of the same calibrated hand should remain detectable");
      const depthCalibration = createCameraDepthCalibration(hands[0]!.areaRatio, nearHand.areaRatio);
      assert(depthCalibration !== null, "far and near apparent hand sizes should create a bounded depth calibration");
      equal(cameraExplodeDistanceFromHandDepth(hands[0]!.areaRatio, depthCalibration, 90), 0, "the far point should map exactly to assembled");
      equal(cameraExplodeDistanceFromHandDepth(nearHand.areaRatio, depthCalibration, 90), 90, "the near point should map exactly to the model-scale maximum");
      assert(cameraDepthFraction((hands[0]!.areaRatio + nearHand.areaRatio) / 2, depthCalibration) > 0, "an intermediate depth should create a partial explosion");
    }
  },
  {
    name: "camera gesture state requires open right palm then pinch-hold while palm depth remains independent",
    run: () => {
      const palmFrame = syntheticOpenRightPalmFrame(120, 90);
      const palmCalibration = calibrateCameraHandColor(palmFrame, 120, 90);
      assert(palmCalibration !== null, "a centered open palm should establish the private color calibration");
      const detectedPalm = detectCalibratedCameraHands(palmFrame, 120, 90, palmCalibration)[0];
      assert(detectedPalm !== undefined, "the geometric detector should find the synthetic open hand");
      equal(detectedPalm.handedness, "right", "a screen-left thumb in the mirrored camera should identify the user's right hand");
      assert(detectedPalm.extendedFingerCount >= 4, "four or five separated radial fingers should qualify open-palm acquisition");
      assert(detectedPalm.pinchEvidence !== "loop", "an ordinary separated open palm must not be reinterpreted as an OK-loop pinch");
      assert(detectedPalm.palm.scale > 0, "palm depth must use a stable inscribed-palm scale rather than full silhouette area");

      const openRight = cameraHandSample({ pinchRatio: 1.7, extendedFingerCount: 5, openPalmConfidence: 0.9 });
      let gesture = createCameraGestureState();
      for (let frame = 0; frame < 6; frame += 1) {
        const transition = advanceCameraGestureState(gesture, openRight);
        gesture = transition.state;
        assert(!gesture.locked, "open-palm acquisition must reject a single accidental frame");
      }
      const acquired = advanceCameraGestureState(gesture, openRight);
      equal(acquired.event, "lock-acquired", "seven stable open-right-palm frames should acquire the control lock");
      gesture = acquired.state;

      const leftPalm = cameraHandSample({ handedness: "left", pinchRatio: 1.7, extendedFingerCount: 5, openPalmConfidence: 0.9 });
      let leftGesture = createCameraGestureState();
      for (let frame = 0; frame < 12; frame += 1) leftGesture = advanceCameraGestureState(leftGesture, leftPalm).state;
      assert(!leftGesture.locked, "the explicitly requested right-hand control must not lock to a left palm");

      const lPose = cameraHandSample({ pinchRatio: 1.4, extendedFingerCount: 2, openPalmConfidence: 0.25 });
      let lGesture = createCameraGestureState();
      for (let frame = 0; frame < 12; frame += 1) lGesture = advanceCameraGestureState(lGesture, lPose).state;
      assert(!lGesture.locked, "the supplied L pose must remain a cursor pose and cannot replace the explicit open-palm lock gesture");

      const unsupportedClosePair = cameraHandSample({ pinchRatio: 0.4, pinchConfidence: 0.05, extendedFingerCount: 1 });
      const unsupportedFirst = advanceCameraGestureState(gesture, unsupportedClosePair);
      const unsupportedSecond = advanceCameraGestureState(unsupportedFirst.state, unsupportedClosePair);
      assert(!unsupportedSecond.state.pinching, "a noisy compact silhouette without adequate thumb-index evidence must not start orbit");

      const pinched = cameraHandSample({ pinchRatio: 0.48, pinchConfidence: 0.82, index: [0.64, 0.32], thumb: [0.62, 0.34] });
      const firstPinch = advanceCameraGestureState(gesture, pinched);
      assert(!firstPinch.state.pinching, "one close landmark frame should not activate orbit");
      const secondPinch = advanceCameraGestureState(firstPinch.state, pinched);
      equal(secondPinch.event, "pinch-start", "a stable thumb-index pinch should engage orbit");
      assert(secondPinch.state.pinching, "pinch-hold should remain latched for orbit drag");

      const startPoint = cameraPinchPoint(pinched);
      const movedPinch = cameraHandSample({ pinchRatio: 0.5, index: [0.7, 0.28], thumb: [0.68, 0.3] });
      const delta = cameraOrbitDelta(startPoint, cameraPinchPoint(movedPinch));
      assert(delta !== null && delta.deltaX < 0 && delta.deltaY > 0, "held-pinch motion should use mirrored direct-manipulation orbit signs");
      const amplified = cameraOrbitDelta({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.49 });
      assert(amplified !== null, "movement beyond the dead zone should create an orbit delta");
      near(amplified.deltaX, -4.72, 1e-9, "horizontal orbit should use four-times gain");
      near(amplified.deltaY, 4.32, 1e-9, "vertical orbit should use four-times gain");

      const firstRelease = advanceCameraGestureState(secondPinch.state, openRight);
      assert(firstRelease.state.pinching, "one noisy open frame should not release an active orbit drag");
      const released = advanceCameraGestureState(firstRelease.state, openRight);
      equal(released.event, "pinch-end", "two open frames should release and stop orbit");
      assert(!released.state.pinching, "index motion after release must return to cursor-only mode");

      const palmDepth = createCameraPalmDepthCalibration(0.08, 0.14);
      assert(palmDepth !== null, "far and near palm radii should create a pose-independent depth calibration");
      equal(cameraExplodeDistanceFromPalmDepth(0.08, palmDepth, 21), 0, "the far palm must map exactly to assembled");
      equal(cameraExplodeDistanceFromPalmDepth(0.14, palmDepth, 21), 21, "the near palm must map exactly to the shared model-scale limit");
      assert(cameraPalmDepthFraction(0.11, palmDepth) > 0 && cameraPalmDepthFraction(0.11, palmDepth) < 1, "intermediate palm depth should produce partial explosion");
    }
  },
  {
    name: "camera background model and moving search window reject static scene clutter",
    run: () => {
      const width = 120;
      const height = 90;
      const staticScene = syntheticClutteredCameraFrame(width, height, false);
      const liveHand = syntheticClutteredCameraFrame(width, height, true);
      const accumulator = createCameraBackgroundAccumulator(width, height);
      assert(accumulator !== null, "a bounded camera frame should allocate a temporary numeric background accumulator");
      for (let frame = 0; frame < 10; frame += 1) {
        const exposureSample = shiftCameraBrightness(staticScene, frame % 2 === 0 ? -8 : 8);
        assert(accumulateCameraBackgroundFrame(accumulator, exposureSample), "each clear-frame sample should contribute to the temporary model");
      }
      const background = finalizeCameraBackgroundModel(accumulator);
      assert(background !== null, "three or more clear-frame samples should finalize a background model");
      const calibration = calibrateCameraHandColor(liveHand, width, height);
      assert(calibration !== null, "the new centered palm should still create its private color calibration");
      equal(
        detectCalibratedCameraHands(shiftCameraBrightness(staticScene, 18), width, height, calibration, { background }).length,
        0,
        "stationary skin-colored clutter under measured office-light exposure drift must not be reported as hands"
      );
      const hands = detectCalibratedCameraHands(liveHand, width, height, calibration, {
        background,
        searchRegion: cameraAcquisitionSearchRegion()
      });
      equal(hands.length, 1, "a new centered hand should remain detectable while static clutter is removed");
      const selected = selectPrimaryCameraHand(hands);
      assert(selected !== undefined && selected.handedness === "right", "centered open-right-palm acquisition should survive background rejection");

      const regionHand = cameraHandSample();
      const narrow = cameraTrackingSearchRegion(regionHand, 0);
      const recovering = cameraTrackingSearchRegion(regionHand, 8);
      assert(narrow.halfWidth < recovering.halfWidth && narrow.halfHeight < recovering.halfHeight, "the search window should expand gradually only while recovering a missed hand");
      assert(recovering.halfWidth <= 0.48 && recovering.halfHeight <= 0.49, "even recovery must remain bounded instead of rescanning arbitrary background");
    }
  },
  {
    name: "camera foreground calibration acquires a large off-center right palm without learning face or red shirt clutter",
    run: () => {
      const width = 160;
      const height = 120;
      const clearScene = syntheticPersonalOfficeFrame(width, height, false);
      const livePalm = syntheticPersonalOfficeFrame(width, height, true);
      const accumulator = createCameraBackgroundAccumulator(width, height);
      assert(accumulator !== null, "the clear office frame should allocate a private background accumulator");
      for (let frame = 0; frame < 10; frame += 1) accumulateCameraBackgroundFrame(accumulator, clearScene);
      const background = finalizeCameraBackgroundModel(accumulator);
      assert(background !== null, "ten clear-scene samples should produce a variance-aware background model");
      const calibration = calibrateCameraHandColorFromForeground(
        livePalm,
        width,
        height,
        background,
        cameraAcquisitionSearchRegion()
      );
      assert(calibration !== null, "moving skin pixels should bootstrap calibration even when the palm is outside the old center patch");
      const hands = detectCalibratedCameraHands(livePalm, width, height, calibration, {
        background,
        searchRegion: cameraAcquisitionSearchRegion()
      });
      const selected = selectPrimaryCameraHand(hands);
      assert(selected !== undefined, "the expanded acquisition window should retain the photo-like off-center hand");
      equal(selected.handedness, "right", "screen-left thumb span should identify the mirrored user's right hand");
      assert(selected.extendedFingerCount >= 4, "the off-center open palm should expose enough separated fingers to acquire safely");
      assert(selected.palm.scale > 0.06, "a close palm should no longer be rejected by the former narrow size ceiling");
    }
  },
  {
    name: "camera OK-loop evidence keeps thumb-index contact detectable while a closed fist cannot start orbit",
    run: () => {
      const width = 120;
      const height = 90;
      const okFrame = syntheticOkGestureFrame(width, height);
      const okCalibration = calibrateCameraHandColor(okFrame, width, height);
      assert(okCalibration !== null, "the photo-informed OK pose should provide a bounded colour sample");
      const okHand = detectCalibratedCameraHands(okFrame, width, height, okCalibration)[0];
      assert(okHand !== undefined, "the connected OK silhouette should remain a valid tracked hand");
      equal(okHand.pinchEvidence, "loop", "the enclosed thumb-index opening should survive merged exterior landmarks");
      assert(okHand.pinchRatio <= 0.2 && (okHand.pinchConfidence ?? 0) >= 0.35, "OK-loop evidence should create a confident pinch below the orbit threshold");

      const fistFrame = syntheticFistFrame(width, height);
      const fistCalibration = calibrateCameraHandColor(fistFrame, width, height);
      assert(fistCalibration !== null, "the fist comparison should remain a valid calibrated foreground");
      const fist = detectCalibratedCameraHands(fistFrame, width, height, fistCalibration)[0];
      assert(fist !== undefined, "the fist should remain trackable for continuity without becoming an action");
      assert(fist.pinchEvidence !== "loop", "a solid fist has no enclosed OK opening and must not produce loop evidence");
      assert(fist.pinchRatio > 0.68 || (fist.pinchConfidence ?? 0) < 0.18, "a fist must not satisfy both pinch distance and evidence gates");
    }
  },
  {
    name: "global Undo and Redo retain broad-project history across workspace switches",
    run: () => {
      equal(selectWorkbenchHistoryLane("sketch", 0, 1), "broad-project", "Sketch edits should use broad-project history");
      equal(selectWorkbenchHistoryLane("part", 0, 1), "broad-project", "a broad edit must remain undoable after switching to Part");
      equal(selectWorkbenchHistoryLane("part", 1, 1), "qualified-part", "a pending qualified Part-worker edit should retain priority while in Part");
      equal(selectWorkbenchHistoryLane("assembly", 4, 0), null, "qualified Part history must not leak into another workspace");
      equal(selectWorkbenchHistoryLane("part", 0, 0), null, "empty histories should disable the global control");
    }
  },
  {
    name: "sketch connected and tangent selection intents preserve topology boundaries",
    run: () => {
      const project = createWorkbenchProject("project:test-selection-intent");
      const sketch = {
        ...project.sketch,
        snapToleranceMm: 0.1,
        entities: [
          { id: "entity:chain-a", kind: "line", start: [0, 0], end: [10, 0], construction: false },
          { id: "entity:chain-b", kind: "line", start: [10, 0], end: [20, 0], construction: false },
          { id: "entity:branch-c", kind: "line", start: [20, 0], end: [20, 10], construction: false },
          { id: "entity:detached", kind: "line", start: [50, 50], end: [60, 50], construction: false }
        ] as const,
        constraints: [],
        dimensions: []
      };
      equal(selectConnectedSketchEntities(sketch, "entity:chain-a").join(","), "entity:branch-c,entity:chain-a,entity:chain-b", "connected intent should traverse the complete endpoint-connected component");
      equal(selectTangentSketchEntities(sketch, "entity:chain-a").join(","), "entity:chain-a,entity:chain-b", "tangent intent should stop at the 90-degree branch");
      equal(selectConnectedSketchEntities(sketch, "entity:missing").length, 0, "an unknown seed should select nothing");
    }
  },
  {
    name: "workspace context menus expose bounded analytic features and disable general topology",
    run: () => {
      equal(classifyWorkbenchSelection("profile:mounting"), "profile", "profile IDs should classify deterministically");
      equal(classifyWorkbenchSelection("component:base"), "component", "component IDs should classify deterministically");

      const profileCommands = resolveWorkbenchContextCommands({ workspace: "sketch", selectionId: "profile:mounting", canUndo: true });
      assert(profileCommands.some((command) => command.id === "feature.extrude" && command.enabled), "a selected sketch profile should offer Extrude");

      const bodyCommands = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "body:qualified" });
      assert(bodyCommands.some((command) => command.id === "body.create-component" && command.enabled), "a selected body should offer Create Component");
      assert(bodyCommands.filter((command) => command.id.startsWith("body.boolean-")).every((command) => !command.enabled), "qualified worker geometry should remain immutable to direct Boolean edits");

      const analyticCommands = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "part-body:target" });
      assert(analyticCommands.some((command) => command.id === "body.boolean-join" && command.enabled), "an analytic body should expose bounded Unite");
      assert(analyticCommands.some((command) => command.id === "body.boolean-cut" && command.enabled), "an analytic body should expose bounded Subtract");
      assert(analyticCommands.some((command) => command.id === "body.boolean-intersect" && !command.enabled && command.disabledReason?.includes("B-rep") === true), "general Intersect should remain visible with an exact-kernel reason");
      const directFeatures = analyticCommands.find((command) => command.id === "body.direct-features");
      assert(directFeatures?.children?.some((command) => command.id === "body.move-face" && command.enabled) === true, "an analytic body should expose direct face editing");
      assert(directFeatures?.children?.some((command) => command.id === "body.shell" && command.enabled) === true, "an analytic body should expose bounded Shell");

      const sketchCanvasCommands = resolveWorkbenchContextCommands({ workspace: "sketch", selectionId: null });
      assert(sketchCanvasCommands.some((command) => command.id === "sketch.select-connected" && command.enabled), "empty sketch canvas should expose connected-curve intent");
      assert(sketchCanvasCommands.some((command) => command.id === "sketch.look-at" && command.enabled), "empty sketch canvas should expose Look At");

      const sketchEntityCommands = resolveWorkbenchContextCommands({ workspace: "sketch", selectionId: "entity:mounting-outline" });
      assert(sketchEntityCommands.some((command) => command.id === "sketch.dimension" && command.enabled), "a selected sketch entity should expose direct dimensioning");
      assert(sketchEntityCommands.some((command) => command.id === "selection.toggle-visibility" && command.enabled), "a selected sketch entity should expose persisted show/hide");
    }
  },
  {
    name: "assembly mates add and delete through revision-checked operations",
    run: () => {
      const project = createWorkbenchProject("project:test-mate-editing");
      const mate = {
        id: "mate:test-base-left-axis",
        name: "Base to left spacer axis",
        kind: "aligned-axis",
        componentIds: ["component:base", "component:spacer-left"],
        axis: "z",
        status: "satisfied"
      } as const;
      const added = applyWorkbenchOperation(project, {
        kind: "add-assembly-mate",
        operationId: "operation:test-add-mate",
        expectedRevision: 0,
        mate
      });
      assert(added.ok, "a mate between two existing components should apply");
      assert(added.value.project.assembly.mates.some((entry) => entry.id === mate.id), "the assembly tree should receive the new mate record");

      const removed = applyWorkbenchOperation(added.value.project, {
        kind: "delete-assembly-mate",
        operationId: "operation:test-delete-mate",
        expectedRevision: 1,
        mateId: mate.id
      });
      assert(removed.ok, "a user-authored mate should be removable");
      assert(!removed.value.project.assembly.mates.some((entry) => entry.id === mate.id), "mate deletion should update the assembly relationship folder");
      equal(removed.value.project.revision, 2, "mate add and delete should create two audited revisions");
    }
  }
];

function dot(left: { readonly x: number; readonly y: number; readonly depth: number }, right: { readonly x: number; readonly y: number; readonly depth: number }): number {
  return left.x * right.x + left.y * right.y + left.depth * right.depth;
}

function syntheticCameraFrame(width: number, height: number, left: number, top: number, right: number, bottom: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const hand = x >= left && x < right && y >= top && y < bottom;
      pixels[offset] = hand ? 190 : 28;
      pixels[offset + 1] = hand ? 138 : 64;
      pixels[offset + 2] = hand ? 108 : 126;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function syntheticOpenRightPalmFrame(width: number, height: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const handRectangles: readonly (readonly [number, number, number, number])[] = [
    [46, 35, 75, 66],
    [52, 63, 69, 87],
    [49, 17, 55, 42],
    [56, 11, 62, 40],
    [64, 16, 70, 40],
    [71, 24, 77, 45],
    [24, 43, 48, 51]
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const hand = handRectangles.some(([left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom);
      pixels[offset] = hand ? 190 : 28;
      pixels[offset + 1] = hand ? 138 : 64;
      pixels[offset + 2] = hand ? 108 : 126;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function syntheticClutteredCameraFrame(width: number, height: number, includeCenteredHand: boolean): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const staticClutter: readonly (readonly [number, number, number, number])[] = [
    [1, 40, 18, 68],
    [5, 65, 15, 89],
    [2, 20, 6, 44],
    [7, 15, 11, 42],
    [12, 18, 16, 42],
    [16, 25, 20, 47],
    [18, 47, 26, 54]
  ];
  const centeredHand: readonly (readonly [number, number, number, number])[] = includeCenteredHand ? [
    [46, 35, 75, 66],
    [52, 63, 69, 87],
    [49, 17, 55, 42],
    [56, 11, 62, 40],
    [64, 16, 70, 40],
    [71, 24, 77, 45],
    [30, 43, 48, 51]
  ] : [];
  const foreground = [...staticClutter, ...centeredHand];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const handLike = foreground.some(([left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom);
      pixels[offset] = handLike ? 190 : 28;
      pixels[offset + 1] = handLike ? 138 : 64;
      pixels[offset + 2] = handLike ? 108 : 126;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function syntheticPersonalOfficeFrame(width: number, height: number, includeHand: boolean): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const handRectangles: readonly (readonly [number, number, number, number])[] = includeHand ? [
    [104, 45, 136, 80],
    [112, 77, 130, 120],
    [106, 15, 112, 50],
    [115, 9, 122, 49],
    [125, 13, 132, 50],
    [134, 23, 141, 54],
    [81, 53, 107, 62]
  ] : [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const staticFace = x >= 23 && x < 48 && y >= 24 && y < 55;
      const staticShirt = x >= 18 && x < 71 && y >= 68;
      const hand = handRectangles.some(([left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom);
      const color: readonly [number, number, number] = hand || staticFace
        ? [190, 138, 108]
        : staticShirt
          ? [172, 36, 42]
          : [35, 52, 70];
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function syntheticOkGestureFrame(width: number, height: number): Uint8ClampedArray {
  return syntheticPoseFrame(width, height, (x, y) => {
    const palm = x >= 51 && x < 78 && y >= 42 && y < 68;
    const wrist = x >= 58 && x < 72 && y >= 65 && y < 89;
    const threeFingers = (x >= 59 && x < 65 && y >= 17 && y < 47)
      || (x >= 67 && x < 73 && y >= 12 && y < 47)
      || (x >= 75 && x < 81 && y >= 21 && y < 49);
    const loopDistance = Math.hypot(x - 46, y - 39);
    const okLoop = loopDistance <= 12 && loopDistance >= 5;
    const loopBridge = x >= 46 && x < 57 && y >= 44 && y < 52;
    return palm || wrist || threeFingers || okLoop || loopBridge;
  });
}

function syntheticFistFrame(width: number, height: number): Uint8ClampedArray {
  return syntheticPoseFrame(width, height, (x, y) => {
    const fist = x >= 44 && x < 78 && y >= 34 && y < 66;
    const knuckle = Math.hypot((x - 61) / 19, (y - 34) / 8) <= 1;
    const wrist = x >= 53 && x < 70 && y >= 64 && y < 89;
    return fist || knuckle || wrist;
  });
}

function syntheticPoseFrame(width: number, height: number, handAt: (x: number, y: number) => boolean): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const hand = handAt(x, y);
      pixels[offset] = hand ? 190 : 28;
      pixels[offset + 1] = hand ? 138 : 64;
      pixels[offset + 2] = hand ? 108 : 126;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function cameraHandSample(overrides: {
  readonly handedness?: CameraTrackedHand["handedness"];
  readonly pinchRatio?: number;
  readonly pinchConfidence?: number;
  readonly extendedFingerCount?: number;
  readonly openPalmConfidence?: number;
  readonly index?: readonly [number, number];
  readonly thumb?: readonly [number, number];
} = {}): CameraTrackedHand {
  const index = overrides.index ?? [0.42, 0.28];
  const thumb = overrides.thumb ?? [0.28, 0.42];
  return {
    x: 0.54,
    y: 0.48,
    areaRatio: 0.16,
    confidence: 0.92,
    finger: { x: index[0], y: index[1], confidence: 0.94 },
    thumb: { x: thumb[0], y: thumb[1], confidence: 0.9 },
    palm: { x: 0.52, y: 0.52, scale: 0.09, confidence: 0.91 },
    handedness: overrides.handedness ?? "right",
    extendedFingerCount: overrides.extendedFingerCount ?? 5,
    openPalmConfidence: overrides.openPalmConfidence ?? 0.9,
    pinchRatio: overrides.pinchRatio ?? 1.7,
    pinchConfidence: overrides.pinchConfidence ?? 0.9
  };
}

function shiftCameraBrightness(pixels: Uint8ClampedArray, delta: number): Uint8ClampedArray {
  const shifted = pixels.slice();
  for (let offset = 0; offset < shifted.length; offset += 4) {
    shifted[offset] = Math.max(0, Math.min(255, (shifted[offset] ?? 0) + delta));
    shifted[offset + 1] = Math.max(0, Math.min(255, (shifted[offset + 1] ?? 0) + delta));
    shifted[offset + 2] = Math.max(0, Math.min(255, (shifted[offset + 2] ?? 0) + delta));
  }
  return shifted;
}
