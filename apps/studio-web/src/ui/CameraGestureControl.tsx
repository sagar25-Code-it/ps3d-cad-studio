import { useCallback, useEffect, useRef, useState } from "react";
import { CameraLandmarkTracker } from "./camera-landmarks.js";
import {
  advanceCameraGestureState,
  cameraExplodeDistanceFromPalmDepth,
  cameraPalmDepthFraction,
  cameraPinchPoint,
  cameraPointerControlSignal,
  createCameraGestureState,
  createCameraPalmDepthCalibration,
  type CameraCursorSignal,
  type CameraDepthCalibration,
  type CameraGestureState,
  type CameraHandedness,
  type CameraTrackedHand,
  type CameraTrackedPoint
} from "./camera-gesture.js";
import {
  PS3D_HAND_LANDMARKER_WORKER_ID,
  type HandLandmarkFrame,
  type HandLandmarkerWorkerRequest,
  type HandLandmarkerWorkerResponse
} from "./hand-landmarker-protocol.js";

type CameraPhase = "idle" | "requesting" | "loading" | "calibrating" | "tracking" | "paused" | "error";
type CameraControlMode = "orbit" | "explode";
type ScheduledFrameKind = "video" | "animation";

export type CameraCursorState = CameraCursorSignal;

export interface CameraGestureControlProps {
  readonly workspace: "part" | "assembly" | "surface" | "vehicle";
  readonly currentExplodeMm: number;
  readonly maxExplodeMm: number;
  readonly onOrbit: (deltaX: number, deltaY: number) => void;
  readonly onCursor: (cursor: CameraCursorState) => void;
  readonly onExplodePreview: (valueMm: number) => void;
  readonly onExplodeCommit: (valueMm: number) => void;
  readonly onMessage: (message: string) => void;
}

const DEFAULT_NEAR_SCALE_RATIO = 1.62;
const MODEL_LOAD_TIMEOUT_MS = 30000;
const STATUS_INTERVAL_MS = 140;
const HAND_CONNECTIONS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

