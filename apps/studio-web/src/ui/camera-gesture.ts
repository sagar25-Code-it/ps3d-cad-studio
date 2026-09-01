export interface CameraHandCalibration {
  readonly cb: number;
  readonly cr: number;
  readonly chromaTolerance: number;
  readonly minimumLuma: number;
  readonly maximumLuma: number;
  readonly sampleCount: number;
}

export interface CameraBackgroundAccumulator {
  readonly width: number;
  readonly height: number;
  readonly lumaSum: Uint32Array;
  readonly cbSum: Uint32Array;
  readonly crSum: Uint32Array;
  readonly lumaSquareSum: Float64Array;
  readonly cbSquareSum: Float64Array;
  readonly crSquareSum: Float64Array;
  sampleCount: number;
}

export interface CameraBackgroundModel {
  readonly width: number;
  readonly height: number;
  readonly luma: Uint8Array;
  readonly cb: Uint8Array;
  readonly cr: Uint8Array;
  readonly lumaNoise: Uint8Array;
  readonly chromaNoise: Uint8Array;
  readonly sampleCount: number;
}

export interface CameraSearchRegion {
  readonly centerX: number;
  readonly centerY: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

export interface CameraDetectionOptions {
  readonly background?: CameraBackgroundModel;
  readonly searchRegion?: CameraSearchRegion;
}

export interface CameraTrackedPoint {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

export interface CameraTrackedPalm extends CameraTrackedPoint {
  /** Palm radius normalized by the shortest camera-frame dimension. */
  readonly scale: number;
}

export type CameraHandedness = "right" | "left" | "unknown";

export interface CameraTrackedHand {
  /** Connected-region centroid; retained for continuity and compatibility. */
  readonly x: number;
  readonly y: number;
  readonly areaRatio: number;
  readonly confidence: number;
  /** Index fingertip. This remains the cursor point. */
  readonly finger: CameraTrackedPoint;
  readonly thumb: CameraTrackedPoint;
  readonly palm: CameraTrackedPalm;
  /** High-confidence category reported by the landmark model. */
  readonly modelHandedness?: CameraHandedness;
  /** Independent 2D palm-chirality check; unknown when the palm is edge-on. */
  readonly anatomicalHandedness?: CameraHandedness;
  readonly handedness: CameraHandedness;
  readonly extendedFingerCount: number;
  readonly openPalmConfidence: number;
  /** Thumb-to-index distance divided by the detected palm radius. */
  readonly pinchRatio: number;
  /** Independent evidence prevents a noisy low-confidence tip pair from starting orbit. */
  readonly pinchConfidence?: number;
  /** A closed OK loop remains detectable when the thumb and index merge into one silhouette. */
  readonly pinchEvidence?: "tips" | "loop" | "merged";
}

export interface CameraOrbitDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface CameraCursorSignal {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
  readonly pinching: boolean;
}

export interface CameraPointerControlSignal {
  readonly cursor: CameraCursorSignal;
  readonly nextPinchPoint?: CameraTrackedPoint;
  readonly orbit?: CameraOrbitDelta;
}

export interface CameraDepthCalibration {
  readonly farScale: number;
  readonly nearScale: number;
}

export interface CameraGestureState {
  readonly locked: boolean;
  readonly pinching: boolean;
  readonly acquireFrames: number;
  readonly pinchFrames: number;
  readonly releaseFrames: number;
  readonly missingFrames: number;
}

export type CameraGestureEvent = "none" | "lock-acquired" | "lock-lost" | "pinch-start" | "pinch-end";

export interface CameraGestureTransition {
  readonly state: CameraGestureState;
  readonly event: CameraGestureEvent;
}

const ACQUIRE_FRAME_COUNT = 7;
const LOST_FRAME_COUNT = 12;
const PINCH_FRAME_COUNT = 2;
const RELEASE_FRAME_COUNT = 2;
const PINCH_ON_RATIO = 0.68;
const PINCH_OFF_RATIO = 0.9;

export function createCameraGestureState(): CameraGestureState {
  return {
    locked: false,
    pinching: false,
    acquireFrames: 0,
    pinchFrames: 0,
    releaseFrames: 0,
    missingFrames: 0
  };
}

/**
 * A deterministic gesture latch. An open, mirrored right palm must remain
 * stable before control is acquired. A thumb/index pinch then uses separate
 * engage and release thresholds so camera noise cannot chatter orbit on/off.
 */
export function advanceCameraGestureState(
  previous: CameraGestureState,
  hand: CameraTrackedHand | undefined
): CameraGestureTransition {
  if (!previous.locked) {
    const openRightPalm = hand !== undefined
      && hand.handedness === "right"
      && hand.extendedFingerCount >= 4
      && hand.openPalmConfidence >= 0.48
      && hand.confidence >= 0.28;
    const acquireFrames = openRightPalm ? previous.acquireFrames + 1 : Math.max(0, previous.acquireFrames - 1);
    const locked = acquireFrames >= ACQUIRE_FRAME_COUNT;
    return {
      state: {
        locked,
        pinching: false,
        acquireFrames,
        pinchFrames: 0,
        releaseFrames: 0,
        missingFrames: 0
      },
      event: locked ? "lock-acquired" : "none"
    };
  }

  if (hand === undefined || hand.handedness !== "right" || hand.confidence < 0.2) {
    const missingFrames = previous.missingFrames + 1;
    if (missingFrames >= LOST_FRAME_COUNT) {
      return { state: createCameraGestureState(), event: "lock-lost" };
    }
    return {
      state: { ...previous, pinching: false, pinchFrames: 0, releaseFrames: 0, missingFrames },
      event: previous.pinching ? "pinch-end" : "none"
    };
  }

  if (!previous.pinching) {
    const supportedPinch = hand.pinchRatio <= PINCH_ON_RATIO && (hand.pinchConfidence ?? 1) >= 0.18;
    const pinchFrames = supportedPinch ? previous.pinchFrames + 1 : 0;
    const pinching = pinchFrames >= PINCH_FRAME_COUNT;
    return {
      state: {
        ...previous,
        pinching,
        pinchFrames,
        releaseFrames: 0,
        missingFrames: 0
      },
      event: pinching ? "pinch-start" : "none"
    };
  }

  const releaseFrames = hand.pinchRatio >= PINCH_OFF_RATIO ? previous.releaseFrames + 1 : 0;
  const released = releaseFrames >= RELEASE_FRAME_COUNT;
  return {
    state: {
      ...previous,
      pinching: !released,
      pinchFrames: released ? 0 : previous.pinchFrames,
      releaseFrames,
      missingFrames: 0
    },
    event: released ? "pinch-end" : "none"
  };
}

/**
 * Learns a robust chroma range from the small center palm target. No camera
 * frame is retained, uploaded, or sent to an external service.
 */
export function calibrateCameraHandColor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): CameraHandCalibration | null {
  if (!validFrame(pixels, width, height)) return null;
  const x0 = Math.floor(width * 0.43);
  const x1 = Math.ceil(width * 0.57);
  const y0 = Math.floor(height * 0.39);
  const y1 = Math.ceil(height * 0.61);
  const lumaSamples: number[] = [];
  const cbSamples: number[] = [];
  const crSamples: number[] = [];

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (red === undefined || green === undefined || blue === undefined || alpha === undefined || alpha === 0) continue;
      const [luma, cb, cr] = rgbToYcbcr(red, green, blue);
      if (luma < 20 || luma > 252) continue;
      lumaSamples.push(luma);
      cbSamples.push(cb);
      crSamples.push(cr);
    }
  }

  return calibrationFromSamples(
    lumaSamples,
    cbSamples,
    crSamples,
    Math.max(24, Math.floor(width * height * 0.002))
  );
}

