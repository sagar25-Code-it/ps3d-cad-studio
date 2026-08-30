import { useEffect, useState } from "react";
import type { ModelSuccessResponse } from "../../../../packages/worker-protocol/src/index.js";
import type { ViewportShadingMode } from "../../../../packages/viewport-three/src/index.js";
import type { PartIntent, PartPreviewBody, PartPreviewBodyShape, Vec3 } from "../../../../packages/workbench-core/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";
import { PartAppearanceControls } from "../ui/PartAppearanceControls.js";

type PartParameter = "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm" | "edgeTreatmentMm" | "patternCount" | "revolveAngleDeg";

const PARAMETERS: readonly { key: PartParameter; label: string; minimum: number; maximum: number; step: number; unit: string; level: "qualified" | "preview" }[] = [
  { key: "widthMm", label: "Plate width", minimum: 5, maximum: 500, step: 1, unit: "mm", level: "qualified" },
  { key: "heightMm", label: "Plate height", minimum: 5, maximum: 500, step: 1, unit: "mm", level: "qualified" },
  { key: "thicknessMm", label: "Thickness", minimum: 1, maximum: 100, step: 0.5, unit: "mm", level: "qualified" },
  { key: "holeDiameterMm", label: "Bore diameter", minimum: 1, maximum: 250, step: 0.5, unit: "mm", level: "qualified" },
  { key: "edgeTreatmentMm", label: "Edge treatment", minimum: 0, maximum: 10, step: 0.25, unit: "mm", level: "preview" },
  { key: "patternCount", label: "Pattern instances", minimum: 1, maximum: 12, step: 1, unit: "×", level: "preview" },
  { key: "revolveAngleDeg", label: "Revolve study", minimum: 30, maximum: 360, step: 5, unit: "°", level: "preview" }
];

interface PartInspectorProps {
  readonly part: PartIntent;
  readonly model: ModelSuccessResponse | undefined;
  readonly working: boolean;
  readonly bodyColor: string;
  readonly shadingMode: ViewportShadingMode;
  readonly selectedId: string | null;
  readonly onCommit: (parameter: PartParameter, value: number) => void;
  readonly onBodyColor: (color: string) => void;
  readonly onShadingMode: (mode: ViewportShadingMode) => void;
  readonly onInsertIntoAssembly: () => void;
  readonly onSelect: (id: string | null) => void;
  readonly onCreatePreviewBody: (shape: PartPreviewBodyShape) => void;
  readonly onPreviewBodyTransform: (bodyId: string, translationMm: Vec3, rotationDeg: Vec3) => void;
  readonly onPreviewBodySize: (bodyId: string, sizeMm: Vec3) => void;
  readonly onPreviewBodyColor: (bodyId: string, color: string) => void;
  readonly onPreviewBodyVisibility: (bodyId: string) => void;
  readonly onPreviewBodyDelete: (bodyId: string) => void;
}

