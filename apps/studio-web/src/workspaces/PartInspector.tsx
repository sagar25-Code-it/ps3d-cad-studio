import { useEffect, useMemo, useState } from "react";
import type { ModelSuccessResponse } from "../../../../packages/worker-protocol/src/index.js";
import type { ViewportShadingMode } from "../../../../packages/viewport-three/src/index.js";
import { describeFeature, featureOfBody, featureStatus, featureStatusText, isNewPrimitiveShape, normalizePrimitiveSize, primitiveSizeLabels, solidMetrics, validPrimitiveBody, type DesignHistory, type DesignSolidFeature, type GeneralSolidBody, type PartIntent, type PartPreviewBody, type PartPreviewBodyShape, type PartPrimitiveParams, type Vec3 } from "../../../../packages/workbench-core/src/index.js";
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
  readonly selectedFace: number | null;
  readonly onSelectFace: (bodyId: string, faceIndex: number | null) => void;
  readonly onCommit: (parameter: PartParameter, value: number) => void;
  readonly onBodyColor: (color: string) => void;
  readonly onShadingMode: (mode: ViewportShadingMode) => void;
  readonly onInsertIntoAssembly: () => void;
  readonly onGeneralBodyToAssembly: (bodyId: string) => void;
  readonly onGeneralBodyVisibility: (bodyId: string) => void;
  readonly onGeneralBodyDelete: (bodyId: string) => void;
  /** The parametric timeline, so a selected solid can say which step made it and open that step for editing. */
  readonly design: DesignHistory;
  readonly onEditFeature: (feature: DesignSolidFeature) => void;
  readonly onSelect: (id: string | null) => void;
  readonly onCreatePreviewBody: (shape: PartPreviewBodyShape) => void;
  readonly onPreviewBodyTransform: (bodyId: string, translationMm: Vec3, rotationDeg: Vec3) => void;
  readonly onPreviewBodySize: (bodyId: string, sizeMm: Vec3, primitiveParams?: PartPrimitiveParams) => void;
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
  const selectedGeneralBody = (props.part.generalBodies ?? []).find((body) => body.id === props.selectedId);
  return <aside className="inspector-panel" aria-label="Part inspector">
    {selectedGeneralBody === undefined
      ? <div className="inspector-title"><div><p>Part intent</p><h2>{props.part.name}</h2></div><CapabilityBadge level="qualified" /></div>
      : <div className="inspector-title"><div><p>Selected solid</p><h2>{selectedGeneralBody.name}</h2></div></div>}
    {selectedGeneralBody !== undefined && <SolidCard
      body={selectedGeneralBody}
      history={props.design}
      onEdit={props.onEditFeature}
      onVisibility={props.onGeneralBodyVisibility}
      onDelete={props.onGeneralBodyDelete}
    />}
    <details className="plate-parameters" key={selectedGeneralBody === undefined ? "plate-open" : "plate-closed"} open={selectedGeneralBody === undefined}>
      <summary><strong>Mounting plate</strong><span>template part · qualified</span></summary>
      <section className="parameter-stack">
        {PARAMETERS.map((parameter) => <div className="parameter-control" key={parameter.key}>
          <label htmlFor={`part-${parameter.key}`}><span>{parameter.label}<small>{parameter.level}</small></span><CapabilityBadge level={parameter.level} /></label>
          <div><input id={`part-${parameter.key}`} type="number" min={parameter.minimum} max={parameter.maximum} step={parameter.step} value={drafts[parameter.key]} onChange={(event) => setDrafts((current) => ({ ...current, [parameter.key]: event.target.value }))} /><span>{parameter.unit}</span><button disabled={props.working} onClick={() => props.onCommit(parameter.key, Number(drafts[parameter.key]))}>Apply</button></div>
        </div>)}
      </section>
    </details>
    <section className="inspector-section part-appearance-card"><header><strong>Body appearance</strong><span>display only</span></header>
      <PartAppearanceControls bodyColor={props.bodyColor} shadingMode={props.shadingMode} onBodyColor={props.onBodyColor} onShadingMode={props.onShadingMode} />
    </section>
    <section className="inspector-section preview-body-card"><header><strong>Independent preview bodies</strong><span>{previewBodies.length} bodies</span></header>
      <p>Analytic bodies remain separate from the qualified plate. Supported revolve, pattern, mirror, Boolean, trim, detail, shell, draft, and planar-face edits are revisioned and regenerate visible closed meshes.</p>
      <div className="preview-body-create" aria-label="Create preview primitive">
        {(["block", "cylinder", "cone", "sphere", "torus", "ellipsoid", "prism", "wedge", "spiral", "tube"] as const).map((shape) => <button key={shape} onClick={() => props.onCreatePreviewBody(shape)}><CommandIcon name={shape} />{shape}</button>)}
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
    {selectedGeneralBody !== undefined && <section className="inspector-section general-body-assembly">
      <header><strong>Use in assembly</strong><span>snapshot</span></header>
      <p>Adds this solid to the Assembly as a mesh component with its real shape. It is a snapshot: later edits to the solid are not carried over.</p>
      <button className="palette-action primary" onClick={() => props.onGeneralBodyToAssembly(selectedGeneralBody.id)}><CommandIcon name="assembly" />Create component from solid</button>
    </section>}
    {selectedGeneralBody?.brep !== undefined && <section className="inspector-section named-faces-card">
      <header><strong>Named faces</strong><span>{selectedGeneralBody.brep.faces.length} faces · {selectedGeneralBody.brep.origin === "mesh-boolean" ? "mesh Boolean regions" : "B-rep"}</span></header>
      <p>{selectedGeneralBody.brep.origin === "mesh-boolean" ? "Labelled regions of a tessellated Boolean result, named target.<face> or tool.<face> after the source faces. This is not an exact B-rep. Select one to highlight it." : "Stable, lineage-anchored faces from the B-rep kernel. Select one to highlight it in the viewport; the name survives dimensional rebuilds."}</p>
      <div className="named-face-list" role="listbox" aria-label="Named faces">
        {selectedGeneralBody.brep.faces.map((face, index) => <button
          key={face.key}
          role="option"
          aria-selected={props.selectedFace === index}
          className={props.selectedFace === index ? "active" : ""}
          onClick={() => props.onSelectFace(selectedGeneralBody.id, props.selectedFace === index ? null : index)}
          title={face.key}
        ><span className="named-face-role"><CommandIcon name="surface" />{face.role.replace("face.", "")}</span><small>{face.areaMm2.toFixed(1)} mm²</small></button>)}
      </div>
    </section>}
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

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const formatNumber = (value: number): string => NUMBER.format(value);
const formatPoint = (point: Vec3): string => `${formatNumber(point[0])}, ${formatNumber(point[1])}, ${formatNumber(point[2])} mm`;