/**
 * Bootstraps the user's session-only hand colour from pixels that changed
 * after the clear-scene scan. This removes the old requirement that the palm
 * cover a tiny centre sample and avoids learning the stationary face, shirt,
 * desk, or office lighting as the hand.
 */
export function calibrateCameraHandColorFromForeground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  background: CameraBackgroundModel,
  searchRegion: CameraSearchRegion = cameraAcquisitionSearchRegion()
): CameraHandCalibration | null {
  if (!validFrame(pixels, width, height) || background.width !== width || background.height !== height) return null;
  const lumaSamples: number[] = [];
  const cbSamples: number[] = [];
  const crSamples: number[] = [];
  const totalPixels = width * height;
  for (let index = 0; index < totalPixels; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (!insideCameraSearchRegion(x, y, width, height, searchRegion)) continue;
    const offset = index * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (red === undefined || green === undefined || blue === undefined || alpha === undefined || alpha === 0) continue;
    const [luma, cb, cr] = rgbToYcbcr(red, green, blue);
    if (!cameraPixelDiffersFromBackground(luma, cb, cr, index, background)) continue;
    const broadlySkinLike = luma >= 24
      && luma <= 252
      && cb >= 72
      && cb <= 142
      && cr >= 126
      && cr <= 184
      && cr - cb >= 4
      && red >= green * 0.92
      && green >= blue * 0.78
      && red - blue >= 6
      && red <= green * 1.72;
    if (!broadlySkinLike) continue;
    lumaSamples.push(luma);
    cbSamples.push(cb);
    crSamples.push(cr);
  }
  return calibrationFromSamples(
    lumaSamples,
    cbSamples,
    crSamples,
    Math.max(36, Math.floor(totalPixels * 0.0009))
  );
}

/**
 * Builds a temporary numeric background model without retaining an RGBA
 * camera frame. Static objects are then rejected even when their color is
 * close to the calibrated hand color.
 */
export function createCameraBackgroundAccumulator(width: number, height: number): CameraBackgroundAccumulator | null {
  if (!validDimensions(width, height)) return null;
  const size = width * height;
  return {
    width,
    height,
    lumaSum: new Uint32Array(size),
    cbSum: new Uint32Array(size),
    crSum: new Uint32Array(size),
    lumaSquareSum: new Float64Array(size),
    cbSquareSum: new Float64Array(size),
    crSquareSum: new Float64Array(size),
    sampleCount: 0
  };
}

export function accumulateCameraBackgroundFrame(
  accumulator: CameraBackgroundAccumulator,
  pixels: Uint8ClampedArray
): boolean {
  if (!validFrame(pixels, accumulator.width, accumulator.height) || accumulator.sampleCount >= 32) return false;
  const totalPixels = accumulator.width * accumulator.height;
  for (let index = 0; index < totalPixels; index += 1) {
    const offset = index * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (red === undefined || green === undefined || blue === undefined || alpha === undefined || alpha === 0) continue;
    const [luma, cb, cr] = rgbToYcbcr(red, green, blue);
    accumulator.lumaSum[index] = (accumulator.lumaSum[index] ?? 0) + Math.round(luma);
    accumulator.cbSum[index] = (accumulator.cbSum[index] ?? 0) + Math.round(cb);
    accumulator.crSum[index] = (accumulator.crSum[index] ?? 0) + Math.round(cr);
    accumulator.lumaSquareSum[index] = (accumulator.lumaSquareSum[index] ?? 0) + luma * luma;
    accumulator.cbSquareSum[index] = (accumulator.cbSquareSum[index] ?? 0) + cb * cb;
    accumulator.crSquareSum[index] = (accumulator.crSquareSum[index] ?? 0) + cr * cr;
  }
  accumulator.sampleCount += 1;
  return true;
}

