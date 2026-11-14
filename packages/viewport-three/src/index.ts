import * as THREE from "three";
import { clampZebraFrequency, type ZebraOptions } from "./zebra.js";
import { applyZebraToObject, disposeZebraOriginals } from "./zebra-materials.js";
import { buildAnalysisGroup, disposeAnalysisGroup, type ViewportAnalysisOverlay } from "./analysis-overlay.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cloneExchangeObject, disposeExchangeObject, inspectExchangeObject, type ExchangeBounds, type ViewportJpeg } from "../../exchange-3d/src/index.js";
import type { ModelSuccessResponse } from "../../worker-protocol/src/index.js";
import type { PreviewBounds, PreviewPrimitive, PreviewScene } from "../../workbench-geometry/src/index.js";
import { buildGhostGroup, buildHandleGroup, disposePreviewGroup, layoutHandleGroup, type ViewportGhost, type ViewportHandle, type ViewportHandleDrag } from "./preview-layer.js";
import { deltaMmFromDrag, hitHandle, projectHandleAxis, type HandleScreenAxis } from "./handle-drag.js";
import { chainsInBox, classifyHover, edgePickToleranceMm, sameHoverTarget, type HoverCandidateBody, type HoverFilter, type HoverRayHit, type HoverTarget, type ProjectedSegment } from "./hover-pick.js";

export { buildAnalysisGroup, disposeAnalysisGroup, EMPTY_ANALYSIS_OVERLAY, type OverlayRgb, type ViewportAnalysisLines, type ViewportAnalysisMesh, type ViewportAnalysisOverlay } from "./analysis-overlay.js";
export { chainsInBox, classifyHover, edgePickToleranceMm, nearestChainWithin, sameHoverTarget, type HoverCandidateBody, type HoverFilter, type HoverRayHit, type HoverTarget, type PickSegmentMm, type ProjectedSegment, type SelectionBox } from "./hover-pick.js";
export { buildGhostGroup, buildHandleGroup, layoutHandleGroup, disposePreviewGroup, type ViewportGhost, type ViewportHandle, type ViewportHandleDrag } from "./preview-layer.js";
export { END_ON_RATIO, deltaMmFromDrag, hitHandle, pointToSegmentPx, projectHandleAxis, valueFromDrag, type HandleHitOptions, type HandleScreenAxis, type HandleValueRule, type Mm3, type Pixel } from "./handle-drag.js";
export { applyZebraToObject } from "./zebra-materials.js";
export { ZEBRA_AXES, ZEBRA_DEFAULT, ZEBRA_MAX_FREQUENCY, ZEBRA_MIN_FREQUENCY, clampZebraFrequency, zebraBandAt, zebraReflection, type ZebraAxis, type ZebraOptions } from "./zebra.js";

export interface ViewportOptions {
  readonly onSelectBody: (bodyId: string | null) => void;
  readonly onViewChange?: (state: ViewportViewState) => void;
  readonly onMeasurePoint?: (point: ViewportMeasurePoint) => void;
  readonly onContextMenu?: (request: ViewportContextMenuRequest) => void;
  /**
   * A click in select mode with the Face or Edge intent active: the picked face or edge chain (or null for empty space).
   * `modifiers` carries Ctrl / Shift so the host can add to a selection instead of replacing it.
   */
  readonly onPickEntity?: (target: HoverTarget | null, modifiers: { readonly ctrl: boolean; readonly shift: boolean }) => void;
  /**
   * A drag box in select mode with the Edge intent (PT-09): every edge chain the box takes. Dragged left-to-right the box
   * is a window (chains fully inside); right-to-left it is a crossing box (chains it touches).
   */
  readonly onPickEntities?: (targets: readonly HoverTarget[], modifiers: { readonly ctrl: boolean; readonly shift: boolean }) => void;
  readonly assemblyTouchGestures?: ViewportAssemblyTouchGestures;
}

export interface ViewportAssemblyTouchGestures {
  readonly getExplodeMm: () => number;
  readonly onExplodePreview: (valueMm: number) => void;
  readonly onExplodeCommit: (valueMm: number) => void;
  readonly maxExplodeMm?: number;
}

export interface ViewportTouchPoint {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

export type ViewOrientation = "custom" | "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric";
export type ViewProjection = "perspective" | "orthographic";
export type NavigationMode = "select" | "orbit" | "pan" | "measure";
export type SelectionFilter = "auto" | "body" | "component" | "face" | "edge" | "sketch-curve" | "profile" | "connected" | "tangent";
export type ViewportShadingMode = "shaded" | "shaded-edges" | "wireframe";
export type ViewportBackgroundTone = "charcoal" | "dark-gray" | "light-gray" | "white";
export type ViewportStudioEnvironment = "softbox" | "daylight" | "graphite" | "white-cyclorama" | "warm-studio";

export interface ViewportStudioMaterial {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly useSourceColors: boolean;
}

export interface ViewportStudioLighting {
  readonly exposure: number;
  readonly keyIntensity: number;
  readonly fillIntensity: number;
  readonly rimIntensity: number;
}

export interface ViewportRenderImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/jpeg" | "image/png";
}

export interface ViewportViewState {
  readonly orientation: ViewOrientation;
  readonly projection: ViewProjection;
  readonly navigationMode: NavigationMode;
  readonly selectionFilter: SelectionFilter;
  readonly shadingMode: ViewportShadingMode;
  readonly bodyColor: string;
  readonly backgroundTone: ViewportBackgroundTone;
  readonly gridVisible: boolean;
  readonly axesVisible: boolean;
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
}

export interface ViewportMeasurePoint {
  readonly pointMm: readonly [number, number, number];
  readonly semanticId: string | null;
  /** The face of the clicked body (an index into its `brep.faces`) when the body has named faces, else null. */
  readonly faceIndex?: number | null;
  /** The clicked surface's outward normal in world space (unit length), when the renderer knows it. */
  readonly normalMm?: readonly [number, number, number];
}

/** A line to draw over the model while the user is picking an edge: its end points in millimetres. */
export type ViewportGuideSegment = readonly [readonly [number, number, number], readonly [number, number, number]];

export interface ViewportContextMenuRequest {
  readonly clientX: number;
  readonly clientY: number;
  readonly semanticId: string | null;
  readonly selectionKind: string | null;
}

export interface ProjectedAxis {
  /** Horizontal screen component, positive to the right. */
  readonly x: number;
  /** Vertical SVG component, positive down. */
  readonly y: number;
  /** Camera-facing depth. Positive means the world axis points toward the camera. */
  readonly depth: number;
}

export interface CameraBasisProjection {
  readonly x: ProjectedAxis;
  readonly y: ProjectedAxis;
  readonly z: ProjectedAxis;
}

const ORIENTATION_ANGLES: Readonly<Record<Exclude<ViewOrientation, "custom">, readonly [number, number]>> = {
  front: [-90, 0],
  back: [90, 0],
  left: [180, 0],
  right: [0, 0],
  top: [-90, 89.994],
  bottom: [-90, -89.994],
  isometric: [-45, Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI]
};

export function viewAnglesForOrientation(orientation: Exclude<ViewOrientation, "custom">): readonly [number, number] {
  return ORIENTATION_ANGLES[orientation];
}

/** Direct-manipulation drag convention: dragging right turns the model to follow the cursor (the grabbed surface tracks the pointer), and dragging up raises the view. */
export function orbitViewAngles(azimuthDeg: number, elevationDeg: number, deltaX: number, deltaY: number, degreesPerPixel = 0.46): readonly [number, number] {
  const azimuth = normalizeDegrees(azimuthDeg - deltaX * degreesPerPixel);
  const elevation = THREE.MathUtils.clamp(elevationDeg - deltaY * degreesPerPixel, -87.1, 87.1);
  return [azimuth, elevation];
}

export function touchCentroidY(points: readonly ViewportTouchPoint[]): number {
  if (points.length === 0) return 0;
  return points.reduce((total, point) => total + point.y, 0) / points.length;
}

export function assemblyExplodeFromVerticalGesture(
  startExplodeMm: number,
  startCentroidY: number,
  currentCentroidY: number,
  viewportHeightPx: number,
  maxExplodeMm = 120
): number {
  const boundedMaximum = Number.isFinite(maxExplodeMm) ? THREE.MathUtils.clamp(maxExplodeMm, 1, 10_000) : 120;
  const travelPx = Math.max(Number.isFinite(viewportHeightPx) ? viewportHeightPx * 0.62 : 0, 160);
  const deltaMm = (startCentroidY - currentCentroidY) * boundedMaximum / travelPx;
  return Math.round(THREE.MathUtils.clamp(startExplodeMm + deltaMm, 0, boundedMaximum) * 10) / 10;
}

/**
 * Projects the document WCS into screen space using the exact camera convention
 * used by ThreeViewportAdapter. ViewCube faces and the WCS triad both consume
 * this result, so they cannot drift into independent orientations.
 */
export function projectWorldAxes(azimuthDeg: number, elevationDeg: number): CameraBasisProjection {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const backward = normalize3([Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)]);
  const referenceUp: Vec3Tuple = Math.abs(Math.cos(elevation)) < 0.01 ? [0, 1, 0] : [0, 0, 1];
  const right = normalize3(cross3(referenceUp, backward));
  const up = normalize3(cross3(backward, right));
  return {
    x: projectAxis([1, 0, 0], right, up, backward),
    y: projectAxis([0, 1, 0], right, up, backward),
    z: projectAxis([0, 0, 1], right, up, backward)
  };
}

