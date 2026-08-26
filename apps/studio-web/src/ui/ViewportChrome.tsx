import { useRef, useState } from "react";
import {
  orbitViewAngles,
  projectWorldAxes,
  type NavigationMode,
  type SelectionFilter,
  type ViewOrientation,
  type ViewportMeasurePoint,
  type ViewportBackgroundTone,
  type ViewportShadingMode,
  type ViewportViewState,
  type ViewProjection
} from "../../../../packages/viewport-three/src/index.js";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { PartAppearanceControls } from "./PartAppearanceControls.js";

interface ViewportChromeProps {
  readonly workspace: Extract<WorkspaceId, "sketch" | "part" | "assembly" | "surface" | "vehicle">;
  readonly state: ViewportViewState;
  readonly measurePoints: readonly ViewportMeasurePoint[];
  readonly onNavigationMode: (mode: NavigationMode) => void;
  readonly onSelectionFilter: (filter: SelectionFilter) => void;
  readonly onOrientation: (orientation: Exclude<ViewOrientation, "custom">) => void;
  readonly onViewAngles: (azimuthDeg: number, elevationDeg: number) => void;
  readonly onProjection: (projection: ViewProjection) => void;
  readonly onGrid: (visible: boolean) => void;
  readonly onAxes: (visible: boolean) => void;
  readonly onShadingMode: (mode: ViewportShadingMode) => void;
  readonly onBodyColor: (color: string) => void;
  readonly onBackgroundTone: (tone: ViewportBackgroundTone) => void;
  readonly onFit: () => void;
  readonly onHome: () => void;
  readonly onClearMeasure: () => void;
}

type Vec3 = readonly [number, number, number];

const ORIENTATION_KEYS: readonly { readonly id: Exclude<ViewOrientation, "custom">; readonly label: string }[] = [
  { id: "front", label: "F" },
  { id: "back", label: "B" },
  { id: "left", label: "L" },
  { id: "right", label: "R" },
  { id: "top", label: "T" },
  { id: "bottom", label: "D" }
];

const CUBE_FACES: readonly {
  readonly id: Exclude<ViewOrientation, "custom" | "isometric">;
  readonly label: string;
  readonly normal: Vec3;
  readonly corners: readonly Vec3[];
}[] = [
  { id: "right", label: "RIGHT", normal: [1, 0, 0], corners: [[1, 1, 1], [1, -1, 1], [1, -1, -1], [1, 1, -1]] },
  { id: "left", label: "LEFT", normal: [-1, 0, 0], corners: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { id: "front", label: "FRONT", normal: [0, -1, 0], corners: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { id: "back", label: "BACK", normal: [0, 1, 0], corners: [[1, 1, 1], [1, 1, -1], [-1, 1, -1], [-1, 1, 1]] },
  { id: "top", label: "TOP", normal: [0, 0, 1], corners: [[-1, 1, 1], [-1, -1, 1], [1, -1, 1], [1, 1, 1]] },
  { id: "bottom", label: "BOTTOM", normal: [0, 0, -1], corners: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] }
];

const CUBE_VERTICES: readonly Vec3[] = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z] as const)));
const CUBE_EDGES = CUBE_VERTICES.flatMap((vertex, index) => CUBE_VERTICES.slice(index + 1).flatMap((other, offset) => differenceCount(vertex, other) === 1 ? [[index, index + offset + 1] as const] : []));