export function finalizeCameraBackgroundModel(accumulator: CameraBackgroundAccumulator): CameraBackgroundModel | null {
  if (accumulator.sampleCount < 3) return null;
  const totalPixels = accumulator.width * accumulator.height;
  const luma = new Uint8Array(totalPixels);
  const cb = new Uint8Array(totalPixels);
  const cr = new Uint8Array(totalPixels);
  const lumaNoise = new Uint8Array(totalPixels);
  const chromaNoise = new Uint8Array(totalPixels);
  for (let index = 0; index < totalPixels; index += 1) {
    const meanLuma = (accumulator.lumaSum[index] ?? 0) / accumulator.sampleCount;
    const meanCb = (accumulator.cbSum[index] ?? 0) / accumulator.sampleCount;
    const meanCr = (accumulator.crSum[index] ?? 0) / accumulator.sampleCount;
    luma[index] = Math.round(meanLuma);
    cb[index] = Math.round(meanCb);
    cr[index] = Math.round(meanCr);
    const lumaVariance = Math.max(0, (accumulator.lumaSquareSum[index] ?? 0) / accumulator.sampleCount - meanLuma * meanLuma);
    const cbVariance = Math.max(0, (accumulator.cbSquareSum[index] ?? 0) / accumulator.sampleCount - meanCb * meanCb);
    const crVariance = Math.max(0, (accumulator.crSquareSum[index] ?? 0) / accumulator.sampleCount - meanCr * meanCr);
    lumaNoise[index] = Math.round(clamp(Math.sqrt(lumaVariance), 0, 48));
    chromaNoise[index] = Math.round(clamp(Math.hypot(Math.sqrt(cbVariance), Math.sqrt(crVariance)), 0, 48));
  }
  return {
    width: accumulator.width,
    height: accumulator.height,
    luma,
    cb,
    cr,
    lumaNoise,
    chromaNoise,
    sampleCount: accumulator.sampleCount
  };
}

export function cameraAcquisitionSearchRegion(): CameraSearchRegion {
  return { centerX: 0.5, centerY: 0.51, halfWidth: 0.46, halfHeight: 0.49 };
}

export function cameraTrackingSearchRegion(hand: CameraTrackedHand, missingFrames = 0): CameraSearchRegion {
  const expansion = 1 + clamp(missingFrames, 0, 12) * 0.055;
  return {
    centerX: hand.palm.x,
    centerY: hand.palm.y,
    halfWidth: clamp(hand.palm.scale * 3.65 * expansion, 0.16, 0.48),
    halfHeight: clamp(hand.palm.scale * 4.55 * expansion, 0.22, 0.49)
  };
}

/** Finds connected calibrated regions, the palm, and separate thumb/index tips. */
export function detectCalibratedCameraHands(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  calibration: CameraHandCalibration,
  options: CameraDetectionOptions = {}
): readonly CameraTrackedHand[] {
  if (!validFrame(pixels, width, height)) return [];
  const background = options.background?.width === width && options.background.height === height
    ? options.background
    : undefined;
  const totalPixels = width * height;
  const raw = new Uint8Array(totalPixels);
  const thresholdSquared = calibration.chromaTolerance * calibration.chromaTolerance;
  for (let index = 0; index < totalPixels; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (options.searchRegion !== undefined && !insideCameraSearchRegion(x, y, width, height, options.searchRegion)) continue;
    const offset = index * 4;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    if (red === undefined || green === undefined || blue === undefined || alpha === undefined || alpha === 0) continue;
    const [luma, cb, cr] = rgbToYcbcr(red, green, blue);
    const cbDelta = cb - calibration.cb;
    const crDelta = cr - calibration.cr;
    if (
      luma >= calibration.minimumLuma
      && luma <= calibration.maximumLuma
      && cbDelta * cbDelta + crDelta * crDelta <= thresholdSquared
      && (background === undefined || cameraPixelDiffersFromBackground(luma, cb, cr, index, background))
    ) raw[index] = 1;
  }

  // Remove isolated camera noise while preserving narrow fingers.
  const mask = new Uint8Array(totalPixels);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (raw[index] !== 1) continue;
      let neighbors = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) neighbors += raw[index + offsetY * width + offsetX] ?? 0;
      }
      if (neighbors >= 4) mask[index] = 1;
    }
  }

  const queue = new Int32Array(totalPixels);
  const components: CameraTrackedHand[] = [];
  const minimumArea = Math.max(24, Math.floor(totalPixels * 0.0028));
  for (let start = 0; start < totalPixels; start += 1) {
    if (mask[start] !== 1) continue;
    let read = 0;
    let write = 1;
    queue[0] = start;
    mask[start] = 0;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let minimumX = width;
    let maximumX = 0;
    let minimumY = height;
    let maximumY = 0;
    while (read < write) {
      const index = queue[read];
      read += 1;
      if (index === undefined) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      count += 1;
      sumX += x;
      sumY += y;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= totalPixels || mask[neighbor] !== 1) continue;
        const neighborX = neighbor % width;
        if (Math.abs(neighborX - x) > 1) continue;
        mask[neighbor] = 0;
        queue[write] = neighbor;
        write += 1;
      }
    }
    if (count < minimumArea || count > totalPixels * 0.58) continue;
    const component = analyzeCameraHandComponent(
      queue,
      write,
      count,
      sumX,
      sumY,
      minimumX,
      maximumX,
      minimumY,
      maximumY,
      width,
      height
    );
    if (component !== undefined) components.push(component);
  }

  return components
    .sort((left, right) => {
      const leftScore = left.confidence + left.palm.confidence + (left.handedness === "right" ? 0.18 : 0);
      const rightScore = right.confidence + right.palm.confidence + (right.handedness === "right" ? 0.18 : 0);
      return rightScore - leftScore;
    })
    .slice(0, 4);
}

