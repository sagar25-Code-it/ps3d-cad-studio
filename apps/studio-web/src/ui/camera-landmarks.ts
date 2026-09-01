import type { CameraTrackedHand, CameraTrackedPoint } from "./camera-gesture.js";
import type { HandLandmarkFrame, HandLandmarkPoint } from "./hand-landmarker-protocol.js";

const EXPECTED_LANDMARK_COUNT = 21;
const DEFAULT_MIN_CUTOFF_HZ = 1.2;
const DEFAULT_BETA = 0.035;
const DEFAULT_DERIVATIVE_CUTOFF_HZ = 1;
const MINIMUM_MIRRORED_PALM_CHIRALITY = 0.08;

interface OneEuroAxisState {
  readonly value: number;
  readonly raw: number;
  readonly derivative: number;
  readonly timestampMs: number;
}

interface LandmarkFilterState {
  readonly x: OneEuroAxisState;
  readonly y: OneEuroAxisState;
  readonly z: OneEuroAxisState;
}

export interface CameraLandmarkTrackerOptions {
  readonly minimumHandednessScore?: number;
  readonly minimumModelConfidence?: number;
  readonly minimumCutoffHz?: number;
  readonly beta?: number;
  readonly derivativeCutoffHz?: number;
  readonly maximumJump?: number;
}

/**
 * Stateful, allocation-bounded landmark tracking. MediaPipe performs hand
 * detection; this layer handles temporal filtering, continuity, gesture
 * geometry, and the fail-closed conversion into PS3D camera-control signals.
 */
export class CameraLandmarkTracker {
  readonly #options: Required<CameraLandmarkTrackerOptions>;
  #filters: LandmarkFilterState[] | undefined;
  #lastHand: CameraTrackedHand | undefined;
  #lastAcceptedAt = 0;

