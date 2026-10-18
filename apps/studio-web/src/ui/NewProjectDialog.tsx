import { useEffect, useRef, useState } from "react";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";

interface NewProjectType {
  readonly workspace: WorkspaceId;
  readonly label: string;
  readonly icon: string;
  readonly hint: string;
}

const NEW_PROJECT_TYPES: readonly NewProjectType[] = [
  { workspace: "sketch", label: "Sketch", icon: "sketch", hint: "Start a profile on the XY plane" },
  { workspace: "part", label: "Part", icon: "part", hint: "Qualified solid modeling" },
  { workspace: "assembly", label: "Assembly", icon: "assembly", hint: "Lay out components" },
  { workspace: "surface", label: "Surface", icon: "surface", hint: "Bézier / loft study" },
  { workspace: "vehicle", label: "Vehicle", icon: "wheel", hint: "Geometry study" },
  { workspace: "electrical", label: "Electrical", icon: "exchange", hint: "Schematic concept" }
];

interface NewProjectDialogProps {
  readonly open: boolean;
  readonly onConfirm: (name: string, workspace: WorkspaceId) => void;
  readonly onClose: () => void;
}

export function NewProjectDialog(props: NewProjectDialogProps): React.JSX.Element | null {
  const [name, setName] = useState("Untitled design");
  const [workspace, setWorkspace] = useState<WorkspaceId>("sketch");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return undefined;
    setName("Untitled design");
    setWorkspace("sketch");
    const frame = window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    const keyboard = (event: KeyboardEvent): void => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", keyboard, true);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", keyboard, true); };
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  const trimmed = name.trim().length === 0 ? "Untitled design" : name.trim();
  const selected = NEW_PROJECT_TYPES.find((type) => type.workspace === workspace);

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section className="save-project-dialog new-project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="file" /></span><div><small>FILE / NEW DESIGN</small><h2 id="new-project-title">Create a new design</h2></div><button onClick={props.onClose} aria-label="Close New dialog">×</button></header>
      <div className="save-project-content">
        <label><span>Design name</span><input ref={inputRef} value={name} maxLength={96} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") props.onConfirm(trimmed, workspace); }} /></label>
        <span className="new-project-label">Start in environment</span>
        <div className="new-project-types" role="radiogroup" aria-label="Starting environment">
          {NEW_PROJECT_TYPES.map((type) => <button key={type.workspace} type="button" role="radio" aria-checked={workspace === type.workspace} className={workspace === type.workspace ? "active" : ""} onClick={() => setWorkspace(type.workspace)}><CommandIcon name={type.icon} /><strong>{type.label}</strong><small>{type.hint}</small></button>)}
        </div>
        <div className="save-project-note"><CommandIcon name="shield" /><span>Creates a fresh validated project and opens the {selected?.label} environment. The current design is replaced in this tab.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" onClick={() => props.onConfirm(trimmed, workspace)}><CommandIcon name="file" />Create design</button></footer>
    </section>
  </div>;
}
