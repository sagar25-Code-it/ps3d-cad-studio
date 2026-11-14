import { useEffect, useMemo, useRef, useState } from "react";
import { describeFailure } from "../failure-text.js";
import type { DesignParameter, ModelValueEdit, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import { analyseModelRows, analyseParameterRows, groupModelParameterRows, modelParameterRowsOf, modelValueEditsOf, nextParameterName, parameterOperationOf, parameterRowsOf, type ModelParameterRow, type ParameterRow } from "../parameter-rows.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface ChangeParametersDialogProps {
  readonly open: boolean;
  readonly project: WorkbenchProject;
  readonly busy: boolean;
  /**
   * Applies the table: the user parameters, the renames and the model values that were edited. Resolves to a message when the project
   * refused it, or undefined when it was applied. `keepOpen` leaves the table open (the Apply button) instead of closing it (OK).
   */
  readonly onApply: (parameters: readonly DesignParameter[], renames: readonly { readonly from: string; readonly to: string }[], modelValues: readonly ModelValueEdit[], keepOpen: boolean) => Promise<string | undefined>;
  readonly onClose: () => void;
}

/**
 * Change Parameters: the table of user parameters (name, expression, unit, comment) with live checking. Each row shows what its
 * expression gives and what is wrong with it, and which steps and dimensions use it; Apply is available only when nothing blocks.
 * Applying re-evaluates every bound number and rebuilds the solids that depend on them.
 */