/**
 * Initial acquisition favors a centered open right palm. Once locked, palm
 * position and scale continuity prevent a face or second hand stealing input.
 */
export function selectPrimaryCameraHand(
  hands: readonly CameraTrackedHand[],
  previous?: CameraTrackedHand
): CameraTrackedHand | undefined {
  let selected: CameraTrackedHand | undefined;
  let selectedScore = Number.POSITIVE_INFINITY;
  for (const hand of hands) {
    const centerDistance = Math.hypot(hand.palm.x - 0.5, hand.palm.y - 0.5);
    const continuityDistance = previous === undefined
      ? centerDistance
      : Math.hypot(hand.palm.x - previous.palm.x, hand.palm.y - previous.palm.y);
    const scaleChange = previous === undefined
      ? 0
      : Math.abs(Math.log(Math.max(hand.palm.scale, 1e-6) / Math.max(previous.palm.scale, 1e-6)));
    if (
      previous === undefined
      && (
        Math.abs(hand.palm.x - 0.5) > 0.45
        || Math.abs(hand.palm.y - 0.51) > 0.46
        || hand.palm.scale < 0.012
        || hand.palm.scale > 0.38
      )
    ) continue;
    const maximumContinuityDistance = previous === undefined
      ? Number.POSITIVE_INFINITY
      : clamp(previous.palm.scale * 1.75 + 0.018, 0.065, 0.19);
    if (previous !== undefined && (continuityDistance > maximumContinuityDistance || scaleChange > 0.5)) continue;
    const handednessPenalty = hand.handedness === "left" ? 0.3 : hand.handedness === "unknown" ? 0.08 : 0;
    const acquisitionShapePenalty = previous === undefined
      ? (1 - hand.openPalmConfidence) * 0.34 + Math.abs(5 - hand.extendedFingerCount) * 0.025
      : 0;
    const score = continuityDistance * (previous === undefined ? 0.28 : 1)
      + scaleChange * 0.2
      + handednessPenalty
      + (1 - hand.palm.confidence) * 0.1
      + acquisitionShapePenalty;
    if (score < selectedScore) {
      selected = hand;
      selectedScore = score;
    }
  }
  return selected;
}

/**
 * Pinch motion directly manipulates the model seen in the mirrored preview.
 * Four-times gain makes normal arm travel useful while the per-frame clamp
 * still prevents one noisy landmark from jerking the CAD camera.
 */
export function cameraOrbitDelta(
  previous: Pick<CameraTrackedPoint, "x" | "y">,
  current: Pick<CameraTrackedPoint, "x" | "y">
): CameraOrbitDelta | null {
  const normalizedDeltaX = previous.x - current.x;
  const normalizedDeltaY = previous.y - current.y;
  const deadZone = 0.0035;
  if (Math.abs(normalizedDeltaX) < deadZone && Math.abs(normalizedDeltaY) < deadZone) return null;
  return {
    deltaX: clamp(normalizedDeltaX * 472, -24, 24),
    deltaY: clamp(normalizedDeltaY * 432, -22, 22)
  };
}

export function cameraPinchPoint(hand: CameraTrackedHand): CameraTrackedPoint {
  const thumbWeight = 0.4;
  return {
    x: hand.finger.x * (1 - thumbWeight) + hand.thumb.x * thumbWeight,
    y: hand.finger.y * (1 - thumbWeight) + hand.thumb.y * thumbWeight,
    confidence: Math.min(hand.finger.confidence, hand.thumb.confidence)
  };
}

/**
 * Converts one authorized landmark frame into the two browser-visible control
 * outputs. Keeping this boundary pure prevents the UI from drawing a hand
 * while silently dropping its cursor/orbit callbacks through a second set of
 * conditions.
 */
export function cameraPointerControlSignal(
  hand: CameraTrackedHand | undefined,
  state: Pick<CameraGestureState, "locked" | "pinching">,
  previousPinchPoint?: CameraTrackedPoint
): CameraPointerControlSignal {
  if (hand === undefined || hand.handedness !== "right" || !state.locked) {
    return { cursor: { x: 0.5, y: 0.5, visible: false, pinching: false } };
  }

  const cursor: CameraCursorSignal = {
    x: hand.finger.x,
    y: hand.finger.y,
    visible: true,
    pinching: state.pinching
  };
  if (!state.pinching) return { cursor };

  const nextPinchPoint = cameraPinchPoint(hand);
  const orbit = previousPinchPoint === undefined || nextPinchPoint.confidence < 0.5
    ? undefined
    : cameraOrbitDelta(previousPinchPoint, nextPinchPoint) ?? undefined;
  return { cursor, nextPinchPoint, ...(orbit === undefined ? {} : { orbit }) };
}

export function createCameraPalmDepthCalibration(farPalmScale: number, nearPalmScale: number): CameraDepthCalibration | null {
  if (!Number.isFinite(farPalmScale) || !Number.isFinite(nearPalmScale) || farPalmScale <= 0 || nearPalmScale <= 0) return null;
  if (nearPalmScale < farPalmScale * 1.15 || nearPalmScale - farPalmScale < 0.01) return null;
  return { farScale: farPalmScale, nearScale: nearPalmScale };
}

