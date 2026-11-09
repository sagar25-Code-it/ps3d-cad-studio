import { useEffect, useMemo, useState } from "react";
import { describeFailure } from "../failure-text.js";
import type { ConstructionAxis, ConstructionBinder, ConstructionEdgeRef, ConstructionPathRef, ConstructionPlaneDefinition, GeneralSolidBody } from "../../../../packages/workbench-core/src/index.js";
import { evaluateConstructionPlaneDefinition } from "../../../../packages/workbench-geometry/src/index.js";
import { emptyEdgeForm, planeDefinitionOfForm, type EdgeForm, type EdgeSource, type PickResult, type SketchPathOption } from "../construction-ui.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

export type ConstructionPlaneMode = "through-two-edges" | "along-path";

interface ConstructionPlaneDialogProps {
  readonly open: boolean;
  readonly mode: ConstructionPlaneMode;
  readonly axes: readonly ConstructionAxis[];
  readonly bodies: readonly GeneralSolidBody[];
  readonly binders: readonly ConstructionBinder[];
  readonly paths: readonly SketchPathOption[];
  /** True while the viewport is waiting for a click, which hides the dialog so the model can be reached. */
  readonly picking: boolean;
  readonly onPickEdge: () => Promise<PickResult<Extract<ConstructionEdgeRef, { readonly kind: "body-edge" }>>>;
  readonly onConfirm: (name: string, definition: ConstructionPlaneDefinition) => void;
  readonly onClose: () => void;
}

/**
 * Creates a construction plane through two edges, or at a position along a path. The plane is evaluated as the form is filled in, so the
 * dialog says what it will make, or what is wrong, before anything is added to the part.
 */