export function ViewportChrome(props: ViewportChromeProps): React.JSX.Element {
  const [displayOpen, setDisplayOpen] = useState(false);
  const delta = props.measurePoints.length === 2
    ? subtract(props.measurePoints[1]!.pointMm, props.measurePoints[0]!.pointMm)
    : undefined;
  const distance = delta === undefined ? undefined : Math.hypot(...delta);
  const sketch = props.workspace === "sketch";

  return <>
    <div className="viewport-controller" aria-label="Viewport navigation and selection controller">
      <div className="controller-group" aria-label="Navigation mode">
        <span>NAV</span>
        {(["select", "orbit", "pan", "measure"] as const)
          .filter((mode) => !sketch || mode !== "measure")
          .map((mode) => <button
          key={mode}
          className={props.state.navigationMode === mode ? "active" : ""}
          aria-pressed={props.state.navigationMode === mode}
          onClick={() => props.onNavigationMode(mode)}
          title={navigationTitle(mode, sketch)}
        ><CommandIcon name={mode} />{mode === "select" ? "Select" : mode === "measure" ? "Measure" : capitalize(mode)}</button>)}
      </div>
      <div className="controller-separator" />
      <div className="controller-group selection-priority" aria-label="Selection intent">
        <span>SELECT</span>
        {sketch ? <>
          <SelectionButton id="auto" label="Auto" icon="select" state={props.state} onSelect={props.onSelectionFilter} />
          <SelectionButton id="profile" label="Profile" icon="profile" state={props.state} onSelect={props.onSelectionFilter} />
          <SelectionButton id="sketch-curve" label="Curve" icon="sketch" state={props.state} onSelect={props.onSelectionFilter} />
          <SelectionButton id="connected" label="Connected" icon="chain" state={props.state} onSelect={props.onSelectionFilter} />
          <SelectionButton id="tangent" label="Tangent" icon="tangent" state={props.state} onSelect={props.onSelectionFilter} />
        </> : <>
          <SelectionButton id="auto" label="Auto" icon="select" state={props.state} onSelect={props.onSelectionFilter} />
          <SelectionButton id="body" label="Body" icon="part" state={props.state} onSelect={props.onSelectionFilter} disabled={props.workspace === "assembly"} />
          <SelectionButton id="component" label="Component" icon="assembly" state={props.state} onSelect={props.onSelectionFilter} disabled={props.workspace !== "assembly"} />
          <button disabled title="Persistent face topology is not available in this bounded mesh kernel."><CommandIcon name="surface" />Face</button>
          <button disabled title="Persistent edge topology is not available in this bounded mesh kernel."><CommandIcon name="edge" />Edge</button>
        </>}
      </div>
      <div className="controller-separator" />
      <div className="controller-group compact" aria-label="Projection mode">
        <span>VIEW</span>
        <button className={props.state.projection === "perspective" ? "active" : ""} aria-pressed={props.state.projection === "perspective"} onClick={() => props.onProjection("perspective")}><CommandIcon name="projection" />Perspective</button>
        <button className={props.state.projection === "orthographic" ? "active" : ""} aria-pressed={props.state.projection === "orthographic"} onClick={() => props.onProjection("orthographic")}><CommandIcon name="projection" />Ortho</button>
      </div>
    </div>

    <ViewCube state={props.state} onOrientation={props.onOrientation} onViewAngles={props.onViewAngles} />
    <AxisViewer state={props.state} />

    <div className="navigation-bar" aria-label="Viewport display controls">
      <button onClick={props.onHome} title="Fit and return to the isometric home view"><CommandIcon name="home" />Home</button>
      <button onClick={props.onFit} title="Fit all visible geometry (F)"><CommandIcon name="fit" />Fit</button>
      {sketch && <button onClick={() => props.onOrientation("top")} title="Look normal to the active XY sketch plane"><CommandIcon name="view" />Look At</button>}
      <button className={props.state.gridVisible ? "active" : ""} aria-pressed={props.state.gridVisible} onClick={() => props.onGrid(!props.state.gridVisible)}><CommandIcon name="grid" />Grid</button>
      <button className={props.state.axesVisible ? "active" : ""} aria-pressed={props.state.axesVisible} onClick={() => props.onAxes(!props.state.axesVisible)}><CommandIcon name="axes" />Axes</button>
      {props.workspace === "part" && <button
        className={displayOpen ? "active" : ""}
        aria-expanded={displayOpen}
        aria-controls="part-display-popover"
        onClick={() => setDisplayOpen((open) => !open)}
        title="Part display style and body color"
      ><CommandIcon name="display" />Display</button>}
      <span>MMB pan · Shift+MMB orbit · wheel zoom · RMB commands</span>
    </div>

    {props.workspace === "part" && displayOpen && <aside id="part-display-popover" className="display-popover" aria-label="Part display settings">
      <header><div><span>DISPLAY SETTINGS</span><strong>Part appearance</strong></div><button onClick={() => setDisplayOpen(false)} aria-label="Close display settings"><CommandIcon name="cancel" /></button></header>
      <PartAppearanceControls compact bodyColor={props.state.bodyColor} shadingMode={props.state.shadingMode} onBodyColor={props.onBodyColor} onShadingMode={props.onShadingMode} />
      <fieldset className="background-tone-controls"><legend>Viewport background</legend>{(["charcoal", "dark-gray", "light-gray", "white"] as const).map((tone) => <button key={tone} className={props.state.backgroundTone === tone ? "active" : ""} aria-pressed={props.state.backgroundTone === tone} onClick={() => props.onBackgroundTone(tone)}><i data-tone={tone} />{tone.replace("-", " ")}</button>)}</fieldset>
      <small>Display-only settings do not change qualified geometry or mass properties.</small>
    </aside>}

    {props.state.navigationMode === "measure" && !sketch && <aside className="measure-panel" aria-label="Point to point measurement">
      <header><div><span>INSPECT</span><strong><CommandIcon name="measure" />Measure</strong></div><button onClick={props.onClearMeasure}><CommandIcon name="cancel" />Clear</button></header>
      <p>{props.measurePoints.length === 0 ? "Pick the first model point." : props.measurePoints.length === 1 ? "Pick the second model point." : "Two-point result"}</p>
      <div className="measure-points">
        {[0, 1].map((index) => <div key={index}><span>P{index + 1}</span><code>{props.measurePoints[index] === undefined ? "—" : vector(props.measurePoints[index]!.pointMm)}</code></div>)}
      </div>
      {delta !== undefined && distance !== undefined && <dl className="measure-result">
        <div><dt>Distance</dt><dd>{format(distance)} mm</dd></div>
        <div><dt>ΔX</dt><dd>{format(delta[0])}</dd></div>
        <div><dt>ΔY</dt><dd>{format(delta[1])}</dd></div>
        <div><dt>ΔZ</dt><dd>{format(delta[2])}</dd></div>
      </dl>}
      <small>Triangle-ray intersection · preview measurement</small>
    </aside>}
  </>;
}

