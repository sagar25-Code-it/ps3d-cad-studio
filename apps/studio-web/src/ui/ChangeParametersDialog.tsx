import { useEffect, useMemo, useState } from "react";
import type { DesignParameter, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import { analyseParameterRows, boundValuesOf, nextParameterName, parameterOperationOf, parameterRowsOf, type ParameterRow } from "../parameter-rows.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface ChangeParametersDialogProps {
  readonly open: boolean;
  readonly project: WorkbenchProject;
  readonly busy: boolean;
  /** Applies the table. Resolves to a message when the project refused it, or undefined when it was applied. */
  readonly onApply: (parameters: readonly DesignParameter[], renames: readonly { readonly from: string; readonly to: string }[]) => Promise<string | undefined>;
  readonly onClose: () => void;
}

/**
 * Change Parameters: the table of user parameters (name, expression, unit, comment) with live checking. Each row shows what its
 * expression gives and what is wrong with it, and which steps and dimensions use it; Apply is available only when nothing blocks.
 * Applying re-evaluates every bound number and rebuilds the solids that depend on them.
 */
export function ChangeParametersDialog(props: ChangeParametersDialogProps): React.JSX.Element | null {
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);
  const [rows, setRows] = useState<readonly ParameterRow[]>([]);
  const [refusal, setRefusal] = useState("");
  const [counter, setCounter] = useState(0);

  useEffect(() => {
    if (!props.open) return;
    setRows(parameterRowsOf(props.project));
    setRefusal("");
    setCounter(0);
  }, [props.open]);

  const report = useMemo(() => analyseParameterRows(props.project, rows), [props.project, rows]);
  const bound = useMemo(() => (props.open ? boundValuesOf(props.project) : []), [props.open, props.project]);

  if (!props.open) return null;

  const edit = (key: string, change: Partial<ParameterRow>): void => { setRows(rows.map((row) => row.key === key ? { ...row, ...change } : row)); setRefusal(""); };
  const add = (): void => {
    setRows([...rows, { key: `new-${counter}`, name: nextParameterName(rows), expression: "10", unit: "mm", comment: "" }]);
    setCounter(counter + 1);
    setRefusal("");
  };
  const remove = (key: string): void => { setRows(rows.filter((row) => row.key !== key)); setRefusal(""); };
  const apply = async (): Promise<void> => {
    if (!report.ready) return;
    const operation = parameterOperationOf(rows);
    const message = await props.onApply(operation.parameters, operation.renames);
    if (message !== undefined) setRefusal(message);
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
              <input aria-label={`Expression of ${row.name}`} value={row.expression} spellCheck={false} aria-invalid={info?.expressionProblem !== undefined} onChange={(event) => edit(row.key, { expression: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(); } }} />
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
        {bound.length > 0 && <details className="parameters-bound" open>
          <summary>{bound.length} bound value{bound.length === 1 ? "" : "s"} in the model</summary>
          <ul>
            {bound.map((binding) => <li key={`${binding.label}|${binding.expression}`} className={binding.problem === undefined ? "" : "failed"}>
              <span><strong>{binding.label}</strong><small><code>{binding.expression}</code>{binding.problem === undefined ? ` = ${binding.valueText}` : ` — ${binding.problem}`}</small></span>
            </li>)}
          </ul>
        </details>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>Renaming a parameter rewrites every expression that uses it. A value that stops evaluating keeps its last good number and is flagged in the timeline; the solid is not changed. Undo restores the previous values.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" disabled={props.busy || !report.ready} onClick={() => void apply()}><CommandIcon name="update-model" />Apply and rebuild</button></footer>
    </section>
  </div>;
}
