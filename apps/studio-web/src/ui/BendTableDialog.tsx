import { useEffect, useState } from "react";
import type { SheetBendTable } from "../../../../packages/workbench-core/src/index.js";
import { draftOf, tableFromDrafts, type RowDraft } from "../bend-table-draft.js";
import { parseBendTableCsv } from "../../../../packages/workbench-geometry/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface BendTableDialogProps {
  readonly open: boolean;
  readonly bodyName: string;
  /** The body's table now; undefined while it has none. */
  readonly table: SheetBendTable | undefined;
  /** Called with the edited table, or undefined to clear it. */
  readonly onApply: (table: SheetBendTable | undefined) => void;
  readonly onExportRows: (table: SheetBendTable) => void;
  readonly onClose: () => void;
}

/** Edits the bend table of a sheet-metal body: K-factor, bend allowance or bend deduction per thickness and bend radius. */
export function BendTableDialog(props: BendTableDialogProps): React.JSX.Element | null {
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);
  const [defaultK, setDefaultK] = useState("0.44");
  const [rows, setRows] = useState<readonly RowDraft[]>([]);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!props.open) return;
    setDefaultK(String(props.table?.defaultKFactor ?? 0.44));
    setRows((props.table?.rows ?? []).map(draftOf));
    setProblem("");
  }, [props.open, props.table]);

  if (!props.open) return null;
  const update = (index: number, patch: Partial<RowDraft>): void => { setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row))); setProblem(""); };
  const apply = (): void => {
    if (rows.length === 0 && Number(defaultK.replace(",", ".")) === 0.44) { props.onApply(undefined); return; }
    const result = tableFromDrafts(defaultK, rows, props.table?.name);
    if (!result.ok) { setProblem(result.message); return; }
    props.onApply(result.table);
  };
  const importCsv = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    let text: string;
    try { text = await file.text(); } catch { setProblem("The file could not be read. Choose it again, or paste the rows by hand."); return; }
    const parsed = parseBendTableCsv(text);
    if (!parsed.ok) { setProblem(parsed.message); return; }
    setRows(parsed.rows.map(draftOf));
    setProblem("");
  };
  const cell = { minWidth: 0, width: "100%" } as const;
  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog feature-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="bend-table-title" onMouseDown={(event) => event.stopPropagation()} style={{ maxWidth: 760, width: "min(760px, 94vw)" }}>
      <header><span><CommandIcon name="export" /></span><div><small>SHEET METAL / BEND TABLE</small><h2 id="bend-table-title">{props.bodyName}</h2></div><button onClick={props.onClose} aria-label="Cancel editing"><CommandIcon name="cancel" /></button></header>
      <div className="save-project-content feature-edit-form">
        <label>
          <span>Default K-factor</span>
          <div className="feature-edit-field">
            <input data-dialog-initial-focus inputMode="decimal" aria-label="Default K-factor" value={defaultK} onChange={(event) => { setDefaultK(event.target.value); setProblem(""); }} />
            <small>used where no row matches</small>
          </div>
        </label>
        <div role="table" aria-label="Bend table rows" style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr 0.8fr 1.3fr 1fr auto", alignItems: "center" }}>
          {["Thickness mm", "Inner radius mm", "Angle °", "Gives", "Value", ""].map((heading, index) => <small key={`${heading}-${index}`} role="columnheader">{heading}</small>)}
          {rows.map((row, index) => <div key={index} role="row" style={{ display: "contents" }}>
            <input style={cell} inputMode="decimal" aria-label={`Row ${index + 1} thickness`} value={row.thickness} onChange={(event) => update(index, { thickness: event.target.value })} />
            <input style={cell} inputMode="decimal" aria-label={`Row ${index + 1} inner radius`} value={row.radius} onChange={(event) => update(index, { radius: event.target.value })} />
            <input style={cell} inputMode="decimal" aria-label={`Row ${index + 1} angle`} placeholder="any" value={row.angle} onChange={(event) => update(index, { angle: event.target.value })} />
            <select style={cell} aria-label={`Row ${index + 1} kind`} value={row.mode} onChange={(event) => update(index, { mode: event.target.value === "allowance" ? "allowance" : event.target.value === "deduction" ? "deduction" : "k" })}>
              <option value="k">K-factor</option>
              <option value="allowance">Bend allowance (mm)</option>
              <option value="deduction">Bend deduction (mm)</option>
            </select>
            <input style={cell} inputMode="decimal" aria-label={`Row ${index + 1} value`} value={row.value} onChange={(event) => update(index, { value: event.target.value })} />
            <button type="button" aria-label={`Remove row ${index + 1}`} onClick={() => { setRows(rows.filter((_, i) => i !== index)); setProblem(""); }}><CommandIcon name="cancel" /></button>
          </div>)}
        </div>
        {rows.length === 0 && <div className="save-project-note"><CommandIcon name="shield" /><span>No rows: every bend uses the default K-factor. Add a row for each sheet thickness and bend radius you use. An allowance or deduction without an angle is the value for a 90° bend; the other angles follow from it.</span></div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => { setRows([...rows, { thickness: "2", radius: "2", angle: "", mode: "k", value: "0.44" }]); setProblem(""); }}>Add row</button>
          <label className="button-like" style={{ cursor: "pointer" }}>Import CSV…<input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(event) => { void importCsv(event.target.files?.[0]); event.target.value = ""; }} /></label>
          <button type="button" disabled={rows.length === 0} onClick={() => { const result = tableFromDrafts(defaultK, rows, props.table?.name); if (result.ok) props.onExportRows(result.table); else setProblem(result.message); }}>Export CSV</button>
          <button type="button" onClick={() => { setRows([]); setDefaultK("0.44"); setProblem(""); }}>Clear table</button>
        </div>
        {problem !== "" && <div className="inline-warning" role="alert">{problem}</div>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>The flat pattern reads each bend's K-factor from this table. A bend between two rows of the same thickness is interpolated by radius; one outside the table uses the default K-factor, and the flat pattern says so.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" onClick={apply}><CommandIcon name="export" />Apply table</button></footer>
    </section>
  </div>;
}