export function cameraPalmDepthFraction(palmScale: number, calibration: CameraDepthCalibration): number {
  if (!Number.isFinite(palmScale) || palmScale <= 0) return 0;
  const linear = clamp((palmScale - calibration.farScale) / Math.max(calibration.nearScale - calibration.farScale, 1e-6), 0, 1);
  return linear * linear * (3 - 2 * linear);
}

export function cameraExplodeDistanceFromPalmDepth(
  palmScale: number,
  calibration: CameraDepthCalibration,
  maximumMm: number
): number {
  const boundedMaximum = Number.isFinite(maximumMm) ? clamp(maximumMm, 1, 10_000) : 120;
  return Math.round(cameraPalmDepthFraction(palmScale, calibration) * boundedMaximum * 10) / 10;
}

/** Older apparent-area helpers remain available for saved automation recipes. */
export function createCameraDepthCalibration(farAreaRatio: number, nearAreaRatio: number): CameraDepthCalibration | null {
  if (!Number.isFinite(farAreaRatio) || !Number.isFinite(nearAreaRatio) || farAreaRatio <= 0 || nearAreaRatio <= 0) return null;
  const farScale = Math.sqrt(farAreaRatio);
  const nearScale = Math.sqrt(nearAreaRatio);
  if (nearScale < farScale * 1.15 || nearScale - farScale < 0.018) return null;
  return { farScale, nearScale };
}

export function cameraDepthFraction(areaRatio: number, calibration: CameraDepthCalibration): number {
  if (!Number.isFinite(areaRatio) || areaRatio <= 0) return 0;
  const linear = clamp((Math.sqrt(areaRatio) - calibration.farScale) / Math.max(calibration.nearScale - calibration.farScale, 1e-6), 0, 1);
  return linear * linear * (3 - 2 * linear);
}

export function cameraExplodeDistanceFromHandDepth(
  areaRatio: number,
  calibration: CameraDepthCalibration,
  maximumMm: number
): number {
  const boundedMaximum = Number.isFinite(maximumMm) ? clamp(maximumMm, 1, 10_000) : 120;
  return Math.round(cameraDepthFraction(areaRatio, calibration) * boundedMaximum * 10) / 10;
}

export function cameraExplodeDistanceFromHandY(normalizedY: number, maximumMm = 120): number {
  const boundedMaximum = Number.isFinite(maximumMm) ? clamp(maximumMm, 1, 10_000) : 120;
  const fraction = clamp((0.82 - normalizedY) / 0.64, 0, 1);
  return Math.round(fraction * boundedMaximum * 10) / 10;
}