/** What the selected solid is, where it came from in the timeline, and what it measures; the actions that apply to a solid. */
function SolidCard(props: {
  readonly body: GeneralSolidBody;
  readonly history: DesignHistory;
  readonly onEdit: (feature: DesignSolidFeature) => void;
  readonly onVisibility: (bodyId: string) => void;
  readonly onDelete: (bodyId: string) => void;
}): React.JSX.Element {
  const { body, history } = props;
  const metrics = useMemo(() => solidMetrics(body.positionsMm, body.indices), [body.positionsMm, body.indices]);
  const feature = featureOfBody(history, body.id);
  const status = feature === undefined ? "" : featureStatusText(featureStatus(history, feature));
  // The steps that shaped the body, in the order they apply: the step that made it, then its joins and cuts.
  const steps = history.features.filter((candidate): candidate is DesignSolidFeature => candidate.kind !== "sketch" && candidate.bodyId === body.id);
  return <section className="inspector-section solid-card" aria-label={`${body.name} properties`}>
    <header><strong>{feature === undefined ? "Ordinary solid" : feature.name}</strong><span>{feature === undefined ? "not in the timeline" : "timeline step"}</span></header>
    <p className="solid-source">{feature === undefined
      ? "This body is not driven by the timeline (it came from Combine, or was saved before the timeline existed), so editing a sketch does not change it."
      : `${describeFeature(history, feature)}${status === "" ? "" : ` · ${status}`}. Edit the step, or edit its sketch, and this solid rebuilds.`}</p>
    {feature?.health !== undefined && <p className="solid-warning" role="alert">{feature.health.message}</p>}
    {steps.length > 1 && <ol className="solid-steps" aria-label="Steps that shaped this solid">
      {steps.map((step) => {
        const stepStatus = featureStatusText(featureStatus(history, step));
        return <li key={step.id} className={step.health === undefined ? "" : "failed"}>
          <span><strong>{step.name}</strong><small>{describeFeature(history, step)}{stepStatus === "" ? "" : ` · ${stepStatus}`}{step.health === undefined ? "" : ` · ${step.health.message}`}</small></span>
          <button onClick={() => props.onEdit(step)} aria-label={`Edit ${step.name}`}>Edit</button>
        </li>;
      })}
    </ol>}
    <dl className="metric-grid">
      <div><dt>Volume</dt><dd>{formatNumber(metrics.volumeMm3)} mm³{metrics.volumeMm3 >= 1000 ? ` (${formatNumber(metrics.volumeMm3 / 1000)} cm³)` : ""}</dd></div>
      <div><dt>Surface area</dt><dd>{formatNumber(metrics.surfaceAreaMm2)} mm²</dd></div>
      <div><dt>Size X × Y × Z</dt><dd>{metrics.sizeMm.map(formatNumber).join(" × ")} mm</dd></div>
      <div><dt>Centre of volume</dt><dd>{formatPoint(metrics.centroidMm)}</dd></div>
      <div><dt>Triangles</dt><dd>{metrics.triangleCount}{body.brep === undefined ? "" : ` · ${body.brep.topology.faces} faces`}</dd></div>
      {!metrics.outward && <div><dt>Winding</dt><dd>inside-out mesh</dd></div>}
    </dl>
    <div className="solid-actions">
      {feature !== undefined && <button className="primary" onClick={() => props.onEdit(feature)}><CommandIcon name="edit" />Edit feature</button>}
      <button onClick={() => props.onVisibility(body.id)}><CommandIcon name={body.visible ? "eye-off" : "eye"} />{body.visible ? "Hide" : "Show"}</button>
      <button className="danger" onClick={() => props.onDelete(body.id)}><CommandIcon name="trash" />Delete</button>
    </div>
  </section>;
}

