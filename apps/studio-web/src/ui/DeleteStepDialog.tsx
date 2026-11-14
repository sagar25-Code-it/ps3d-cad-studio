import { useEffect, useRef } from "react";
import { deleteImpactHeadline, type DeleteImpact } from "../../../../packages/workbench-core/src/index.js";

interface DeleteStepDialogProps {
  readonly impact: DeleteImpact;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * HS-02: asked before a timeline step is deleted when other steps are built on it. It names every step that would go and why,
 * and the solids that disappear; Cancel changes nothing, and the delete itself is one Undo step.
 */
export function DeleteStepDialog({ impact, onConfirm, onCancel }: DeleteStepDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const frame = window.requestAnimationFrame(() => dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    };
    dialog.addEventListener("keydown", onKey);
    return () => { window.cancelAnimationFrame(frame); dialog.removeEventListener("keydown", onKey); };
  }, []);
  const total = impact.dependents.length + 1;
  return <div className="engineering-confirmation-backdrop">
    <section ref={dialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact delete-step-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-step-title" aria-describedby="delete-step-description">
      <header><div><h2 id="delete-step-title">Delete {impact.featureName}?</h2></div><button onClick={onCancel} aria-label="Close without deleting">×</button></header>
      <div className="engineering-review-copy" id="delete-step-description">
        <p>{deleteImpactHeadline(impact)}</p>
        <ul className="delete-step-list" aria-label="Steps that go with it">
          {impact.dependents.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{item.reason}</span></li>)}
        </ul>
        {impact.removedBodyNames.length > 0 && <p className="delete-step-bodies">The solid{impact.removedBodyNames.length === 1 ? "" : "s"} {impact.removedBodyNames.join(", ")} {impact.removedBodyNames.length === 1 ? "is" : "are"} removed from the model.</p>}
        <p className="delete-step-note">This is one step in the undo history: Ctrl+Z brings back everything listed here.</p>
      </div>
      <footer><button data-dialog-initial-focus onClick={onCancel}>Cancel</button><button className="primary danger" onClick={onConfirm}>Delete {total} steps</button></footer>
    </section>
  </div>;
}
