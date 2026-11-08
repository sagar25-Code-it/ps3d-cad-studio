import { useEffect, useState } from "react";
import type { DesignSolidFeature } from "../../../../packages/workbench-core/src/index.js";
import { validSolidFeaturePayload } from "../../../../packages/workbench-core/src/index.js";
import { applyParameterValues, parameterFieldsOf, parameterValuesOf } from "../feature-parameters.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface FeatureEditDialogProps {
  /** The feature being edited; the dialog is open while this is defined. */
  readonly feature: DesignSolidFeature | undefined;
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

/** Edit a timeline step: an extrude or revolve has its own form (size, direction, second side, extent, thin wall); every other kind lists its parameters from `parameterFieldsOf`. */
export function FeatureEditDialog(props: FeatureEditDialogProps): React.JSX.Element | null {
  const open = props.feature !== undefined;
  const dialogRef = useDialogFocus<HTMLElement>(open, props.onClose);
  const [value, setValue] = useState("");
  const [direction, setDirection] = useState<Direction>("one-side");
  const [second, setSecond] = useState("10");
  const [extent, setExtent] = useState<Extent>("distance");
  const [thin, setThin] = useState(false);
  const [thinWall, setThinWall] = useState("2");
  const [thinSide, setThinSide] = useState<NonNullable<DesignSolidFeature["thinSide"]>>("inside");
  const [problem, setProblem] = useState("");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    if (props.feature === undefined) return;
    setValue(String(Number(Math.abs(props.feature.valueMm).toFixed(3))));
    setDirection(props.feature.direction ?? "one-side");
    setSecond(String(Number((props.feature.secondValueMm ?? 10).toFixed(3))));
    setExtent(props.feature.extent ?? "distance");
    setThin(props.feature.thinWallMm !== undefined);
    setThinWall(String(props.feature.thinWallMm ?? 2));
    setThinSide(props.feature.thinSide ?? "inside");
    setValues(parameterValuesOf(props.feature));
    setProblem("");
  }, [props.feature?.id]);

  if (props.feature === undefined) return null;
  const feature = props.feature;
  const fields = parameterFieldsOf(feature);
  const plainForm = feature.kind === "extrude" || feature.kind === "revolve";
  const isExtrude = feature.kind === "extrude";
  // Through-all is for extruded cuts: the cutter is stretched across the body at rebuild time.
  const isCut = isExtrude && feature.operation === "cut";
  const throughAll = isCut && extent === "through-all";
  // A "to" extent keeps the target recorded when the step was made; it is offered while the step has one.
  const reaching = feature.extentTarget !== undefined && extent === feature.extent && extent !== "distance" && extent !== "through-all";
  const unit = isExtrude ? "mm" : "°";

  const apply = (): void => {
    if (fields !== undefined) {
      const result = applyParameterValues(feature, values);
      if (!result.ok) { setProblem(result.message); return; }
      props.onApply(result.feature);
      return;
    }
    if (!plainForm) { props.onClose(); return; }
    const parsed = throughAll || reaching ? Math.abs(feature.valueMm) : Number(value.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0 || (!isExtrude && parsed > 360)) {
      setProblem(isExtrude ? "Enter a distance greater than zero." : "Enter an angle between 0 and 360 degrees.");
      return;
    }
    const secondParsed = Number(second.trim().replace(",", "."));
    if (direction === "two-side" && (!Number.isFinite(secondParsed) || secondParsed <= 0)) { setProblem(`Enter a second ${isExtrude ? "distance" : "angle"} greater than zero.`); return; }
    if (!isExtrude && direction === "two-side" && !reaching && parsed + secondParsed > 360) { setProblem("The two angles add up to more than a full turn."); return; }
    const wallParsed = Number(thinWall.trim().replace(",", "."));
    if (!isExtrude && thin && (!Number.isFinite(wallParsed) || wallParsed <= 0)) { setProblem("Enter a wall thickness greater than zero."); return; }
    const { direction: _direction, extent: _extent, extentTarget: _target, secondValueMm: _second, thinWallMm: _wall, thinSide: _side, ...rest } = feature;
    void _direction; void _extent; void _target; void _second; void _wall; void _side;
    const next: DesignSolidFeature = {
      ...rest,
      valueMm: parsed,
      ...(direction !== "one-side" && !throughAll ? { direction } : {}),
      ...(direction === "two-side" && !throughAll ? { secondValueMm: secondParsed } : {}),
      ...(throughAll ? { extent: "through-all" as const } : {}),
      ...(reaching && feature.extentTarget !== undefined && feature.extent !== undefined ? { extent: feature.extent, extentTarget: feature.extentTarget } : {}),
      ...(!isExtrude && thin ? { thinWallMm: wallParsed, thinSide } : {})
    };
    if (!validSolidFeaturePayload(next)) { setProblem("Those settings do not go together. A To extent cannot be symmetric or (for a revolve) two-sided."); return; }
    props.onApply(next);
  };

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog feature-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="feature-edit-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name={feature.kind} /></span><div><small>TIMELINE / EDIT FEATURE</small><h2 id="feature-edit-title">{feature.name}</h2></div><button onClick={props.onClose} aria-label="Cancel editing"><CommandIcon name="cancel" /></button></header>
      <div className="save-project-content feature-edit-form">
        {fields !== undefined && fields.map((field, index) => <label key={field.id}>
          <span>{field.label}</span>
          {field.input === "select"
            ? <select aria-label={field.label} value={values[field.id] ?? ""} onChange={(event) => { setValues({ ...values, [field.id]: event.target.value }); setProblem(""); }}>
              {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            : <div className="feature-edit-field">
              <input
                {...(index === 0 ? { "data-dialog-initial-focus": true } : {})}
                inputMode={field.input === "vector" ? "text" : "decimal"}
                aria-label={field.label}
                value={values[field.id] ?? ""}
                onChange={(event) => { setValues({ ...values, [field.id]: event.target.value }); setProblem(""); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
              />
              {field.unit !== "" && <small>{field.unit}</small>}
            </div>}
          {field.hint !== undefined && <small className="feature-edit-hint">{field.hint}</small>}
        </label>)}
        {!plainForm && fields === undefined && <div className="save-project-note"><CommandIcon name="shield" /><span>This step has no numbers to edit. Delete it from the timeline, or suppress it, to change the result.</span></div>}
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
              inputMode="decimal"
              aria-label={isExtrude ? "Distance in millimetres" : "Angle in degrees"}
              value={throughAll ? "through all" : reaching ? `measured from the target (${value} ${unit} when last set)` : value}
              disabled={throughAll || reaching}
              onChange={(event) => { setValue(event.target.value); setProblem(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
            />
            {!reaching && <small>{unit}</small>}
          </div>
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
        {problem !== "" && <div className="inline-warning" role="alert">{problem}</div>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>The solid is rebuilt from the sketch it was made from. Steps built on this one rebuild with it, and Undo restores the previous solid.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" disabled={props.busy} onClick={apply}><CommandIcon name={feature.kind} />Update feature</button></footer>
    </section>
  </div>;
}
