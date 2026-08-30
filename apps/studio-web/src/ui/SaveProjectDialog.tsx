import { useEffect, useRef, useState } from "react";
import { normalizeProjectFileName, type PsCadWorkspaceStatus } from "../file-workspace.js";
import { CommandIcon } from "./CommandIcon.js";

interface SaveProjectDialogProps {
  readonly open: boolean;
  readonly mode: "save-as" | "copy";
  readonly projectName: string;
  readonly workspaceStatus: PsCadWorkspaceStatus;
  readonly onConfirm: (fileName: string) => void;
  readonly onClose: () => void;
}

export function SaveProjectDialog(props: SaveProjectDialogProps): React.JSX.Element | null {
  const [fileName, setFileName] = useState(props.projectName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setFileName(props.mode === "copy" ? `${props.projectName} Copy` : props.projectName);
    const frame = window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    const keyboard = (event: KeyboardEvent): void => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", keyboard, true);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", keyboard, true); };
  }, [props.mode, props.onClose, props.open, props.projectName]);

  if (!props.open) return null;
  const normalized = normalizeProjectFileName(fileName);
  const location = props.workspaceStatus.bound && props.workspaceStatus.permission === "granted"
    ? `${props.workspaceStatus.folderName} / Projects`
    : props.workspaceStatus.apiSupported ? "Browser save picker" : "Downloads";

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section className="save-project-dialog" role="dialog" aria-modal="true" aria-labelledby="save-project-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name={props.mode === "copy" ? "copy" : "save"} /></span><div><small>FILE / {props.mode === "copy" ? "SAVE A COPY" : "SAVE AS"}</small><h2 id="save-project-title">{props.mode === "copy" ? "Save an independent copy" : "Name this PS3D project"}</h2></div><button onClick={props.onClose} aria-label="Close Save dialog">×</button></header>
      <div className="save-project-content">
        <label><span>File name</span><input ref={inputRef} value={fileName} maxLength={96} onChange={(event) => setFileName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") props.onConfirm(normalized); }} /></label>
        <div className="save-file-preview"><CommandIcon name="file" /><span><strong>{normalized}</strong><small>{location}</small></span></div>
        <div className="save-project-note"><CommandIcon name="shield" /><span>PS3D validates the full project before writing. {props.mode === "copy" ? "The active file remains unchanged." : "Future Ctrl+S saves update this file."}</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" onClick={() => props.onConfirm(normalized)}><CommandIcon name="save" />{props.mode === "copy" ? "Save Copy" : "Save"}</button></footer>
    </section>
  </div>;
}
