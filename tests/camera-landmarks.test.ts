import { CameraLandmarkTracker, deriveCameraTrackedHand, resolveCameraHandedness } from "../apps/studio-web/src/ui/camera-landmarks.js";
import type { HandLandmarkFrame, HandLandmarkPoint } from "../apps/studio-web/src/ui/hand-landmarker-protocol.js";
import { advanceCameraGestureState, cameraPointerControlSignal, createCameraGestureState } from "../apps/studio-web/src/ui/camera-gesture.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const cameraLandmarkTests: readonly TestCase[] = [
  {
    name: "21-landmark open right palm acquires while left hand and fist remain fail-closed",
    run: () => {
      const openRight = deriveCameraTrackedHand(handFrame(openPalm(), { handedness: "right" }));
      assert(openRight !== undefined, "a complete finite landmark frame should derive one tracked hand");
      assert(openPalm()[4]!.x > openPalm()[17]!.x, "a mirrored right-palm fixture must put the thumb on the display-right side");
      equal(openRight.modelHandedness, "right", "the mirrored MediaPipe category should identify the user's right hand");
      equal(openRight.anatomicalHandedness, "right", "the mirrored wrist-index-pinky triangle should independently identify a palm-facing right hand");
      equal(openRight.handedness, "right", "worker-mirrored MediaPipe handedness should remain the user's right hand");
      assert(openRight.extendedFingerCount >= 4, "open-palm geometry should identify four or five extended fingers");
      assert(openRight.openPalmConfidence >= 0.48, "open palm should satisfy the explicit lock confidence threshold");
      assert(openRight.pinchRatio > 0.9, "separated thumb and index tips must not look pinched");

      let state = createCameraGestureState();
      for (let frame = 0; frame < 7; frame += 1) state = advanceCameraGestureState(state, openRight).state;
      assert(state.locked, "seven stable open-right-palm landmark frames should acquire control");

      const left = deriveCameraTrackedHand(handFrame(mirrorX(openPalm()), { handedness: "left" }));
      assert(left !== undefined, "left-hand landmarks can be observed for user feedback");
      equal(left.handedness, "left", "model and mirrored palm chirality should agree on an actual left hand");
      let leftState = createCameraGestureState();
      for (let frame = 0; frame < 12; frame += 1) leftState = advanceCameraGestureState(leftState, left).state;
      assert(!leftState.locked, "left-hand observation must never authorize right-hand CAD motion");

      const mislabeledLeft = deriveCameraTrackedHand(handFrame(mirrorX(openPalm()), { handedness: "right" }));
      const mislabeledRight = deriveCameraTrackedHand(handFrame(openPalm(), { handedness: "left" }));
      assert(mislabeledLeft !== undefined && mislabeledRight !== undefined, "handedness disagreements remain observable for diagnostics");
      equal(mislabeledLeft.handedness, "unknown", "a left palm mislabeled right must fail closed");
      equal(mislabeledRight.handedness, "unknown", "a right palm mislabeled left must fail closed");

      const fist = deriveCameraTrackedHand(handFrame(closedFist(), { handedness: "right" }));
      assert(fist !== undefined, "a fist remains a valid hand observation");
      assert(fist.extendedFingerCount <= 2 && fist.openPalmConfidence < 0.48, "a fist must not satisfy open-palm lock geometry");
    }
  },
  {
    name: "landmark pinch geometry uses hysteresis and relative motion without silhouette evidence",
    run: () => {
      const open = deriveCameraTrackedHand(handFrame(openPalm(), { handedness: "right" }));
      const pinch = deriveCameraTrackedHand(handFrame(pinchedPalm(), { handedness: "right", timestampMs: 33 }));
      assert(open !== undefined && pinch !== undefined, "open and pinched landmark fixtures should both be valid hands");
      assert(pinch.pinchRatio < 0.4 && (pinch.pinchConfidence ?? 0) > 0.18, "thumb-index landmark contact should provide independent pinch evidence");
      assert(pinch.openPalmConfidence < open.openPalmConfidence, "pinch contact must reduce open-palm acquisition confidence");

      let state = createCameraGestureState();
      for (let frame = 0; frame < 7; frame += 1) state = advanceCameraGestureState(state, open).state;
      const first = advanceCameraGestureState(state, pinch);
      assert(!first.state.pinching, "one landmark frame cannot engage orbit");
      const engaged = advanceCameraGestureState(first.state, pinch);
      assert(engaged.state.pinching && engaged.event === "pinch-start", "two stable landmark pinch frames should engage orbit");
      const noisyRelease = advanceCameraGestureState(engaged.state, open);
      assert(noisyRelease.state.pinching, "one open frame cannot chatter an active pinch off");
      const released = advanceCameraGestureState(noisyRelease.state, open);
      assert(!released.state.pinching && released.event === "pinch-end", "two open frames should release orbit deterministically");

      const activeAgain = advanceCameraGestureState(advanceCameraGestureState(released.state, pinch).state, pinch);
      assert(activeAgain.state.pinching, "the right hand can deliberately start a new orbit after release");
      const leftHand = deriveCameraTrackedHand(handFrame(mirrorX(openPalm()), { handedness: "left", timestampMs: 66 }));
      assert(leftHand !== undefined, "left-hand fixture should remain observable");
      const stolen = advanceCameraGestureState(activeAgain.state, leftHand);
      assert(!stolen.state.pinching && stolen.event === "pinch-end", "a handedness change must suspend active orbit immediately");
      let lost = stolen.state;
      for (let frame = 0; frame < 11; frame += 1) lost = advanceCameraGestureState(lost, leftHand).state;
      assert(!lost.locked, "a persistent left hand cannot inherit the previously acquired right-hand lock");
    }
  },
  {
    name: "right-hand identity reaches cursor and orbit while only clear chirality conflicts fail closed",
    run: () => {
      equal(resolveCameraHandedness("right", "unknown"), "right", "edge-on palm chirality must not erase a confident right-hand model identity");
      equal(resolveCameraHandedness("left", "unknown"), "left", "ambiguous anatomy must preserve a confident left label for explicit rejection feedback");
      equal(resolveCameraHandedness("right", "left"), "unknown", "clear opposite-hand anatomical evidence must still fail closed");
      equal(resolveCameraHandedness("unknown", "right"), "unknown", "anatomy alone must never authorize control without a confident model identity");

      const open = deriveCameraTrackedHand(handFrame(openPalm(), { handedness: "right" }));
      const pinch = deriveCameraTrackedHand(handFrame(pinchedPalm(), { handedness: "right", timestampMs: 33 }));
      const movedPinch = deriveCameraTrackedHand(handFrame(translate(pinchedPalm(), -0.05, 0.035), { handedness: "right", timestampMs: 66 }));
      const left = deriveCameraTrackedHand(handFrame(mirrorX(openPalm()), { handedness: "left", timestampMs: 99 }));
      assert(open !== undefined && pinch !== undefined && movedPinch !== undefined && left !== undefined, "control-path landmark fixtures must derive valid hands");

      let state = createCameraGestureState();
      for (let frame = 0; frame < 7; frame += 1) state = advanceCameraGestureState(state, open).state;
      const cursor = cameraPointerControlSignal(open, state);
      assert(cursor.cursor.visible && !cursor.cursor.pinching, "an acquired right-hand lock must emit a visible index cursor");
      equal(cursor.cursor.x, open.finger.x, "cursor x must come from the tracked index fingertip");
      equal(cursor.cursor.y, open.finger.y, "cursor y must come from the tracked index fingertip");

      state = advanceCameraGestureState(state, pinch).state;
      state = advanceCameraGestureState(state, pinch).state;
      assert(state.pinching, "two supported pinch frames must activate orbit before signal emission");
      const seeded = cameraPointerControlSignal(pinch, state);
      assert(seeded.cursor.visible && seeded.cursor.pinching && seeded.nextPinchPoint !== undefined, "the first held-pinch signal must keep the cursor visible and seed relative orbit");
      const moved = cameraPointerControlSignal(movedPinch, state, seeded.nextPinchPoint);
      assert(moved.orbit !== undefined, "a subsequent supported pinch movement must emit a CAD orbit delta");
      assert(moved.orbit.deltaX > 0 && moved.orbit.deltaY < 0, "mirrored orbit output must preserve the reviewed axis mapping");

      const rejected = cameraPointerControlSignal(left, state, seeded.nextPinchPoint);
      assert(!rejected.cursor.visible && rejected.orbit === undefined, "a left hand must emit neither cursor nor orbit even when a prior right-hand pinch was active");
    }
  },
  {
    name: "One Euro landmark filtering smooths normal motion and rejects discontinuous background steals",
    run: () => {
      const tracker = new CameraLandmarkTracker({ maximumJump: 0.24 });
      const first = tracker.update(handFrame(openPalm(), { timestampMs: 100 }));
      assert(first !== undefined, "first valid hand should initialize the temporal tracker");
      const shiftedPoints = translate(openPalm(), 0.06, -0.025);
      const second = tracker.update(handFrame(shiftedPoints, { timestampMs: 133 }));
      assert(second !== undefined, "bounded hand motion should remain tracked");
      assert(second.finger.x > first.finger.x && second.finger.x < first.finger.x + 0.06, "One Euro filtering should follow but smooth cursor motion");

      const impossibleJump = translate(openPalm(), 0.43, 0.28);
      equal(tracker.update(handFrame(impossibleJump, { timestampMs: 166 })), undefined, "one discontinuous detection must be rejected");
      equal(tracker.update(handFrame(impossibleJump, { timestampMs: 199 })), undefined, "two discontinuous detections must still be rejected");
      equal(tracker.update(handFrame(impossibleJump, { timestampMs: 232 })), undefined, "a persistent distant detection cannot inherit the current hand lock");
      const reacquired = tracker.update(handFrame(impossibleJump, { timestampMs: 850 }));
      const rawReacquired = deriveCameraTrackedHand(handFrame(impossibleJump, { timestampMs: 850 }));
      assert(reacquired !== undefined && rawReacquired !== undefined, "a distant hand may initialize only after the old continuity window has expired");
      assert(
        Math.abs(reacquired.palm.x - rawReacquired.palm.x) < 1e-9,
        "a new identity after the continuity window must not inherit the previous hand filter"
      );
    }
  },
  {
    name: "invalid or low-confidence landmark data cannot produce CAD control signals",
    run: () => {
      const invalid = handFrame(openPalm().slice(0, 20), { handednessScore: 0.99 });
      equal(deriveCameraTrackedHand(invalid), undefined, "exactly 21 landmarks are required");
      const tracker = new CameraLandmarkTracker();
      equal(tracker.update(handFrame(openPalm(), { handednessScore: 0.2 })), undefined, "low model confidence must fail closed");
      const notFinite = [...openPalm()];
      notFinite[8] = { x: Number.NaN, y: 0.2, z: 0 };
      equal(tracker.update(handFrame(notFinite)), undefined, "non-finite fingertip data must fail closed");
    }
  }
];