export class ThreeViewportAdapter {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(38, 1, 0.001, 100);
  readonly #orthographicCamera = new THREE.OrthographicCamera(-0.1, 0.1, 0.1, -0.1, 0.001, 100);
  readonly #bodyGroup = new THREE.Group();
  readonly #measurementGroup = new THREE.Group();
  readonly #guideGroup = new THREE.Group();
  /** Live feature preview: the translucent result ghost and the draggable arrow (see setPreviewGhost / setPreviewHandle). */
  readonly #ghostGroup = new THREE.Group();
  readonly #handleGroup = buildHandleGroup();
  #handle: ViewportHandle | undefined;
  #handleHot = false;
  #handleDrag: { readonly pointerId: number; readonly startX: number; readonly startY: number; readonly axis: HandleScreenAxis } | undefined;
  #ghostHiddenBodyId: string | undefined;
  readonly #ghostHidden = new Set<THREE.Object3D>();
  #analysisGroup: THREE.Group | undefined;
  readonly #grid = new THREE.GridHelper(0.24, 24, "#9aa3aa", "#545d64");
  readonly #axes = new THREE.AxesHelper(0.035);
  readonly #hemisphereLight = new THREE.HemisphereLight("#f5f7f8", "#1f2428", 1.35);
  readonly #keyLight = new THREE.DirectionalLight("#ffffff", 2.35);
  readonly #fillLight = new THREE.DirectionalLight("#bfd9ef", 0.55);
  readonly #rimLight = new THREE.DirectionalLight("#c7d1d8", 0.85);
  readonly #studioGround = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: "#6d747a", roughness: 0.88, metalness: 0, transparent: true, opacity: 0.4 })
  );
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #target = new THREE.Vector3();
  readonly #resizeObserver: ResizeObserver;
  readonly #options: ViewportOptions;
  readonly #objects: THREE.Object3D[] = [];
  #zebra: ZebraOptions | null = null;
  readonly #pickable: THREE.Object3D[] = [];
  #bodyId: string | undefined;
  #selectedId: string | undefined;
  #lastSceneId: string | undefined;
  #azimuth = -Math.PI / 4;
  #elevation = Math.PI / 5;
  #radius = 0.16;
  #orientation: ViewOrientation = "isometric";
  #projection: ViewProjection = "perspective";
  #navigationMode: NavigationMode = "select";
  #selectionFilter: SelectionFilter = "auto";
  #shadingMode: ViewportShadingMode = "shaded-edges";
  #bodyColor = "#aeb3b8";
  #backgroundTone: ViewportBackgroundTone = "dark-gray";
  #qualifiedBody: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
  #qualifiedEdges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial> | undefined;
  #faceHighlight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
  /** Hover pre-highlight (PT-08): what the cursor is over, its overlay meshes, and the per-body pick candidates. */
  #pickCandidates: ReadonlyMap<string, HoverCandidateBody> = new Map();
  #hover: HoverTarget | null = null;
  #hoverFace: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
  readonly #hoverGroup = new THREE.Group();
  #hoverBodyMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
  readonly #selectedEdgeGroup = new THREE.Group();
  /** Window / crossing box selection with the Edge intent (PT-09): the drag in client pixels and its rubber-band rectangle. */
  #boxSelect: { readonly startX: number; readonly startY: number; x: number; y: number } | undefined;
  #boxDiv: HTMLDivElement | undefined;
  #drag: { pointerId: number; x: number; y: number; startX: number; startY: number; moved: boolean; mode: NavigationMode } | undefined;
  readonly #touchPointers = new Map<number, ViewportTouchPoint>();
  #assemblyTouchGesture: { startCentroidY: number; startExplodeMm: number; latestExplodeMm: number } | undefined;
  #frame = 0;

  constructor(canvas: HTMLCanvasElement, options: ViewportOptions) {
    this.#canvas = canvas;
    this.#options = options;
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1;
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFShadowMap;
    this.#scene.background = new THREE.Color("#30363b");
    this.#scene.fog = new THREE.Fog("#30363b", 0.28, 0.75);

    this.#grid.rotation.x = Math.PI / 2;
    this.#grid.position.z = -0.0052;
    this.#scene.add(this.#grid);
    this.#scene.add(this.#axes);
    this.#scene.add(this.#bodyGroup);
    this.#scene.add(this.#measurementGroup);
    this.#scene.add(this.#guideGroup);
    this.#scene.add(this.#ghostGroup);
    this.#handleGroup.visible = false;
    this.#scene.add(this.#handleGroup);
    this.#scene.add(this.#hoverGroup);
    this.#scene.add(this.#selectedEdgeGroup);
    this.#scene.add(this.#hemisphereLight);
    this.#keyLight.position.set(0.12, -0.08, 0.2);
    this.#keyLight.castShadow = true;
    this.#keyLight.shadow.mapSize.set(2048, 2048);
    this.#keyLight.shadow.camera.near = 0.001;
    this.#keyLight.shadow.camera.far = 20;
    this.#scene.add(this.#keyLight);
    this.#fillLight.position.set(-0.16, -0.04, 0.09);
    this.#scene.add(this.#fillLight);
    this.#rimLight.position.set(-0.1, 0.12, 0.08);
    this.#scene.add(this.#rimLight);
    this.#studioGround.position.z = -0.006;
    this.#studioGround.receiveShadow = true;
    this.#studioGround.visible = false;
    this.#scene.add(this.#studioGround);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    canvas.addEventListener("pointerdown", this.#onPointerDown);
    canvas.addEventListener("pointermove", this.#onPointerMove);
    canvas.addEventListener("pointerup", this.#onPointerUp);
    canvas.addEventListener("pointercancel", this.#onPointerUp);
    canvas.addEventListener("pointerleave", this.#onPointerLeave);
    canvas.addEventListener("wheel", this.#onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.#onContextMenu);
    this.fit();
    this.#animate();
  }

  getViewState(): ViewportViewState {
    return {
      orientation: this.#orientation,
      projection: this.#projection,
      navigationMode: this.#navigationMode,
      selectionFilter: this.#selectionFilter,
      shadingMode: this.#shadingMode,
      bodyColor: this.#bodyColor,
      backgroundTone: this.#backgroundTone,
      gridVisible: this.#grid.visible,
      axesVisible: this.#axes.visible,
      azimuthDeg: Math.round(THREE.MathUtils.radToDeg(this.#azimuth) * 10) / 10,
      elevationDeg: Math.round(THREE.MathUtils.radToDeg(this.#elevation) * 10) / 10
    };
  }

  setOrientation(orientation: Exclude<ViewOrientation, "custom">): void {
    const [azimuthDeg, elevationDeg] = viewAnglesForOrientation(orientation);
    this.#azimuth = THREE.MathUtils.degToRad(azimuthDeg);
    this.#elevation = THREE.MathUtils.degToRad(elevationDeg);
    this.#orientation = orientation;
    this.#updateCamera();
  }

  setViewAngles(azimuthDeg: number, elevationDeg: number): void {
    if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) return;
    this.#azimuth = THREE.MathUtils.degToRad(normalizeDegrees(azimuthDeg));
    this.#elevation = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elevationDeg, -87.1, 87.1));
    this.#orientation = "custom";
    this.#updateCamera();
  }

  orbitByPixels(deltaX: number, deltaY: number): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const [azimuthDeg, elevationDeg] = orbitViewAngles(
      THREE.MathUtils.radToDeg(this.#azimuth),
      THREE.MathUtils.radToDeg(this.#elevation),
      THREE.MathUtils.clamp(deltaX, -80, 80),
      THREE.MathUtils.clamp(deltaY, -80, 80)
    );
    this.#azimuth = THREE.MathUtils.degToRad(azimuthDeg);
    this.#elevation = THREE.MathUtils.degToRad(elevationDeg);
    this.#orientation = "custom";
    this.#updateCamera();
  }

  restoreViewState(state: ViewportViewState): void {
    this.#azimuth = THREE.MathUtils.degToRad(normalizeDegrees(state.azimuthDeg));
    this.#elevation = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(state.elevationDeg, -87.1, 87.1));
    this.#orientation = state.orientation;
    this.#projection = state.projection;
    this.#navigationMode = state.navigationMode;
    this.#selectionFilter = state.selectionFilter;
    this.#grid.visible = state.gridVisible;
    this.#axes.visible = state.axesVisible;
    this.setBackgroundTone(state.backgroundTone);
    this.setBodyColor(state.bodyColor);
    this.setShadingMode(state.shadingMode);
    this.#canvas.style.cursor = state.navigationMode === "orbit" ? "grab" : state.navigationMode === "pan" ? "move" : state.navigationMode === "measure" ? "crosshair" : "default";
    this.#updateCamera();
  }

  setProjection(projection: ViewProjection): void {
    this.#projection = projection;
    this.#updateCamera();
  }

  setNavigationMode(mode: NavigationMode): void {
    this.#navigationMode = mode;
    if (mode !== "select") this.#setHover(null);
    this.#canvas.style.cursor = mode === "orbit" ? "grab" : mode === "pan" ? "move" : mode === "measure" ? "crosshair" : "default";
    this.#emitViewState();
  }

  setSelectionFilter(filter: SelectionFilter): void {
    this.#selectionFilter = filter;
    this.#setHover(null);
    this.#emitViewState();
  }

  /** The faces and sharp edges each body offers to the hover picker (PT-08), keyed by body id. */
  setPickCandidates(candidates: ReadonlyMap<string, HoverCandidateBody>): void {
    this.#pickCandidates = candidates;
    this.#setHover(null);
  }

  /** Draws the selected edge chains over the model (amber, persistent until replaced); an empty list clears them. */
  setSelectedEdges(segmentsMm: readonly ViewportGuideSegment[]): void {
    this.#clearRodGroup(this.#selectedEdgeGroup);
    this.#addRods(this.#selectedEdgeGroup, segmentsMm, "#ffb347", 1.4, 17);
  }

  /** Draws colour-mapped analysis meshes and highlight lines over the model (or clears them with null). */
  setAnalysisOverlay(overlay: ViewportAnalysisOverlay | null): void {
    if (this.#analysisGroup !== undefined) {
      this.#scene.remove(this.#analysisGroup);
      disposeAnalysisGroup(this.#analysisGroup);
      this.#analysisGroup = undefined;
    }
    if (overlay === null || (overlay.meshes.length === 0 && overlay.lines.length === 0)) return;
    this.#analysisGroup = buildAnalysisGroup(overlay);
    this.#scene.add(this.#analysisGroup);
  }

  /** Shades every mesh, whatever its material, with zebra stripes (or restores normal shading with null). New geometry and imports pick it up too. */
  setZebra(options: ZebraOptions | null): void {
    this.#zebra = options === null ? null : { axis: options.axis, frequency: clampZebraFrequency(options.frequency) };
    for (const object of this.#objects) this.#applyZebra(object);
    this.#emitViewState();
  }

  getZebra(): ZebraOptions | null {
    return this.#zebra;
  }

  #applyZebra(entry: THREE.Object3D): void {
    applyZebraToObject(entry, this.#zebra);
  }

  setShadingMode(mode: ViewportShadingMode): void {
    this.#shadingMode = mode;
    if (this.#qualifiedBody !== undefined) {
      this.#qualifiedBody.material.wireframe = false;
      this.#qualifiedBody.material.transparent = mode === "wireframe";
      this.#qualifiedBody.material.opacity = mode === "wireframe" ? 0 : 1;
      this.#qualifiedBody.material.depthWrite = mode !== "wireframe";
      this.#qualifiedBody.material.needsUpdate = true;
    }
    if (this.#qualifiedEdges !== undefined) {
      this.#qualifiedEdges.visible = mode !== "shaded";
      this.#qualifiedEdges.material.opacity = mode === "wireframe" ? 1 : 0.82;
      this.#qualifiedEdges.material.depthTest = mode !== "wireframe";
      this.#qualifiedEdges.material.color.set(mode === "wireframe" ? "#e1e5e8" : "#3f454a");
      this.#qualifiedEdges.material.needsUpdate = true;
      this.#qualifiedEdges.renderOrder = mode === "wireframe" ? 5 : 0;
    }
    this.#emitViewState();
  }

  setBodyColor(color: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    this.#bodyColor = color.toLowerCase();
    if (this.#qualifiedBody !== undefined) {
      this.#qualifiedBody.userData["baseColor"] = this.#bodyColor;
      if (this.#qualifiedBody.userData["semanticId"] !== this.#selectedId) this.#qualifiedBody.material.color.set(this.#bodyColor);
    }
    this.#emitViewState();
  }

  setBackgroundTone(tone: ViewportBackgroundTone): void {
    const colors: Readonly<Record<ViewportBackgroundTone, string>> = {
      charcoal: "#171a1d",
      "dark-gray": "#30363b",
      "light-gray": "#c7ccd1",
      white: "#f3f4f5"
    };
    this.#backgroundTone = tone;
    this.#scene.background = new THREE.Color(colors[tone]);
    if (this.#scene.fog instanceof THREE.Fog) this.#scene.fog.color.set(colors[tone]);
    this.#emitViewState();
  }

  setStudioEnvironment(environment: ViewportStudioEnvironment): void {
    const presets: Readonly<Record<ViewportStudioEnvironment, {
      readonly background: string;
      readonly fog: string;
      readonly sky: string;
      readonly ground: string;
      readonly key: string;
      readonly fill: string;
      readonly rim: string;
    }>> = {
      softbox: { background: "#68747d", fog: "#68747d", sky: "#f7fafc", ground: "#2d3439", key: "#ffffff", fill: "#c7e6ff", rim: "#edf7ff" },
      daylight: { background: "#8eafc4", fog: "#8eafc4", sky: "#e7f6ff", ground: "#45584a", key: "#fff6dc", fill: "#b9dcff", rim: "#ffffff" },
      graphite: { background: "#151a1f", fog: "#151a1f", sky: "#c8d0d6", ground: "#080a0c", key: "#f4f7fa", fill: "#6685a0", rim: "#d8efff" },
      "white-cyclorama": { background: "#e9edef", fog: "#e9edef", sky: "#ffffff", ground: "#a8afb4", key: "#ffffff", fill: "#e8f4ff", rim: "#ffffff" },
      "warm-studio": { background: "#5d4b40", fog: "#5d4b40", sky: "#ffe5c5", ground: "#2c211c", key: "#ffd6a6", fill: "#8ea9c3", rim: "#fff1d7" }
    };
    const preset = presets[environment];
    this.#scene.background = new THREE.Color(preset.background);
    if (this.#scene.fog instanceof THREE.Fog) this.#scene.fog.color.set(preset.fog);
    this.#hemisphereLight.color.set(preset.sky);
    this.#hemisphereLight.groundColor.set(preset.ground);
    this.#keyLight.color.set(preset.key);
    this.#fillLight.color.set(preset.fill);
    this.#rimLight.color.set(preset.rim);
    const groundMaterial = this.#studioGround.material;
    if (groundMaterial instanceof THREE.MeshStandardMaterial) groundMaterial.color.set(preset.ground);
  }

  setStudioMaterial(material: ViewportStudioMaterial): void {
    if (!/^#[0-9a-f]{6}$/iu.test(material.color) || !Number.isFinite(material.roughness) || !Number.isFinite(material.metalness)) return;
    this.#bodyGroup.traverse((entry) => {
      if (!(entry instanceof THREE.Mesh)) return;
      const materials = Array.isArray(entry.material) ? entry.material : [entry.material];
      for (const candidate of materials) {
        if (!(candidate instanceof THREE.MeshStandardMaterial)) continue;
        const sourceColor = typeof entry.userData["baseColor"] === "string" ? entry.userData["baseColor"] as string : this.#bodyColor;
        candidate.color.set(material.useSourceColors ? sourceColor : material.color);
        candidate.roughness = THREE.MathUtils.clamp(material.roughness, 0.04, 1);
        candidate.metalness = THREE.MathUtils.clamp(material.metalness, 0, 1);
        candidate.needsUpdate = true;
      }
    });
  }

  setStudioLighting(lighting: ViewportStudioLighting): void {
    if (![lighting.exposure, lighting.keyIntensity, lighting.fillIntensity, lighting.rimIntensity].every(Number.isFinite)) return;
    this.#renderer.toneMappingExposure = THREE.MathUtils.clamp(lighting.exposure, 0.25, 3);
    this.#keyLight.intensity = THREE.MathUtils.clamp(lighting.keyIntensity, 0, 8);
    this.#fillLight.intensity = THREE.MathUtils.clamp(lighting.fillIntensity, 0, 5);
    this.#rimLight.intensity = THREE.MathUtils.clamp(lighting.rimIntensity, 0, 5);
  }

  setStudioGroundVisible(visible: boolean): void {
    this.#studioGround.visible = visible;
  }

  setGridVisible(visible: boolean): void {
    this.#grid.visible = visible;
    this.#emitViewState();
  }

  setAxesVisible(visible: boolean): void {
    this.#axes.visible = visible;
    this.#emitViewState();
  }

  setMeasurePoints(pointsMm: readonly (readonly [number, number, number])[]): void {
    this.#clearMeasurements();
    const markerRadius = THREE.MathUtils.clamp(this.#radius * 0.018, 0.001, 0.004);
    for (const point of pointsMm) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 18, 12),
        new THREE.MeshBasicMaterial({ color: "#ffd166", depthTest: false })
      );
      marker.position.set(point[0] / 1000, point[1] / 1000, point[2] / 1000);
      marker.renderOrder = 20;
      this.#measurementGroup.add(marker);
    }
    if (pointsMm.length === 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(pointsMm.map((point) => new THREE.Vector3(point[0] / 1000, point[1] / 1000, point[2] / 1000)));
      const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: "#ffd166", dashSize: 0.004, gapSize: 0.002, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 19;
      this.#measurementGroup.add(line);
    }
  }

  setArtifact(render: ModelSuccessResponse["render"]): void {
    this.#clearBody();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(render.positions), 3));
    geometry.setIndex(new THREE.BufferAttribute(render.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: this.#bodyColor,
      roughness: 0.64,
      metalness: 0.04,
      emissive: "#08090a",
      side: THREE.FrontSide
    });
    const body = new THREE.Mesh(geometry, material);
    body.userData["semanticId"] = render.bodyId;
    body.userData["selectionKind"] = "body";
    body.userData["baseColor"] = this.#bodyColor;
    this.#addObject(body, true);
    const edgeGeometry = new THREE.EdgesGeometry(geometry, 28);
    const edgeDisplay = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: "#3f454a", transparent: true, opacity: 0.82 }));
    edgeDisplay.userData["ps3dExchangeHelper"] = true;
    this.#addObject(edgeDisplay, false);
    this.#qualifiedBody = body;
    this.#qualifiedEdges = edgeDisplay;
    this.setShadingMode(this.#shadingMode);
    this.#bodyId = render.bodyId;
  }

  setArtifactWithScene(render: ModelSuccessResponse["render"], scene: PreviewScene): void {
    this.setArtifact(render);
    for (const primitive of scene.primitives) this.#addPrimitive(primitive);
    this.setSelectedId(this.#selectedId ?? null);
  }

  /** Draws a preview scene. `autoFit` false leaves the camera alone even on a scene change (the caller fits when it decides to). */
  setScene(scene: PreviewScene, autoFit = true): void {
    const previousSelectedId = this.#selectedId;
    this.#clearBody();
    for (const primitive of scene.primitives) this.#addPrimitive(primitive);
    this.#bodyId = undefined;
    this.#applyGhostHide();
    this.setSelectedId(previousSelectedId ?? null);
    const changed = scene.id !== this.#lastSceneId;
    this.#lastSceneId = scene.id;
    if (autoFit && changed) this.fitPreview(scene.boundsMm);
  }

  setExternalObject(source: THREE.Object3D): void {
    this.#clearBody();
    const root = cloneExchangeObject(source);
    let ordinal = 0;
    root.traverse((entry) => {
      if (entry instanceof THREE.Camera || entry instanceof THREE.Light) entry.visible = false;
      if (!(entry instanceof THREE.Mesh || entry instanceof THREE.Points || entry instanceof THREE.Line)) return;
      const id = typeof entry.userData["semanticId"] === "string" ? entry.userData["semanticId"] as string : `import:object-${ordinal}`;
      entry.userData["semanticId"] = id;
      entry.userData["selectionKind"] = "body";
      if (entry instanceof THREE.Mesh && entry.material instanceof THREE.MeshStandardMaterial) entry.userData["baseColor"] = `#${entry.material.color.getHexString()}`;
      this.#pickable.push(entry);
      ordinal += 1;
    });
    this.#bodyGroup.add(root);
    this.#objects.push(root);
    if (this.#zebra !== null) this.#applyZebra(root);
    this.#bodyId = undefined;
    this.fitExchange(inspectExchangeObject(root).bounds);
  }

  snapshotExchangeObject(): THREE.Object3D {
    // Zebra stand-in materials are a display aid and must not leak into an export.
    const zebra = this.#zebra;
    if (zebra !== null) applyZebraToObject(this.#bodyGroup, null);
    let snapshot: THREE.Object3D;
    try { snapshot = cloneExchangeObject(this.#bodyGroup); } finally { if (zebra !== null) applyZebraToObject(this.#bodyGroup, zebra); }
    const helpers: THREE.Object3D[] = [];
    snapshot.traverse((entry) => { if (entry.userData["ps3dExchangeHelper"] === true) helpers.push(entry); });
    for (const helper of helpers) { helper.parent?.remove(helper); disposeExchangeObject(helper); }
    return snapshot;
  }

  async capturePreviewJpeg(quality = 0.9): Promise<ViewportJpeg> {
    this.#renderer.render(this.#scene, this.#activeCamera());
    const dataUrl = this.#canvas.toDataURL("image/jpeg", THREE.MathUtils.clamp(quality, 0.5, 1));
    const encoded = dataUrl.split(",", 2)[1];
    if (encoded === undefined) throw new Error("The viewport preview could not be encoded as JPEG.");
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { bytes, width: this.#canvas.width, height: this.#canvas.height };
  }

  async captureRenderImage(width: number, height: number, format: "jpeg" | "png", quality = 0.94): Promise<ViewportRenderImage> {
    const boundedWidth = THREE.MathUtils.clamp(Math.round(width), 256, 4096);
    const boundedHeight = THREE.MathUtils.clamp(Math.round(height), 256, 4096);
    const priorPixelRatio = this.#renderer.getPixelRatio();
    try {
      this.#renderer.setPixelRatio(1);
      this.#renderer.setSize(boundedWidth, boundedHeight, false);
      this.#setProjectionAspect(boundedWidth / boundedHeight);
      this.#renderer.render(this.#scene, this.#activeCamera());
      const mimeType = format === "png" ? "image/png" : "image/jpeg";
      const dataUrl = this.#canvas.toDataURL(mimeType, THREE.MathUtils.clamp(quality, 0.5, 1));
      const encoded = dataUrl.split(",", 2)[1];
      if (encoded === undefined) throw new Error("The Render Studio image could not be encoded.");
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return { bytes, width: boundedWidth, height: boundedHeight, mimeType };
    } finally {
      this.#renderer.setPixelRatio(priorPixelRatio);
      this.#resize();
    }
  }

  fit(bounds?: ModelSuccessResponse["render"]["measurements"]["boundsMeters"]): void {
    if (bounds !== undefined) {
      this.#target.set(
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2
      );
      this.#radius = Math.max(...bounds.size) * 2.8;
    }
    this.#updateCamera();
  }

  fitPreview(bounds: PreviewBounds): void {
    this.#target.set(
      (bounds.min[0] + bounds.max[0]) / 2 / 1000,
      (bounds.min[1] + bounds.max[1]) / 2 / 1000,
      (bounds.min[2] + bounds.max[2]) / 2 / 1000
    );
    this.#radius = Math.max(...bounds.size) / 1000 * 2.8;
    this.#updateCamera();
  }

  fitExchange(bounds: ExchangeBounds): void {
    this.#target.set(...bounds.centerMeters);
    this.#radius = Math.max(Math.max(...bounds.sizeMeters) * 2.8, 0.015);
    this.#updateCamera();
  }

  fitCurrent(): void {
    this.fitExchange(inspectExchangeObject(this.#bodyGroup).bounds);
  }

  setSelected(selected: boolean): void {
    this.setSelectedId(selected ? this.#bodyId ?? null : null);
  }

  setSelectedId(id: string | null): void {
    this.#selectedId = id ?? undefined;
    for (const object of this.#pickable) {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) continue;
      const selected = object.userData["semanticId"] === id;
      const baseColor = object.userData["baseColor"] as string | undefined;
      object.material.color.set(selected ? "#e0646d" : baseColor ?? this.#bodyColor);
      object.material.emissive.set(selected ? "#351014" : "#08090a");
    }
    if (this.#qualifiedEdges !== undefined) {
      const idleEdgeColor = this.#shadingMode === "wireframe" ? "#e1e5e8" : "#3f454a";
      this.#qualifiedEdges.material.color.set(id === this.#bodyId ? "#e0646d" : idleEdgeColor);
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    this.#touchPointers.clear();
    this.#assemblyTouchGesture = undefined;
    this.#drag = undefined;
    this.#resizeObserver.disconnect();
    this.#canvas.removeEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.removeEventListener("pointermove", this.#onPointerMove);
    this.#canvas.removeEventListener("pointerup", this.#onPointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#onPointerUp);
    this.#canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    this.#removeSelectionBox();
    this.setPreviewGhost(null);
    this.setPreviewHandle(null);
    disposePreviewGroup(this.#handleGroup);
    this.setSelectedEdges([]);
    this.#canvas.removeEventListener("wheel", this.#onWheel);
    this.#canvas.removeEventListener("contextmenu", this.#onContextMenu);
    this.setAnalysisOverlay(null);
    this.#clearBody();
    this.#clearMeasurements();
    this.#grid.geometry.dispose();
    if (Array.isArray(this.#grid.material)) this.#grid.material.forEach((material) => material.dispose());
    else this.#grid.material.dispose();
    this.#axes.geometry.dispose();
    if (Array.isArray(this.#axes.material)) this.#axes.material.forEach((material) => material.dispose());
    else this.#axes.material.dispose();
    this.#studioGround.geometry.dispose();
    if (Array.isArray(this.#studioGround.material)) this.#studioGround.material.forEach((material) => material.dispose());
    else this.#studioGround.material.dispose();
    this.#renderer.dispose();
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) return;
    // A press on the preview arrow drags the arrow (never the camera); middle-button and every other press go on as before.
    if (event.button === 0 && this.#beginHandleDrag(event)) return;
    this.#canvas.setPointerCapture(event.pointerId);
    if (event.pointerType === "touch") {
      event.preventDefault();
      this.#touchPointers.set(event.pointerId, { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
      const assemblyGestures = this.#options.assemblyTouchGestures;
      if (assemblyGestures !== undefined && this.#touchPointers.size >= 2) {
        const points = Array.from(this.#touchPointers.values()).slice(0, 2);
        const startExplodeMm = THREE.MathUtils.clamp(assemblyGestures.getExplodeMm(), 0, assemblyGestures.maxExplodeMm ?? 120);
        this.#assemblyTouchGesture = {
          startCentroidY: touchCentroidY(points),
          startExplodeMm,
          latestExplodeMm: startExplodeMm
        };
        this.#drag = undefined;
        return;
      }
    }
    const mode: NavigationMode = event.button === 1
      ? event.shiftKey ? "orbit" : "pan"
      : event.pointerType === "touch" && this.#options.assemblyTouchGestures !== undefined ? "orbit" : this.#navigationMode;
    this.#drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, mode };
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (this.#handleDrag !== undefined) { if (this.#handleDrag.pointerId === event.pointerId) this.#moveHandleDrag(event); return; }
    if (this.#handle !== undefined && this.#drag === undefined && event.pointerType !== "touch" && this.#hoverHandle(event)) return;
    if (event.pointerType === "touch" && this.#touchPointers.has(event.pointerId)) {
      event.preventDefault();
      this.#touchPointers.set(event.pointerId, { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
      const assemblyGestures = this.#options.assemblyTouchGestures;
      if (assemblyGestures !== undefined && this.#assemblyTouchGesture !== undefined && this.#touchPointers.size >= 2) {
        const valueMm = assemblyExplodeFromVerticalGesture(
          this.#assemblyTouchGesture.startExplodeMm,
          this.#assemblyTouchGesture.startCentroidY,
          touchCentroidY(Array.from(this.#touchPointers.values()).slice(0, 2)),
          this.#canvas.clientHeight,
          assemblyGestures.maxExplodeMm ?? 120
        );
        this.#assemblyTouchGesture.latestExplodeMm = valueMm;
        assemblyGestures.onExplodePreview(valueMm);
        return;
      }
    }
    if (this.#drag === undefined && event.pointerType !== "touch" && this.#navigationMode === "select") this.#updateHover(event.clientX, event.clientY);
    if (this.#drag === undefined || this.#drag.pointerId !== event.pointerId) return;
    if (this.#drag.moved) this.#setHover(null);
    // A left drag in select mode with the Edge intent is a selection box, not a camera move.
    if (this.#drag.mode === "select" && this.#hoverFilter() === "edge" && event.pointerType !== "touch") {
      if (this.#boxSelect === undefined && this.#drag.moved) this.#boxSelect = { startX: this.#drag.startX, startY: this.#drag.startY, x: event.clientX, y: event.clientY };
      if (this.#boxSelect !== undefined) {
        this.#boxSelect.x = event.clientX;
        this.#boxSelect.y = event.clientY;
        this.#drawSelectionBox();
        return;
      }
    }
    const dx = event.clientX - this.#drag.x;
    const dy = event.clientY - this.#drag.y;
    if (Math.hypot(event.clientX - this.#drag.startX, event.clientY - this.#drag.startY) > 3) this.#drag.moved = true;
    this.#drag.x = event.clientX;
    this.#drag.y = event.clientY;
    if (this.#drag.mode === "orbit") {
      const [azimuthDeg, elevationDeg] = orbitViewAngles(
        THREE.MathUtils.radToDeg(this.#azimuth),
        THREE.MathUtils.radToDeg(this.#elevation),
        dx,
        dy
      );
      this.#azimuth = THREE.MathUtils.degToRad(azimuthDeg);
      this.#elevation = THREE.MathUtils.degToRad(elevationDeg);
      this.#orientation = "custom";
    } else if (this.#drag.mode === "pan") {
      const scale = this.#radius / Math.max(this.#canvas.clientHeight, 1);
      const activeCamera = this.#activeCamera();
      const right = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(activeCamera.matrix, 1);
      this.#target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    }
    if (this.#drag.mode === "orbit" || this.#drag.mode === "pan") this.#updateCamera();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (this.#handleDrag !== undefined) { if (this.#handleDrag.pointerId === event.pointerId) this.#endHandleDrag(event, event.type === "pointercancel" ? "cancel" : "end"); return; }
    if (event.pointerType === "touch") {
      this.#touchPointers.delete(event.pointerId);
      if (this.#assemblyTouchGesture !== undefined && this.#touchPointers.size < 2) {
        const committedValueMm = this.#assemblyTouchGesture.latestExplodeMm;
        this.#assemblyTouchGesture = undefined;
        this.#options.assemblyTouchGestures?.onExplodeCommit(committedValueMm);
        const remaining = this.#touchPointers.values().next().value as ViewportTouchPoint | undefined;
        this.#drag = remaining === undefined ? undefined : {
          pointerId: remaining.pointerId,
          x: remaining.x,
          y: remaining.y,
          startX: remaining.x,
          startY: remaining.y,
          moved: true,
          mode: "orbit"
        };
        if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
        return;
      }
    }
    if (this.#drag !== undefined && this.#drag.pointerId === event.pointerId && this.#boxSelect !== undefined) {
      this.#finishSelectionBox(event);
    } else if (this.#drag !== undefined && this.#drag.pointerId === event.pointerId && !this.#drag.moved) {
      if (this.#drag.mode === "select") this.#pick(event);
      if (this.#drag.mode === "measure") this.#measurePick(event);
    }
    if (this.#drag?.pointerId === event.pointerId) this.#drag = undefined;
    if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
  };

  /** The rubber band: solid for a left-to-right window box, dashed for a right-to-left crossing box, Fusion style. */
  #drawSelectionBox(): void {
    const box = this.#boxSelect;
    if (box === undefined) return;
    if (this.#boxDiv === undefined) {
      this.#boxDiv = this.#canvas.ownerDocument.createElement("div");
      this.#boxDiv.style.position = "fixed";
      this.#boxDiv.style.pointerEvents = "none";
      this.#boxDiv.style.zIndex = "60";
      this.#boxDiv.style.background = "rgba(63, 160, 255, 0.12)";
      this.#canvas.ownerDocument.body.append(this.#boxDiv);
    }
    const crossing = box.x < box.startX;
    this.#boxDiv.style.border = crossing ? "1px dashed #5fd4ff" : "1px solid #5fd4ff";
    this.#boxDiv.style.left = `${Math.min(box.startX, box.x)}px`;
    this.#boxDiv.style.top = `${Math.min(box.startY, box.y)}px`;
    this.#boxDiv.style.width = `${Math.abs(box.x - box.startX)}px`;
    this.#boxDiv.style.height = `${Math.abs(box.y - box.startY)}px`;
  }

  #removeSelectionBox(): void {
    this.#boxSelect = undefined;
    this.#boxDiv?.remove();
    this.#boxDiv = undefined;
  }

  /** Ends the box: projects every pickable edge to the screen and reports the chains the box takes. */
  #finishSelectionBox(event: PointerEvent): void {
    const box = this.#boxSelect;
    this.#removeSelectionBox();
    if (box === undefined) return;
    const crossing = box.x < box.startX;
    const bounds = { left: Math.min(box.startX, box.x), top: Math.min(box.startY, box.y), right: Math.max(box.startX, box.x), bottom: Math.max(box.startY, box.y) };
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const camera = this.#activeCamera();
    camera.updateMatrixWorld();
    const vector = new THREE.Vector3();
    const project = (point: readonly [number, number, number]): readonly [number, number] => {
      vector.set(point[0] / 1000, point[1] / 1000, point[2] / 1000).project(camera);
      return [rect.left + (vector.x + 1) / 2 * rect.width, rect.top + (1 - vector.y) / 2 * rect.height];
    };
    const projected: ProjectedSegment[] = [];
    for (const [bodyId, candidates] of this.#pickCandidates) {
      for (const edge of candidates.edges) {
        const [ax, ay] = project(edge.a);
        const [bx, by] = project(edge.b);
        projected.push({ bodyId, chain: edge.chain, ax, ay, bx, by });
      }
    }
    const chains = chainsInBox(projected, bounds, crossing);
    const targets: HoverTarget[] = chains.map((entry) => {
      const segments = this.#pickCandidates.get(entry.bodyId)?.edges.filter((edge) => edge.chain === entry.chain) ?? [];
      return { kind: "edge", bodyId: entry.bodyId, chain: entry.chain, segments, distanceMm: 0, concave: segments[0]?.concave === true };
    });
    this.#options.onPickEntities?.(targets, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  }

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const previousRadius = this.#radius;
    const nextRadius = THREE.MathUtils.clamp(previousRadius * Math.exp(event.deltaY * 0.001), 0.0001, 10_000);
    const scale = nextRadius / previousRadius;
    this.#radius = nextRadius;
    const rect = this.#canvas.getBoundingClientRect();
    // Fusion-style dolly to cursor: keep the point under the pointer anchored while zooming.
    if (scale !== 1 && rect.width > 0 && rect.height > 0) {
      const camera = this.#activeCamera();
      camera.updateMatrixWorld();
      this.#pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      this.#raycaster.setFromCamera(this.#pointer, camera);
      const forward = new THREE.Vector3().subVectors(this.#target, camera.position).normalize();
      const focusPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, this.#target);
      const cursorPoint = new THREE.Vector3();
      if (this.#raycaster.ray.intersectPlane(focusPlane, cursorPoint)) this.#target.lerp(cursorPoint, 1 - scale);
    }
    this.#updateCamera();
  };

  readonly #onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.#options.onContextMenu === undefined) return;
    const hit = this.#hitObject(event.clientX, event.clientY);
    const semanticId = typeof hit?.userData["semanticId"] === "string" ? hit.userData["semanticId"] as string : null;
    const selectionKind = typeof hit?.userData["selectionKind"] === "string" ? hit.userData["selectionKind"] as string : null;
    if (semanticId !== null) {
      this.setSelectedId(semanticId);
      this.#options.onSelectBody(semanticId);
    }
    this.#options.onContextMenu?.({ clientX: event.clientX, clientY: event.clientY, semanticId, selectionKind });
  };

  #pick(event: PointerEvent): void {
    const filter = this.#hoverFilter();
    // Face / Edge intent: the click picks what the hover pre-highlight shows and the host decides what to do with it.
    if (filter === "face" || filter === "edge") {
      const hit = this.#hitForHover(event.clientX, event.clientY);
      const target = classifyHover(hit, hit === undefined ? undefined : this.#pickCandidates.get(hit.bodyId), filter, edgePickToleranceMm(this.#radius, this.#canvas.clientHeight));
      this.#options.onPickEntity?.(target, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
      return;
    }
    if (this.#pickable.length === 0) return;
    const hit = this.#hitObject(event.clientX, event.clientY);
    const id = typeof hit?.userData["semanticId"] === "string" ? hit.userData["semanticId"] as string : null;
    const next = id === this.#selectedId ? null : id;
    this.setSelectedId(next);
    this.#options.onSelectBody(next);
  }

  #hitObject(clientX: number, clientY: number): THREE.Object3D | undefined {
    if (this.#pickable.length === 0) return undefined;
    const rect = this.#canvas.getBoundingClientRect();
    this.#pointer.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#activeCamera());
    return this.#raycaster.intersectObjects(this.#pickable, false).find((entry) => this.#selectionAllows(entry.object))?.object;
  }

  #measurePick(event: PointerEvent): void {
    if (this.#pickable.length === 0) return;
    const rect = this.#canvas.getBoundingClientRect();
    this.#pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#activeCamera());
    const hit = this.#raycaster.intersectObjects(this.#pickable, false).find((entry) => this.#selectionAllows(entry.object));
    if (hit === undefined) return;
    const semanticId = typeof hit.object.userData["semanticId"] === "string" ? hit.object.userData["semanticId"] as string : null;
    const faceTriangles = hit.object.userData["faceTriangles"];
    const faceIndex = Array.isArray(faceTriangles) && hit.faceIndex !== undefined && hit.faceIndex !== null ? (faceTriangles[hit.faceIndex] as number | undefined) ?? null : null;
    const worldNormal = hit.face === undefined || hit.face === null ? undefined : hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    this.#options.onMeasurePoint?.({ pointMm: [hit.point.x * 1000, hit.point.y * 1000, hit.point.z * 1000], semanticId, faceIndex, ...(worldNormal === undefined ? {} : { normalMm: [worldNormal.x, worldNormal.y, worldNormal.z] as const }) });
  }

  #selectionAllows(object: THREE.Object3D): boolean {
    if (this.#selectionFilter === "auto") return true;
    // The Face and Edge intents pick into bodies, so any body surface may be hit.
    if (this.#selectionFilter === "face" || this.#selectionFilter === "edge") return object.userData["selectionKind"] === "body";
    return object.userData["selectionKind"] === this.#selectionFilter;
  }

  #updateCamera(): void {
    const horizontal = this.#radius * Math.cos(this.#elevation);
    const position = new THREE.Vector3(
      this.#target.x + horizontal * Math.cos(this.#azimuth),
      this.#target.y + horizontal * Math.sin(this.#azimuth),
      this.#target.z + this.#radius * Math.sin(this.#elevation)
    );
    const verticalView = Math.abs(Math.cos(this.#elevation)) < 0.01;
    for (const camera of [this.#camera, this.#orthographicCamera]) {
      camera.position.copy(position);
      camera.up.set(0, verticalView ? 1 : 0, verticalView ? 0 : 1);
      camera.lookAt(this.#target);
    }
    if (this.#scene.fog instanceof THREE.Fog) {
      this.#scene.fog.near = Math.max(this.#radius * 0.72, 0.002);
      this.#scene.fog.far = Math.max(this.#radius * 5, 0.75);
    }
    this.#updateProjection();
    this.#layoutHandle();
    this.#emitViewState();
  }

  #resize(): void {
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.#updateProjection();
  }

  #animate = (): void => {
    this.#renderer.render(this.#scene, this.#activeCamera());
    this.#frame = requestAnimationFrame(this.#animate);
  };

  #clearBody(): void {
    this.#setHover(null);
    for (const object of this.#objects) {
      this.#bodyGroup.remove(object);
      disposeZebraOriginals(object);
      disposeExchangeObject(object);
    }
    this.#objects.length = 0;
    this.#pickable.length = 0;
    this.#selectedId = undefined;
    this.#qualifiedBody = undefined;
    this.#qualifiedEdges = undefined;
    this.#clearFaceHighlight();
  }

  #clearFaceHighlight(): void {
    if (this.#faceHighlight === undefined) return;
    this.#bodyGroup.remove(this.#faceHighlight);
    this.#faceHighlight.geometry.dispose();
    this.#faceHighlight.material.dispose();
    this.#faceHighlight = undefined;
  }

  /** Highlight one named face of a general mesh body, or clear the highlight when faceIndex is null. */
  setHighlightedFace(bodyId: string | null, faceIndex: number | null): void {
    this.#clearFaceHighlight();
    if (bodyId === null || faceIndex === null || faceIndex < 0) return;
    this.#faceHighlight = this.#buildFaceOverlay(bodyId, faceIndex, { color: "#ffd24a", emissive: "#6a4a00", renderOrder: 3 });
  }

  /** A translucent copy of one named face, placed over its body; undefined when the body or face is not drawn. */
  #buildFaceOverlay(bodyId: string, faceIndex: number, style: { readonly color: string; readonly emissive: string; readonly renderOrder: number }): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined {
    let source: THREE.Mesh | undefined;
    for (const object of this.#objects) {
      object.traverse((child) => {
        if (source === undefined && child instanceof THREE.Mesh && child.userData["semanticId"] === bodyId && Array.isArray(child.userData["faceTriangles"])) source = child;
      });
      if (source !== undefined) break;
    }
    if (source === undefined) return undefined;
    const faceOfTriangle = source.userData["faceTriangles"] as number[];
    const position = source.geometry.getAttribute("position");
    const index = source.geometry.getIndex();
    const highlightPositions: number[] = [];
    for (let triangle = 0; triangle < faceOfTriangle.length; triangle += 1) {
      if (faceOfTriangle[triangle] !== faceIndex) continue;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index !== null ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
        highlightPositions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
      }
    }
    if (highlightPositions.length === 0) return undefined;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(highlightPositions), 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: style.color, emissive: style.emissive, roughness: 0.35, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false });
    const highlight = new THREE.Mesh(geometry, material);
    highlight.renderOrder = style.renderOrder;
    highlight.userData["ps3dExchangeHelper"] = true;
    highlight.position.copy(source.position);
    highlight.rotation.copy(source.rotation);
    this.#bodyGroup.add(highlight);
    return highlight;
  }

  readonly #onPointerLeave = (): void => {
    this.#setHover(null);
    if (this.#handleHot && this.#handleDrag === undefined) { this.#handleHot = false; this.#layoutHandle(); }
  };

  /** Raycasts the cursor and pre-highlights the face, edge or body a click would pick (PT-08). */
  #updateHover(clientX: number, clientY: number): void {
    const hit = this.#hitForHover(clientX, clientY);
    const filter = this.#hoverFilter();
    const tolerance = edgePickToleranceMm(this.#radius, this.#canvas.clientHeight);
    const target = classifyHover(hit, hit === undefined ? undefined : this.#pickCandidates.get(hit.bodyId), filter, tolerance);
    this.#setHover(target);
  }

  #hoverFilter(): HoverFilter {
    const filter = this.#selectionFilter;
    return filter === "body" || filter === "component" || filter === "face" || filter === "edge" ? filter : "auto";
  }

  #hitForHover(clientX: number, clientY: number): HoverRayHit | undefined {
    if (this.#pickable.length === 0) return undefined;
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    this.#pointer.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#activeCamera());
    const hit = this.#raycaster.intersectObjects(this.#pickable, false).find((entry) => this.#selectionAllows(entry.object));
    if (hit === undefined) return undefined;
    const bodyId = typeof hit.object.userData["semanticId"] === "string" ? hit.object.userData["semanticId"] as string : undefined;
    if (bodyId === undefined) return undefined;
    const faceTriangles = hit.object.userData["faceTriangles"];
    const faceIndex = Array.isArray(faceTriangles) && hit.faceIndex !== undefined && hit.faceIndex !== null ? (faceTriangles[hit.faceIndex] as number | undefined) ?? null : null;
    return { bodyId, pointMm: [hit.point.x * 1000, hit.point.y * 1000, hit.point.z * 1000], faceIndex };
  }

  #setHover(target: HoverTarget | null): void {
    if (sameHoverTarget(this.#hover, target)) return;
    // Clear the previous tint.
    if (this.#hoverFace !== undefined) {
      this.#bodyGroup.remove(this.#hoverFace);
      this.#hoverFace.geometry.dispose();
      this.#hoverFace.material.dispose();
      this.#hoverFace = undefined;
    }
    this.#clearRodGroup(this.#hoverGroup);
    if (this.#hoverBodyMesh !== undefined) {
      if (this.#hoverBodyMesh.userData["semanticId"] !== this.#selectedId) this.#hoverBodyMesh.material.emissive.set("#08090a");
      this.#hoverBodyMesh = undefined;
    }
    this.#hover = target;
    if (target === null) { this.#canvas.style.cursor = this.#navigationMode === "select" ? "default" : this.#canvas.style.cursor; return; }
    if (target.kind === "face") {
      this.#hoverFace = this.#buildFaceOverlay(target.bodyId, target.faceIndex, { color: "#8fd0f2", emissive: "#17405a", renderOrder: 2 });
    } else if (target.kind === "edge") {
      this.#addRods(this.#hoverGroup, target.segments.map((segment) => [segment.a, segment.b] as ViewportGuideSegment), "#5fd4ff", 1.3, 16);
    } else {
      for (const object of this.#pickable) {
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) continue;
        if (object.userData["semanticId"] !== target.bodyId) continue;
        if (object.userData["semanticId"] !== this.#selectedId) object.material.emissive.set("#1c333d");
        this.#hoverBodyMesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
        break;
      }
    }
    if (this.#navigationMode === "select") this.#canvas.style.cursor = "pointer";
  }

  /**
   * Live preview (see apps/studio-web/src/part-preview.ts): shows the result of a command's current inputs as a translucent ghost,
   * or removes it with null. A ghost that carries `replacesBodyId` hides that body while it shows (the ghost is the changed solid).
   * The ghost is never pickable, so clicks still reach the real solid underneath.
   */
  setPreviewGhost(ghost: ViewportGhost | null): void {
    for (const object of [...this.#ghostGroup.children]) {
      this.#ghostGroup.remove(object);
      if (object instanceof THREE.Group) disposePreviewGroup(object);
    }
    this.#ghostHiddenBodyId = ghost?.replacesBodyId;
    if (ghost !== null && ghost.positionsMm.length >= 9 && ghost.indices.length >= 3) this.#ghostGroup.add(buildGhostGroup(ghost));
    else this.#ghostHiddenBodyId = undefined;
    this.#applyGhostHide();
  }

  /** Hides the body a ghost stands in for (and its edge lines), and shows again whatever an earlier ghost hid. */
  #applyGhostHide(): void {
    for (const object of this.#ghostHidden) object.visible = true;
    this.#ghostHidden.clear();
    const id = this.#ghostHiddenBodyId;
    if (id === undefined) return;
    this.#objects.forEach((object, index) => {
      if (object.userData["semanticId"] !== id) return;
      object.visible = false;
      this.#ghostHidden.add(object);
      // A mesh primitive's edge lines follow it in the list without an id of their own.
      const next = this.#objects[index + 1];
      if (next !== undefined && next.userData["semanticId"] === undefined && next.userData["ps3dExchangeHelper"] === true) { next.visible = false; this.#ghostHidden.add(next); }
    });
  }

  /**
   * The draggable arrow of a command (null removes it). A press on its knob or shaft starts a drag that reports how far the knob
   * travelled along the arrow through `onDrag`; it never moves the camera, Escape during the drag cancels it (phase "cancel"), and
   * every press elsewhere behaves exactly as before. The caller moves the arrow by passing a new handle.
   */
  setPreviewHandle(handle: ViewportHandle | null): void {
    if (handle === null && this.#handleDrag !== undefined) this.#endHandleDrag(undefined, "cancel");
    this.#handle = handle ?? undefined;
    if (handle === null) { this.#handleGroup.visible = false; this.#handleHot = false; return; }
    this.#layoutHandle();
  }

  #layoutHandle(): void {
    if (this.#handle === undefined) { this.#handleGroup.visible = false; return; }
    layoutHandleGroup(this.#handleGroup, this.#handle, THREE.MathUtils.clamp(this.#radius * 0.004, 0.0003, 0.003), this.#handleHot || this.#handleDrag !== undefined);
  }

  /** The arrow as the screen sees it now, in client pixels; undefined when there is no arrow or the canvas has no size. */
  #handleAxis(): HandleScreenAxis | undefined {
    const handle = this.#handle;
    const rect = this.#canvas.getBoundingClientRect();
    if (handle === undefined || rect.width <= 0 || rect.height <= 0) return undefined;
    const camera = this.#activeCamera();
    camera.updateMatrixWorld();
    const vector = new THREE.Vector3();
    const project = (point: readonly [number, number, number]): readonly [number, number] => {
      vector.set(point[0] / 1000, point[1] / 1000, point[2] / 1000).project(camera);
      return [rect.left + (vector.x + 1) / 2 * rect.width, rect.top + (1 - vector.y) / 2 * rect.height];
    };
    const unit = new THREE.Vector3(handle.directionMm[0], handle.directionMm[1], handle.directionMm[2]).normalize();
    const tip = new THREE.Vector3(handle.anchorMm[0], handle.anchorMm[1], handle.anchorMm[2]).addScaledVector(unit, handle.tipDistanceMm);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const flatA = project([tip.x, tip.y, tip.z]);
    const flatB = project([tip.x + right.x, tip.y + right.y, tip.z + right.z]);
    return projectHandleAxis(project, handle.anchorMm, handle.directionMm, handle.tipDistanceMm, Math.hypot(flatB[0] - flatA[0], flatB[1] - flatA[1]));
  }

  #beginHandleDrag(event: PointerEvent): boolean {
    // A camera drag already under way (a middle-button orbit or pan) is never taken over by the arrow.
    if (this.#handle === undefined || this.#handleDrag !== undefined || this.#drag !== undefined) return false;
    const axis = this.#handleAxis();
    if (axis === undefined || !hitHandle(axis, [event.clientX, event.clientY])) return false;
    event.preventDefault();
    this.#canvas.setPointerCapture(event.pointerId);
    this.#handleDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, axis };
    this.#setHover(null);
    this.#canvas.style.cursor = "grabbing";
    this.#canvas.ownerDocument.defaultView?.addEventListener("keydown", this.#onHandleKey, true);
    this.#layoutHandle();
    this.#handle.onDrag({ phase: "start", deltaMm: 0, shiftKey: event.shiftKey });
    return true;
  }

  #moveHandleDrag(event: PointerEvent): void {
    const drag = this.#handleDrag;
    if (drag === undefined || this.#handle === undefined) return;
    this.#handle.onDrag({ phase: "move", deltaMm: deltaMmFromDrag(drag.axis, [event.clientX - drag.startX, event.clientY - drag.startY]), shiftKey: event.shiftKey });
  }

  #endHandleDrag(event: PointerEvent | undefined, phase: "end" | "cancel"): void {
    const drag = this.#handleDrag;
    if (drag === undefined) return;
    this.#handleDrag = undefined;
    this.#canvas.ownerDocument.defaultView?.removeEventListener("keydown", this.#onHandleKey, true);
    if (this.#canvas.hasPointerCapture(drag.pointerId)) this.#canvas.releasePointerCapture(drag.pointerId);
    this.#canvas.style.cursor = "";
    const delta = phase === "cancel" || event === undefined ? 0 : deltaMmFromDrag(drag.axis, [event.clientX - drag.startX, event.clientY - drag.startY]);
    this.#handle?.onDrag({ phase, deltaMm: delta, shiftKey: event?.shiftKey ?? false });
    this.#layoutHandle();
  }

  /** Escape while the arrow is held drops the drag, not the command: the panel keeps its value from before the press. */
  readonly #onHandleKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.#handleDrag === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.#endHandleDrag(undefined, "cancel");
  };

  /** Hover over the arrow: it brightens and the cursor offers a grab. Returns true while the pointer is over it (the model's own hover then stays off). */
  #hoverHandle(event: PointerEvent): boolean {
    const axis = this.#handleAxis();
    const over = axis !== undefined && hitHandle(axis, [event.clientX, event.clientY]);
    if (over !== this.#handleHot) { this.#handleHot = over; this.#layoutHandle(); this.#canvas.style.cursor = over ? "grab" : ""; }
    if (over) this.#setHover(null);
    return over;
  }

  /**
   * Draws guide lines over the model (edges the user may pick, with the one under consideration highlighted). Passing an empty
   * list removes them.
   */
  setGuideSegments(segmentsMm: readonly ViewportGuideSegment[], activeIndex: number | readonly number[] | null = null): void {
    const activeSet = new Set<number>(activeIndex === null ? [] : typeof activeIndex === "number" ? [activeIndex] : activeIndex);
    this.#clearRodGroup(this.#guideGroup);
    const active = segmentsMm.filter((_, index) => activeSet.has(index));
    const idle = segmentsMm.filter((_, index) => !activeSet.has(index));
    this.#addRods(this.#guideGroup, idle, "#3fd0ff", 1, 18, 0.85);
    this.#addRods(this.#guideGroup, active, "#ffb347", 1.6, 18, 1);
  }

  #clearRodGroup(group: THREE.Group): void {
    for (const object of [...group.children]) {
      group.remove(object);
      if ("geometry" in object && object.geometry instanceof THREE.BufferGeometry) object.geometry.dispose();
      if ("material" in object) (object.material as THREE.Material).dispose();
    }
  }

  /** A line is one pixel wide whatever the zoom, so each guide or highlight is a thin rod that always draws on top of the model. */
  #addRods(group: THREE.Group, segmentsMm: readonly ViewportGuideSegment[], color: string, radiusScale: number, renderOrder: number, opacity = 1): void {
    const rodRadius = THREE.MathUtils.clamp(this.#radius * 0.004, 0.0003, 0.003) * radiusScale;
    const up = new THREE.Vector3(0, 1, 0);
    for (const [from, to] of segmentsMm) {
      const start = new THREE.Vector3(from[0] / 1000, from[1] / 1000, from[2] / 1000);
      const end = new THREE.Vector3(to[0] / 1000, to[1] / 1000, to[2] / 1000);
      const direction = new THREE.Vector3().subVectors(end, start);
      const length = direction.length();
      if (length < 1e-9) continue;
      const geometry = new THREE.CylinderGeometry(rodRadius, rodRadius, length, 8, 1, false);
      const rod = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity }));
      rod.quaternion.setFromUnitVectors(up, direction.normalize());
      rod.position.copy(start).add(end).multiplyScalar(0.5);
      rod.renderOrder = renderOrder;
      rod.userData["ps3dExchangeHelper"] = true;
      group.add(rod);
    }
  }

  #clearMeasurements(): void {
    for (const object of [...this.#measurementGroup.children]) {
      this.#measurementGroup.remove(object);
      if ("geometry" in object && object.geometry instanceof THREE.BufferGeometry) object.geometry.dispose();
      if ("material" in object) {
        const material = object.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material.dispose();
      }
    }
  }

  #activeCamera(): THREE.Camera {
    return this.#projection === "orthographic" ? this.#orthographicCamera : this.#camera;
  }

  #updateProjection(): void {
    const aspect = Math.max(this.#canvas.clientWidth, 1) / Math.max(this.#canvas.clientHeight, 1);
    this.#setProjectionAspect(aspect);
  }

  #setProjectionAspect(aspect: number): void {
    const halfHeight = Math.max(this.#radius * Math.tan(THREE.MathUtils.degToRad(this.#camera.fov / 2)), 0.004);
    this.#orthographicCamera.left = -halfHeight * aspect;
    this.#orthographicCamera.right = halfHeight * aspect;
    this.#orthographicCamera.top = halfHeight;
    this.#orthographicCamera.bottom = -halfHeight;
    const near = Math.max(this.#radius / 10_000, 0.00001);
    const far = Math.max(this.#radius * 25, 10);
    this.#camera.near = near;
    this.#camera.far = far;
    this.#orthographicCamera.near = near;
    this.#orthographicCamera.far = far;
    this.#camera.aspect = aspect;
    this.#camera.updateProjectionMatrix();
    this.#orthographicCamera.updateProjectionMatrix();
  }

  #emitViewState(): void {
    this.#options.onViewChange?.(this.getViewState());
  }

  #addObject(object: THREE.Object3D, pickable: boolean): void {
    object.traverse((entry) => {
      if (entry instanceof THREE.Mesh) { entry.castShadow = true; entry.receiveShadow = true; }
    });
    this.#bodyGroup.add(object);
    this.#objects.push(object);
    if (pickable) this.#pickable.push(object);
    if (this.#zebra !== null) this.#applyZebra(object);
  }

  #addPrimitive(primitive: PreviewPrimitive): void {
    if (primitive.kind === "line") {
      const points: THREE.Vector3[] = [];
      for (let index = 0; index < primitive.pointsMm.length; index += 3) {
        points.push(new THREE.Vector3(primitive.pointsMm[index]! / 1000, primitive.pointsMm[index + 1]! / 1000, primitive.pointsMm[index + 2]! / 1000));
      }
      if (!primitive.dashed && primitive.radiusMm !== undefined && points.length > 1) {
        const segmentValues: number[] = primitive.segmentsMm === undefined ? [] : [...primitive.segmentsMm];
        if (primitive.segmentsMm === undefined) {
          for (let index = 3; index < primitive.pointsMm.length; index += 3) {
            segmentValues.push(
              primitive.pointsMm[index - 3]!, primitive.pointsMm[index - 2]!, primitive.pointsMm[index - 1]!,
              primitive.pointsMm[index]!, primitive.pointsMm[index + 1]!, primitive.pointsMm[index + 2]!
            );
          }
        }
        const segmentGeometries: THREE.BufferGeometry[] = [];
        const up = new THREE.Vector3(0, 1, 0);
        for (let index = 0; index < segmentValues.length; index += 6) {
          const from = new THREE.Vector3(segmentValues[index]! / 1000, segmentValues[index + 1]! / 1000, segmentValues[index + 2]! / 1000);
          const to = new THREE.Vector3(segmentValues[index + 3]! / 1000, segmentValues[index + 4]! / 1000, segmentValues[index + 5]! / 1000);
          const direction = new THREE.Vector3().subVectors(to, from);
          const length = direction.length();
          if (length <= 1e-8) continue;
          const segmentGeometry = new THREE.CylinderGeometry(primitive.radiusMm / 1000, primitive.radiusMm / 1000, length, 8, 1, false);
          segmentGeometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()));
          const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
          segmentGeometry.translate(midpoint.x, midpoint.y, midpoint.z);
          segmentGeometries.push(segmentGeometry);
        }
        const geometry = segmentGeometries.length > 0 ? mergeGeometries(segmentGeometries, false) : null;
        for (const segmentGeometry of segmentGeometries) segmentGeometry.dispose();
        if (geometry !== null) {
          const material = new THREE.MeshStandardMaterial({
            color: primitive.color,
            roughness: 0.5,
            metalness: 0,
            transparent: primitive.opacity < 1,
            opacity: primitive.opacity
          });
          const tube = new THREE.Mesh(geometry, material);
          tube.userData["ps3dConductorVisualization"] = true;
          tube.userData["semanticId"] = primitive.id;
          tube.userData["selectionKind"] = primitive.id.startsWith("component:") ? "component" : "body";
          tube.userData["baseColor"] = primitive.color;
          this.#addObject(tube, primitive.selectable);
          return;
        }
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = primitive.dashed
        ? new THREE.LineDashedMaterial({ color: primitive.color, transparent: true, opacity: primitive.opacity, dashSize: 0.004, gapSize: 0.002 })
        : new THREE.LineBasicMaterial({ color: primitive.color, transparent: true, opacity: primitive.opacity });
      const line = new THREE.Line(geometry, material);
      if (material instanceof THREE.LineDashedMaterial) line.computeLineDistances();
      this.#addObject(line, false);
      return;
    }
    let geometry: THREE.BufferGeometry;
    if (primitive.kind === "box") {
      geometry = new THREE.BoxGeometry(primitive.sizeMm[0] / 1000, primitive.sizeMm[1] / 1000, primitive.sizeMm[2] / 1000);
    } else if (primitive.kind === "cylinder") {
      geometry = new THREE.CylinderGeometry(primitive.radiusMm / 1000, primitive.radiusMm / 1000, primitive.heightMm / 1000, primitive.radialSegments);
      geometry.rotateX(Math.PI / 2);
    } else if (primitive.kind === "cone") {
      geometry = new THREE.CylinderGeometry(primitive.topRadiusMm / 1000, primitive.baseRadiusMm / 1000, primitive.heightMm / 1000, primitive.radialSegments);
      geometry.rotateX(Math.PI / 2);
    } else if (primitive.kind === "sphere") {
      geometry = new THREE.SphereGeometry(primitive.radiusMm / 1000, primitive.widthSegments, primitive.heightSegments);
    } else {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(primitive.positionsMm, (value) => value / 1000), 3));
      geometry.setIndex(Array.from(primitive.indices));
      geometry.computeVertexNormals();
    }
    const material = new THREE.MeshStandardMaterial({
      color: primitive.color,
      roughness: 0.52,
      metalness: 0.08,
      emissive: "#06182d",
      transparent: primitive.opacity < 1,
      opacity: primitive.opacity,
      side: primitive.kind === "mesh" && primitive.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      wireframe: primitive.kind === "mesh" && primitive.wireframe
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData["semanticId"] = primitive.id;
    mesh.userData["selectionKind"] = primitive.id.startsWith("component:") ? "component" : "body";
    mesh.userData["baseColor"] = primitive.color;
    if (primitive.kind === "mesh" && primitive.faceTriangles !== undefined) mesh.userData["faceTriangles"] = [...primitive.faceTriangles];
    if (primitive.kind !== "mesh") {
      mesh.position.set(primitive.positionMm[0] / 1000, primitive.positionMm[1] / 1000, primitive.positionMm[2] / 1000);
      const [x, y, z] = primitive.rotationDeg.map((value) => value * Math.PI / 180) as [number, number, number];
      mesh.rotation.set(x, y, z, primitive.rotationOrder ?? "XYZ");
    }
    this.#addObject(mesh, primitive.selectable);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: "#c7eff5", transparent: true, opacity: 0.42 }));
    edges.userData["ps3dExchangeHelper"] = true;
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    this.#addObject(edges, false);
  }
}

type Vec3Tuple = readonly [number, number, number];

function normalizeDegrees(value: number): number {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return Math.abs(wrapped + 180) < 1e-9 ? 180 : wrapped;
}

function normalize3(value: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(...value);
  return length < 1e-12 ? [0, 0, 0] : [value[0] / length, value[1] / length, value[2] / length];
}

function cross3(left: Vec3Tuple, right: Vec3Tuple): Vec3Tuple {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function dot3(left: Vec3Tuple, right: Vec3Tuple): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function projectAxis(axis: Vec3Tuple, right: Vec3Tuple, up: Vec3Tuple, backward: Vec3Tuple): ProjectedAxis {
  return { x: dot3(axis, right), y: -dot3(axis, up), depth: dot3(axis, backward) };
}
