import { useState, type CSSProperties } from "react";
import type {
  NavigationMode,
  SelectionFilter,
  ViewOrientation,
  ViewportMeasurePoint,
  ViewportBackgroundTone,
  ViewportShadingMode,
  ViewportViewState,
  ViewProjection
} from "../../../../packages/viewport-three/src/index.js";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { PartAppearanceControls } from "./PartAppearanceControls.js";

interface ViewportChromeProps {
  readonly workspace: Extract<WorkspaceId, "part" | "assembly" | "surface" | "vehicle">;
  readonly state: ViewportViewState;
  readonly measurePoints: readonly ViewportMeasurePoint[];
  readonly onNavigationMode: (mode: NavigationMode) => void;
  readonly onSelectionFilter: (filter: SelectionFilter) => void;
  readonly onOrientation: (orientation: Exclude<ViewOrientation, "custom">) => void;
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

const ORIENTATION_KEYS: readonly { readonly id: Exclude<ViewOrientation, "custom">; readonly label: string }[] = [
  { id: "front", label: "F" },
  { id: "back", label: "B" },
  { id: "left", label: "L" },
  { id: "right", label: "R" },
  { id: "top", label: "T" },
  { id: "bottom", label: "D" }
];

export function ViewportChrome(props: ViewportChromeProps): React.JSX.Element {
  const [displayOpen, setDisplayOpen] = useState(false);
  const delta = props.measurePoints.length === 2
    ? subtract(props.measurePoints[1]!.pointMm, props.measurePoints[0]!.pointMm)
    : undefined;
  const distance = delta === undefined ? undefined : Math.hypot(...delta);

  return <>
    <div className="viewport-controller" aria-label="Viewport navigation and selection controller">
      <div className="controller-group" aria-label="Navigation mode">
        <span>NAV</span>
        {(["select", "orbit", "pan", "measure"] as const).map((mode) => <button
          key={mode}
          className={props.state.navigationMode === mode ? "active" : ""}
          aria-pressed={props.state.navigationMode === mode}
          onClick={() => props.onNavigationMode(mode)}
          title={navigationTitle(mode)}
        ><CommandIcon name={mode} />{mode === "select" ? "Select" : mode === "measure" ? "Measure" : capitalize(mode)}</button>)}
      </div>
      <div className="controller-separator" />
      <div className="controller-group selection-priority" aria-label="Selection priority">
        <span>SELECT</span>
        <button className={props.state.selectionFilter === "auto" ? "active" : ""} aria-pressed={props.state.selectionFilter === "auto"} onClick={() => props.onSelectionFilter("auto")}><CommandIcon name="select" />Auto</button>
        <button className={props.state.selectionFilter === "body" ? "active" : ""} aria-pressed={props.state.selectionFilter === "body"} disabled={props.workspace === "assembly"} onClick={() => props.onSelectionFilter("body")}><CommandIcon name="part" />Body</button>
        <button className={props.state.selectionFilter === "component" ? "active" : ""} aria-pressed={props.state.selectionFilter === "component"} disabled={props.workspace !== "assembly"} onClick={() => props.onSelectionFilter("component")}><CommandIcon name="assembly" />Component</button>
        <button disabled title="Persistent face topology is not available in this mesh preview."><CommandIcon name="surface" />Face</button>
        <button disabled title="Persistent edge topology is not available in this mesh preview."><CommandIcon name="edge" />Edge</button>
      </div>
      <div className="controller-separator" />
      <div className="controller-group compact" aria-label="Projection mode">
        <span>VIEW</span>
        <button className={props.state.projection === "perspective" ? "active" : ""} aria-pressed={props.state.projection === "perspective"} onClick={() => props.onProjection("perspective")}><CommandIcon name="projection" />Perspective</button>
        <button className={props.state.projection === "orthographic" ? "active" : ""} aria-pressed={props.state.projection === "orthographic"} onClick={() => props.onProjection("orthographic")}><CommandIcon name="projection" />Ortho</button>
      </div>
    </div>

    <div className="viewbox" aria-label="Named view box">
      <button className={`viewbox-top ${props.state.orientation === "top" ? "active" : ""}`} onClick={() => props.onOrientation("top")}>TOP</button>
      <button className={`viewbox-front ${props.state.orientation === "front" ? "active" : ""}`} onClick={() => props.onOrientation("front")}>FRONT</button>
      <button className={`viewbox-right ${props.state.orientation === "right" ? "active" : ""}`} onClick={() => props.onOrientation("right")}>RIGHT</button>
      <button className={`viewbox-corner ${props.state.orientation === "isometric" ? "active" : ""}`} onClick={() => props.onOrientation("isometric")} title="Isometric home view">ISO</button>
      <div className="viewbox-more" aria-label="Additional named views">
        {ORIENTATION_KEYS.map((view) => <button key={view.id} className={props.state.orientation === view.id ? "active" : ""} onClick={() => props.onOrientation(view.id)} title={capitalize(view.id)}>{view.label}</button>)}
      </div>
      <small>{props.state.orientation === "custom" ? `${props.state.azimuthDeg}° / ${props.state.elevationDeg}°` : capitalize(props.state.orientation)}</small>
    </div>

    <AxisViewer state={props.state} />

    <div className="navigation-bar" aria-label="Viewport display controls">
      <button onClick={props.onHome} title="Fit and return to the isometric home view"><CommandIcon name="home" />Home</button>
      <button onClick={props.onFit} title="Fit all visible geometry (F)"><CommandIcon name="fit" />Fit</button>
      <button className={props.state.gridVisible ? "active" : ""} aria-pressed={props.state.gridVisible} onClick={() => props.onGrid(!props.state.gridVisible)}><CommandIcon name="grid" />Grid</button>
      <button className={props.state.axesVisible ? "active" : ""} aria-pressed={props.state.axesVisible} onClick={() => props.onAxes(!props.state.axesVisible)}><CommandIcon name="axes" />Axes</button>
      {props.workspace === "part" && <button
        className={displayOpen ? "active" : ""}
        aria-expanded={displayOpen}
        aria-controls="part-display-popover"
        onClick={() => setDisplayOpen((open) => !open)}
        title="Part display style and body color"
      ><CommandIcon name="display" />Display</button>}
      <span>MMB pan · Shift+MMB orbit · wheel zoom</span>
    </div>

    {props.workspace === "part" && displayOpen && <aside id="part-display-popover" className="display-popover" aria-label="Part display settings">
      <header><div><span>DISPLAY SETTINGS</span><strong>Part appearance</strong></div><button onClick={() => setDisplayOpen(false)} aria-label="Close display settings"><CommandIcon name="cancel" /></button></header>
      <PartAppearanceControls compact bodyColor={props.state.bodyColor} shadingMode={props.state.shadingMode} onBodyColor={props.onBodyColor} onShadingMode={props.onShadingMode} />
      <fieldset className="background-tone-controls"><legend>Viewport background</legend>{(["charcoal", "dark-gray", "light-gray", "white"] as const).map((tone) => <button key={tone} className={props.state.backgroundTone === tone ? "active" : ""} aria-pressed={props.state.backgroundTone === tone} onClick={() => props.onBackgroundTone(tone)}><i data-tone={tone} />{tone.replace("-", " ")}</button>)}</fieldset>
      <small>Display-only settings do not change qualified geometry or mass properties.</small>
    </aside>}

    {props.state.navigationMode === "measure" && <aside className="measure-panel" aria-label="Point to point measurement">
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

function AxisViewer({ state }: { readonly state: ViewportViewState }): React.JSX.Element {
  const style = { "--axis-yaw": `${-state.azimuthDeg}deg`, "--axis-tilt": `${state.elevationDeg}deg` } as CSSProperties;
  return <div className="axis-viewer" style={style} aria-label={`Axis viewer, azimuth ${state.azimuthDeg} degrees, elevation ${state.elevationDeg} degrees`}>
    <div className="axis-plane"><i className="axis-x" /><i className="axis-y" /><b>X</b><em>Y</em></div>
    <i className="axis-z" /><strong>Z</strong><span>WCS</span>
  </div>;
}

function navigationTitle(mode: NavigationMode): string {
  if (mode === "orbit") return "Left drag to orbit; right drag or Shift+middle also orbits.";
  if (mode === "pan") return "Left drag to pan; middle drag pans from any mode.";
  if (mode === "measure") return "Pick two model points for XYZ delta and distance.";
  return "Click visible model objects to select them.";
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