function handFrame(
  landmarks: readonly HandLandmarkPoint[],
  overrides: Partial<Pick<HandLandmarkFrame, "timestampMs" | "handedness" | "handednessScore">> = {}
): HandLandmarkFrame {
  return {
    frameId: 1,
    timestampMs: overrides.timestampMs ?? 0,
    frameWidth: 640,
    frameHeight: 480,
    handedness: overrides.handedness ?? "right",
    handednessScore: overrides.handednessScore ?? 0.96,
    landmarks,
    worldLandmarks: [],
    inferenceMs: 12
  };
}

function openPalm(): HandLandmarkPoint[] {
  // MediaPipe receives the worker-mirrored selfie frame. A user's RIGHT palm
  // therefore appears with its thumb on the display-right side. Keep this
  // fixture in the same coordinate convention as the production worker so a
  // sign inversion cannot hide behind synthetic unmirrored geometry again.
  return mirrorX(points([
    [0.5, 0.88],
    [0.42, 0.74], [0.34, 0.66], [0.26, 0.58], [0.17, 0.49],
    [0.42, 0.63], [0.405, 0.46], [0.395, 0.31], [0.385, 0.15],
    [0.5, 0.6], [0.5, 0.4], [0.5, 0.23], [0.5, 0.07],
    [0.58, 0.62], [0.595, 0.43], [0.605, 0.28], [0.615, 0.13],
    [0.66, 0.67], [0.70, 0.52], [0.73, 0.39], [0.76, 0.27]
  ]));
}

