import type { ShortcutGroup } from "./sketch-shortcut-items.js";
import { useDialogFocus } from "./useDialogFocus.js";

/**
 * The global keyboard shortcut list (press ?). The caller builds the groups, so the sketch group follows the keys the user has set in the
 * shortcut editor. It is a modal dialog: focus moves into it, Tab stays inside, Esc closes it and focus returns to where it was.
 */
export function ShortcutsOverlay(props: { readonly open: boolean; readonly groups: readonly ShortcutGroup[]; readonly onClose: () => void }): React.JSX.Element | null {
  const dialogRef = useDialogFocus<HTMLDivElement>(props.open, props.onClose);
  if (!props.open) return null;
  return <div className="shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={props.onClose}>
    <div className="shortcuts-panel" ref={dialogRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
      <header><strong>Keyboard shortcuts</strong><button type="button" data-dialog-initial-focus onClick={props.onClose} aria-label="Close keyboard shortcuts">×</button></header>
      <div className="shortcuts-grid">
        {props.groups.map((group) => <section key={group.title} aria-label={group.title}><h4>{group.title}</h4><dl>{group.items.map((item, index) => <div key={`${index}:${item.label}`}><dt>{item.keys.map((key, keyIndex) => <kbd key={`${keyIndex}:${key}`}>{key}</kbd>)}</dt><dd>{item.label}</dd></div>)}</dl></section>)}
      </div>
      <footer>Press <kbd>?</kbd> anytime to open this list · <kbd>Esc</kbd> to close</footer>
    </div>
  </div>;
}