  constructor(options: CameraLandmarkTrackerOptions = {}) {
    this.#options = {
      minimumHandednessScore: options.minimumHandednessScore ?? 0.55,
      minimumModelConfidence: options.minimumModelConfidence ?? 0.5,
      minimumCutoffHz: options.minimumCutoffHz ?? DEFAULT_MIN_CUTOFF_HZ,
      beta: options.beta ?? DEFAULT_BETA,
      derivativeCutoffHz: options.derivativeCutoffHz ?? DEFAULT_DERIVATIVE_CUTOFF_HZ,
      maximumJump: options.maximumJump ?? 0.3
    };
  }

  reset(): void {
    this.#filters = undefined;
    this.#lastHand = undefined;
    this.#lastAcceptedAt = 0;
  }

  miss(timestampMs: number): void {
    if (this.#lastAcceptedAt !== 0 && timestampMs - this.#lastAcceptedAt > 650) this.reset();
  }

  update(frame: HandLandmarkFrame): CameraTrackedHand | undefined {
    if (!validFrame(frame) || frame.handednessScore < this.#options.minimumModelConfidence) {
      this.miss(frame.timestampMs);
      return undefined;
    }

    const rawHand = deriveCameraTrackedHand(frame, frame.landmarks, this.#options.minimumHandednessScore);
    if (rawHand === undefined) return undefined;
    if (this.#lastHand !== undefined && this.#lastAcceptedAt !== 0) {
      const elapsed = frame.timestampMs - this.#lastAcceptedAt;
      if (elapsed >= 650) {
        // A hand seen after the continuity window is a new acquisition. Do not
        // blend it with stale landmarks or allow the previous identity/filter
        // state to leak into the new track.
        this.reset();
      } else {
        const jump = Math.hypot(rawHand.palm.x - this.#lastHand.palm.x, rawHand.palm.y - this.#lastHand.palm.y);
        const scaleAwareLimit = Math.max(0.16, Math.min(this.#options.maximumJump, this.#lastHand.palm.scale * 1.8));
        if (elapsed <= 0) return undefined;
        if (jump > scaleAwareLimit) {
          this.miss(frame.timestampMs);
          return undefined;
        }
      }
    }

    const filtered = this.#filter(frame.landmarks, frame.timestampMs);
    const hand = deriveCameraTrackedHand(frame, filtered, this.#options.minimumHandednessScore);
    if (hand === undefined) return undefined;
    this.#lastHand = hand;
    this.#lastAcceptedAt = frame.timestampMs;
    return hand;
  }

  #filter(landmarks: readonly HandLandmarkPoint[], timestampMs: number): readonly HandLandmarkPoint[] {
    const nextFilters: LandmarkFilterState[] = [];
    const filtered: HandLandmarkPoint[] = [];
    for (let index = 0; index < EXPECTED_LANDMARK_COUNT; index += 1) {
      const point = landmarks[index]!;
      const previous = this.#filters?.[index];
      const x = filterOneEuroAxis(previous?.x, point.x, timestampMs, this.#options);
      const y = filterOneEuroAxis(previous?.y, point.y, timestampMs, this.#options);
      const z = filterOneEuroAxis(previous?.z, point.z, timestampMs, this.#options);
      nextFilters.push({ x, y, z });
      filtered.push({ x: x.value, y: y.value, z: z.value });
    }
    this.#filters = nextFilters;
    return filtered;
  }
}

export function deriveCameraTrackedHand(
  frame: HandLandmarkFrame,
  landmarks: readonly HandLandmarkPoint[] = frame.landmarks,
  minimumHandednessScore = 0.55
): CameraTrackedHand | undefined {
  if (!validLandmarks(landmarks) || frame.frameWidth <= 0 || frame.frameHeight <= 0) return undefined;
  const aspectX = frame.frameWidth / Math.min(frame.frameWidth, frame.frameHeight);
  const aspectY = frame.frameHeight / Math.min(frame.frameWidth, frame.frameHeight);
  const point = (index: number): HandLandmarkPoint => landmarks[index]!;
  const metric = (index: number): HandLandmarkPoint => {
    const candidate = frame.worldLandmarks[index];
    if (candidate !== undefined && finitePoint(candidate)) return candidate;
    const source = point(index);
    return { x: source.x * aspectX, y: source.y * aspectY, z: source.z };
  };
  const palmIndices = [0, 5, 9, 13, 17] as const;
  const palmCenter = meanPoint(palmIndices.map(point));
  const palmMetric = meanPoint(palmIndices.map(metric));
  const palmWidth = Math.max(distance2dScaled(point(5), point(17), aspectX, aspectY), 1e-4);
  const palmMetricWidth = Math.max(distance3d(metric(5), metric(17)), 1e-4);
  const box = landmarkBounds(landmarks);
  const modelConfidence = clamp(frame.handednessScore, 0, 1);

  const extensionScores = [
    thumbExtensionScore(metric, palmMetric, palmMetricWidth),
    fingerExtensionScore(metric, 5, 6, 7, 8),
    fingerExtensionScore(metric, 9, 10, 11, 12),
    fingerExtensionScore(metric, 13, 14, 15, 16),
    fingerExtensionScore(metric, 17, 18, 19, 20)
  ];
  const extendedFingerCount = extensionScores.filter((score) => score >= 0.56).length;
  const nonThumbExtension = mean(extensionScores.slice(1));
  const tipSpread = mean([
    distance2dScaled(point(8), point(12), aspectX, aspectY),
    distance2dScaled(point(12), point(16), aspectX, aspectY),
    distance2dScaled(point(16), point(20), aspectX, aspectY)
  ]) / palmWidth;
  const spreadScore = remapClamped(tipSpread, 0.18, 0.62);
  const pinchRatio = distance2dScaled(point(4), point(8), aspectX, aspectY) / palmWidth;
  const pinchConfidence = clamp(remapClamped(0.58 - pinchRatio, 0, 0.42) * modelConfidence, 0, 1);
  const openPalmConfidence = clamp(
    (nonThumbExtension * 0.62 + spreadScore * 0.22 + modelConfidence * 0.16) * remapClamped(pinchRatio, 0.32, 0.82),
    0,
    1
  );
  const modelHandedness = frame.handednessScore < minimumHandednessScore ? "unknown" : frame.handedness;
  const anatomicalHandedness = mirroredPalmAnatomicalHandedness(landmarks, aspectX, aspectY);
  // The worker receives the same mirrored image shown to the user. A clear
  // anatomical contradiction still fails closed, but an edge-on/foreshortened
  // palm may retain a high-confidence model identity. Requiring a decisive 2D
  // signed area on every frame drew valid landmarks while permanently
  // suppressing the cursor and every downstream CAD control callback.
  const handedness = resolveCameraHandedness(modelHandedness, anatomicalHandedness);
  const pointConfidence = clamp(modelConfidence * 0.95 + 0.05, 0, 1);

  return {
    x: palmCenter.x,
    y: palmCenter.y,
    areaRatio: clamp((box.maximumX - box.minimumX) * (box.maximumY - box.minimumY), 0, 1),
    confidence: modelConfidence,
    finger: trackedPoint(point(8), pointConfidence),
    thumb: trackedPoint(point(4), pointConfidence),
    palm: { ...trackedPoint(palmCenter, pointConfidence), scale: palmWidth },
    modelHandedness,
    anatomicalHandedness,
    handedness,
    extendedFingerCount,
    openPalmConfidence,
    pinchRatio,
    pinchConfidence,
    pinchEvidence: "tips"
  };
}

export function resolveCameraHandedness(
  modelHandedness: CameraTrackedHand["handedness"],
  anatomicalHandedness: CameraTrackedHand["handedness"]
): CameraTrackedHand["handedness"] {
  if (modelHandedness === "unknown") return "unknown";
  if (anatomicalHandedness !== "unknown" && anatomicalHandedness !== modelHandedness) return "unknown";
  return modelHandedness;
}

function mirroredPalmAnatomicalHandedness(
  landmarks: readonly HandLandmarkPoint[],
  aspectX: number,
  aspectY: number
): CameraTrackedHand["handedness"] {
  const wrist = landmarks[0]!;
  const indexMcp = landmarks[5]!;
  const pinkyMcp = landmarks[17]!;
  const indexX = (indexMcp.x - wrist.x) * aspectX;
  const indexY = (indexMcp.y - wrist.y) * aspectY;
  const pinkyX = (pinkyMcp.x - wrist.x) * aspectX;
  const pinkyY = (pinkyMcp.y - wrist.y) * aspectY;
  const palmWidth = Math.max(distance2dScaled(indexMcp, pinkyMcp, aspectX, aspectY), 1e-4);
  const normalizedSignedArea = (indexX * pinkyY - indexY * pinkyX) / (palmWidth * palmWidth);
  // The worker flips the camera frame before inference. In that mirrored
  // coordinate system a palm-facing RIGHT hand places the thumb/display side
  // to the right and produces a negative wrist-index-pinky signed area. The
  // previous mapping used the unmirrored sign convention, so a real right
  // palm contradicted MediaPipe's correct RIGHT label and was resolved to
  // unknown: landmarks were drawn, but cursor/orbit callbacks were blocked.
  if (normalizedSignedArea <= -MINIMUM_MIRRORED_PALM_CHIRALITY) return "right";
  if (normalizedSignedArea >= MINIMUM_MIRRORED_PALM_CHIRALITY) return "left";
  return "unknown";
}

function validFrame(frame: HandLandmarkFrame): boolean {
  return Number.isInteger(frame.frameId)
    && frame.frameId >= 0
    && Number.isFinite(frame.timestampMs)
    && Number.isInteger(frame.frameWidth)
    && Number.isInteger(frame.frameHeight)
    && frame.frameWidth > 0
    && frame.frameHeight > 0
    && frame.frameWidth * frame.frameHeight <= 2_073_600
    && Number.isFinite(frame.handednessScore)
    && frame.handednessScore >= 0
    && frame.handednessScore <= 1
    && Number.isFinite(frame.inferenceMs)
    && frame.inferenceMs >= 0
    && frame.inferenceMs <= 10_000
    && validNormalizedLandmarks(frame.landmarks)
    && (frame.worldLandmarks.length === 0 || validLandmarks(frame.worldLandmarks));
}

function validLandmarks(landmarks: readonly HandLandmarkPoint[]): boolean {
  return landmarks.length === EXPECTED_LANDMARK_COUNT && landmarks.every(finitePoint);
}

function validNormalizedLandmarks(landmarks: readonly HandLandmarkPoint[]): boolean {
  return validLandmarks(landmarks)
    && landmarks.every((point) => point.x >= -1 && point.x <= 2 && point.y >= -1 && point.y <= 2 && point.z >= -2 && point.z <= 2);
}

function finitePoint(point: HandLandmarkPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function trackedPoint(point: HandLandmarkPoint, confidence: number): CameraTrackedPoint {
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1), confidence };
}

function fingerExtensionScore(
  point: (index: number) => HandLandmarkPoint,
  mcp: number,
  pip: number,
  dip: number,
  tip: number
): number {
  const pipAngle = jointAngle(point(mcp), point(pip), point(dip));
  const dipAngle = jointAngle(point(pip), point(dip), point(tip));
  const wristDistanceRatio = distance3d(point(tip), point(0)) / Math.max(distance3d(point(pip), point(0)), 1e-4);
  return clamp(
    remapClamped(pipAngle, 1.92, 2.88) * 0.48
      + remapClamped(dipAngle, 2.05, 2.92) * 0.34
      + remapClamped(wristDistanceRatio, 1.04, 1.38) * 0.18,
    0,
    1
  );
}

function thumbExtensionScore(
  point: (index: number) => HandLandmarkPoint,
  palmCenter: HandLandmarkPoint,
  palmWidth: number
): number {
  const angle = jointAngle(point(2), point(3), point(4));
  const reach = distance3d(point(4), palmCenter) / palmWidth;
  return clamp(remapClamped(angle, 1.75, 2.82) * 0.65 + remapClamped(reach, 0.48, 0.9) * 0.35, 0, 1);
}

function filterOneEuroAxis(
  previous: OneEuroAxisState | undefined,
  raw: number,
  timestampMs: number,
  options: Required<CameraLandmarkTrackerOptions>
): OneEuroAxisState {
  if (previous === undefined || timestampMs <= previous.timestampMs) {
    return { value: raw, raw, derivative: 0, timestampMs };
  }
  const elapsedSeconds = clamp((timestampMs - previous.timestampMs) / 1000, 1 / 240, 0.25);
  const rawDerivative = (raw - previous.raw) / elapsedSeconds;
  const derivative = lowPass(previous.derivative, rawDerivative, smoothingAlpha(options.derivativeCutoffHz, elapsedSeconds));
  const cutoff = options.minimumCutoffHz + options.beta * Math.abs(derivative);
  return {
    value: lowPass(previous.value, raw, smoothingAlpha(cutoff, elapsedSeconds)),
    raw,
    derivative,
    timestampMs
  };
}

function smoothingAlpha(cutoffHz: number, elapsedSeconds: number): number {
  const timeConstant = 1 / (2 * Math.PI * Math.max(cutoffHz, 1e-4));
  return 1 / (1 + timeConstant / elapsedSeconds);
}

function lowPass(previous: number, current: number, alpha: number): number {
  return previous + (current - previous) * clamp(alpha, 0, 1);
}

function jointAngle(a: HandLandmarkPoint, b: HandLandmarkPoint, c: HandLandmarkPoint): number {
  const ab = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const denominator = Math.max(Math.hypot(ab.x, ab.y, ab.z) * Math.hypot(cb.x, cb.y, cb.z), 1e-8);
  return Math.acos(clamp((ab.x * cb.x + ab.y * cb.y + ab.z * cb.z) / denominator, -1, 1));
}

function landmarkBounds(points: readonly HandLandmarkPoint[]): { minimumX: number; minimumY: number; maximumX: number; maximumY: number } {
  return points.reduce((bounds, point) => ({
    minimumX: Math.min(bounds.minimumX, point.x),
    minimumY: Math.min(bounds.minimumY, point.y),
    maximumX: Math.max(bounds.maximumX, point.x),
    maximumY: Math.max(bounds.maximumY, point.y)
  }), { minimumX: 1, minimumY: 1, maximumX: 0, maximumY: 0 });
}

function meanPoint(points: readonly HandLandmarkPoint[]): HandLandmarkPoint {
  return {
    x: mean(points.map((point) => point.x)),
    y: mean(points.map((point) => point.y)),
    z: mean(points.map((point) => point.z))
  };
}

function distance2dScaled(a: HandLandmarkPoint, b: HandLandmarkPoint, scaleX: number, scaleY: number): number {
  return Math.hypot((a.x - b.x) * scaleX, (a.y - b.y) * scaleY);
}

function distance3d(a: HandLandmarkPoint, b: HandLandmarkPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function remapClamped(value: number, minimum: number, maximum: number): number {
  return clamp((value - minimum) / Math.max(maximum - minimum, 1e-8), 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