function analyzeCameraHandComponent(
  componentPixels: Int32Array,
  componentLength: number,
  count: number,
  sumX: number,
  sumY: number,
  minimumX: number,
  maximumX: number,
  minimumY: number,
  maximumY: number,
  frameWidth: number,
  frameHeight: number
): CameraTrackedHand | undefined {
  const localWidth = maximumX - minimumX + 3;
  const localHeight = maximumY - minimumY + 3;
  if (localWidth < 4 || localHeight < 4) return undefined;
  const localMask = new Uint8Array(localWidth * localHeight);
  for (let position = 0; position < componentLength; position += 1) {
    const index = componentPixels[position];
    if (index === undefined) continue;
    const x = index % frameWidth;
    const y = Math.floor(index / frameWidth);
    localMask[(y - minimumY + 1) * localWidth + x - minimumX + 1] = 1;
  }

  const distance = new Uint16Array(localMask.length);
  for (let index = 0; index < localMask.length; index += 1) distance[index] = localMask[index] === 1 ? 255 : 0;
  for (let y = 1; y < localHeight - 1; y += 1) {
    for (let x = 1; x < localWidth - 1; x += 1) {
      const index = y * localWidth + x;
      if (localMask[index] !== 1) continue;
      distance[index] = Math.min(
        distance[index] ?? 255,
        (distance[index - 1] ?? 0) + 1,
        (distance[index - localWidth] ?? 0) + 1,
        (distance[index - localWidth - 1] ?? 0) + 1,
        (distance[index - localWidth + 1] ?? 0) + 1
      );
    }
  }
  for (let y = localHeight - 2; y >= 1; y -= 1) {
    for (let x = localWidth - 2; x >= 1; x -= 1) {
      const index = y * localWidth + x;
      if (localMask[index] !== 1) continue;
      distance[index] = Math.min(
        distance[index] ?? 255,
        (distance[index + 1] ?? 0) + 1,
        (distance[index + localWidth] ?? 0) + 1,
        (distance[index + localWidth - 1] ?? 0) + 1,
        (distance[index + localWidth + 1] ?? 0) + 1
      );
    }
  }

  let palmIndex = 0;
  let palmRadius = 0;
  for (let index = 0; index < distance.length; index += 1) {
    const value = distance[index] ?? 0;
    if (value > palmRadius) {
      palmRadius = value;
      palmIndex = index;
    }
  }
  if (palmRadius < 2) return undefined;
  const palmLocalX = palmIndex % localWidth;
  const palmLocalY = Math.floor(palmIndex / localWidth);
  const palmPixelX = palmLocalX + minimumX - 1;
  const palmPixelY = palmLocalY + minimumY - 1;
  const tips = findRadialFingertips(localMask, localWidth, localHeight, palmLocalX, palmLocalY, palmRadius)
    .map((tip) => ({ ...tip, pixelX: tip.x + minimumX - 1, pixelY: tip.y + minimumY - 1 }));

  // The processed video is mirrored: a user's right thumb is on screen-left.
  const rightThumb = tips
    .filter((tip) => tip.angle <= -2.36 || tip.angle >= 2.72)
    .sort((left, right) => right.distance - left.distance)[0];
  const leftThumb = tips
    .filter((tip) => tip.angle >= -0.82 && tip.angle <= 0.48)
    .sort((left, right) => right.distance - left.distance)[0];
  const lateralSpans = palmLateralSpans(localMask, localWidth, localHeight, palmLocalX, palmLocalY, palmRadius);
  const rightEvidence = Math.max(rightThumb?.distance ?? 0, lateralSpans.left);
  const leftEvidence = Math.max(leftThumb?.distance ?? 0, lateralSpans.right);
  const handedness: CameraHandedness = rightEvidence >= palmRadius * 1.28 && rightEvidence >= leftEvidence * 1.055
    ? "right"
    : leftEvidence >= palmRadius * 1.28 && leftEvidence >= rightEvidence * 1.055
      ? "left"
      : "unknown";

  const thumbTip = handedness === "right" ? rightThumb : handedness === "left" ? leftThumb : tips.slice().sort((left, right) => Math.abs(right.pixelX - palmPixelX) - Math.abs(left.pixelX - palmPixelX))[0];
  const upwardTips = tips.filter((tip) => tip.pixelY < palmPixelY - palmRadius * 0.22 && tip !== thumbTip);
  const indexTip = handedness === "right"
    ? upwardTips.slice().sort((left, right) => left.pixelX - right.pixelX)[0]
    : handedness === "left"
      ? upwardTips.slice().sort((left, right) => right.pixelX - left.pixelX)[0]
      : upwardTips.slice().sort((left, right) => left.pixelY - right.pixelY)[0];
  const fallbackTip = topBandTip(componentPixels, componentLength, frameWidth, minimumY, maximumY);
  let resolvedIndex = indexTip ?? fallbackTip;
  let resolvedThumb = thumbTip ?? {
    pixelX: palmPixelX,
    pixelY: palmPixelY,
    distance: palmRadius,
    confidence: 0,
    angle: 0,
    x: palmLocalX,
    y: palmLocalY
  };
  if (resolvedIndex === undefined) return undefined;

  // A true OK gesture leaves at most four exterior radial tips (the touching
  // thumb/index pair becomes the loop). This blocks ordinary five-finger gaps
  // from being reinterpreted as a pinch under high-contrast office lighting.
  const pinchLoop = tips.length <= 4
    ? findPinchLoop(localMask, localWidth, localHeight, palmLocalX, palmLocalY, palmRadius, handedness)
    : undefined;
  if (pinchLoop !== undefined) {
    const loopPixelX = pinchLoop.x + minimumX - 1;
    const loopPixelY = pinchLoop.y + minimumY - 1;
    resolvedIndex = {
      x: pinchLoop.x,
      y: pinchLoop.y,
      pixelX: loopPixelX,
      pixelY: loopPixelY,
      angle: Math.atan2(pinchLoop.y - palmLocalY, pinchLoop.x - palmLocalX),
      distance: Math.hypot(pinchLoop.x - palmLocalX, pinchLoop.y - palmLocalY),
      confidence: pinchLoop.confidence
    };
    resolvedThumb = {
      ...resolvedIndex,
      pixelX: loopPixelX + (handedness === "right" ? -0.12 : 0.12) * palmRadius
    };
  }

  const palmScale = palmRadius / Math.max(1, Math.min(frameWidth, frameHeight));
  const indexPoint = normalizedPoint(resolvedIndex.pixelX, resolvedIndex.pixelY, resolvedIndex.confidence, frameWidth, frameHeight);
  const thumbPoint = normalizedPoint(resolvedThumb.pixelX, resolvedThumb.pixelY, resolvedThumb.confidence, frameWidth, frameHeight);
  const pinchDistancePixels = Math.hypot(resolvedIndex.pixelX - resolvedThumb.pixelX, resolvedIndex.pixelY - resolvedThumb.pixelY);
  const pinchRatio = pinchLoop === undefined ? pinchDistancePixels / Math.max(palmRadius, 1) : 0.12;
  const pinchConfidence = pinchLoop?.confidence
    ?? (pinchRatio <= 1.05 ? Math.min(resolvedIndex.confidence, resolvedThumb.confidence) : 0);
  const extendedFingerCount = Math.min(5, tips.length);
  const palmConfidence = clamp((palmRadius / Math.max(4, Math.min(localWidth, localHeight) * 0.2)) * 0.55 + Math.min(1, count / 420) * 0.45, 0, 1);
  const openPalmConfidence = clamp((extendedFingerCount - 2) / 3 * 0.72 + palmConfidence * 0.28, 0, 1);
  const areaRatio = count / (frameWidth * frameHeight);
  return {
    x: clamp(sumX / count / Math.max(frameWidth - 1, 1), 0, 1),
    y: clamp(sumY / count / Math.max(frameHeight - 1, 1), 0, 1),
    areaRatio,
    confidence: clamp(count / Math.max(frameWidth * frameHeight * 0.055, 1), 0, 1),
    finger: indexPoint,
    thumb: thumbPoint,
    palm: {
      x: clamp(palmPixelX / Math.max(frameWidth - 1, 1), 0, 1),
      y: clamp(palmPixelY / Math.max(frameHeight - 1, 1), 0, 1),
      scale: palmScale,
      confidence: palmConfidence
    },
    handedness,
    extendedFingerCount,
    openPalmConfidence,
    pinchRatio,
    pinchConfidence,
    ...(pinchLoop !== undefined
      ? { pinchEvidence: "loop" as const }
      : pinchRatio <= 1.05 && pinchConfidence >= 0.12
        ? { pinchEvidence: "tips" as const }
        : {})
  };
}

