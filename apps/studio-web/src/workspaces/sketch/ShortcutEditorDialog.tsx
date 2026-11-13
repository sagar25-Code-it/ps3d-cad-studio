import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SKETCH_KEYMAP, SKETCH_KEYMAP_COMMANDS, keySpecOfInput, rebindKey, sketchCommandInfo, type SketchCommandGroup, type SketchCommandId
} from "../../../../../packages/workbench-sketch/src/hotkeys.js";
import { CommandIcon } from "../../ui/CommandIcon.js";
import { useDialogFocus } from "../../ui/useDialogFocus.js";
import { updateSketchKeymap, useSketchKeymap } from "./useSketchKeymap.js";

const GROUPS: readonly SketchCommandGroup[] = ["Draw", "Modify", "Constrain", "Dimension and view", "Input assistance"];

type Notice =
  | { readonly kind: "info" | "error"; readonly text: string }
  | { readonly kind: "conflict"; readonly text: string; readonly id: SketchCommandId; readonly spec: string; readonly owner: SketchCommandId };

/**
 * The shortcut editor: every sketch command with its key. Click a key, press the new one; a key that another command already
 * has is reported and can be taken over; the result is saved in the browser at once and every chip and help sheet follows.
 */
export function ShortcutEditorDialog(props: { readonly open: boolean; readonly onClose: () => void }): React.JSX.Element | null {
  const keymap = useSketchKeymap();
  const [capturing, setCapturing] = useState<SketchCommandId | null>(null);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);

  useEffect(() => { if (!props.open) { setCapturing(null); setNotice(undefined); } }, [props.open]);

  const tryBind = (id: SketchCommandId, spec: string | undefined, replace = false): void => {
    const result = rebindKey(keymap, id, spec, { replace });
    const label = sketchCommandInfo(id)?.label ?? id;
    if (result.ok) {
      updateSketchKeymap(result.keymap);
      const displaced = result.displaced === undefined ? "" : ` ${sketchCommandInfo(result.displaced)?.label ?? result.displaced} no longer has a key.`;
      setNotice({ kind: "info", text: spec === undefined ? `${label} has no key now.` : `${label} is now ${spec}.${displaced}` });
    } else if (result.conflict !== undefined && spec !== undefined) {
      setNotice({ kind: "conflict", text: result.reason, id, spec, owner: result.conflict });
    } else {
      setNotice({ kind: "error", text: result.reason });
    }
  };

  useEffect(() => {
    if (capturing === null) return undefined;
    // In the capture phase on the window, so the dialog's own Escape handling and the sketch hotkeys never see the key.
    const listener = (event: KeyboardEvent): void => {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { setCapturing(null); setNotice({ kind: "info", text: "Cancelled." }); return; }
      if (event.key === "Backspace" || event.key === "Delete") { tryBind(capturing, undefined); setCapturing(null); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) { setNotice({ kind: "error", text: "Ctrl, Alt and Cmd combinations belong to the application. Use a letter, optionally with Shift, or F2 to F12." }); return; }
      const spec = keySpecOfInput({ key: event.key, code: event.code, shift: event.shiftKey });
      if (spec === undefined) { setNotice({ kind: "error", text: "Press a letter (optionally with Shift) or a function key F2 to F12." }); return; }
      setCapturing(null);
      tryBind(capturing, spec);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });

  const rows = useMemo(() => GROUPS.map((group) => ({ group, commands: SKETCH_KEYMAP_COMMANDS.filter((info) => info.group === group) })), []);
  if (!props.open) return null;

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog shortcut-editor" role="dialog" aria-modal="true" aria-labelledby="shortcut-editor-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="command" /></span><div><small>SKETCH / KEYBOARD</small><h2 id="shortcut-editor-title">Sketch shortcuts</h2></div><button onClick={props.onClose} aria-label="Close the shortcut editor">×</button></header>
      <div className="shortcut-editor-body">
        <p className="shortcut-editor-hint">Click a key, then press the new one (a letter, optionally with Shift, or F2 to F12). Backspace removes the key. S always opens the command search.</p>
        <div className="shortcut-editor-status" role="status" aria-live="polite">
          {notice === undefined ? null : <>
            <span className={`shortcut-editor-notice ${notice.kind}`}>{notice.text}</span>
            {notice.kind === "conflict" && <>
              <button type="button" onClick={() => { tryBind(notice.id, notice.spec, true); }}>Take it from {sketchCommandInfo(notice.owner)?.label ?? notice.owner}</button>
              <button type="button" onClick={() => setNotice(undefined)}>Keep as it was</button>
            </>}
          </>}
        </div>
        {rows.map(({ group, commands }) => <section key={group} className="shortcut-editor-group">
          <h3>{group}</h3>
          <table>
            <tbody>
              {commands.map((info) => {
                const key = keymap.keys[info.id];
                const changed = key !== info.defaultKey;
                return <tr key={info.id}>
                  <th scope="row">{info.label}</th>
                  <td>
                    <button
                      type="button"
                      className={`shortcut-key${capturing === info.id ? " capturing" : ""}${key === undefined ? " unbound" : ""}`}
                      aria-label={`${info.label}: ${key ?? "no key"}. Click to change.`}
                      onClick={() => { setCapturing(capturing === info.id ? null : info.id); setNotice(undefined); }}
                    >{capturing === info.id ? "Press a key…" : key ?? "none"}</button>
                  </td>
                  <td className="shortcut-editor-actions">
                    <button type="button" disabled={key === undefined} onClick={() => tryBind(info.id, undefined)} aria-label={`Remove the key of ${info.label}`}>Clear</button>
                    <button type="button" disabled={!changed} onClick={() => tryBind(info.id, info.defaultKey, true)} aria-label={`Restore the default key of ${info.label}`}>Default{info.defaultKey === undefined ? "" : ` (${info.defaultKey})`}</button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </section>)}
      </div>
      <footer className="shortcut-editor-footer">
        <button type="button" onClick={() => { updateSketchKeymap(DEFAULT_SKETCH_KEYMAP); setNotice({ kind: "info", text: "Every key is back to its default." }); }}>Reset all</button>
        <button type="button" data-dialog-initial-focus onClick={props.onClose}>Done</button>
      </footer>
    </section>
  </div>;
}