function pinchedPalm(): HandLandmarkPoint[] {
  const result = openPalm();
  result[1] = point(0.58, 0.72);
  result[2] = point(0.65, 0.58);
  result[3] = point(0.63, 0.36);
  result[4] = point(0.61, 0.18);
  result[8] = point(0.615, 0.16);
  return result;
}

function closedFist(): HandLandmarkPoint[] {
  return points([
    [0.5, 0.86],
    [0.42, 0.74], [0.36, 0.68], [0.42, 0.61], [0.49, 0.62],
    [0.42, 0.62], [0.39, 0.52], [0.44, 0.57], [0.49, 0.62],
    [0.5, 0.6], [0.49, 0.49], [0.52, 0.55], [0.54, 0.62],
    [0.58, 0.62], [0.59, 0.51], [0.58, 0.57], [0.57, 0.64],
    [0.66, 0.67], [0.67, 0.57], [0.64, 0.61], [0.61, 0.67]
  ]);
}

function points(values: readonly (readonly [number, number])[]): HandLandmarkPoint[] {
  return values.map(([x, y]) => point(x, y));
}

function point(x: number, y: number): HandLandmarkPoint {
  return { x, y, z: 0 };
}

function translate(pointsToMove: readonly HandLandmarkPoint[], deltaX: number, deltaY: number): HandLandmarkPoint[] {
  return pointsToMove.map((landmark) => ({ ...landmark, x: landmark.x + deltaX, y: landmark.y + deltaY }));
}

function mirrorX(pointsToMirror: readonly HandLandmarkPoint[]): HandLandmarkPoint[] {
  return pointsToMirror.map((landmark) => ({ ...landmark, x: 1 - landmark.x }));
}
