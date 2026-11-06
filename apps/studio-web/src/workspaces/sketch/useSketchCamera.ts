import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Vec2 } from "../../../../../packages/workbench-core/src/index.js";
import {
  DEFAULT_CAMERA,
  cameraViewBox,
  fitCameraToViewport,
  mmPerPixel,
  panCamera,
  screenToSketch,
  zoomCamera,
  type ScreenInsets,
  type SketchCamera,
  type SketchExtents,
  type SketchViewBox
} from "../../../../../packages/workbench-sketch/src/camera.js";

export interface SketchCameraController {
  /** Attach to the sketch `<svg>`: it measures the canvas and owns wheel zoom. */
  readonly svgRef: (node: SVGSVGElement | null) => void;
  readonly camera: SketchCamera;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewBox: SketchViewBox;
  /** Millimetres covered by one screen pixel. Glyphs, handles and hit areas are sized with this. */
  readonly mmPerPx: number;
  readonly panning: boolean;
  readonly spaceHeld: boolean;
  readonly toSketch: (clientX: number, clientY: number) => Vec2;
  readonly fit: () => void;
  readonly zoomAtCenter: (factor: number) => void;
  readonly beginPan: (event: React.PointerEvent<SVGSVGElement>) => void;
  /** True when the event belonged to an active pan and has been handled. */
  readonly movePan: (event: React.PointerEvent<SVGSVGElement>) => boolean;
  readonly endPan: (event: React.PointerEvent<SVGSVGElement>) => boolean;
}

/** Pixels at each side of the canvas that floating panels (palette, navigation bars, status strip) currently cover. */
function measureInsets(node: SVGSVGElement): ScreenInsets {
  const rect = node.getBoundingClientRect();
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  const overlays = node.parentElement?.querySelectorAll<HTMLElement>(".sketch-palette, .viewport-controller, .navigation-bar, .canvas-hud") ?? [];
  for (const element of overlays) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const boxLeft = box.left - rect.left;
    const boxRight = box.right - rect.left;
    const boxTop = box.top - rect.top;
    const boxBottom = box.bottom - rect.top;
    if (box.width > rect.width * 0.5) {
      // A wide bar belongs to the top or bottom edge, whichever half it sits in.
      if ((boxTop + boxBottom) / 2 < rect.height / 2) top = Math.max(top, boxBottom);
      else bottom = Math.max(bottom, rect.height - boxTop);
    } else if ((boxLeft + boxRight) / 2 > rect.width / 2) right = Math.max(right, rect.width - boxLeft);
    else left = Math.max(left, boxRight);
  }
  return { left, top, right, bottom };
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='dialog'], [role='menu']") !== null;
}

/**
 * The sketch canvas camera: wheel zoom about the cursor, middle-button / Space / Pan-mode drag to pan, and Fit.
 * The camera is a centre point and a visible width in millimetres, so it never depends on the geometry that is drawn:
 * adding a curve does not move the view. It fits once when the canvas is first measured (and whenever `fitKey` changes)
 * and again whenever `fitSerial` increases.
 */
export function useSketchCamera(extents: SketchExtents | undefined, fitKey: string, fitSerial: number): SketchCameraController {
  const [node, setNode] = useState<SVGSVGElement | null>(null);
  const nodeRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCameraState] = useState<SketchCamera>(DEFAULT_CAMERA);
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const cameraRef = useRef(camera);
  const extentsRef = useRef(extents);
  const sizeRef = useRef(size);
  const panState = useRef<{ readonly pointerId: number; x: number; y: number } | undefined>(undefined);

  useLayoutEffect(() => {
    extentsRef.current = extents;
    sizeRef.current = size;
  });

  const setCamera = useCallback((next: SketchCamera): void => {
    cameraRef.current = next;
    setCameraState(next);
  }, []);

  const svgRef = useCallback((element: SVGSVGElement | null): void => {
    nodeRef.current = element;
    setNode(element);
  }, []);

  useEffect(() => {
    if (node === null) return undefined;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setSize((current) => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  const fit = useCallback((): void => {
    const current = sizeRef.current;
    const element = nodeRef.current;
    if (element === null || current.width < 8 || current.height < 8) return;
    setCamera(fitCameraToViewport(extentsRef.current, current, measureInsets(element)));
  }, [setCamera]);

  const fittedKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (size.width < 8 || size.height < 8 || fittedKey.current === fitKey) return;
    fittedKey.current = fitKey;
    fit();
  }, [fit, fitKey, size.width, size.height]);

  const handledFitSerial = useRef(fitSerial);
  useEffect(() => {
    if (fitSerial === handledFitSerial.current) return;
    handledFitSerial.current = fitSerial;
    fit();
  }, [fit, fitSerial]);

  // Wheel zoom must be a native non-passive listener: React attaches wheel passively, so preventDefault would be ignored and the page would scroll.
  useEffect(() => {
    if (node === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const factor = Math.min(2, Math.max(0.5, Math.exp(event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0015))));
      const anchor = screenToSketch(event.clientX, event.clientY, rect, cameraRef.current);
      setCamera(zoomCamera(cameraRef.current, anchor, factor));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [node, setCamera]);

  // Holding Space turns a left drag into a pan, like the middle button.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || isInteractive(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const up = (event: KeyboardEvent): void => { if (event.code === "Space") setSpaceHeld(false); };
    const blur = (): void => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const toSketch = useCallback((clientX: number, clientY: number): Vec2 => {
    const element = nodeRef.current;
    if (element === null) return [0, 0];
    return screenToSketch(clientX, clientY, element.getBoundingClientRect(), cameraRef.current);
  }, []);

  const zoomAtCenter = useCallback((factor: number): void => {
    setCamera(zoomCamera(cameraRef.current, cameraRef.current.centerMm, factor));
  }, [setCamera]);

  const beginPan = useCallback((event: React.PointerEvent<SVGSVGElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panState.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
  }, []);

  const movePan = useCallback((event: React.PointerEvent<SVGSVGElement>): boolean => {
    const state = panState.current;
    if (state === undefined || state.pointerId !== event.pointerId) return false;
    const width = event.currentTarget.getBoundingClientRect().width;
    setCamera(panCamera(cameraRef.current, event.clientX - state.x, event.clientY - state.y, width));
    state.x = event.clientX;
    state.y = event.clientY;
    return true;
  }, [setCamera]);

  const endPan = useCallback((event: React.PointerEvent<SVGSVGElement>): boolean => {
    const state = panState.current;
    if (state === undefined || state.pointerId !== event.pointerId) return false;
    panState.current = undefined;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    return true;
  }, []);

  const aspect = size.height > 0 ? size.width / size.height : 1.6;
  return {
    svgRef,
    camera,
    size,
    viewBox: cameraViewBox(camera, aspect),
    mmPerPx: mmPerPixel(camera, Math.max(size.width, 1)),
    panning,
    spaceHeld,
    toSketch,
    fit,
    zoomAtCenter,
    beginPan,
    movePan,
    endPan
  };
}
