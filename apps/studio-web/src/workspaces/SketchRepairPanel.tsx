import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchSketch } from "../../../../packages/workbench-core/src/index.js";
import { checkSketch, type SketchEditPlan } from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { analyzeSketch, type RepairFix, type RepairIssue } from "../../../../packages/workbench-sketch/src/sketch-repair.js";
import { CommandIcon } from "../ui/CommandIcon.js";

interface SketchRepairPanelProps {
  readonly sketch: WorkbenchSketch;
  /** Applies a sketch edit; false means the operation refused it. */
  readonly onApplyEdit: (plan: SketchEditPlan) => boolean | void;
  /** Relaxes (or restores) relations; false means the operation refused it. */
  readonly onSetSuppressed: (constraintIds: readonly string[], suppressed: boolean) => boolean | void;
  /** Selects the curves an issue is about, so they light up on the canvas. */
  readonly onSelect: (entityIds: readonly string[]) => void;
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
}

const SEVERITY_LABEL = { error: "Error", warning: "Warning", info: "Note" } as const;

/**
 * Validate Sketch and interactive repair: the verdict and counts, then every real problem found (conflicting or redundant relations,
 * gaps, duplicate and zero-length curves, unclosed chains), each with one-click fixes that have already been checked against the
 * operation's own rules. "Fix all" applies the first fix of each in turn, re-checking after every step.
 */
export function SketchRepairPanel(props: SketchRepairPanelProps): React.JSX.Element {
  const report = useMemo(() => analyzeSketch({ sketch: props.sketch, newId: (prefix) => `${prefix}:user-${crypto.randomUUID()}` }), [props.sketch]);
  const [fixingAll, setFixingAll] = useState(false);
  const [tick, setTick] = useState(0);
  const attempted = useRef(new Set<string>());
  const applied = useRef(0);
  const { onApplyEdit, onSetSuppressed, onMessage } = props;

  const run = (fix: RepairFix): boolean => {
    const accepted = fix.kind === "edit" ? onApplyEdit(fix.plan) : onSetSuppressed(fix.constraintIds, true);
    return accepted !== false;
  };

  // Fix all: one fix per render, so the next step is planned against the sketch the previous fix produced.
  useEffect(() => {
    if (!fixingAll) return;
    const next = report.issues.find((issue) => issue.severity !== "info" && issue.fixes.length > 0 && !attempted.current.has(issue.id));
    if (next === undefined) {
      setFixingAll(false);
      onMessage(`Fix all finished: ${applied.current} fix${applied.current === 1 ? "" : "es"} applied; ${report.errors} error${report.errors === 1 ? "" : "s"} and ${report.warnings} warning${report.warnings === 1 ? "" : "s"} left.`);
      return;
    }
    attempted.current.add(next.id);
    if (run(next.fixes[0]!)) applied.current += 1;
    else setTick((value) => value + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixingAll, report, tick]);

  const startFixAll = (): void => {
    attempted.current = new Set();
    applied.current = 0;
    setFixingAll(true);
    setTick((value) => value + 1);
  };

  const diagnostics = useMemo(() => checkSketch(props.sketch), [props.sketch]);
  const press = (issue: RepairIssue, fix: RepairFix): void => {
    props.onSelect(issue.entityIds);
    if (!run(fix)) props.onMessage(`"${fix.label}" was refused by the sketch. The sketch changed under the repair; review the list and try again.`);
  };

  return <section className="inspector-section sketch-check-panel sketch-repair-panel" aria-label="Sketch repair">
    <header>
      <strong>Sketch repair</strong>
      <span>{report.errors} error{report.errors === 1 ? "" : "s"} · {report.warnings} warning{report.warnings === 1 ? "" : "s"}</span>
    </header>
    <div role="status" aria-label="Validate sketch" style={{ display: "grid", gap: "0.2rem", fontSize: "0.78rem", marginBottom: "0.5rem" }}>
      <strong>{report.usableForSolid ? "Valid: ready for a solid feature" : report.valid ? "Valid, but there is no closed profile yet" : "Needs repair"}</strong>
      {report.summary.map((line, index) => <span key={index}>{line}</span>)}
    </div>
    {report.fixable > 0 && <button className="palette-action primary" disabled={fixingAll} onClick={startFixAll}>
      <CommandIcon name="cube-check" />Fix all ({report.fixable} fixable)
    </button>}
    {report.issues.length === 0 && <p className="profile-help">Nothing to repair: no conflicts, redundant relations, gaps, duplicates or open chains were found.</p>}
    <ul className="sketch-check-list" style={{ maxHeight: "24rem" }}>
      {report.issues.map((issue) => <li key={issue.id} className={`check-${issue.severity}`} style={{ gridTemplateColumns: "4.2rem 1fr" }}>
        <b>{SEVERITY_LABEL[issue.severity]}</b>
        <div style={{ display: "grid", gap: "0.25rem" }}>
          <span><strong>{issue.title}</strong></span>
          <span>{issue.detail}</span>
          {issue.noFixReason !== undefined && issue.fixes.length === 0 && <span style={{ opacity: 0.8 }}>No one-click fix: {issue.noFixReason}</span>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
            {issue.entityIds.length > 0 && <button className="palette-action" onClick={() => props.onSelect(issue.entityIds)}><CommandIcon name="select" />Show</button>}
            {issue.fixes.map((fix, index) => <button key={index} className={`palette-action${index === 0 ? " primary" : ""}`} onClick={() => press(issue, fix)}><CommandIcon name={fix.kind === "relax" ? "unfixed" : "cube-check"} />{fix.label}</button>)}
          </div>
        </div>
      </li>)}
    </ul>
    <details>
      <summary>All diagnostics ({diagnostics.items.length})</summary>
      <ul className="sketch-check-list">
        {diagnostics.items.map((item, index) => <li key={index} className={`check-${item.severity}`}><b>{SEVERITY_LABEL[item.severity]}</b><span>{item.message}</span></li>)}
      </ul>
    </details>
    <button className="palette-action" onClick={props.onClose}><CommandIcon name="cancel" />Close</button>
  </section>;
}
