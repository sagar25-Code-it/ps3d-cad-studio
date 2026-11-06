import { useEffect, useState } from "react";
import type { DesignSolidFeature } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface FeatureEditDialogProps {
  /** The feature being edited; the dialog is open while this is defined. */
  readonly feature: DesignSolidFeature | undefined;
  readonly busy: boolean;
  readonly onApply: (next: DesignSolidFeature) => void;
  readonly onClose: () => void;
}

/** Edit a timeline extrude or revolve: its size and, for an extrude, which way it goes from the sketch plane. */
export function FeatureEditDialog(props: FeatureEditDialogProps): React.JSX.Element | null {
  const open = props.feature !== undefined;
  const dialogRef = useDialogFocus<HTMLElement>(open, props.onClose);
  const [value, setValue] = useState("");
  const [direction, setDirection] = useState<NonNullable<DesignSolidFeature["direction"]>>("one-side");
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (props.feature === undefined) return;
    setValue(String(Number(Math.abs(props.feature.valueMm).toFixed(3))));
    setDirection(props.feature.direction ?? "one-side");
    setProblem("");
  }, [props.feature?.id]);

  if (props.feature === undefined) return null;
  const feature = props.feature;
  const isExtrude = feature.kind === "extrude";

  const apply = (): void => {
    const parsed = Number(value.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0 || (!isExtrude && parsed > 360)) {
      setProblem(isExtrude ? "Enter a distance greater than zero." : "Enter an angle between 0 and 360 degrees.");
      return;
    }
    const { direction: _previous, ...rest } = feature;
    props.onApply({ ...rest, valueMm: parsed, ...(isExtrude && direction !== "one-side" ? { direction } : {}) });
  };

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog feature-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="feature-edit-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name={feature.kind} /></span><div><small>TIMELINE / EDIT FEATURE</small><h2 id="feature-edit-title">{feature.name}</h2></div><button onClick={props.onClose} aria-label="Cancel editing"><CommandIcon name="cancel" /></button></header>
      <div className="save-project-content feature-edit-form">
        <label>
          <span>{isExtrude ? "Distance" : "Angle"}</span>
          <div className="feature-edit-field">
            <input
              data-dialog-initial-focus
              inputMode="decimal"
              aria-label={isExtrude ? "Distance in millimetres" : "Angle in degrees"}
              value={value}
              onChange={(event) => { setValue(event.target.value); setProblem(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
            />
            <small>{isExtrude ? "mm" : "°"}</small>
          </div>
        </label>
        {isExtrude && <label>
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