export function PartInspector(props: PartInspectorProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<PartParameter, string>>(() => values(props.part));
  useEffect(() => setDrafts(values(props.part)), [props.part]);
  const measurements = props.model?.render.measurements;
  const previewBodies = props.part.previewBodies ?? [];
  const selectedPreviewBody = previewBodies.find((body) => body.id === props.selectedId);
  return <aside className="inspector-panel" aria-label="Part inspector">
    <div className="inspector-title"><div><p>Part intent</p><h2>{props.part.name}</h2></div><CapabilityBadge level="qualified" /></div>
    <section className="parameter-stack">
      {PARAMETERS.map((parameter) => <div className="parameter-control" key={parameter.key}>
        <label htmlFor={`part-${parameter.key}`}><span>{parameter.label}<small>{parameter.level}</small></span><CapabilityBadge level={parameter.level} /></label>
        <div><input id={`part-${parameter.key}`} type="number" min={parameter.minimum} max={parameter.maximum} step={parameter.step} value={drafts[parameter.key]} onChange={(event) => setDrafts((current) => ({ ...current, [parameter.key]: event.target.value }))} /><span>{parameter.unit}</span><button disabled={props.working} onClick={() => props.onCommit(parameter.key, Number(drafts[parameter.key]))}>Apply</button></div>
      </div>)}
    </section>
    <section className="inspector-section part-appearance-card"><header><strong>Body appearance</strong><span>display only</span></header>
      <PartAppearanceControls bodyColor={props.bodyColor} shadingMode={props.shadingMode} onBodyColor={props.onBodyColor} onShadingMode={props.onShadingMode} />
    </section>
    <section className="inspector-section preview-body-card"><header><strong>Independent preview bodies</strong><span>{previewBodies.length} bodies</span></header>
      <p>Analytic bodies remain separate from the qualified plate. Supported revolve, pattern, mirror, Boolean, trim, detail, shell, draft, and planar-face edits are revisioned and regenerate visible closed meshes.</p>
      <div className="preview-body-create" aria-label="Create preview primitive">
        {(["block", "cylinder", "cone", "sphere"] as const).map((shape) => <button key={shape} onClick={() => props.onCreatePreviewBody(shape)}><CommandIcon name={shape} />{shape}</button>)}
      </div>
      {previewBodies.length === 0 ? <div className="preview-body-empty">Create a primitive here or from All Commands.</div> : <div className="preview-body-list">
        {previewBodies.map((body) => <button key={body.id} className={body.id === props.selectedId ? "active" : ""} onClick={() => props.onSelect(body.id === props.selectedId ? null : body.id)}><i style={{ background: body.color }} /><span><strong>{body.name}</strong><small>{featureSummary(body)} | {body.visible ? "shown" : "hidden"}</small></span></button>)}
      </div>}
      {selectedPreviewBody !== undefined && <PreviewBodyEditor
        body={selectedPreviewBody}
        onTransform={props.onPreviewBodyTransform}
        onSize={props.onPreviewBodySize}
        onColor={props.onPreviewBodyColor}
        onVisibility={props.onPreviewBodyVisibility}
        onDelete={props.onPreviewBodyDelete}
      />}
    </section>
    <section className="inspector-section metrics-section"><header><strong>Validated body</strong><span>{props.model?.render.topology.triangles ?? "—"} triangles</span></header>
      <dl className="metric-grid">
        <div><dt>Topology</dt><dd>{props.model === undefined ? "pending" : `closed · genus ${props.model.render.topology.genus}`}</dd></div>
        <div><dt>Volume</dt><dd>{measurements === undefined ? "—" : `${(measurements.volumeCubicMeters * 1e9).toFixed(1)} mm³`}</dd></div>
        <div><dt>Semantic hash</dt><dd title={props.model?.evidence.semanticHash}>{shortHash(props.model?.evidence.semanticHash)}</dd></div>
        <div><dt>Mesh hash</dt><dd title={props.model?.evidence.body.canonicalMeshHash}>{shortHash(props.model?.evidence.body.canonicalMeshHash)}</dd></div>
      </dl>
    </section>
    <section className="inspector-section part-downstream-card"><header><strong>Downstream assembly</strong><span>editable snapshot</span></header>
      <p>Insert this qualified envelope as a selectable plate component. The inserted component records the current revision; later part edits do not update it automatically.</p>
      <button disabled={props.working || props.model === undefined} onClick={props.onInsertIntoAssembly}><CommandIcon name="assemble" />Insert current part into assembly</button>
    </section>
    <div className="scope-note qualified"><strong>Qualified path</strong><p>Width, height, thickness, and bore regenerate in the isolated f64 worker and must pass independent closed-mesh and evidence checks.</p></div>
  </aside>;
}