export function CameraGestureControl(props: CameraGestureControlProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [phase, setPhaseState] = useState<CameraPhase>("idle");
  const [mode, setModeState] = useState<CameraControlMode>("orbit");
  const [feedback, setFeedback] = useState("Camera remains off until you select Start camera.");
  const [locked, setLocked] = useState(false);
  const [pinching, setPinching] = useState(false);
  const [fingerCount, setFingerCount] = useState(0);
  const [trackingConfidence, setTrackingConfidence] = useState(0);
  const [pinchPercent, setPinchPercent] = useState(0);
  const [depthPercent, setDepthPercent] = useState(0);
  const [nearTuned, setNearTuned] = useState(false);
  const [backgroundBlur, setBackgroundBlur] = useState(true);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [cameraProfile, setCameraProfile] = useState("not started");
  const [inferenceMs, setInferenceMs] = useState(0);
  const [droppedFrames, setDroppedFrames] = useState(0);
  const [detectedHandedness, setDetectedHandedness] = useState<CameraHandedness>("unknown");
  const [modelHandedness, setModelHandedness] = useState<CameraHandedness>("unknown");
  const [anatomicalHandedness, setAnatomicalHandedness] = useState<CameraHandedness>("unknown");
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);
  const workerReadyRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const frameInFlightRef = useRef(false);
  const frameSequenceRef = useRef(0);
  const skippedFrameCountRef = useRef(0);
  const scheduledFrameRef = useRef(0);
  const scheduledFrameKindRef = useRef<ScheduledFrameKind | undefined>(undefined);
  const captureGenerationRef = useRef(0);
  const modelTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const phaseRef = useRef<CameraPhase>("idle");
  const modeRef = useRef<CameraControlMode>("orbit");
  const propsRef = useRef(props);
  const trackerRef = useRef(new CameraLandmarkTracker());
  const gestureStateRef = useRef<CameraGestureState>(createCameraGestureState());
  const currentHandRef = useRef<CameraTrackedHand | undefined>(undefined);
  const currentFrameRef = useRef<HandLandmarkFrame | undefined>(undefined);
  const previousPinchPointRef = useRef<CameraTrackedPoint | undefined>(undefined);
  const depthCalibrationRef = useRef<CameraDepthCalibration | undefined>(undefined);
  const farPalmScaleRef = useRef<number | undefined>(undefined);
  const lastStatusAtRef = useRef(0);
  const explodeDirtyRef = useRef(false);
  const explodeActiveRef = useRef(false);
  const latestExplodeRef = useRef(props.currentExplodeMm);
  const submitFrameRef = useRef<(timestampMs: number) => void>(() => undefined);
  const workerMessageRef = useRef<(response: HandLandmarkerWorkerResponse) => void>(() => undefined);
  propsRef.current = props;

  const setPhase = useCallback((next: CameraPhase): void => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const hideCursor = useCallback((): void => {
    propsRef.current.onCursor({ x: 0.5, y: 0.5, visible: false, pinching: false });
  }, []);

  const resetPalmLock = useCallback((): void => {
    trackerRef.current.reset();
    gestureStateRef.current = createCameraGestureState();
    currentHandRef.current = undefined;
    currentFrameRef.current = undefined;
    previousPinchPointRef.current = undefined;
    depthCalibrationRef.current = undefined;
    farPalmScaleRef.current = undefined;
    explodeActiveRef.current = false;
    setLocked(false);
    setPinching(false);
    setFingerCount(0);
    setTrackingConfidence(0);
    setPinchPercent(0);
    setDepthPercent(0);
    setDetectedHandedness("unknown");
    setModelHandedness("unknown");
    setAnatomicalHandedness("unknown");
    setNearTuned(false);
    hideCursor();
  }, [hideCursor]);

  const commitExplodeIfNeeded = useCallback((): void => {
    if (!explodeDirtyRef.current) return;
    explodeDirtyRef.current = false;
    propsRef.current.onExplodeCommit(latestExplodeRef.current);
  }, []);

  const cancelCaptureLoop = useCallback((): void => {
    captureGenerationRef.current += 1;
    const handle = scheduledFrameRef.current;
    const video = videoRef.current;
    if (handle !== 0 && scheduledFrameKindRef.current === "video") video?.cancelVideoFrameCallback(handle);
    if (handle !== 0 && scheduledFrameKindRef.current === "animation") cancelAnimationFrame(handle);
    scheduledFrameRef.current = 0;
    scheduledFrameKindRef.current = undefined;
  }, []);

  const disposeWorker = useCallback((): void => {
    if (modelTimeoutRef.current !== undefined) clearTimeout(modelTimeoutRef.current);
    modelTimeoutRef.current = undefined;
    const worker = workerRef.current;
    if (worker !== undefined) {
      const dispose: HandLandmarkerWorkerRequest = { type: "dispose" };
      worker.postMessage(dispose);
      worker.terminate();
    }
    workerRef.current = undefined;
    workerReadyRef.current = false;
    frameInFlightRef.current = false;
    setRuntimeReady(false);
  }, []);

  const stopCamera = useCallback((announce = true): void => {
    cancelCaptureLoop();
    disposeWorker();
    commitExplodeIfNeeded();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = undefined;
    cameraReadyRef.current = false;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
    resetPalmLock();
    clearOverlay(overlayRef.current);
    setCameraProfile("not started");
    setInferenceMs(0);
    skippedFrameCountRef.current = 0;
    setDroppedFrames(0);
    setPhase("idle");
    setFeedback("Camera is off. No frame or landmark history is retained by PS3D.");
    if (announce) propsRef.current.onMessage("Right-hand landmark control stopped; camera and worker resources were released.");
  }, [cancelCaptureLoop, commitExplodeIfNeeded, disposeWorker, resetPalmLock, setPhase]);

  const processTrackedFrame = useCallback((frame: HandLandmarkFrame | null): void => {
    frameInFlightRef.current = false;
    const timestampMs = frame?.timestampMs ?? performance.now();
    if (frame === null) {
      trackerRef.current.miss(timestampMs);
      const transition = advanceCameraGestureState(gestureStateRef.current, undefined);
      gestureStateRef.current = transition.state;
      currentFrameRef.current = undefined;
      currentHandRef.current = undefined;
      previousPinchPointRef.current = undefined;
      setPinching(false);
      drawLandmarkOverlay(overlayRef.current, undefined, transition.state, phaseRef.current === "calibrating");
      hideCursor();
      if (transition.event === "lock-lost") {
        commitExplodeIfNeeded();
        resetPalmLock();
        setPhase("calibrating");
        setFeedback("Right-hand landmarks were lost. CAD motion is frozen; show an open right palm to reacquire.");
      }
      return;
    }

    const hand = trackerRef.current.update(frame);
    currentFrameRef.current = frame;
    const transition = advanceCameraGestureState(gestureStateRef.current, hand);
    gestureStateRef.current = transition.state;
    drawLandmarkOverlay(overlayRef.current, frame, transition.state, phaseRef.current === "calibrating");
    if (hand === undefined) {
      currentHandRef.current = undefined;
      previousPinchPointRef.current = undefined;
      setPinching(false);
      hideCursor();
      return;
    }

    if (timestampMs - lastStatusAtRef.current > STATUS_INTERVAL_MS) {
      lastStatusAtRef.current = timestampMs;
      setFingerCount(hand.extendedFingerCount);
      setTrackingConfidence(Math.round(hand.confidence * 100));
      setPinchPercent(Math.round(clamp((0.9 - hand.pinchRatio) / 0.72, 0, 1) * 100));
      setInferenceMs(Math.round(frame.inferenceMs * 10) / 10);
      setDroppedFrames(skippedFrameCountRef.current);
      setDetectedHandedness(hand.handedness);
      setModelHandedness(hand.modelHandedness ?? "unknown");
      setAnatomicalHandedness(hand.anatomicalHandedness ?? "unknown");
    }

    if (phaseRef.current === "calibrating") {
      if (transition.event !== "lock-acquired") {
        const progress = Math.min(7, transition.state.acquireFrames);
        setFeedback(hand.handedness === "left"
          ? "Left hand detected. Use your RIGHT hand and show the palm to the camera."
          : hand.handedness === "unknown"
            ? `Hand identity conflict (model ${handednessCode(hand.modelHandedness)}, palm ${handednessCode(hand.anatomicalHandedness)}). Face your RIGHT palm toward the camera.`
          : hand.extendedFingerCount >= 4
            ? `Open right palm recognized. Hold steady to lock (${progress}/7).`
            : "Show an open RIGHT palm with four or five fingers visible to acquire control.");
        return;
      }
      farPalmScaleRef.current = hand.palm.scale;
      depthCalibrationRef.current = createCameraPalmDepthCalibration(
        hand.palm.scale,
        hand.palm.scale * DEFAULT_NEAR_SCALE_RATIO
      ) ?? undefined;
      setLocked(true);
      setPinching(false);
      setPhase("tracking");
      setFeedback("Right hand locked. Index is the cursor; thumb-index pinch and hold activates mirrored 4x orbit.");
      propsRef.current.onMessage("21-landmark right-hand lock acquired with confidence-gated model identity and palm-chirality conflict rejection. Mirrored 4x pinch orbit and bounded palm-depth explode are ready.");
      return;
    }

    if (phaseRef.current !== "tracking") return;
    if (hand.handedness !== "right") {
      currentHandRef.current = undefined;
      previousPinchPointRef.current = undefined;
      setPinching(false);
      hideCursor();
      setFeedback("The locked right hand is not confidently visible. CAD motion is frozen while PS3D waits or releases the lock.");
      return;
    }
    currentHandRef.current = hand;
    setLocked(transition.state.locked);
    setPinching(transition.state.pinching);
    const pointerSignal = cameraPointerControlSignal(hand, transition.state, previousPinchPointRef.current);
    propsRef.current.onCursor(pointerSignal.cursor);

    const depthCalibration = depthCalibrationRef.current;
    const depthFraction = depthCalibration === undefined ? 0 : cameraPalmDepthFraction(hand.palm.scale, depthCalibration);
    if (timestampMs - lastStatusAtRef.current <= STATUS_INTERVAL_MS + 20) setDepthPercent(Math.round(depthFraction * 100));

    if (transition.event === "pinch-start") {
      previousPinchPointRef.current = cameraPinchPoint(hand);
      setFeedback("Pinch held: mirrored 4x direct orbit is active. Release thumb and index to stop immediately.");
    } else if (transition.event === "pinch-end") {
      previousPinchPointRef.current = undefined;
      setFeedback("Pinch released: orbit stopped. Index movement is cursor-only again.");
    }

    if (modeRef.current === "orbit") {
      if (!transition.state.pinching) {
        previousPinchPointRef.current = undefined;
        return;
      }
      previousPinchPointRef.current = pointerSignal.nextPinchPoint;
      if (pointerSignal.orbit !== undefined) propsRef.current.onOrbit(pointerSignal.orbit.deltaX, pointerSignal.orbit.deltaY);
      return;
    }

    if (propsRef.current.workspace !== "assembly" || depthCalibration === undefined) return;
    const openRightPalm = hand.handedness === "right" && hand.extendedFingerCount >= 4 && hand.openPalmConfidence >= 0.48;
    if (!openRightPalm || transition.state.pinching) return;
    const maximumMm = Math.max(1, propsRef.current.maxExplodeMm);
    const targetMm = cameraExplodeDistanceFromPalmDepth(hand.palm.scale, depthCalibration, maximumMm);
    const previousMm = explodeActiveRef.current ? latestExplodeRef.current : targetMm;
    let valueMm = explodeActiveRef.current ? previousMm + (targetMm - previousMm) * 0.24 : targetMm;
    if (depthFraction <= 0.025) valueMm = 0;
    if (depthFraction >= 0.975) valueMm = maximumMm;
    valueMm = Math.round(valueMm * 10) / 10;
    explodeActiveRef.current = true;
    const updateThreshold = Math.max(0.2, maximumMm * 0.0025);
    if (Math.abs(valueMm - latestExplodeRef.current) < updateThreshold) return;
    latestExplodeRef.current = valueMm;
    explodeDirtyRef.current = true;
    propsRef.current.onExplodePreview(valueMm);
  }, [commitExplodeIfNeeded, hideCursor, resetPalmLock, setPhase]);

  workerMessageRef.current = (response): void => {
    if (response.type === "ready") {
      if (response.workerId !== PS3D_HAND_LANDMARKER_WORKER_ID) {
        setPhase("error");
        setFeedback("The hand worker identity did not match the reviewed PS3D runtime.");
        return;
      }
      if (modelTimeoutRef.current !== undefined) clearTimeout(modelTimeoutRef.current);
      modelTimeoutRef.current = undefined;
      workerReadyRef.current = true;
      setRuntimeReady(true);
      if (cameraReadyRef.current) {
        resetPalmLock();
        setPhase("calibrating");
        setFeedback("Landmark model ready. Show your open RIGHT palm and hold it steady to lock.");
      }
      return;
    }
    if (response.type === "result") {
      processTrackedFrame(response.frame);
      return;
    }
    frameInFlightRef.current = false;
    if (response.stage === "initialization") {
      stopCamera(false);
      setPhase("error");
      setFeedback(`Local hand model could not start: ${response.message}`);
      propsRef.current.onMessage("Camera control stopped because the hash-pinned landmark runtime failed to initialize.");
      return;
    }
    skippedFrameCountRef.current += 1;
    setDroppedFrames(skippedFrameCountRef.current);
    setFeedback(`One landmark frame was rejected safely: ${response.message}`);
  };

  const submitFrame = useCallback((timestampMs: number): void => {
    const phaseNow = phaseRef.current;
    if (phaseNow !== "calibrating" && phaseNow !== "tracking") return;
    const worker = workerRef.current;
    const video = videoRef.current;
    if (!workerReadyRef.current || worker === undefined || video === null || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (frameInFlightRef.current) {
      skippedFrameCountRef.current += 1;
      return;
    }
    frameInFlightRef.current = true;
    const frameId = frameSequenceRef.current + 1;
    frameSequenceRef.current = frameId;
    void createImageBitmap(video).then((bitmap) => {
      if (workerRef.current !== worker || !workerReadyRef.current) {
        bitmap.close();
        frameInFlightRef.current = false;
        return;
      }
      const request: HandLandmarkerWorkerRequest = { type: "frame", frameId, timestampMs, bitmap };
      worker.postMessage(request, [bitmap]);
    }).catch((error: unknown) => {
      frameInFlightRef.current = false;
      stopCamera(false);
      setPhase("error");
      setFeedback(`Camera frame transfer failed: ${errorMessage(error)}`);
    });
  }, [setPhase, stopCamera]);
  submitFrameRef.current = submitFrame;

  const startCaptureLoop = useCallback((): void => {
    cancelCaptureLoop();
    const generation = captureGenerationRef.current;
    const schedule = (): void => {
      if (captureGenerationRef.current !== generation) return;
      const video = videoRef.current;
      if (video !== null) {
        scheduledFrameKindRef.current = "video";
        scheduledFrameRef.current = video.requestVideoFrameCallback((now, metadata) => {
          schedule();
          submitFrameRef.current(metadata.mediaTime > 0 ? metadata.mediaTime * 1000 : now);
        });
      } else {
        scheduledFrameKindRef.current = "animation";
        scheduledFrameRef.current = requestAnimationFrame((now) => {
          schedule();
          submitFrameRef.current(now);
        });
      }
    };
    schedule();
  }, [cancelCaptureLoop]);

  const startWorker = useCallback((): void => {
    disposeWorker();
    const worker = new Worker(new URL("./hand-landmarker-worker.ts", import.meta.url), {
      type: "module",
      name: PS3D_HAND_LANDMARKER_WORKER_ID
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<HandLandmarkerWorkerResponse>): void => workerMessageRef.current(event.data);
    worker.onerror = (event): void => {
      frameInFlightRef.current = false;
      stopCamera(false);
      setPhase("error");
      setFeedback(`Hand worker failed safely: ${event.message || "unknown worker error"}`);
    };
    const init: HandLandmarkerWorkerRequest = {
      type: "init",
      wasmBaseUrl: "/mediapipe/wasm",
      modelUrl: "/mediapipe/models/hand_landmarker-float16-v1.task",
      minimumDetectionConfidence: 0.58,
      minimumPresenceConfidence: 0.58,
      minimumTrackingConfidence: 0.62
    };
    worker.postMessage(init);
    modelTimeoutRef.current = setTimeout(() => {
      if (workerReadyRef.current) return;
      stopCamera(false);
      setPhase("error");
      setFeedback("The local hand model did not become ready within 30 seconds. Check browser WASM support and reload.");
    }, MODEL_LOAD_TIMEOUT_MS);
  }, [disposeWorker, setPhase, stopCamera]);

  const startCamera = useCallback(async (): Promise<void> => {
    if (!globalThis.isSecureContext || navigator.mediaDevices?.getUserMedia === undefined || globalThis.createImageBitmap === undefined) {
      setPhase("error");
      setFeedback("Camera landmark control needs HTTPS or localhost, MediaDevices, ImageBitmap, workers, and WebAssembly support.");
      return;
    }
    setPhase("requesting");
    setFeedback("Waiting for camera permission...");
    skippedFrameCountRef.current = 0;
    setDroppedFrames(0);
    startWorker();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video === null) throw new Error("The camera preview is not mounted.");
      video.srcObject = stream;
      await video.play();
      cameraReadyRef.current = true;
      const settings = stream.getVideoTracks()[0]?.getSettings();
      setCameraProfile(`${settings?.width ?? video.videoWidth} x ${settings?.height ?? video.videoHeight} at ${Math.round(settings?.frameRate ?? 0) || "auto"} fps`);
      startCaptureLoop();
      if (workerReadyRef.current) {
        resetPalmLock();
        setPhase("calibrating");
        setFeedback("Landmark model ready. Show your open RIGHT palm and hold it steady to lock.");
      } else {
        setPhase("loading");
        setFeedback("Camera is live. Loading the hash-pinned on-device hand landmark model...");
      }
      propsRef.current.onMessage("Camera is live locally; raw frames stay on-device and are processed in an isolated landmark worker.");
    } catch (error) {
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = undefined;
      cameraReadyRef.current = false;
      disposeWorker();
      setPhase("error");
      setFeedback(cameraErrorMessage(error));
    }
  }, [disposeWorker, resetPalmLock, setPhase, startCaptureLoop, startWorker]);

  const tuneNearDepth = useCallback((): void => {
    const hand = currentHandRef.current;
    const farScale = farPalmScaleRef.current;
    if (hand === undefined || farScale === undefined) return;
    if (hand.handedness !== "right" || hand.extendedFingerCount < 4 || hand.openPalmConfidence < 0.48) {
      setFeedback("Show the same open RIGHT palm before saving the near/full-explode distance.");
      return;
    }
    const calibration = createCameraPalmDepthCalibration(farScale, hand.palm.scale);
    if (calibration === null) {
      setFeedback("Move the open palm nearer until its landmark palm width is at least 15% larger, then try again.");
      return;
    }
    depthCalibrationRef.current = calibration;
    setNearTuned(true);
    setDepthPercent(100);
    setFeedback("Near/full-explode palm distance saved. Move back to the lock distance to assemble.");
  }, []);

  const reacquirePalm = useCallback((): void => {
    commitExplodeIfNeeded();
    resetPalmLock();
    setPhase("calibrating");
    setFeedback("Lock reset. Show the open right palm again at the far/assembled distance.");
  }, [commitExplodeIfNeeded, resetPalmLock, setPhase]);

  const togglePause = useCallback((): void => {
    if (phaseRef.current === "paused") {
      previousPinchPointRef.current = undefined;
      setPhase(gestureStateRef.current.locked ? "tracking" : "calibrating");
      setFeedback(gestureStateRef.current.locked ? "Landmark tracking resumed; pinch is released." : "Show the open right palm to acquire control.");
      return;
    }
    if (phaseRef.current !== "tracking" && phaseRef.current !== "calibrating") return;
    commitExplodeIfNeeded();
    hideCursor();
    setPhase("paused");
    setFeedback("Camera preview remains local and live; landmark inference and all CAD motion are paused.");
  }, [commitExplodeIfNeeded, hideCursor, setPhase]);

  const changeMode = useCallback((next: CameraControlMode): void => {
    if (next === "explode" && propsRef.current.workspace !== "assembly") return;
    if (modeRef.current === "explode" && next !== "explode") commitExplodeIfNeeded();
    modeRef.current = next;
    setModeState(next);
    previousPinchPointRef.current = undefined;
    explodeActiveRef.current = false;
    latestExplodeRef.current = clamp(propsRef.current.currentExplodeMm, 0, propsRef.current.maxExplodeMm);
    setFeedback(next === "orbit"
      ? "Orbit: index moves the cursor; thumb-index pinch and hold activates relative rotation."
      : "Explode: keep the right palm open; move nearer to explode and farther to assemble.");
  }, [commitExplodeIfNeeded]);

  const closePanel = useCallback((): void => {
    stopCamera(false);
    setOpen(false);
  }, [stopCamera]);

  useEffect(() => {
    if (props.workspace === "assembly" || modeRef.current !== "explode") return;
    commitExplodeIfNeeded();
    modeRef.current = "orbit";
    setModeState("orbit");
    previousPinchPointRef.current = undefined;
  }, [commitExplodeIfNeeded, props.workspace]);

  useEffect(() => {
    latestExplodeRef.current = clamp(latestExplodeRef.current, 0, props.maxExplodeMm);
  }, [props.maxExplodeMm]);

  useEffect(() => () => {
    cancelCaptureLoop();
    disposeWorker();
    commitExplodeIfNeeded();
    hideCursor();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = undefined;
  }, [cancelCaptureLoop, commitExplodeIfNeeded, disposeWorker, hideCursor]);

  if (!open) return <button type="button" className="camera-gesture-launcher" onClick={() => setOpen(true)} aria-label="Open right-hand camera control"><span aria-hidden="true">◎</span> Camera control</button>;

  const cameraLive = streamRef.current !== undefined;
  return <section className={`camera-gesture-panel ${phase} ${pinching ? "pinching" : ""} ${backgroundBlur ? "background-blur" : ""}`} aria-label="Right-hand landmark camera control">
    <header><div><span>ON-DEVICE LANDMARKS</span><strong>Right-hand gesture control</strong></div><span className="camera-privacy-state"><i />{cameraLive ? "camera live" : "camera off"}</span><button type="button" onClick={closePanel} aria-label="Close right-hand camera control">×</button></header>
    <div className="camera-preview">
      <video ref={videoRef} muted playsInline aria-label="Mirrored local camera preview" />
      <canvas ref={overlayRef} width={640} height={480} aria-hidden="true" />
      {phase === "loading" && cameraLive && <span className="camera-calibration-target">LOADING LOCAL MODEL</span>}
      {phase === "calibrating" && cameraLive && <span className="camera-calibration-target">OPEN RIGHT PALM</span>}
      {!cameraLive && <div className="camera-off-slate"><span>◎</span><strong>Camera is off</strong><small>Starts only after your click</small></div>}
    </div>
    <div className="camera-mode-tabs" role="group" aria-label="Camera control mode">
      <button type="button" aria-pressed={mode === "orbit"} className={mode === "orbit" ? "active" : ""} onClick={() => changeMode("orbit")}>Orbit · mirrored 4x pinch</button>
      <button type="button" aria-pressed={mode === "explode"} className={mode === "explode" ? "active" : ""} disabled={props.workspace !== "assembly"} onClick={() => changeMode("explode")}>Explode · open-palm depth</button>
    </div>
    <div className="camera-gesture-steps" aria-label="Right-hand gesture sequence">
      <span className={locked ? "complete" : "active"}><b>1</b> Open right palm</span>
      <span className={locked && !pinching ? "active" : locked ? "complete" : ""}><b>2</b> Index cursor</span>
      <span className={pinching ? "active" : ""}><b>3</b> Pinch orbit</span>
    </div>
    <div className="camera-finger-signal" aria-label="Right hand landmark signal">
      <span><i className={locked ? "locked" : ""} />{locked ? "RIGHT LOCK" : detectedHandedness === "left" ? "LEFT REJECTED" : "SEARCHING"} <b>{trackingConfidence}%</b></span>
      <meter min="0" max="100" value={mode === "orbit" ? pinchPercent : depthPercent}>{mode === "orbit" ? pinchPercent : depthPercent}%</meter>
      <output>{mode === "orbit" ? pinching ? "PINCH HELD" : `${fingerCount} fingers` : `${depthPercent}% near`}</output>
    </div>
    <div className="camera-runtime-diagnostics" aria-label="Landmark runtime diagnostics">
      <span><b>{runtimeReady ? "ML ready" : "ML idle"}</b> 21 points</span>
      <span>{cameraProfile}</span>
      <span>ID model {handednessCode(modelHandedness)} · palm {handednessCode(anatomicalHandedness)} · control {handednessCode(detectedHandedness)}</span>
      <span>{inferenceMs > 0 ? `${inferenceMs} ms inference` : "waiting for frame"}</span>
      <span>{droppedFrames} frames skipped</span>
    </div>
    <p className="camera-feedback" aria-live="polite"><strong>{phaseLabel(phase, locked, pinching)}</strong>{feedback}</p>
    <div className="camera-actions">
      {!cameraLive && <button type="button" className="primary" disabled={phase === "requesting" || phase === "loading"} onClick={() => void startCamera()}>{phase === "requesting" ? "Requesting..." : "Start camera"}</button>}
      {cameraLive && <>
        {locked && <button type="button" className="primary" onClick={tuneNearDepth}>{nearTuned ? "Update near/full" : "Set current near"}</button>}
        {(phase === "tracking" || phase === "calibrating") && <button type="button" onClick={reacquirePalm}>{locked ? "Re-lock palm" : "Reset search"}</button>}
        <button type="button" aria-pressed={backgroundBlur} onClick={() => setBackgroundBlur((value) => !value)}>{backgroundBlur ? "Preview blur on" : "Preview blur off"}</button>
        <button type="button" disabled={phase === "loading"} onClick={togglePause}>{phase === "paused" ? "Resume" : "Pause"}</button>
        <button type="button" onClick={() => stopCamera()}>Stop</button>
      </>}
    </div>
    <small className="camera-privacy-note">The raw camera frame is transferred to a same-origin worker, mirrored there, converted into 21 hand landmarks, and immediately closed. No frame is saved or uploaded. A high-confidence RIGHT model identity may lock unless palm chirality gives clear opposite-hand evidence; an edge-on ambiguous chirality frame no longer suppresses a valid cursor. Pinch-hold uses mirrored 4x direct orbit; open-palm near/far controls explosion up to 50% of model scale. Left-hand, conflicting, missing, or low-confidence frames produce no CAD motion.</small>
  </section>;
}