export function ChangeParametersDialog(props: ChangeParametersDialogProps): React.JSX.Element | null {
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);
  const [rows, setRows] = useState<readonly ParameterRow[]>(() => props.open ? parameterRowsOf(props.project) : []);
  const [refusal, setRefusal] = useState("");
  const [counter, setCounter] = useState(0);
  const [modelRows, setModelRows] = useState<readonly ModelParameterRow[]>(() => props.open ? modelParameterRowsOf(props.project) : []);
  /** Set just before an Apply that keeps the table open: the next project to arrive is shown in the table again. */
  const reseed = useRef(false);

  useEffect(() => {
    if (!props.open) return;
    setRows(parameterRowsOf(props.project));
    setModelRows(modelParameterRowsOf(props.project));
    setRefusal("");
    setCounter(0);
  }, [props.open]);
  // After Apply the table stays open and shows what the project came to (a new value, a rebuilt number), so a second change starts from it.
  useEffect(() => {
    if (!props.open || !reseed.current) return;
    reseed.current = false;
    setRows(parameterRowsOf(props.project));
    setModelRows(modelParameterRowsOf(props.project));
  }, [props.project]);

  const report = useMemo(() => analyseParameterRows(props.project, rows), [props.project, rows]);
  const modelReport = useMemo(() => analyseModelRows(props.project, modelRows), [props.project, modelRows]);
  const modelGroups = useMemo(() => groupModelParameterRows(modelRows), [modelRows]);
  const modelChanged = modelRows.filter((row) => row.typed.trim() !== row.text.trim()).length;
  const modelBlocked = Object.values(modelReport).some((entry) => entry.problem !== undefined);

  if (!props.open) return null;

  const edit = (key: string, change: Partial<ParameterRow>): void => { setRows(rows.map((row) => row.key === key ? { ...row, ...change } : row)); setRefusal(""); };
  const add = (): void => {
    setRows([...rows, { key: `new-${counter}`, name: nextParameterName(rows), expression: "10", unit: "mm", comment: "" }]);
    setCounter(counter + 1);
    setRefusal("");
  };
  const remove = (key: string): void => { setRows(rows.filter((row) => row.key !== key)); setRefusal(""); };
  const editModel = (key: string, typed: string): void => { setModelRows(modelRows.map((row) => row.key === key ? { ...row, typed } : row)); setRefusal(""); };
  const apply = async (keepOpen: boolean): Promise<void> => {
    if (!report.ready || modelBlocked) return;
    const operation = parameterOperationOf(rows);
    reseed.current = keepOpen;
    try {
      const message = await props.onApply(operation.parameters, operation.renames, modelValueEditsOf(modelRows), keepOpen);
      if (message !== undefined) { reseed.current = false; setRefusal(message); }
    } catch (failure) {
      reseed.current = false;
      setRefusal(describeFailure(failure, "Saving the parameters"));
    }
  };

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog parameters-dialog" role="dialog" aria-modal="true" aria-labelledby="parameters-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="dimension" /></span><div><small>MODIFY / PARAMETERS</small><h2 id="parameters-title">Change parameters</h2></div><button onClick={props.onClose} aria-label="Close without applying"><CommandIcon name="cancel" /></button></header>
      <div className="save-project-content parameters-content">
        <p className="parameters-intro">A parameter is a named value. Use it in any feature field or sketch dimension: type <code>2 * pin_r</code> instead of a number. Units: mm, cm, m, in, deg, rad. A step&apos;s own numbers can be used too, like <code>Extrude1.distance / 2</code>.</p>
        <div className="parameters-table" role="table" aria-label="User parameters">
          <div className="parameters-row parameters-head" role="row"><span role="columnheader">Name</span><span role="columnheader">Expression</span><span role="columnheader">Unit</span><span role="columnheader">Value</span><span role="columnheader">Comment</span><span role="columnheader" aria-hidden="true" /></div>
          {rows.length === 0 && <p className="parameters-empty">No parameters yet. Add one, then use its name in a feature or a sketch dimension.</p>}
          {rows.map((row, index) => {
            const info = report.rows[row.key];
            const problem = info?.nameProblem ?? info?.expressionProblem;
            return <div key={row.key} className={`parameters-row${problem === undefined ? "" : " has-problem"}`} role="row">
              <input aria-label={`Name of parameter ${index + 1}`} value={row.name} spellCheck={false} {...(index === 0 ? { "data-dialog-initial-focus": true } : {})} aria-invalid={info?.nameProblem !== undefined} onChange={(event) => edit(row.key, { name: event.target.value })} />
              <input aria-label={`Expression of ${row.name}`} value={row.expression} spellCheck={false} aria-invalid={info?.expressionProblem !== undefined} onChange={(event) => edit(row.key, { expression: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(false); } }} />
              <select aria-label={`Unit of ${row.name}`} value={row.unit} onChange={(event) => edit(row.key, { unit: event.target.value === "mm" ? "mm" : event.target.value === "deg" ? "deg" : "" })}>
                <option value="mm">mm (length)</option><option value="deg">deg (angle)</option><option value="">number</option>
              </select>
              <output aria-label={`Value of ${row.name}`}>{info?.valueText ?? "—"}</output>
              <input aria-label={`Comment on ${row.name}`} value={row.comment} onChange={(event) => edit(row.key, { comment: event.target.value })} />
              <button type="button" aria-label={`Remove ${row.name}`} onClick={() => remove(row.key)}><CommandIcon name="trash" /></button>
              {problem !== undefined && <p className="parameters-problem" role="alert">{problem}</p>}
              {info !== undefined && info.usedBy.length > 0 && <p className="parameters-used">Used by {info.usedBy.slice(0, 4).join(", ")}{info.usedBy.length > 4 ? ` and ${info.usedBy.length - 4} more` : ""}</p>}
            </div>;
          })}
        </div>
        <button type="button" className="parameters-add" onClick={add}><CommandIcon name="insert" />Add parameter</button>
        {report.tableProblem !== undefined && <div className="inline-warning" role="alert">{report.tableProblem}</div>}
        {refusal !== "" && <div className="inline-warning" role="alert">{refusal}</div>}
        {modelRows.length > 0 && <details className="parameters-model" open>
          <summary>Model parameters<small>{modelRows.length} number{modelRows.length === 1 ? "" : "s"} in the timeline{modelChanged === 0 ? "" : ` · ${modelChanged} changed`}</small></summary>
          <p className="parameters-model-intro">Every number a step takes and every driving dimension of a sketch. Type a number, or an expression that uses a parameter or another number (<code>plate_w / 2</code>, <code>d1 * 2</code>, <code>Extrude1.distance</code>).</p>
          <div className="parameters-model-table" role="table" aria-label="Model parameters">
            {modelGroups.map((group) => <div key={group.ownerId} className="parameters-model-group" role="rowgroup" aria-label={group.group}>
              <h3>{group.group}<small>{group.groupKind === "sketch" ? "sketch dimensions" : "step"}</small></h3>
              {group.rows.map((row) => {
                const info = modelReport[row.key];
                return <div key={row.key} className={`parameters-model-row${info?.problem === undefined ? "" : " has-problem"}`} role="row">
                  <span className="parameters-model-name"><strong>{row.name}</strong>{row.detail === "" ? null : <small>{row.detail}</small>}</span>
                  <input aria-label={`Expression of ${row.group} ${row.name}`} value={row.typed} spellCheck={false} aria-invalid={info?.problem !== undefined} onChange={(event) => editModel(row.key, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(false); } }} />
                  <output aria-label={`Value of ${row.group} ${row.name}`}>{info?.valueText ?? `${Number(row.value.toFixed(6))}${row.unit === "mm" ? " mm" : row.unit === "deg" ? "°" : ""}`}{row.bound && info === undefined ? <em title="Driven by an expression"> fx</em> : null}</output>
                  {info?.problem !== undefined && <p className="parameters-problem" role="alert">{info.problem}</p>}
                </div>;
              })}
            </div>)}
          </div>
        </details>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>Renaming a parameter rewrites every expression that uses it. A value that stops evaluating keeps its last good number and is flagged in the timeline; the solid is not changed. Undo restores the previous values.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button disabled={props.busy || !report.ready || modelBlocked} onClick={() => void apply(true)} title="Apply the changes and rebuild; the table stays open for the next change.">Apply</button><button className="primary" disabled={props.busy || !report.ready || modelBlocked} onClick={() => void apply(false)} title="Apply the changes, rebuild and close."><CommandIcon name="update-model" />OK</button></footer>
    </section>
  </div>;
}