function PreviewBodyEditor(props: {
  readonly body: PartPreviewBody;
  readonly onTransform: (bodyId: string, translationMm: Vec3, rotationDeg: Vec3) => void;
  readonly onSize: (bodyId: string, sizeMm: Vec3) => void;
  readonly onColor: (bodyId: string, color: string) => void;
  readonly onVisibility: (bodyId: string) => void;
  readonly onDelete: (bodyId: string) => void;
}): React.JSX.Element {
  const [transform, setTransform] = useState(() => transformStrings(props.body));
  const [size, setSize] = useState(() => sizeStrings(props.body));
  useEffect(() => { setTransform(transformStrings(props.body)); setSize(sizeStrings(props.body)); }, [props.body]);
  const translation = [Number(transform.tx), Number(transform.ty), Number(transform.tz)] as Vec3;
  const rotation = [Number(transform.rx), Number(transform.ry), Number(transform.rz)] as Vec3;
  const rawSize = [Number(size.x), Number(size.y), Number(size.z)] as Vec3;
  const normalizedSize: Vec3 = props.body.shape === "cylinder" ? [rawSize[0], rawSize[0], rawSize[2]]
    : props.body.shape === "sphere" ? [rawSize[0], rawSize[0], rawSize[0]] : rawSize;
  const transformValid = [...translation, ...rotation].every(Number.isFinite);
  const sizeValid = normalizedSize.every(Number.isFinite) && normalizedSize[0] > 0 && normalizedSize[2] > 0 && normalizedSize[1] >= 0
    && (props.body.shape !== "revolved" || (normalizedSize[1] > 0 && normalizedSize[1] < normalizedSize[0]));
  return <div className="preview-body-editor">
    <div className="preview-body-editor-title"><span><CommandIcon name={bodyShapeIcon(props.body)} /></span><div><small>ANALYTIC BODY / DIRECT EDIT</small><strong>{props.body.name}</strong></div></div>
    <div className="preview-body-feature-summary"><strong>Feature stack</strong><span>{featureSummary(props.body)}</span><small>{props.body.featureTrace === undefined ? "Created primitive" : `${props.body.featureTrace.kind} | ${props.body.featureTrace.operationId}`}</small></div>
    <fieldset><legend>Move / rotate</legend><div className="preview-body-fields">
      {(["tx", "ty", "tz", "rx", "ry", "rz"] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" step={key.startsWith("r") ? 1 : 0.5} value={transform[key]} onChange={(event) => setTransform((current) => ({ ...current, [key]: event.target.value }))} /><small>{key.startsWith("r") ? "°" : "mm"}</small></label>)}
    </div><button disabled={!transformValid} onClick={() => props.onTransform(props.body.id, translation, rotation)}>Apply transform</button></fieldset>
    <fieldset><legend>Analytic dimensions</legend><div className="preview-body-fields size">
      <label><span>{props.body.shape === "cone" ? "Base diameter" : props.body.shape === "block" ? "Width" : props.body.shape === "revolved" ? "Outer diameter" : "Diameter"}</span><input type="number" min="0.01" step="0.5" value={size.x} onChange={(event) => setSize((current) => ({ ...current, x: event.target.value }))} /><small>mm</small></label>
      {(props.body.shape === "block" || props.body.shape === "cone" || props.body.shape === "revolved") && <label><span>{props.body.shape === "cone" ? "Top diameter" : props.body.shape === "revolved" ? "Inner diameter" : "Depth"}</span><input type="number" min={props.body.shape === "cone" ? 0 : 0.01} step="0.5" value={size.y} onChange={(event) => setSize((current) => ({ ...current, y: event.target.value }))} /><small>mm</small></label>}
      {props.body.shape !== "sphere" && <label><span>Height</span><input type="number" min="0.01" step="0.5" value={size.z} onChange={(event) => setSize((current) => ({ ...current, z: event.target.value }))} /><small>mm</small></label>}
    </div><button disabled={!sizeValid} onClick={() => props.onSize(props.body.id, normalizedSize)}>Apply dimensions</button></fieldset>
    <div className="preview-body-appearance"><label><span>Body color</span><input type="color" value={props.body.color} onChange={(event) => props.onColor(props.body.id, event.target.value)} /></label><button onClick={() => props.onVisibility(props.body.id)}><CommandIcon name={props.body.visible ? "eye-off" : "eye"} />{props.body.visible ? "Hide" : "Show"}</button><button className="danger" onClick={() => props.onDelete(props.body.id)}><CommandIcon name="trash" />Delete</button></div>
  </div>;
}

function transformStrings(body: PartPreviewBody): { tx: string; ty: string; tz: string; rx: string; ry: string; rz: string } {
  return { tx: String(body.translationMm[0]), ty: String(body.translationMm[1]), tz: String(body.translationMm[2]), rx: String(body.rotationDeg[0]), ry: String(body.rotationDeg[1]), rz: String(body.rotationDeg[2]) };
}

function sizeStrings(body: PartPreviewBody): { x: string; y: string; z: string } {
  return { x: String(body.sizeMm[0]), y: String(body.sizeMm[1]), z: String(body.sizeMm[2]) };
}

function bodyShapeIcon(body: PartPreviewBody): string {
  return body.shape === "revolved" ? "revolve" : body.shape;
}

function featureSummary(body: PartPreviewBody): string {
  const modifiers = [
    body.boreDiameterMm === undefined ? undefined : `bore ${body.boreDiameterMm} mm`,
    body.edgeTreatment === undefined ? undefined : `${body.edgeTreatment.kind} ${body.edgeTreatment.sizeMm} mm`,
    body.shellThicknessMm === undefined ? undefined : `shell ${body.shellThicknessMm} mm`,
    body.draftAngleDeg === undefined ? undefined : `draft ${body.draftAngleDeg} deg`
  ].filter((value): value is string => value !== undefined);
  return modifiers.length === 0 ? body.shape : `${body.shape} | ${modifiers.join(" | ")}`;
}

function values(part: PartIntent): Record<PartParameter, string> {
  return {
    widthMm: String(part.widthMm),
    heightMm: String(part.heightMm),
    thicknessMm: String(part.thicknessMm),
    holeDiameterMm: String(part.holeDiameterMm),
    edgeTreatmentMm: String(part.edgeTreatmentMm),
    patternCount: String(part.patternCount),
    revolveAngleDeg: String(part.revolveAngleDeg)
  };
}

function shortHash(hash: string | undefined): string {
  return hash === undefined ? "pending" : `${hash.slice(0, 8)}…${hash.slice(-5)}`;
}
