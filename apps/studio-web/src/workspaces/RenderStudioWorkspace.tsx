import type { RefObject } from "react";
import type { WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { ViewOrientation, ViewProjection } from "../../../../packages/viewport-three/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

export type RenderSource = "part" | "assembly" | "surface" | "vehicle";
export type RenderEnvironment = "softbox" | "daylight" | "graphite" | "white-cyclorama" | "warm-studio";
export type RenderMaterialPreset = "original" | "machined-aluminum" | "brushed-steel" | "painted-red" | "technical-plastic" | "satin-black";
export type RenderImageFormat = "jpeg" | "png";
export type RenderResolution = "1280x720" | "1920x1080" | "2048x2048" | "2560x1440" | "3840x2160";

export interface RenderStudioSettings {
  readonly source: RenderSource;
  readonly environment: RenderEnvironment;
  readonly materialPreset: RenderMaterialPreset;
  readonly bodyColor: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly exposure: number;
  readonly keyIntensity: number;
  readonly fillIntensity: number;
  readonly rimIntensity: number;
  readonly groundVisible: boolean;
  readonly projection: ViewProjection;
  readonly orientation: Exclude<ViewOrientation, "custom">;
  readonly format: RenderImageFormat;
  readonly resolution: RenderResolution;
  readonly quality: number;
}

export interface RenderGalleryEntry {
  readonly id: string;
  readonly fileName: string;
  readonly width: number;
  readonly height: number;
  readonly format: RenderImageFormat;
  readonly createdAt: string;
  readonly destination: "workspace" | "download";
}

interface RenderStudioWorkspaceProps {
  readonly project: WorkbenchProject;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly settings: RenderStudioSettings;
  readonly gallery: readonly RenderGalleryEntry[];
  readonly busy: boolean;
  readonly onSettings: (settings: RenderStudioSettings) => void;
  readonly onFit: () => void;
  readonly onRender: () => void;
  readonly onClose: () => void;
}

export const DEFAULT_RENDER_SETTINGS: RenderStudioSettings = {
  source: "part",
  environment: "softbox",
  materialPreset: "machined-aluminum",
  bodyColor: "#aeb6bd",
  roughness: 0.34,
  metalness: 0.72,
  exposure: 1,
  keyIntensity: 2.45,
  fillIntensity: 0.78,
  rimIntensity: 1.1,
  groundVisible: true,
  projection: "perspective",
  orientation: "isometric",
  format: "png",
  resolution: "1920x1080",
  quality: 0.94
};

const MATERIALS: readonly { readonly id: RenderMaterialPreset; readonly label: string; readonly color: string; readonly roughness: number; readonly metalness: number }[] = [
  { id: "original", label: "Model colors", color: "#aeb3b8", roughness: 0.52, metalness: 0.08 },
  { id: "machined-aluminum", label: "Machined aluminum", color: "#b8c0c7", roughness: 0.28, metalness: 0.82 },
  { id: "brushed-steel", label: "Brushed steel", color: "#8e989f", roughness: 0.38, metalness: 0.9 },
  { id: "painted-red", label: "Painted red", color: "#a7222e", roughness: 0.22, metalness: 0.1 },
  { id: "technical-plastic", label: "Technical plastic", color: "#d4d6d7", roughness: 0.48, metalness: 0.02 },
  { id: "satin-black", label: "Satin black", color: "#20262b", roughness: 0.42, metalness: 0.16 }
];

const ENVIRONMENTS: readonly { readonly id: RenderEnvironment; readonly label: string; readonly swatch: string }[] = [
  { id: "softbox", label: "Neutral softbox", swatch: "linear-gradient(135deg,#eef3f6,#60707d)" },
  { id: "daylight", label: "Daylight", swatch: "linear-gradient(135deg,#dff2ff,#6e91ae)" },
  { id: "graphite", label: "Graphite studio", swatch: "linear-gradient(135deg,#313942,#090c0f)" },
  { id: "white-cyclorama", label: "White cyclorama", swatch: "linear-gradient(135deg,#fff,#cfd5d9)" },
  { id: "warm-studio", label: "Warm studio", swatch: "linear-gradient(135deg,#ffe1b2,#5b4032)" }
];

export function RenderStudioWorkspace(props: RenderStudioWorkspaceProps): React.JSX.Element {
  const set = <K extends keyof RenderStudioSettings>(key: K, value: RenderStudioSettings[K]): void => props.onSettings({ ...props.settings, [key]: value });
  const material = MATERIALS.find((candidate) => candidate.id === props.settings.materialPreset) ?? MATERIALS[0]!;
  const counts = sourceCounts(props.project, props.settings.source);

  return <section className="render-studio-workspace" aria-label="PS3D Render Studio">
    <header className="render-studio-ribbon">
      <div className="render-context"><small>ACTIVE WORKSPACE</small><strong>Render Studio</strong><CapabilityBadge level="preview" /></div>
      <RenderRibbonGroup label="Scene">
        <RenderButton icon="insert" label="Linked model" hint={sourceLabel(props.settings.source)} active />
        <RenderButton icon="fit" label="Fit scene" hint="F" onClick={props.onFit} />
        <RenderButton icon="home" label="Isometric" hint="Home" onClick={() => set("orientation", "isometric")} />
      </RenderRibbonGroup>
      <RenderRibbonGroup label="Appearance">
        <RenderButton icon="appearance" label="Material" hint={material.label} active />
        <RenderButton icon="display" label="Environment" hint={environmentLabel(props.settings.environment)} active />
        <RenderButton icon="shaded" label="ACES preview" hint="real-time" active />
      </RenderRibbonGroup>
      <RenderRibbonGroup label="Output">
        <RenderButton icon="appearance" label={props.busy ? "Rendering…" : "Render image"} hint={props.settings.resolution} disabled={props.busy} primary onClick={props.onRender} />
        <RenderButton icon="return" label="Return to Design" hint="Esc" onClick={props.onClose} />
      </RenderRibbonGroup>
    </header>

    <div className="render-studio-grid">
      <aside className="render-scene-browser">
        <header><small>SCENE</small><strong>{props.project.name}</strong><span>linked revision {props.project.revision}</span></header>
        <label className="render-source-select"><span>Source model</span><select value={props.settings.source} onChange={(event) => set("source", event.target.value as RenderSource)}><option value="part">Part Studio</option><option value="assembly">Assembly</option><option value="surface">Surface</option><option value="vehicle">Vehicle study</option></select></label>
        <div className="render-tree">
          <TreeRow icon="assembly" label={sourceLabel(props.settings.source)} value={`${counts.primary} items`} level={0} open />
          <TreeRow icon="part" label="Geometry" value={`${counts.geometry} visible`} level={1} open />
          <TreeRow icon="appearance" label="Material assignment" value={material.label} level={1} />
          <TreeRow icon="display" label="Environment" value={environmentLabel(props.settings.environment)} level={1} />
          <TreeRow icon="view" label="Camera 01" value={props.settings.projection} level={1} />
          <TreeRow icon="shaded" label="Ground plane" value={props.settings.groundVisible ? "visible" : "hidden"} level={1} />
        </div>
        <div className="render-scene-status"><span><i />Linked</span><p>Scene updates from the current in-memory PS3D project. Render settings do not alter engineering geometry.</p></div>
      </aside>

      <section className="render-viewport-shell">
        <div className="render-viewport-toolbar">
          <div><span>NAV</span><button title="Orbit with middle mouse drag"><CommandIcon name="orbit" />Orbit</button><button title="Pan with Shift + middle mouse drag"><CommandIcon name="pan" />Pan</button><button onClick={props.onFit}><CommandIcon name="fit" />Fit</button></div>
          <div><span>CAMERA</span><button className={props.settings.projection === "perspective" ? "active" : ""} onClick={() => set("projection", "perspective")}>Perspective</button><button className={props.settings.projection === "orthographic" ? "active" : ""} onClick={() => set("projection", "orthographic")}>Ortho</button></div>
        </div>
        <canvas ref={props.canvasRef} className="render-canvas" role="img" aria-label={`Real-time ${props.settings.source} render preview`} />
        <div className="render-preview-badge"><span><i />REAL-TIME</span><strong>ACES studio preview</strong><small>Raster preview · not a path-traced manufacturing truth source</small></div>
        <div className="render-view-presets" aria-label="Render camera views">{(["front", "right", "top", "isometric"] as const).map((orientation) => <button key={orientation} className={props.settings.orientation === orientation ? "active" : ""} onClick={() => set("orientation", orientation)}>{orientation === "isometric" ? "ISO" : orientation.slice(0, 1).toUpperCase()}</button>)}</div>
      </section>

      <aside className="render-properties">
        <header><small>RENDER PROPERTIES</small><strong>Scene 01</strong><span>quality-controlled local output</span></header>
        <details open><summary>Material &amp; finish</summary><div className="render-property-content">
          <div className="material-preset-grid">{MATERIALS.map((preset) => <button key={preset.id} className={props.settings.materialPreset === preset.id ? "active" : ""} title={preset.label} onClick={() => props.onSettings({ ...props.settings, materialPreset: preset.id, bodyColor: preset.color, roughness: preset.roughness, metalness: preset.metalness })}><i style={{ background: preset.color }} /><span>{preset.label}</span></button>)}</div>
          <label><span>Body color</span><input type="color" value={props.settings.bodyColor} onChange={(event) => set("bodyColor", event.target.value)} /></label>
          <RangeControl label="Roughness" value={props.settings.roughness} min={0.04} max={1} step={0.01} onChange={(value) => set("roughness", value)} />
          <RangeControl label="Metalness" value={props.settings.metalness} min={0} max={1} step={0.01} onChange={(value) => set("metalness", value)} />
        </div></details>
        <details open><summary>Environment &amp; lighting</summary><div className="render-property-content">
          <div className="environment-grid">{ENVIRONMENTS.map((environment) => <button key={environment.id} className={props.settings.environment === environment.id ? "active" : ""} onClick={() => set("environment", environment.id)}><i style={{ background: environment.swatch }} /><span>{environment.label}</span></button>)}</div>
          <RangeControl label="Exposure" value={props.settings.exposure} min={0.35} max={2.2} step={0.05} onChange={(value) => set("exposure", value)} />
          <RangeControl label="Key light" value={props.settings.keyIntensity} min={0} max={5} step={0.05} onChange={(value) => set("keyIntensity", value)} />
          <RangeControl label="Fill light" value={props.settings.fillIntensity} min={0} max={3} step={0.05} onChange={(value) => set("fillIntensity", value)} />
          <RangeControl label="Rim light" value={props.settings.rimIntensity} min={0} max={3} step={0.05} onChange={(value) => set("rimIntensity", value)} />
          <label className="render-checkbox"><input type="checkbox" checked={props.settings.groundVisible} onChange={(event) => set("groundVisible", event.target.checked)} /><span>Ground plane and contact shadow</span></label>
        </div></details>
        <details open><summary>Output</summary><div className="render-property-content output-controls">
          <label><span>Resolution</span><select value={props.settings.resolution} onChange={(event) => set("resolution", event.target.value as RenderResolution)}><option value="1280x720">1280 × 720 · HD</option><option value="1920x1080">1920 × 1080 · Full HD</option><option value="2048x2048">2048 × 2048 · Square</option><option value="2560x1440">2560 × 1440 · QHD</option><option value="3840x2160">3840 × 2160 · 4K</option></select></label>
          <label><span>Format</span><select value={props.settings.format} onChange={(event) => set("format", event.target.value as RenderImageFormat)}><option value="png">PNG · lossless</option><option value="jpeg">JPEG · compact</option></select></label>
          <RangeControl label="Quality" value={props.settings.quality} min={0.5} max={1} step={0.01} onChange={(value) => set("quality", value)} />
          <button className="render-now" disabled={props.busy} onClick={props.onRender}><CommandIcon name="appearance" />{props.busy ? "Rendering image…" : "Render image"}<small>{props.settings.resolution} · {props.settings.format.toUpperCase()}</small></button>
        </div></details>
      </aside>

      <section className="render-gallery">
        <header><div><small>RENDER GALLERY</small><strong>Session output</strong></div><span>{props.gallery.length} image{props.gallery.length === 1 ? "" : "s"}</span></header>
        <div>{props.gallery.map((entry) => <article key={entry.id}><span><CommandIcon name="appearance" /></span><div><strong>{entry.fileName}</strong><small>{entry.width} × {entry.height} · {entry.format.toUpperCase()} · {entry.destination}</small></div><time>{new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>)}{props.gallery.length === 0 && <p><CommandIcon name="appearance" />Rendered images from this session appear here and save to the Renders folder when connected.</p>}</div>
      </section>
    </div>
  </section>;
}

function RenderRibbonGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element { return <div className="render-ribbon-group"><div>{children}</div><small>{label}</small></div>; }
function RenderButton({ icon, label, hint, active = false, disabled = false, primary = false, onClick }: { readonly icon: string; readonly label: string; readonly hint: string; readonly active?: boolean; readonly disabled?: boolean; readonly primary?: boolean; readonly onClick?: () => void }): React.JSX.Element { return <button className={`${active ? "active" : ""} ${primary ? "primary" : ""}`.trim()} disabled={disabled} onClick={onClick}><span><CommandIcon name={icon} /></span><strong>{label}</strong><small>{hint}</small></button>; }
function TreeRow({ icon, label, value, level, open = false }: { readonly icon: string; readonly label: string; readonly value: string; readonly level: number; readonly open?: boolean }): React.JSX.Element { return <button style={{ paddingLeft: `${0.55 + level * 0.75}rem` }}><i>{open ? "⌄" : level === 0 ? "›" : ""}</i><CommandIcon name={icon} /><span><strong>{label}</strong><small>{value}</small></span><b>●</b></button>; }
function RangeControl({ label, value, min, max, step, onChange }: { readonly label: string; readonly value: number; readonly min: number; readonly max: number; readonly step: number; readonly onChange: (value: number) => void }): React.JSX.Element { return <label className="range-control"><span>{label}<output>{value.toFixed(2)}</output></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>; }

function sourceCounts(project: WorkbenchProject, source: RenderSource): { readonly primary: number; readonly geometry: number } {
  if (source === "assembly") return { primary: project.assembly.components.length, geometry: project.assembly.components.filter((component) => component.visible).length };
  if (source === "vehicle") {
    const layers = Object.values(project.vehicle.layers);
    return { primary: layers.length, geometry: layers.filter(Boolean).length };
  }
  if (source === "surface") return { primary: 1, geometry: 1 };
  return { primary: 1 + (project.part.previewBodies?.length ?? 0), geometry: 1 + (project.part.previewBodies?.filter((body) => body.visible).length ?? 0) };
}

function sourceLabel(source: RenderSource): string { return source === "part" ? "Part Studio" : source === "assembly" ? "Assembly" : source === "surface" ? "Surface body" : "Vehicle study"; }
function environmentLabel(environment: RenderEnvironment): string { return ENVIRONMENTS.find((entry) => entry.id === environment)?.label ?? environment; }

export function renderResolutionSize(value: RenderResolution): readonly [number, number] {
  const [width, height] = value.split("x").map(Number);
  return [width ?? 1920, height ?? 1080];
}