function PreviewBodyEditor(props: {
  readonly body: PartPreviewBody;
  readonly onTransform: (bodyId: string, translationMm: Vec3, rotationDeg: Vec3) => void;
  readonly onSize: (bodyId: string, sizeMm: Vec3, primitiveParams?: PartPrimitiveParams) => void;
  readonly onColor: (bodyId: string, color: string) => void;
  readonly onVisibility: (bodyId: string) => void;
  readonly onDelete: (bodyId: string) => void;
}): React.JSX.Element {
  const [transform, setTransform] = useState(() => transformStrings(props.body));
  const [size, setSize] = useState(() => sizeStrings(props.body));
  const newShape = isNewPrimitiveShape(props.body.shape) ? props.body.shape : undefined;
  const labels = newShape === undefined ? undefined : primitiveSizeLabels(newShape);
  const [countText, setCountText] = useState(() => primitiveCountText(props.body));
  useEffect(() => { setTransform(transformStrings(props.body)); setSize(sizeStrings(props.body)); setCountText(primitiveCountText(props.body)); }, [props.body]);
  const translation = [Number(transform.tx), Number(transform.ty), Number(transform.tz)] as Vec3;
  const rotation = [Number(transform.rx), Number(transform.ry), Number(transform.rz)] as Vec3;
  const rawSize = [Number(size.x), Number(size.y), Number(size.z)] as Vec3;
  const normalizedSize: Vec3 = props.body.shape === "cylinder" || props.body.shape === "prism" || props.body.shape === "spiral" ? [rawSize[0], rawSize[0], rawSize[2]]
    : props.body.shape === "sphere" ? [rawSize[0], rawSize[0], rawSize[0]] : rawSize;
  const count = Number(countText);
  const nextParams: PartPrimitiveParams | undefined = props.body.shape === "prism" ? { sides: count } : props.body.shape === "spiral" ? { turns: count } : undefined;
  const primitiveValid = newShape === undefined || (normalizePrimitiveSize(newShape, normalizedSize) !== undefined && validPrimitiveBody({ shape: newShape, sizeMm: normalizedSize, ...(nextParams === undefined ? {} : { primitiveParams: nextParams }) }));
  const transformValid = [...translation, ...rotation].every(Number.isFinite);
  const sizeValid = primitiveValid && normalizedSize.every(Number.isFinite) && normalizedSize[0] > 0 && normalizedSize[2] > 0 && normalizedSize[1] >= 0
    && (props.body.shape !== "revolved" || (normalizedSize[1] > 0 && normalizedSize[1] < normalizedSize[0]));
  return <div className="preview-body-editor">
    <div className="preview-body-editor-title"><span><CommandIcon name={bodyShapeIcon(props.body)} /></span><div><small>ANALYTIC BODY / DIRECT EDIT</small><strong>{props.body.name}</strong></div></div>
    <div className="preview-body-feature-summary"><strong>Feature stack</strong><span>{featureSummary(props.body)}</span><small>{props.body.featureTrace === undefined ? "Created primitive" : `${props.body.featureTrace.kind} | ${props.body.featureTrace.operationId}`}</small></div>
    <fieldset><legend>Move / rotate</legend><div className="preview-body-fields">
      {(["tx", "ty", "tz", "rx", "ry", "rz"] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" step={key.startsWith("r") ? 1 : 0.5} value={transform[key]} onChange={(event) => setTransform((current) => ({ ...current, [key]: event.target.value }))} /><small>{key.startsWith("r") ? "°" : "mm"}</small></label>)}
    </div><button disabled={!transformValid} onClick={() => props.onTransform(props.body.id, translation, rotation)}>Apply transform</button></fieldset>
    <fieldset><legend>Analytic dimensions</legend><div className="preview-body-fields size">
      <label><span>{labels?.x ?? (props.body.shape === "cone" ? "Base diameter" : props.body.shape === "block" ? "Width" : props.body.shape === "revolved" ? "Outer diameter" : "Diameter")}</span><input type="number" min="0.01" step="0.5" value={size.x} onChange={(event) => setSize((current) => ({ ...current, x: event.target.value }))} /><small>mm</small></label>
      {(props.body.shape === "block" || props.body.shape === "cone" || props.body.shape === "revolved" || labels?.y !== undefined) && <label><span>{labels?.y ?? (props.body.shape === "cone" ? "Top diameter" : props.body.shape === "revolved" ? "Inner diameter" : "Depth")}</span><input type="number" min={props.body.shape === "cone" ? 0 : 0.01} step="0.5" value={size.y} onChange={(event) => setSize((current) => ({ ...current, y: event.target.value }))} /><small>mm</small></label>}
      {props.body.shape === "prism" && <label><span>Sides</span><input type="number" min="3" max="64" step="1" value={countText} onChange={(event) => setCountText(event.target.value)} /><small>flat faces</small></label>}
      {props.body.shape === "spiral" && <label><span>Turns</span><input type="number" min="0.5" max="20" step="0.5" value={countText} onChange={(event) => setCountText(event.target.value)} /><small>turns</small></label>}
      {props.body.shape !== "sphere" && (labels === undefined || labels.z !== undefined) && <label><span>{labels?.z ?? "Height"}</span><input type="number" min="0.01" step="0.5" value={size.z} onChange={(event) => setSize((current) => ({ ...current, z: event.target.value }))} /><small>mm</small></label>}
    </div><button disabled={!sizeValid} onClick={() => nextParams === undefined ? props.onSize(props.body.id, normalizedSize) : props.onSize(props.body.id, normalizedSize, nextParams)}>Apply dimensions</button></fieldset>
    <div className="preview-body-appearance"><label><span>Body color</span><input type="color" value={props.body.color} onChange={(event) => props.onColor(props.body.id, event.target.value)} /></label><button onClick={() => props.onVisibility(props.body.id)}><CommandIcon name={props.body.visible ? "eye-off" : "eye"} />{props.body.visible ? "Hide" : "Show"}</button><button className="danger" onClick={() => props.onDelete(props.body.id)}><CommandIcon name="trash" />Delete</button></div>
  </div>;
}

function transformStrings(body: PartPreviewBody): { tx: string; ty: string; tz: string; rx: string; ry: string; rz: string } {
  return { tx: String(body.translationMm[0]), ty: String(body.translationMm[1]), tz: String(body.translationMm[2]), rx: String(body.rotationDeg[0]), ry: String(body.rotationDeg[1]), rz: String(body.rotationDeg[2]) };
}

function primitiveCountText(body: PartPreviewBody): string {
  return String(body.primitiveParams?.sides ?? body.primitiveParams?.turns ?? "");
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