function drawLandmarkOverlay(
  canvas: HTMLCanvasElement | null,
  frame: HandLandmarkFrame | undefined,
  state: CameraGestureState,
  calibrating: boolean
): void {
  if (canvas === null) return;
  const context = canvas.getContext("2d");
  if (context === null) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (calibrating) {
    context.strokeStyle = "rgba(79, 211, 203, 0.72)";
    context.lineWidth = 2;
    context.setLineDash([8, 6]);
    context.strokeRect(width * 0.14, height * 0.1, width * 0.72, height * 0.8);
    context.setLineDash([]);
  }
  if (frame === undefined || frame.landmarks.length !== 21) return;
  const point = (index: number): { x: number; y: number } => ({
    x: frame.landmarks[index]!.x * width,
    y: frame.landmarks[index]!.y * height
  });
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = state.pinching ? "rgba(245, 182, 65, 0.95)" : state.locked ? "rgba(72, 224, 177, 0.92)" : "rgba(78, 205, 222, 0.86)";
  context.lineWidth = 3;
  for (const [from, to] of HAND_CONNECTIONS) {
    const a = point(from);
    const b = point(to);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  for (let index = 0; index < 21; index += 1) {
    const landmark = point(index);
    context.beginPath();
    context.fillStyle = index === 8 ? "#f8d14a" : index === 4 ? "#ff7e67" : "#dffcff";
    context.arc(landmark.x, landmark.y, index === 8 || index === 4 ? 5 : 3, 0, Math.PI * 2);
    context.fill();
  }
}

function clearOverlay(canvas: HTMLCanvasElement | null): void {
  const context = canvas?.getContext("2d");
  if (canvas !== null && context !== null && context !== undefined) context.clearRect(0, 0, canvas.width, canvas.height);
}

function phaseLabel(phase: CameraPhase, locked: boolean, pinching: boolean): string {
  if (phase === "idle") return "READY";
  if (phase === "requesting") return "PERMISSION";
  if (phase === "loading") return "MODEL";
  if (phase === "calibrating") return "ACQUIRE";
  if (phase === "paused") return "PAUSED";
  if (phase === "error") return "STOPPED";
  if (pinching) return "ORBIT ACTIVE";
  return locked ? "LANDMARK LOCK" : "SEARCHING";
}

function handednessCode(handedness: CameraHandedness | undefined): "R" | "L" | "?" {
  if (handedness === "right") return "R";
  if (handedness === "left") return "L";
  return "?";
}

function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Camera permission was denied or blocked by browser policy.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "No compatible camera was found for this browser session.";
    if (error.name === "NotReadableError" || error.name === "AbortError") return "The camera is busy or could not be started. Close other camera apps and try again.";
  }
  return `Camera could not start: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
