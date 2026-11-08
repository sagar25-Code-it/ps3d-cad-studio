import { useEffect, useState } from "react";
import type { DesignSolidFeature } from "../../../../packages/workbench-core/src/index.js";
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

/** Edit a timeline step: an extrude or revolve has its own form (size, direction, cut extent); every other kind lists its parameters from `parameterFieldsOf`. */
export function FeatureEditDialog(props: FeatureEditDialogProps): React.JSX.Element | null {
  const open = props.feature !== undefined;
  const dialogRef = useDialogFocus<HTMLElement>(open, props.onClose);
  const [value, setValue] = useState("");
  const [direction, setDirection] = useState<NonNullable<DesignSolidFeature["direction"]>>("one-side");
  const [extent, setExtent] = useState<"distance" | "through-all">("distance");
  const [problem, setProblem] = useState("");
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    if (props.feature === undefined) return;
    setValue(String(Number(Math.abs(props.feature.valueMm).toFixed(3))));
    setDirection(props.feature.direction ?? "one-side");
    setExtent(props.feature.extent === "through-all" ? "through-all" : "distance");
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

  const apply = (): void => {
    if (fields !== undefined) {
      const result = applyParameterValues(feature, values);
      if (!result.ok) { setProblem(result.message); return; }
      props.onApply(result.feature);
      return;
    }
    if (!plainForm) { props.onClose(); return; }
    const parsed = throughAll ? Math.abs(feature.valueMm) : Number(value.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0 || (!isExtrude && parsed > 360)) {
      setProblem(isExtrude ? "Enter a distance greater than zero." : "Enter an angle between 0 and 360 degrees.");
      return;
    }
    const { direction: _previous, extent: _extent, ...rest } = feature;
    props.onApply({ ...rest, valueMm: parsed, ...(isExtrude && direction !== "one-side" && !throughAll ? { direction } : {}), ...(throughAll ? { extent: "through-all" as const } : {}) });
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
        {plainForm && isCut && <label>
          <span>Extent</span>
          <select value={extent} aria-label="Cut extent" onChange={(event) => { setExtent(event.target.value === "through-all" ? "through-all" : "distance"); setProblem(""); }}>
            <option value="distance">Distance</option>
            <option value="through-all">Through all (the whole solid)</option>
          </select>
        </label>}
        {plainForm && <label>
          <span>{isExtrude ? "Distance" : "Angle"}</span>
          <div className="feature-edit-field">
            <input
              data-dialog-initial-focus
              inputMode="decimal"
              aria-label={isExtrude ? "Distance in millimetres" : "Angle in degrees"}
              value={throughAll ? "through all" : value}
              disabled={throughAll}
              onChange={(event) => { setValue(event.target.value); setProblem(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
            />
            <small>{isExtrude ? "mm" : "°"}</small>
          </div>
        </label>}
        {isExtrude && !throughAll && <label>
          <span>Direction</span>
          <select value={direction} aria-label="Extrusion direction" onChange={(event) => setDirection(event.target.value as NonNullable<DesignSolidFeature["direction"]>)}>
            <option value="one-side">One side (along the plane normal)</option>
            <option value="symmetric">Symmetric (half each way)</option>
            <option value="flipped">Flipped (against the normal)</option>
          </select>
        </label>}
        {problem !== "" && <div className="inline-warning" role="alert">{problem}</div>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>The solid is rebuilt from the sketch it was made from. Steps built on this one rebuild with it, and Undo restores the previous solid.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" disabled={props.busy} onClick={apply}><CommandIcon name={feature.kind} />Update feature</button></footer>
    </section>
  </div>;
}