export function ConstructionPlaneDialog(props: ConstructionPlaneDialogProps): React.JSX.Element | null {
  const [mode, setMode] = useState<ConstructionPlaneMode>(props.mode);
  const [edgeA, setEdgeA] = useState<EdgeForm>(() => emptyEdgeForm(props.axes, props.binders, props.bodies));
  const [edgeB, setEdgeB] = useState<EdgeForm>(() => emptyEdgeForm(props.axes, props.binders, props.bodies));
  const [pathSource, setPathSource] = useState<"axis" | "sketch">(props.axes.length > 0 && props.paths.length === 0 ? "axis" : "sketch");
  const [pathAxisId, setPathAxisId] = useState(props.axes[0]?.id ?? "");
  const [sketchPathId, setSketchPathId] = useState(props.paths[0]?.id ?? "");
  const [tText, setTText] = useState("50");
  const [orientation, setOrientation] = useState<"perpendicular" | "tangent">("perpendicular");
  const [name, setName] = useState("");
  const dialogRef = useDialogFocus<HTMLElement>(props.open && !props.picking, props.onClose);

  useEffect(() => {
    if (!props.open) return;
    setMode(props.mode);
    setEdgeA(emptyEdgeForm(props.axes, props.binders, props.bodies));
    setEdgeB(emptyEdgeForm(props.axes, props.binders, props.bodies));
    setPathSource(props.axes.length > 0 && props.paths.length === 0 ? "axis" : "sketch");
    setPathAxisId(props.axes[0]?.id ?? "");
    setSketchPathId(props.paths[0]?.id ?? "");
    setTText("50");
    setOrientation("perpendicular");
    setName("");
    // Re-initialise only when the dialog opens, not when the part changes underneath it.
  }, [props.open, props.mode]);

  const definition = useMemo((): ConstructionPlaneDefinition | undefined => {
    if (mode === "through-two-edges") return planeDefinitionOfForm({ mode, edgeA, edgeB });
    const path: ConstructionPathRef | undefined = pathSource === "axis" ? (pathAxisId === "" ? undefined : { kind: "axis", axisId: pathAxisId }) : props.paths.find((option) => option.id === sketchPathId)?.path;
    return planeDefinitionOfForm({ mode, path, percentText: tText, orientation });
  }, [mode, edgeA, edgeB, pathSource, pathAxisId, sketchPathId, tText, orientation, props.paths]);

  const verdict = useMemo((): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string } => {
    if (definition === undefined) return { ok: false, text: mode === "through-two-edges" ? "Choose both edges." : "Choose a path and a position from 0 to 100 %." };
    const frame = evaluateConstructionPlaneDefinition(definition, props.bodies, props.axes, props.binders);
    return "error" in frame ? { ok: false, text: frame.error } : { ok: true, text: `${frame.description}. Normal ${frame.normal.map((value) => value.toFixed(3)).join(", ")}.` };
  }, [definition, mode, props.bodies, props.axes, props.binders]);

  if (!props.open) return null;

  const pickInto = async (set: (updater: (form: EdgeForm) => EdgeForm) => void): Promise<void> => {
    let result: Awaited<ReturnType<typeof props.onPickEdge>>;
    try { result = await props.onPickEdge(); } catch (failure) { set((form) => ({ ...form, picked: undefined, pickedText: describeFailure(failure, "Picking the edge") })); return; }
    if (result.ok) set((form) => ({ ...form, picked: result.value, pickedText: result.message }));
    else set((form) => ({ ...form, picked: undefined, pickedText: result.message }));
  };

  const edgeEditor = (title: string, form: EdgeForm, set: (updater: (form: EdgeForm) => EdgeForm) => void): React.JSX.Element => {
    const edgeBinders = props.binders.filter((binder) => binder.target.kind === "edge");
    return <fieldset className="sketch-plane-faces">
      <legend><small className="sketch-plane-faces-title">{title}</small></legend>
      <label className="sketch-plane-offset"><span>Edge from</span><div className="feature-edit-field">
        <select aria-label={`${title} source`} value={form.source} onChange={(event) => set((current) => ({ ...current, source: event.target.value as EdgeSource }))}>
          {props.axes.length > 0 && <option value="axis">A construction axis</option>}
          {props.bodies.length > 0 && <option value="pick">A straight edge picked on a solid</option>}
          {edgeBinders.length > 0 && <option value="binder">An edge binder</option>}
          <option value="points">Two typed points</option>
        </select>
      </div></label>
      {form.source === "axis" && <label className="sketch-plane-offset"><span>Axis</span><div className="feature-edit-field">
        <select aria-label={`${title} axis`} value={form.axisId} onChange={(event) => set((current) => ({ ...current, axisId: event.target.value }))}>
          {props.axes.map((axis) => <option key={axis.id} value={axis.id}>{axis.name}</option>)}
        </select>
      </div></label>}
      {form.source === "binder" && <label className="sketch-plane-offset"><span>Binder</span><div className="feature-edit-field">
        <select aria-label={`${title} binder`} value={form.binderId} onChange={(event) => set((current) => ({ ...current, binderId: event.target.value }))}>
          {edgeBinders.map((binder) => <option key={binder.id} value={binder.id}>{binder.name}</option>)}
        </select>
      </div></label>}
      {form.source === "pick" && <div className="sketch-plane-offset"><span>Picked edge</span><div className="feature-edit-field">
        <button type="button" onClick={() => void pickInto(set)}>{form.picked === undefined ? "Pick an edge in the viewport" : "Pick another edge"}</button>
        <small>{form.pickedText === "" ? "The dialog steps aside so you can click an edge of a solid." : form.pickedText}</small>
      </div></div>}
      {form.source === "points" && <>
        <label className="sketch-plane-offset"><span>Start (x, y, z in mm)</span><div className="feature-edit-field">
          <input aria-label={`${title} start point`} placeholder="0, 0, 0" value={form.from} onChange={(event) => set((current) => ({ ...current, from: event.target.value }))} />
        </div></label>
        <label className="sketch-plane-offset"><span>End (x, y, z in mm)</span><div className="feature-edit-field">
          <input aria-label={`${title} end point`} placeholder="50, 0, 0" value={form.to} onChange={(event) => set((current) => ({ ...current, to: event.target.value }))} />
        </div></label>
      </>}
    </fieldset>;
  };

  const confirm = (): void => {
    if (definition === undefined || !verdict.ok) return;
    const fallback = mode === "through-two-edges" ? "Plane through two edges" : `Plane along path at ${tText.trim()}%`;
    props.onConfirm(name.trim() === "" ? fallback : name.trim().slice(0, 120), definition);
  };

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" style={props.picking ? { display: "none" } : undefined} onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog new-project-dialog sketch-plane-dialog" role="dialog" aria-modal="true" aria-labelledby="construction-plane-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="projection" /></span><div><small>CONSTRUCT / PLANE</small><h2 id="construction-plane-title">{mode === "through-two-edges" ? "Plane through two edges" : "Plane along path"}</h2></div><button onClick={props.onClose} aria-label="Cancel plane">×</button></header>
      <div className="save-project-content">
        <div className="new-project-types sketch-plane-types" role="radiogroup" aria-label="Plane type">
          <button type="button" role="radio" aria-checked={mode === "through-two-edges"} className={mode === "through-two-edges" ? "active" : ""} onClick={() => setMode("through-two-edges")}><CommandIcon name="projection" /><strong>Through two edges</strong><small>Two parallel or crossing straight edges</small></button>
          <button type="button" role="radio" aria-checked={mode === "along-path"} className={mode === "along-path" ? "active" : ""} onClick={() => setMode("along-path")}><CommandIcon name="projection" /><strong>Along a path</strong><small>At a position on a sketch curve or axis</small></button>
        </div>
        {mode === "through-two-edges" && <>
          {edgeEditor("First edge", edgeA, setEdgeA)}
          {edgeEditor("Second edge", edgeB, setEdgeB)}
        </>}
        {mode === "along-path" && <fieldset className="sketch-plane-faces">
          <legend><small className="sketch-plane-faces-title">Path and position</small></legend>
          <label className="sketch-plane-offset"><span>Path from</span><div className="feature-edit-field">
            <select aria-label="Path source" value={pathSource} onChange={(event) => setPathSource(event.target.value as "axis" | "sketch")}>
              {props.paths.length > 0 && <option value="sketch">A sketch curve</option>}
              {props.axes.length > 0 && <option value="axis">A construction axis</option>}
            </select>
          </div></label>
          {pathSource === "sketch" && <label className="sketch-plane-offset"><span>Sketch curve</span><div className="feature-edit-field">
            <select aria-label="Sketch curve" value={sketchPathId} onChange={(event) => setSketchPathId(event.target.value)}>
              {props.paths.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <small>the curve is copied when you make the plane</small>
          </div></label>}
          {pathSource === "axis" && <label className="sketch-plane-offset"><span>Axis</span><div className="feature-edit-field">
            <select aria-label="Path axis" value={pathAxisId} onChange={(event) => setPathAxisId(event.target.value)}>
              {props.axes.map((axis) => <option key={axis.id} value={axis.id}>{axis.name}</option>)}
            </select>
          </div></label>}
          <label className="sketch-plane-offset"><span>Position along the path</span><div className="feature-edit-field">
            <input inputMode="decimal" aria-label="Position along the path in percent" value={tText} onChange={(event) => setTText(event.target.value)} />
            <small>% of the path's length · 0 is the start, 100 the end</small>
          </div></label>
          <label className="sketch-plane-offset"><span>Plane is</span><div className="feature-edit-field">
            <select aria-label="Plane orientation" value={orientation} onChange={(event) => setOrientation(event.target.value as "perpendicular" | "tangent")}>
              <option value="perpendicular">Perpendicular to the path</option>
              <option value="tangent">Tangent: holds the path's direction</option>
            </select>
          </div></label>
        </fieldset>}
        <label className="sketch-plane-offset"><span>Name</span><div className="feature-edit-field">
          <input aria-label="Plane name" placeholder={mode === "through-two-edges" ? "Plane through two edges" : "Plane along path"} value={name} onChange={(event) => setName(event.target.value)} />
        </div></label>
        <p role="status" className={verdict.ok ? "feature-edit-note" : "feature-edit-error"}>{verdict.text}</p>
        <div className="solid-actions">
          <button className="primary" disabled={!verdict.ok} onClick={confirm}><CommandIcon name="insert" />Create plane</button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </section>
  </div>;
}

