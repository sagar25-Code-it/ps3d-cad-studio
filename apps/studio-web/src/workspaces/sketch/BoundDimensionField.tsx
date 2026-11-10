import { useEffect, useId, useState } from "react";
import { readDimensionText } from "../../../../../packages/workbench-sketch/src/dimension-text.js";
import type { SketchLengthUnit } from "../../../../../packages/workbench-sketch/src/sketch-units.js";
import type { AcceptedDimensionRead } from "./dimension-requests.js";

/**
 * One inspector field for a dimension. It takes a number with a unit (`12`, `0.5 in`, `45`) or a parameter name or expression
 * (`plate_w / 4`), which binds the dimension so it follows that parameter. A bound dimension shows its expression, so it can be
 * edited as text. The same reader serves every dimension field, so a distance from the origin, a hole diameter, an ellipse radius and
 * an angle all accept the same things.
 */
export interface BoundDimensionFieldProps {
  readonly label: string;
  /** Names the field in a message: "the distance", "the diameter". Defaults to the label in lower case. */
  readonly subject?: string;
  readonly ariaLabel: string;
  /** The current value as the field's text, in the display unit. */
  readonly valueText: string;
  /** The expression the dimension is bound to, shown instead of the value. */
  readonly boundExpression?: string | undefined;
  /** The unit a bare number is read in. */
  readonly unit: SketchLengthUnit;
  /** The unit shown beside the field: "mm", "in" or "°". */
  readonly unitLabel: string;
  readonly angle?: boolean;
  readonly zeroAllowed?: boolean;
  readonly placeholder?: string;
  readonly submitLabel?: string;
  readonly submitTitle?: string;
  readonly submitDisabled?: boolean;
  readonly submitIcon?: React.ReactNode;
  /** Extra buttons after the submit button (Reference). */
  readonly children?: React.ReactNode;
  readonly onSubmit: (read: AcceptedDimensionRead) => void;
  readonly onMessage: (message: string) => void;
}

export function BoundDimensionField(props: BoundDimensionFieldProps): React.JSX.Element {
  const shown = props.boundExpression ?? props.valueText;
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown, props.unit]);
  const hintId = useId();
  const subject = props.subject ?? props.label.toLowerCase();
  return <form className="dimension-field" onSubmit={(event) => {
    event.preventDefault();
    const read = readDimensionText(draft, { unit: props.unit, subject, ...(props.angle === true ? { angle: true } : {}), ...(props.zeroAllowed === true ? { zeroAllowed: true } : {}) });
    if (read.kind === "invalid") { props.onMessage(`${props.label}: ${read.message}`); return; }
    props.onSubmit(read);
  }}>
    <label><span>{props.label}</span><div>
      <input
        aria-label={props.ariaLabel}
        aria-describedby={hintId}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        placeholder={props.placeholder ?? ""}
        onChange={(event) => setDraft(event.target.value)}
      />
      <small>{props.unitLabel}</small>
      <button type="submit" disabled={props.submitDisabled === true} title={props.submitTitle ?? "Drive the geometry to this value and hold it"}>{props.submitIcon}{props.submitLabel ?? "Apply"}</button>
      {props.children}
    </div></label>
    <span className="sketch-sr-only" id={hintId}>{props.angle === true ? "Type degrees, or a parameter name or expression such as turn_angle / 2 to bind the angle to it." : "Type a number with an optional unit, or a parameter name or expression such as plate_w / 4 to bind the dimension to it."}{props.boundExpression === undefined ? "" : ` Bound to ${props.boundExpression}.`}</span>
    {props.boundExpression !== undefined && <small className="dimension-bound" title="Edit the expression, or type a plain number to unbind it">Bound to a parameter: {props.boundExpression}</small>}
  </form>;
}