function SelectionButton({ id, label, icon, state, onSelect, disabled = false }: { readonly id: SelectionFilter; readonly label: string; readonly icon: string; readonly state: ViewportViewState; readonly onSelect: (filter: SelectionFilter) => void; readonly disabled?: boolean }): React.JSX.Element {
  return <button className={state.selectionFilter === id ? "active" : ""} aria-pressed={state.selectionFilter === id} disabled={disabled} onClick={() => onSelect(id)}><CommandIcon name={icon} />{label}</button>;
}

function ViewCube({ state, onOrientation, onViewAngles }: { readonly state: ViewportViewState; readonly onOrientation: (orientation: Exclude<ViewOrientation, "custom">) => void; readonly onViewAngles: (azimuthDeg: number, elevationDeg: number) => void }): React.JSX.Element {
  const basis = projectWorldAxes(state.azimuthDeg, state.elevationDeg);
  const drag = useRef<{ readonly pointerId: number; readonly x: number; readonly y: number; readonly azimuth: number; readonly elevation: number; moved: boolean } | undefined>(undefined);
  const suppressClick = useRef(false);
  const projected = CUBE_VERTICES.map((vertex) => projectVertex(vertex, basis));
  const visibleFaces = CUBE_FACES
    .map((face) => ({ ...face, depth: face.normal[0] * basis.x.depth + face.normal[1] * basis.y.depth + face.normal[2] * basis.z.depth }))
    .filter((face) => face.depth > 0.012)
    .sort((left, right) => left.depth - right.depth);
  const chooseDirection = (direction: Vec3): void => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const length = Math.hypot(...direction);
    onViewAngles(Math.atan2(direction[1], direction[0]) * 180 / Math.PI, Math.asin(direction[2] / length) * 180 / Math.PI);
  };
  return <div className="viewbox" aria-label="Camera-synchronized ViewCube">
    <svg className="viewcube-svg" viewBox="-1.55 -1.55 3.1 3.1" role="img" aria-label={`ViewCube at ${state.azimuthDeg} degree azimuth and ${state.elevationDeg} degree elevation`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, azimuth: state.azimuthDeg, elevation: state.elevationDeg, moved: false };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === undefined || current.pointerId !== event.pointerId) return;
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        if (Math.hypot(dx, dy) > 3) current.moved = true;
        if (!current.moved) return;
        suppressClick.current = true;
        const [azimuth, elevation] = orbitViewAngles(current.azimuth, current.elevation, dx, dy, 0.55);
        onViewAngles(azimuth, elevation);
      }}
      onPointerUp={(event) => {
        if (drag.current?.moved !== true) suppressClick.current = false;
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = undefined; suppressClick.current = false; }}>
      {visibleFaces.map((face) => {
        const points = face.corners.map((corner) => pointText(projectVertex(corner, basis))).join(" ");
        const center = face.corners.map((corner) => projectVertex(corner, basis)).reduce((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4] as const, [0, 0] as const);
        return <g key={face.id} className={`viewcube-face ${state.orientation === face.id ? "active" : ""}`} onClick={() => { if (!suppressClick.current) onOrientation(face.id); else suppressClick.current = false; }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOrientation(face.id); } }} role="button" tabIndex={0} aria-label={`${face.label} view`}>
          <polygon points={points} />
          {face.depth > 0.3 && <text x={center[0]} y={center[1] + 0.055}>{face.label}</text>}
        </g>;
      })}
      {CUBE_EDGES.map(([first, second]) => {
        const left = projected[first]!;
        const right = projected[second]!;
        const direction = add3(CUBE_VERTICES[first]!, CUBE_VERTICES[second]!);
        return <line key={`${first}:${second}`} className="viewcube-edge" x1={left[0]} y1={left[1]} x2={right[0]} y2={right[1]} data-direction={`${direction[0]},${direction[1]},${direction[2]}`} />;
      })}
      {projected.map((point, index) => <rect key={index} className="viewcube-corner" x={point[0] - 0.085} y={point[1] - 0.085} width="0.17" height="0.17" rx="0.035" onClick={() => chooseDirection(CUBE_VERTICES[index]!)} />)}
    </svg>
    <button className={`viewcube-home ${state.orientation === "isometric" ? "active" : ""}`} onClick={() => onOrientation("isometric")} title="Isometric home view">HOME</button>
    <div className="viewbox-more" aria-label="Standard named views">
      {ORIENTATION_KEYS.map((view) => <button key={view.id} className={state.orientation === view.id ? "active" : ""} onClick={() => onOrientation(view.id)} title={capitalize(view.id)}>{view.label}</button>)}
    </div>
    <small>{state.orientation === "custom" ? `${state.azimuthDeg}° / ${state.elevationDeg}°` : capitalize(state.orientation)}</small>
  </div>;
}

