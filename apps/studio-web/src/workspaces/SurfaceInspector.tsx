import { useEffect, useState } from "react";
import type { SurfaceIntent } from "../../../../packages/workbench-core/src/index.js";
import type { SurfaceMetrics } from "../../../../packages/workbench-geometry/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";

type SurfaceParameter = "widthMm" | "depthMm" | "crownMm" | "twistDeg" | "uSegments" | "vSegments";

const CONTROLS: readonly { key: SurfaceParameter; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "widthMm", label: "Span", min: 20, max: 300, step: 1, unit: "mm" },
  { key: "depthMm", label: "Depth", min: 20, max: 300, step: 1, unit: "mm" },
  { key: "crownMm", label: "Crown height", min: -40, max: 80, step: 1, unit: "mm" },
  { key: "twistDeg", label: "Twist", min: -45, max: 45, step: 1, unit: "°" },
  { key: "uSegments", label: "U tessellation", min: 4, max: 48, step: 1, unit: "seg" },
  { key: "vSegments", label: "V tessellation", min: 4, max: 48, step: 1, unit: "seg" }
];

interface SurfaceInspectorProps {
  readonly surface: SurfaceIntent;
  readonly metrics: SurfaceMetrics;
  readonly onParameter: (parameter: SurfaceParameter, value: number) => void;
}

export function SurfaceInspector(props: SurfaceInspectorProps): React.JSX.Element {
  const [draft, setDraft] = useState<Record<SurfaceParameter, number>>(() => values(props.surface));
  useEffect(() => setDraft(values(props.surface)), [props.surface]);
  return <aside className="inspector-panel" aria-label="Surface inspector">
    <div className="inspector-title"><div><p>Surface laboratory</p><h2>{props.surface.name}</h2></div><CapabilityBadge level="preview" /></div>
    <section className="surface-controls">{CONTROLS.map((control) => <label key={control.key}><span><strong>{control.label}</strong><output>{draft[control.key]} {control.unit}</output></span><input type="range" min={control.min} max={control.max} step={control.step} value={draft[control.key]} onChange={(event) => setDraft((current) => ({ ...current, [control.key]: Number(event.target.value) }))} onPointerUp={() => props.onParameter(control.key, draft[control.key])} onKeyUp={() => props.onParameter(control.key, draft[control.key])} /></label>)}</section>
    <small className="property-help">Surface type, shape presets, and Fit surface are available from the top ribbon.</small>
    <section className="inspector-section metrics-section"><header><strong>Tessellation metrics</strong><span>finite</span></header><dl className="metric-grid"><div><dt>Vertices</dt><dd>{props.metrics.vertices}</dd></div><div><dt>Triangles</dt><dd>{props.metrics.triangles}</dd></div><div><dt>Area</dt><dd>{props.metrics.approximateAreaSquareMm.toFixed(1)} mm²</dd></div><div><dt>Max normal step</dt><dd>{props.metrics.maximumNormalVariationDeg.toFixed(2)}°</dd></div><div><dt>Boundary edges</dt><dd>{props.metrics.boundaryEdges}</dd></div><div><dt>Control net</dt><dd>4 × 4</dd></div></dl></section>
    <section className="continuity-card"><span>C0</span><div><strong>Bounded patch continuity</strong><p>One deterministic patch with finite normals and explicit open boundaries.</p></div></section>
    <div className="scope-note"><strong>Unavailable in this phase</strong><p>Trimming, sewing, offsets, exact NURBS, intersection curves, and surface-to-solid conversion.</p></div>
  </aside>;
}

function values(surface: SurfaceIntent): Record<SurfaceParameter, number> {
  return { widthMm: surface.widthMm, depthMm: surface.depthMm, crownMm: surface.crownMm, twistDeg: surface.twistDeg, uSegments: surface.uSegments, vSegments: surface.vSegments };
}
