import { useEffect, useState } from "react";
import type { DesignSolidFeature, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import { canRepairSketch, designOf, isMarkedBroken, lostSketchOf, previewFieldExpression, repairCandidates, repairSketchReference } from "../../../../packages/workbench-core/src/index.js";
import { applyParameterValues, applyPlainSize, fieldAcceptsExpression, parameterFieldsOf, parameterValuesOf } from "../feature-parameters.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDockedPanel } from "./docked-panel.js";

interface FeatureEditDialogProps {
  /** The feature being edited; the dialog is open while this is defined. */
  readonly feature: DesignSolidFeature | undefined;
  /** The project the step lives in: its parameters and the other steps' numbers are what an expression can name. */
  readonly project: WorkbenchProject;
  readonly busy: boolean;
  readonly onApply: (next: DesignSolidFeature) => void;
  readonly onClose: () => void;
}

type Extent = NonNullable<DesignSolidFeature["extent"]>;
type Direction = NonNullable<DesignSolidFeature["direction"]>;

const EXTENT_LABEL: Readonly<Record<string, string>> = {
  "to-face": "To face (the recorded target)",
  "to-body": "To object (the recorded target)",
  "to-vertex": "To vertex (the recorded target)",
  "to-first": "To first face (the recorded target)",
  "to-last": "To last face (the recorded target)"
};

/**
 * Edit a timeline step: an extrude or revolve has its own form (operation, size, direction, second side, extent, thin wall); every other
 * kind lists its parameters from `parameterFieldsOf`. The form is docked at the right of the window with no backdrop (HS-06), so the model
 * stays live to look at and orbit while it is open; Esc closes it and Update feature applies it. It is a docked panel and not a modal
 * dialog: it has no dialog role, so the Part hotkeys, Ctrl+Z, Ctrl+B and the timeline keep working while it is open, Tab is not trapped
 * in it, and Esc closes it from the canvas too (see docked-panel.ts).
 */
export function FeatureEditDialog(props: FeatureEditDialogProps): React.JSX.Element | null {
  const open = props.feature !== undefined;
  const dock = useDockedPanel<HTMLElement>(open, props.onClose);
  const [value, setValue] = useState("");
  const [direction, setDirection] = useState<Direction>("one-side");
  const [second, setSecond] = useState("10");
  const [extent, setExtent] = useState<Extent>("distance");
  const [thin, setThin] = useState(false);
  const [thinWall, setThinWall] = useState("2");
  const [thinSide, setThinSide] = useState<NonNullable<DesignSolidFeature["thinSide"]>>("inside");
  const [problem, setProblem] = useState("");
  const [operation, setOperation] = useState<"join" | "cut" | "intersect">(() => props.feature?.operation === "cut" || props.feature?.operation === "intersect" ? props.feature.operation : "join");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  /** The sketch picked to replace one that was deleted (empty until the person chooses). */
  const [sketchChoice, setSketchChoice] = useState("");

  useEffect(() => {
    if (props.feature === undefined) return;
    setValue(props.feature.expressions?.[props.feature.kind === "extrude" ? "distance" : "angle"] ?? String(Number(Math.abs(props.feature.valueMm).toFixed(3))));
    setDirection(props.feature.direction ?? "one-side");
    setSecond(String(Number((props.feature.secondValueMm ?? 10).toFixed(3))));
    setExtent(props.feature.extent ?? "distance");
    setThin(props.feature.thinWallMm !== undefined);
    setThinWall(String(props.feature.thinWallMm ?? 2));
    setThinSide(props.feature.thinSide ?? "inside");
    setOperation(props.feature.operation === "cut" || props.feature.operation === "intersect" ? props.feature.operation : "join");
    setValues(parameterValuesOf(props.feature));
    setProblem("");
    setSketchChoice("");
  }, [props.feature?.id]);

  if (props.feature === undefined) return null;
  const feature = props.feature;
  const fields = parameterFieldsOf(feature);
  const plainForm = feature.kind === "extrude" || feature.kind === "revolve";
  const isExtrude = feature.kind === "extrude";
  // A join, cut or intersect step can switch between them; a step that makes a body of its own has no target to switch to.
  const switchable = plainForm && (feature.operation === "join" || feature.operation === "cut" || feature.operation === "intersect");
  // Through-all is for extruded cuts: the cutter is stretched across the body at rebuild time.
  const isCut = isExtrude && (switchable ? operation === "cut" : feature.operation === "cut");
  const throughAll = isCut && extent === "through-all";
  // A "to" extent keeps the target recorded when the step was made; it is offered while the step has one.
  const reaching = feature.extentTarget !== undefined && extent === feature.extent && extent !== "distance" && extent !== "through-all";
  const unit = isExtrude ? "mm" : "°";
  const plainFieldId = isExtrude ? "distance" : "angle";
  const names = [...(designOf(props.project).parameters ?? []).map((parameter) => parameter.name)];
  /** What a non-numeric entry in a field evaluates to, or why it does not, shown under the field as the user types. */
  const live = (fieldId: string, text: string): React.JSX.Element | null => {
    const typed = text.trim();
    if (typed === "" || Number.isFinite(Number(typed.replace(",", "."))) || !fieldAcceptsExpression(feature, fieldId)) return null;
    const preview = previewFieldExpression(props.project, feature, fieldId, typed);
    return preview.ok
      ? <small className="feature-edit-live" role="status">= {preview.text}</small>
      : <small className="feature-edit-live failed" role="alert">{preview.message}{preview.position === undefined ? "" : ` (character ${preview.position + 1})`}</small>;
  };

  // A step whose sketch was deleted (Delete only this step keeps it) offers the sketches before it to be built on instead.
  const history = designOf(props.project);
  const lostSketch = lostSketchOf(history, feature) !== undefined;
  const repairable = lostSketch && canRepairSketch(feature);
  const candidates = repairable ? repairCandidates(history, feature.id) : [];
  const turnsAboutLostLine = repairable && feature.revolveAxis?.kind === "sketch-line";

  const apply = (): void => {
    let working = feature;
    if (repairable) {
      if (sketchChoice === "") { setProblem("Choose the sketch this step should be built on, or cancel and delete the step."); return; }
      const repair = repairSketchReference(history, feature, sketchChoice);
      if (!repair.ok) { setProblem(repair.message); return; }
      working = repair.feature;
    } else if (lostSketch) { setProblem(`${feature.name} cannot take another sketch here. Delete it and build it again from a sketch.`); return; }
    if (fields !== undefined) {
      const result = applyParameterValues(working, values, props.project);
      if (!result.ok) { setProblem(result.message); return; }
      props.onApply(result.feature);
      return;
    }
    if (!plainForm) { props.onClose(); return; }
    const result = applyPlainSize(working, {
      text: value, direction, throughAll, reaching, secondText: second,
      ...(switchable && operation !== feature.operation ? { operation } : {}),
      ...(!isExtrude && thin ? { thin: { wallText: thinWall, side: thinSide } } : {})
    }, props.project);
    if (!result.ok) { setProblem(result.message); return; }
    props.onApply(result.feature);
  };

  return <div className="dialog-backdrop save-project-backdrop feature-edit-dock" role="presentation" style={dock.style}>
    <section ref={dock.ref} tabIndex={-1} className="save-project-dialog feature-edit-dialog" role="region" aria-labelledby="feature-edit-title">
      <header><span><CommandIcon name={feature.kind} /></span><div><small>TIMELINE / EDIT FEATURE</small><h2 id="feature-edit-title">{feature.name}</h2></div><button onClick={props.onClose} aria-label="Cancel editing"><CommandIcon name="cancel" /></button></header>
      <div className="save-project-content feature-edit-form">
        {isMarkedBroken(feature) && <div className="inline-warning feature-edit-broken" role="alert">{feature.health?.message}</div>}
        {repairable && <label>
          <span>Sketch</span>
          {candidates.length === 0
            ? <small className="feature-edit-hint">No sketch comes before this step. Cancel and draw one first, or delete the step.</small>
            : <select aria-label="Replacement sketch" value={sketchChoice} onChange={(event) => { setSketchChoice(event.target.value); setProblem(""); }}>
              <option value="">Choose the sketch to build on…</option>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>}
          <small className="feature-edit-hint">The profile is picked again from the new sketch (its outer outline, with the shapes inside it as holes).{turnsAboutLostLine ? " The step turned about a line of the deleted sketch; it will turn about the sketch's Y axis." : ""}</small>
        </label>}
        {lostSketch && !repairable && <div className="save-project-note"><CommandIcon name="shield" /><span>The sketch this step was built on was deleted, and this kind of step cannot take another one here. Delete it and build it again.</span></div>}
        {fields !== undefined && fields.map((field, index) => <label key={field.id}>
          <span>{field.label}</span>
          {field.input === "select"
            ? <select aria-label={field.label} value={values[field.id] ?? ""} onChange={(event) => { setValues({ ...values, [field.id]: event.target.value }); setProblem(""); }}>
              {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            : <div className="feature-edit-field">
              <input
                {...(index === 0 ? { "data-dialog-initial-focus": true } : {})}
                inputMode="text"
                spellCheck={false}
                aria-label={field.label}
                value={values[field.id] ?? ""}
                onChange={(event) => { setValues({ ...values, [field.id]: event.target.value }); setProblem(""); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
              />
              {field.unit !== "" && <small>{field.unit}</small>}
            </div>}
          {field.input !== "select" && field.input !== "vector" && live(field.id, values[field.id] ?? "")}
          {field.hint !== undefined && <small className="feature-edit-hint">{field.hint}</small>}
        </label>)}
        {!plainForm && fields === undefined && <div className="save-project-note"><CommandIcon name="shield" /><span>This step has no numbers to edit. Delete it from the timeline, or suppress it, to change the result.</span></div>}
        {switchable && <label>
          <span>Operation</span>
          <select value={operation} aria-label="Operation" onChange={(event) => {
            const next = event.target.value as "join" | "cut" | "intersect";
            setOperation(next);
            // Through all belongs to a cut only: leaving the cut puts the extent back to a distance.
            if (next !== "cut" && extent === "through-all") setExtent("distance");
            setProblem("");
          }}>
            <option value="join">Join (add to the solid)</option>
            <option value="cut">Cut (remove from the solid)</option>
            <option value="intersect">Intersect (keep only the overlap)</option>
          </select>
        </label>}
        {plainForm && (isCut || feature.extentTarget !== undefined) && <label>
          <span>Extent</span>
          <select value={extent} aria-label="Cut extent" onChange={(event) => { setExtent(event.target.value as Extent); setProblem(""); }}>
            <option value="distance">{isExtrude ? "Distance" : "Angle"}</option>
            {isCut && <option value="through-all">Through all (the whole solid)</option>}
            {feature.extentTarget !== undefined && feature.extent !== undefined && feature.extent !== "distance" && feature.extent !== "through-all" && <option value={feature.extent}>{EXTENT_LABEL[feature.extent] ?? feature.extent}</option>}
          </select>
        </label>}
        {plainForm && <label>
          <span>{isExtrude ? "Distance" : "Angle"}</span>
          <div className="feature-edit-field">
            <input
              data-dialog-initial-focus
              inputMode="text"
              spellCheck={false}
              aria-label={isExtrude ? "Distance in millimetres" : "Angle in degrees"}
              value={throughAll ? "through all" : reaching ? `measured from the target (${value} ${unit} when last set)` : value}
              disabled={throughAll || reaching}
              onChange={(event) => { setValue(event.target.value); setProblem(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
            />
            {!reaching && <small>{unit}</small>}
          </div>
          {!throughAll && !reaching && live(plainFieldId, value)}
        </label>}
        {plainForm && !throughAll && <label>
          <span>Direction</span>
          <select value={direction} aria-label={isExtrude ? "Extrusion direction" : "Revolve direction"} onChange={(event) => { setDirection(event.target.value as Direction); setProblem(""); }}>
            <option value="one-side">{isExtrude ? "One side (along the plane normal)" : "One side (along the sketch plane's turn)"}</option>
            <option value="symmetric" disabled={reaching}>Symmetric (half each way)</option>
            <option value="flipped">Flipped (against the normal)</option>
            <option value="two-side" disabled={reaching && !isExtrude}>Two sides (a different amount each way)</option>
          </select>
        </label>}
        {plainForm && !throughAll && direction === "two-side" && <label>
          <span>Second side</span>
          <div className="feature-edit-field">
            <input inputMode="decimal" aria-label={isExtrude ? "Second side distance in millimetres" : "Second side angle in degrees"} value={second} onChange={(event) => { setSecond(event.target.value); setProblem(""); }} />
            <small>{unit}</small>
          </div>
        </label>}
        {!isExtrude && plainForm && <label>
          <span>Thin wall</span>
          <div className="feature-edit-field">
            <input type="checkbox" aria-label="Thin wall" checked={thin} onChange={(event) => { setThin(event.target.checked); setProblem(""); }} />
            {thin && <input inputMode="decimal" aria-label="Thin wall thickness in millimetres" value={thinWall} onChange={(event) => { setThinWall(event.target.value); setProblem(""); }} />}
            {thin && <small>mm</small>}
          </div>
        </label>}
        {!isExtrude && plainForm && thin && <label>
          <span>Wall side</span>
          <select value={thinSide} aria-label="Thin wall side" onChange={(event) => setThinSide(event.target.value as NonNullable<DesignSolidFeature["thinSide"]>)}>
            <option value="inside">Inside the outline</option>
            <option value="outside">Outside the outline</option>
            <option value="center">Centered on it</option>
          </select>
        </label>}
        {(fields !== undefined || plainForm) && <p className="feature-edit-expression-hint">Type a number, or an expression such as <code>2 * pin_r</code> or <code>Extrude1.distance / 2</code>{names.length === 0 ? "." : `. Parameters: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}.`}</p>}
        {problem !== "" && <div className="inline-warning" role="alert">{problem}</div>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>The solid is rebuilt from the sketch it was made from. Steps built on this one rebuild with it, and Undo restores the previous solid.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" disabled={props.busy} onClick={apply}><CommandIcon name={feature.kind} />Update feature</button></footer>
    </section>
  </div>;
}