interface RadialTip {
  readonly x: number;
  readonly y: number;
  readonly pixelX: number;
  readonly pixelY: number;
  readonly angle: number;
  readonly distance: number;
  readonly confidence: number;
}

function findRadialFingertips(
  mask: Uint8Array,
  width: number,
  height: number,
  palmX: number,
  palmY: number,
  palmRadius: number
): readonly Omit<RadialTip, "pixelX" | "pixelY">[] {
  const binCount = 128;
  const radii = new Float64Array(binCount);
  const pointX = new Int16Array(binCount);
  const pointY = new Int16Array(binCount);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (mask[index] !== 1) continue;
      const boundary = mask[index - 1] !== 1 || mask[index + 1] !== 1 || mask[index - width] !== 1 || mask[index + width] !== 1;
      if (!boundary) continue;
      const deltaX = x - palmX;
      const deltaY = y - palmY;
      const distance = Math.hypot(deltaX, deltaY);
      const angle = Math.atan2(deltaY, deltaX);
      const bin = clamp(Math.floor((angle + Math.PI) / (Math.PI * 2) * binCount), 0, binCount - 1);
      if (distance <= (radii[bin] ?? 0)) continue;
      radii[bin] = distance;
      pointX[bin] = x;
      pointY[bin] = y;
    }
  }

  const smoothed = new Float64Array(binCount);
  for (let bin = 0; bin < binCount; bin += 1) {
    let total = 0;
    let weight = 0;
    for (let offset = -1; offset <= 1; offset += 1) {
      const sample = radii[wrapBin(bin + offset, binCount)] ?? 0;
      const sampleWeight = offset === 0 ? 2 : 1;
      total += sample * sampleWeight;
      weight += sampleWeight;
    }
    smoothed[bin] = total / weight;
  }

  const candidates: Array<Omit<RadialTip, "pixelX" | "pixelY">> = [];
  for (let bin = 0; bin < binCount; bin += 1) {
    const angle = (bin + 0.5) / binCount * Math.PI * 2 - Math.PI;
    if (angle > 0.52 && angle < 2.72) continue;
    const radius = smoothed[bin] ?? 0;
    if (radius < palmRadius * 1.42) continue;
    let localMaximum = true;
    for (let offset = -2; offset <= 2; offset += 1) {
      if (offset !== 0 && (smoothed[wrapBin(bin + offset, binCount)] ?? 0) > radius) localMaximum = false;
    }
    if (!localMaximum) continue;
    const valley = Math.min(smoothed[wrapBin(bin - 3, binCount)] ?? 0, smoothed[wrapBin(bin + 3, binCount)] ?? 0);
    const prominence = radius - valley;
    if (prominence < palmRadius * 0.08) continue;
    const x = pointX[bin] ?? 0;
    const y = pointY[bin] ?? 0;
    if (y > palmY + palmRadius * 0.45) continue;
    candidates.push({
      x,
      y,
      angle,
      distance: radii[bin] ?? radius,
      confidence: clamp((radius / Math.max(palmRadius, 1) - 1.2) * 0.55 + prominence / Math.max(palmRadius, 1) * 0.45, 0, 1)
    });
  }

  const selected: Array<Omit<RadialTip, "pixelX" | "pixelY">> = [];
  for (const candidate of candidates.sort((left, right) => right.distance - left.distance)) {
    const duplicate = selected.some((existing) => {
      const angleDistance = Math.abs(Math.atan2(Math.sin(candidate.angle - existing.angle), Math.cos(candidate.angle - existing.angle)));
      return angleDistance < 0.09 || Math.hypot(candidate.x - existing.x, candidate.y - existing.y) < palmRadius * 0.34;
    });
    if (!duplicate) selected.push(candidate);
    if (selected.length >= 5) break;
  }
  return selected;
}

function palmLateralSpans(
  mask: Uint8Array,
  width: number,
  height: number,
  palmX: number,
  palmY: number,
  palmRadius: number
): { readonly left: number; readonly right: number } {
  const top = Math.max(1, Math.floor(palmY - palmRadius * 0.88));
  const bottom = Math.min(height - 2, Math.ceil(palmY + palmRadius * 0.68));
  let minimumX = palmX;
  let maximumX = palmX;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (mask[y * width + x] !== 1) continue;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
    }
  }
  return { left: palmX - minimumX, right: maximumX - palmX };
}

interface CameraPinchLoop {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

/**
 * Detects the enclosed opening of an OK gesture. Thumb and index become one
 * exterior contour at contact, so a conventional fingertip-distance detector
 * loses both identities; the interior loop remains stable and pose-specific.
 */
function findPinchLoop(
  mask: Uint8Array,
  width: number,
  height: number,
  palmX: number,
  palmY: number,
  palmRadius: number,
  handedness: CameraHandedness
): CameraPinchLoop | undefined {
  const closed = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (mask[index] !== 1) continue;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) closed[index + offsetY * width + offsetX] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let selected: CameraPinchLoop | undefined;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (let start = 0; start < closed.length; start += 1) {
    if (closed[start] === 1 || visited[start] === 1) continue;
    let read = 0;
    let write = 1;
    queue[0] = start;
    visited[start] = 1;
    let touchesBorder = false;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    while (read < write) {
      const index = queue[read];
      read += 1;
      if (index === undefined) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      count += 1;
      sumX += x;
      sumY += y;
      for (const neighbor of [index - 1, index + 1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= closed.length || closed[neighbor] === 1 || visited[neighbor] === 1) continue;
        const neighborX = neighbor % width;
        if (Math.abs(neighborX - x) > 1) continue;
        visited[neighbor] = 1;
        queue[write] = neighbor;
        write += 1;
      }
    }
    if (touchesBorder || count < Math.max(3, palmRadius * palmRadius * 0.045) || count > palmRadius * palmRadius * 3.2) continue;
    const x = sumX / count;
    const y = sumY / count;
    const deltaX = x - palmX;
    const deltaY = y - palmY;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < palmRadius * 0.72 || distance > palmRadius * 3.65 || y > palmY + palmRadius * 0.72) continue;
    const correctSide = handedness === "right"
      ? deltaX <= palmRadius * 0.45
      : handedness === "left"
        ? deltaX >= -palmRadius * 0.45
        : Math.abs(deltaX) >= palmRadius * 0.2;
    if (!correctSide) continue;
    const areaScore = clamp(count / Math.max(palmRadius * palmRadius * 0.55, 1), 0, 1);
    const distanceScore = 1 - clamp(Math.abs(distance / Math.max(palmRadius, 1) - 1.65) / 1.8, 0, 1);
    const score = areaScore * 0.46 + distanceScore * 0.54;
    if (score > selectedScore) {
      selected = { x, y, confidence: clamp(0.35 + score * 0.65, 0, 1) };
      selectedScore = score;
    }
  }
  return selected;
}

