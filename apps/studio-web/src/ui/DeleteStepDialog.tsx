import { useState } from "react";
import { useDialogFocus } from "./useDialogFocus.js";
import { deleteChoiceHeadline, type DeleteImpact } from "../../../../packages/workbench-core/src/index.js";

export type DeleteMode = "only" | "all";

interface DeleteStepDialogProps {
  readonly impact: DeleteImpact;
  /** Replaces the opening sentence and removes the choice (a whole pattern group is deleted: its copies are not dependants of the first one). */
  readonly headline?: string;
  /** "only" keeps what is built on the step (it stays in the timeline marked as needing attention); "all" also deletes it. */
  readonly onConfirm: (mode: DeleteMode) => void;
  readonly onCancel: () => void;
  /** Which choice is selected when the dialog opens. The default is to delete only this step. */
  readonly initialMode?: DeleteMode;
}

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * Asked before a timeline step is deleted when other steps are built on it. Two choices: delete only this step (the default: the steps built on
 * it stay, turn red and say why, and can be edited or deleted one by one) or delete it and everything built on it. It lists what each choice
 * leaves or removes; Cancel changes nothing, and either delete is one Undo step. A group delete (a headline is given) has no choice: it removes
 * the whole group.
 */
export function DeleteStepDialog({ impact, headline, onConfirm, onCancel, initialMode = "only" }: DeleteStepDialogProps): React.JSX.Element {
  // Esc closes, Tab stays inside the dialog (Cancel first, so Enter never deletes by accident), and focus returns to where the delete was asked.
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const [chosen, setChosen] = useState<DeleteMode>(initialMode);
  const grouped = headline !== undefined;
  const mode: DeleteMode = grouped ? "all" : chosen;
  const count = impact.dependents.length;
  const total = count + 1;
  const keptBodies = impact.kept.removedBodyNames;
  const goneBodies = impact.removedBodyNames;
  return <div className="engineering-confirmation-backdrop">
    <section ref={dialogRef} tabIndex={-1} onKeyDown={(event) => event.stopPropagation()} className="engineering-confirmation-dialog compact delete-step-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-step-title" aria-describedby="delete-step-description">
      <header><div><h2 id="delete-step-title">Delete {impact.featureName}?</h2></div><button onClick={onCancel} aria-label="Close without deleting">×</button></header>
      <div className="engineering-review-copy" id="delete-step-description">
        <p>{headline ?? deleteChoiceHeadline(impact)}</p>
        {!grouped && <fieldset className="delete-step-choices">
          <legend>What to delete</legend>
          <label className={mode === "only" ? "selected" : ""}>
            <input type="radio" name="delete-step-mode" value="only" checked={mode === "only"} onChange={() => setChosen("only")} />
            <span><strong>Delete only this step</strong><small>The {count} {plural(count, "step", "steps")} built on it stay in the timeline and are marked as needing attention. Edit {plural(count, "it", "them")} to choose another sketch, or delete {plural(count, "it", "them")}.</small></span>
          </label>
          <label className={mode === "all" ? "selected" : ""}>
            <input type="radio" name="delete-step-mode" value="all" checked={mode === "all"} onChange={() => setChosen("all")} />
            <span><strong>Delete this step and what is built on it</strong><small>{total} steps are removed from the timeline.</small></span>
          </label>
        </fieldset>}
        {mode === "only"
          ? <>
            <p className="delete-step-heading">Left needing attention</p>
            <ul className="delete-step-list" aria-label="Steps that stay and need attention">
              {impact.kept.marks.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{item.brief}</span></li>)}
            </ul>
            {keptBodies.length > 0 && <p className="delete-step-bodies">The solid{keptBodies.length === 1 ? "" : "s"} {keptBodies.join(", ")} {keptBodies.length === 1 ? "is" : "are"} removed from the model.</p>}
          </>
          : <>
            <p className="delete-step-heading">Deleted with it</p>
            <ul className="delete-step-list" aria-label="Steps that go with it">
              {impact.dependents.map((item) => <li key={item.id}><strong>{item.name}</strong><span>{item.reason}</span></li>)}
            </ul>
            {goneBodies.length > 0 && <p className="delete-step-bodies">The solid{goneBodies.length === 1 ? "" : "s"} {goneBodies.join(", ")} {goneBodies.length === 1 ? "is" : "are"} removed from the model.</p>}
          </>}
        <p className="delete-step-note">This is one step in the undo history: Ctrl+Z brings back everything listed here.</p>
      </div>
      <footer><button data-dialog-initial-focus onClick={onCancel}>Cancel</button><button className="primary danger" onClick={() => onConfirm(mode)}>{mode === "only" ? "Delete this step" : `Delete ${total} steps`}</button></footer>
    </section>
  </div>;
}
