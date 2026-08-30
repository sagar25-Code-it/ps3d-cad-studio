import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cloneExchangeObject, disposeExchangeObject, inspectExchangeObject, type ExchangeBounds, type ViewportJpeg } from "../../exchange-3d/src/index.js";
import type { ModelSuccessResponse } from "../../worker-protocol/src/index.js";
import type { PreviewBounds, PreviewPrimitive, PreviewScene } from "../../workbench-geometry/src/index.js";

export interface ViewportOptions {
  readonly onSelectBody: (bodyId: string | null) => void;
  readonly onViewChange?: (state: ViewportViewState) => void;
  readonly onMeasurePoint?: (point: ViewportMeasurePoint) => void;
  readonly onContextMenu?: (request: ViewportContextMenuRequest) => void;
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
export type SelectionFilter = "auto" | "body" | "component" | "sketch-curve" | "profile" | "connected" | "tangent";
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
}

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
  isometric: [45, Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI]
};

export function viewAnglesForOrientation(orientation: Exclude<ViewOrientation, "custom">): readonly [number, number] {
  return ORIENTATION_ANGLES[orientation];
}

/** Fusion-style drag convention: right drag rotates the view to the right; up drag raises it. */
export function orbitViewAngles(azimuthDeg: number, elevationDeg: number, deltaX: number, deltaY: number, degreesPerPixel = 0.46): readonly [number, number] {
  const azimuth = normalizeDegrees(azimuthDeg + deltaX * degreesPerPixel);
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
  const boundedMaximum = Number.isFinite(maxExplodeMm) ? THREE.MathUtils.clamp(maxExplodeMm, 1, 200) : 120;
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
  readonly #pickable: THREE.Object3D[] = [];
  #bodyId: string | undefined;
  #selectedId: string | undefined;
  #azimuth = Math.PI / 4;
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
    this.#canvas.style.cursor = mode === "orbit" ? "grab" : mode === "pan" ? "move" : mode === "measure" ? "crosshair" : "default";
    this.#emitViewState();
  }

  setSelectionFilter(filter: SelectionFilter): void {
    this.#selectionFilter = filter;
    this.#emitViewState();
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

  setScene(scene: PreviewScene): void {
    this.#clearBody();
    for (const primitive of scene.primitives) this.#addPrimitive(primitive);
    this.#bodyId = undefined;
    this.fitPreview(scene.boundsMm);
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
    this.#bodyId = undefined;
    this.fitExchange(inspectExchangeObject(root).bounds);
  }

  snapshotExchangeObject(): THREE.Object3D {
    const snapshot = cloneExchangeObject(this.#bodyGroup);
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
    this.#canvas.removeEventListener("wheel", this.#onWheel);
    this.#canvas.removeEventListener("contextmenu", this.#onContextMenu);
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
    if (this.#drag === undefined || this.#drag.pointerId !== event.pointerId) return;
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
    if (this.#drag !== undefined && this.#drag.pointerId === event.pointerId && !this.#drag.moved) {
      if (this.#drag.mode === "select") this.#pick(event);
      if (this.#drag.mode === "measure") this.#measurePick(event);
    }
    if (this.#drag?.pointerId === event.pointerId) this.#drag = undefined;
    if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.#radius = THREE.MathUtils.clamp(this.#radius * Math.exp(event.deltaY * 0.001), 0.0001, 10_000);
    this.#updateCamera();
  };

  readonly #onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
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
    this.#options.onMeasurePoint?.({ pointMm: [hit.point.x * 1000, hit.point.y * 1000, hit.point.z * 1000], semanticId });
  }

  #selectionAllows(object: THREE.Object3D): boolean {
    if (this.#selectionFilter === "auto") return true;
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
    for (const object of this.#objects) {
      this.#bodyGroup.remove(object);
      disposeExchangeObject(object);
    }
    this.#objects.length = 0;
    this.#pickable.length = 0;
    this.#selectedId = undefined;
    this.#qualifiedBody = undefined;
    this.#qualifiedEdges = undefined;
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
          this.#addObject(tube, false);
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
