import { useDialogFocus } from "./useDialogFocus.js";
import { deleteImpactHeadline, type DeleteImpact } from "../../../../packages/workbench-core/src/index.js";

interface DeleteStepDialogProps {
  readonly impact: DeleteImpact;
  /** Replaces the opening sentence (a whole pattern group is deleted: its copies are not dependants of the first one). */
  readonly headline?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * HS-02: asked before a timeline step is deleted when other steps are built on it. It names every step that would go and why,
 * and the solids that disappear; Cancel changes nothing, and the delete itself is one Undo step.
 */
export function DeleteStepDialog({ impact, headline, onConfirm, onCancel }: DeleteStepDialogProps): React.JSX.Element {
  // Esc closes, Tab stays inside the dialog (Cancel first, so Enter never deletes by accident), and focus returns to where the delete was asked.
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const total = impact.dependents.length + 1;
  return <div className="engineering-confirmation-backdrop">
    <section ref={dialogRef} tabIndex={-1} onKeyDown={(event) => event.stopPropagation()} className="engineering-confirmation-dialog compact delete-step-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-step-title" aria-describedby="delete-step-description">
      <header><div><h2 id="delete-step-title">Delete {impact.featureName}?</h2></div><button onClick={onCancel} aria-label="Close without deleting">×</button></header>
      <div className="engineering-review-copy" id="delete-step-description">
        <p>{headline ?? deleteImpactHeadline(impact)}</p>
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