function topBandTip(
  componentPixels: Int32Array,
  componentLength: number,
  frameWidth: number,
  minimumY: number,
  maximumY: number
): RadialTip | undefined {
  const bandBottom = minimumY + Math.max(2, Math.floor((maximumY - minimumY + 1) * 0.12));
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let position = 0; position < componentLength; position += 1) {
    const index = componentPixels[position];
    if (index === undefined) continue;
    const y = Math.floor(index / frameWidth);
    if (y > bandBottom) continue;
    count += 1;
    sumX += index % frameWidth;
    sumY += y;
  }
  if (count === 0) return undefined;
  return {
    x: 0,
    y: 0,
    pixelX: sumX / count,
    pixelY: sumY / count,
    angle: -Math.PI / 2,
    distance: 0,
    confidence: 0.22
  };
}

function normalizedPoint(pixelX: number, pixelY: number, confidence: number, width: number, height: number): CameraTrackedPoint {
  return {
    x: clamp(pixelX / Math.max(width - 1, 1), 0, 1),
    y: clamp(pixelY / Math.max(height - 1, 1), 0, 1),
    confidence: clamp(confidence, 0, 1)
  };
}

function wrapBin(value: number, count: number): number {
  return (value % count + count) % count;
}

function insideCameraSearchRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  region: CameraSearchRegion
): boolean {
  const normalizedX = x / Math.max(width - 1, 1);
  const normalizedY = y / Math.max(height - 1, 1);
  return Math.abs(normalizedX - region.centerX) <= region.halfWidth
    && Math.abs(normalizedY - region.centerY) <= region.halfHeight;
}

function cameraPixelDiffersFromBackground(
  luma: number,
  cb: number,
  cr: number,
  index: number,
  background: CameraBackgroundModel
): boolean {
  const backgroundLuma = background.luma[index] ?? 0;
  const backgroundCb = background.cb[index] ?? 128;
  const backgroundCr = background.cr[index] ?? 128;
  const lumaDelta = Math.abs(luma - backgroundLuma);
  const chromaDelta = Math.hypot(cb - backgroundCb, cr - backgroundCr);
  const lumaThreshold = clamp(16 + (background.lumaNoise[index] ?? 0) * 2.6, 18, 48);
  const chromaThreshold = clamp(8 + (background.chromaNoise[index] ?? 0) * 2.15, 10, 32);
  return lumaDelta >= lumaThreshold
    || chromaDelta >= chromaThreshold
    || lumaDelta / lumaThreshold + chromaDelta / chromaThreshold >= 1.18;
}

function calibrationFromSamples(
  lumaSamples: number[],
  cbSamples: number[],
  crSamples: number[],
  minimumSamples: number
): CameraHandCalibration | null {
  if (lumaSamples.length < minimumSamples || cbSamples.length !== lumaSamples.length || crSamples.length !== lumaSamples.length) return null;
  lumaSamples.sort((left, right) => left - right);
  cbSamples.sort((left, right) => left - right);
  crSamples.sort((left, right) => left - right);
  const cb = percentile(cbSamples, 0.5);
  const cr = percentile(crSamples, 0.5);
  const cbDeviation = medianAbsoluteDeviation(cbSamples, cb);
  const crDeviation = medianAbsoluteDeviation(crSamples, cr);
  const chromaTolerance = clamp(Math.hypot(cbDeviation, crDeviation) * 3.2 + 10, 14, 44);
  return {
    cb,
    cr,
    chromaTolerance,
    minimumLuma: clamp(percentile(lumaSamples, 0.08) - 48, 10, 220),
    maximumLuma: clamp(percentile(lumaSamples, 0.92) + 48, 50, 254),
    sampleCount: lumaSamples.length
  };
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width >= 16
    && height >= 16
    && width * height <= 4_194_304;
}

function validFrame(pixels: Uint8ClampedArray, width: number, height: number): boolean {
  return validDimensions(width, height) && pixels.length === width * height * 4;
}

function rgbToYcbcr(red: number, green: number, blue: number): readonly [number, number, number] {
  return [
    0.299 * red + 0.587 * green + 0.114 * blue,
    128 - 0.168736 * red - 0.331264 * green + 0.5 * blue,
    128 + 0.5 * red - 0.418688 * green - 0.081312 * blue
  ];
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.round(clamp(fraction, 0, 1) * (sorted.length - 1));
  return sorted[index] ?? 0;
}

function medianAbsoluteDeviation(sorted: readonly number[], median: number): number {
  return percentile(sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right), 0.5);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