function AxisViewer({ state }: { readonly state: ViewportViewState }): React.JSX.Element {
  const basis = projectWorldAxes(state.azimuthDeg, state.elevationDeg);
  const axes = [
    { id: "X", axis: basis.x, color: "#e64646" },
    { id: "Y", axis: basis.y, color: "#2ca76c" },
    { id: "Z", axis: basis.z, color: "#267de0" }
  ].sort((left, right) => left.axis.depth - right.axis.depth);
  return <div className="axis-viewer" aria-label={`WCS axis viewer synchronized to camera, azimuth ${state.azimuthDeg} degrees, elevation ${state.elevationDeg} degrees`}>
    <svg viewBox="0 0 72 72" aria-hidden="true">
      <circle className="axis-origin" cx="36" cy="36" r="2.6" />
      {axes.map(({ id, axis, color }) => {
        const x = 36 + axis.x * 24;
        const y = 36 + axis.y * 24;
        return <g key={id} className={`wcs-axis ${axis.depth >= 0 ? "near" : "far"}`}><line x1="36" y1="36" x2={x} y2={y} stroke={color} /><circle cx={x} cy={y} r="2.2" fill={color} /><text x={x + (axis.x >= 0 ? 4 : -4)} y={y + (axis.y >= 0 ? 7 : -4)} fill={color}>{id}</text></g>;
      })}
    </svg>
    <span>WCS · Z UP</span>
  </div>;
}

function projectVertex(vertex: Vec3, basis: ReturnType<typeof projectWorldAxes>): readonly [number, number] {
  const scale = 0.72;
  return [
    (vertex[0] * basis.x.x + vertex[1] * basis.y.x + vertex[2] * basis.z.x) * scale,
    (vertex[0] * basis.x.y + vertex[1] * basis.y.y + vertex[2] * basis.z.y) * scale
  ];
}

function pointText(point: readonly [number, number]): string { return `${point[0]},${point[1]}`; }
function differenceCount(left: Vec3, right: Vec3): number { return left.filter((value, index) => value !== right[index]).length; }
function add3(left: Vec3, right: Vec3): Vec3 { return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]; }

function navigationTitle(mode: NavigationMode, sketch: boolean): string {
  if (mode === "orbit") return sketch ? "Drag to orbit the camera around the active sketch plane; geometry remains on XY." : "Left drag or Shift+middle drag to orbit.";
  if (mode === "pan") return "Left drag to pan; middle drag pans from any mode.";
  if (mode === "measure") return "Pick two model points for XYZ delta and distance.";
  return "Click visible geometry to select it; right-click opens contextual commands.";
}

function subtract(right: readonly [number, number, number], left: readonly [number, number, number]): readonly [number, number, number] {
  return [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
}

function vector(value: readonly [number, number, number]): string {
  return `${format(value[0])}, ${format(value[1])}, ${format(value[2])} mm`;
}

function format(value: number): string {
  return Number(value.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
