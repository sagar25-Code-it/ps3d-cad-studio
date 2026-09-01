export const PS3D_HAND_LANDMARKER_WORKER_ID = "ps3d-hand-landmarker-worker-v1";

export interface HandLandmarkPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface HandLandmarkFrame {
  readonly frameId: number;
  readonly timestampMs: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly handedness: "right" | "left" | "unknown";
  readonly handednessScore: number;
  readonly landmarks: readonly HandLandmarkPoint[];
  readonly worldLandmarks: readonly HandLandmarkPoint[];
  readonly inferenceMs: number;
}

export type HandLandmarkerWorkerRequest =
  | {
      readonly type: "init";
      readonly wasmBaseUrl: string;
      readonly modelUrl: string;
      readonly minimumDetectionConfidence: number;
      readonly minimumPresenceConfidence: number;
      readonly minimumTrackingConfidence: number;
    }
  | {
      readonly type: "frame";
      readonly frameId: number;
      readonly timestampMs: number;
      readonly bitmap: ImageBitmap;
    }
  | { readonly type: "dispose" };

export type HandLandmarkerWorkerResponse =
  | { readonly type: "ready"; readonly workerId: typeof PS3D_HAND_LANDMARKER_WORKER_ID }
  | { readonly type: "result"; readonly frame: HandLandmarkFrame | null }
  | { readonly type: "error"; readonly stage: "initialization" | "inference"; readonly message: string };

