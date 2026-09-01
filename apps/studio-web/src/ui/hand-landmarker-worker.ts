import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  PS3D_HAND_LANDMARKER_WORKER_ID,
  type HandLandmarkFrame,
  type HandLandmarkPoint,
  type HandLandmarkerWorkerRequest,
  type HandLandmarkerWorkerResponse
} from "./hand-landmarker-protocol.js";

interface WorkerHost {
  onmessage: ((event: MessageEvent<HandLandmarkerWorkerRequest>) => void) | null;
  postMessage(message: HandLandmarkerWorkerResponse): void;
}

const host = globalThis as unknown as WorkerHost;
let handLandmarker: HandLandmarker | undefined;
let mirrorCanvas: OffscreenCanvas | undefined;
let mirrorContext: OffscreenCanvasRenderingContext2D | null = null;

host.onmessage = (event): void => {
  const message = event.data;
  if (message.type === "init") {
    void initialize(message);
    return;
  }
  if (message.type === "dispose") {
    handLandmarker?.close();
    handLandmarker = undefined;
    mirrorCanvas = undefined;
    mirrorContext = null;
    return;
  }
  if (message.type === "frame") processFrame(message);
};

async function initialize(message: Extract<HandLandmarkerWorkerRequest, { type: "init" }>): Promise<void> {
  try {
    if (message.wasmBaseUrl !== "/mediapipe/wasm" || message.modelUrl !== "/mediapipe/models/hand_landmarker-float16-v1.task") {
      throw new Error("Hand runtime must use the reviewed same-origin paths.");
    }
    for (const confidence of [
      message.minimumDetectionConfidence,
      message.minimumPresenceConfidence,
      message.minimumTrackingConfidence
    ]) {
      if (!Number.isFinite(confidence) || confidence < 0.5 || confidence > 0.95) {
        throw new Error("Hand runtime confidence threshold is outside the reviewed range.");
      }
    }
    handLandmarker?.close();
    const fileset = await FilesetResolver.forVisionTasks(message.wasmBaseUrl, true);
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: message.modelUrl,
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: message.minimumDetectionConfidence,
      minHandPresenceConfidence: message.minimumPresenceConfidence,
      minTrackingConfidence: message.minimumTrackingConfidence
    });
    host.postMessage({ type: "ready", workerId: PS3D_HAND_LANDMARKER_WORKER_ID });
  } catch (error) {
    host.postMessage({ type: "error", stage: "initialization", message: errorMessage(error) });
  }
}

function processFrame(message: Extract<HandLandmarkerWorkerRequest, { type: "frame" }>): void {
  const startedAt = performance.now();
  try {
    if (handLandmarker === undefined) throw new Error("Hand landmark runtime is not initialized.");
    const width = message.bitmap.width;
    const height = message.bitmap.height;
    if (
      !Number.isInteger(message.frameId)
      || message.frameId <= 0
      || !Number.isFinite(message.timestampMs)
      || width <= 0
      || height <= 0
      || width * height > 2_073_600
    ) {
      throw new Error("Camera frame identity, timestamp, or dimensions are invalid.");
    }
    if (mirrorCanvas === undefined || mirrorCanvas.width !== width || mirrorCanvas.height !== height) {
      mirrorCanvas = new OffscreenCanvas(width, height);
      mirrorContext = mirrorCanvas.getContext("2d", { alpha: false });
    }
    if (mirrorContext === null || mirrorCanvas === undefined) throw new Error("Offscreen camera processing is unavailable.");
    mirrorContext.save();
    mirrorContext.setTransform(-1, 0, 0, 1, width, 0);
    mirrorContext.drawImage(message.bitmap, 0, 0, width, height);
    mirrorContext.restore();
    const result = handLandmarker.detectForVideo(
      mirrorCanvas as unknown as Parameters<HandLandmarker["detectForVideo"]>[0],
      message.timestampMs
    );
    host.postMessage({
      type: "result",
      frame: serializeResult(result, message.frameId, message.timestampMs, width, height, performance.now() - startedAt)
    });
  } catch (error) {
    host.postMessage({ type: "error", stage: "inference", message: errorMessage(error) });
  } finally {
    message.bitmap.close();
  }
}

function serializeResult(
  result: HandLandmarkerResult,
  frameId: number,
  timestampMs: number,
  frameWidth: number,
  frameHeight: number,
  inferenceMs: number
): HandLandmarkFrame | null {
  const landmarks = result.landmarks[0];
  if (landmarks === undefined || landmarks.length !== 21) return null;
  const category = result.handedness[0]?.[0] ?? result.handednesses[0]?.[0];
  const categoryName = category?.categoryName.toLowerCase();
  const handedness = categoryName === "right" ? "right" : categoryName === "left" ? "left" : "unknown";
  return {
    frameId,
    timestampMs,
    frameWidth,
    frameHeight,
    handedness,
    handednessScore: category?.score ?? 0,
    landmarks: landmarks.map(copyPoint),
    worldLandmarks: (result.worldLandmarks[0] ?? []).map(copyPoint),
    inferenceMs
  };
}

function copyPoint(point: { x: number; y: number; z: number }): HandLandmarkPoint {
  return { x: point.x, y: point.y, z: point.z };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown hand landmark runtime failure.";
}
