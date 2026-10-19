import { useEffect, useRef, useState } from "react";
import type { BooleanMode } from "../../../../packages/workbench-geometry/src/index.js";

export interface CombineBodyOption {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
}

export interface CombineChoice {
  readonly targetId: string;
  readonly toolId: string;
  readonly mode: BooleanMode;
  readonly keepTool: boolean;
}

interface CombineDialogProps {
  readonly bodies: readonly CombineBodyOption[];
  readonly initialTargetId: string | undefined;
  readonly initialMode: BooleanMode;
  /** Resolves to an error message to show in the dialog, or undefined when the Boolean was applied. */
  readonly onApply: (choice: CombineChoice) => Promise<string | undefined>;
  readonly onCancel: () => void;
}

const MODE_COPY: Readonly<Record<BooleanMode, { readonly label: string; readonly help: string }>> = {
  join: { label: "Join", help: "Merge the tool into the target. The bodies must overlap or touch." },
  cut: { label: "Cut", help: "Remove the tool's volume from the target, leaving a pocket or hole." },
  intersect: { label: "Intersect", help: "Keep only the volume the two bodies share." }
};

/** Chooses the target, tool and operation for a mesh Boolean between two general bodies. */
export function CombineDialog(props: CombineDialogProps): React.JSX.Element {
  const [targetId, setTargetId] = useState(props.initialTargetId !== undefined && props.bodies.some((body) => body.id === props.initialTargetId) ? props.initialTargetId : props.bodies[0]?.id ?? "");
  const [toolId, setToolId] = useState(() => props.bodies.find((body) => body.id !== targetId)?.id ?? "");
  const [mode, setMode] = useState<BooleanMode>(props.initialMode);
  const [keepTool, setKeepTool] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const frame = window.requestAnimationFrame(() => dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
    };
    dialog.addEventListener("keydown", onKey);
    return () => { window.cancelAnimationFrame(frame); dialog.removeEventListener("keydown", onKey); };
  }, []);

  const apply = async (): Promise<void> => {
    if (targetId === "" || toolId === "" || targetId === toolId) { setError("Choose two different bodies."); return; }
    setWorking(true);
    setError(undefined);
    const message = await props.onApply({ targetId, toolId, mode, keepTool });
    setWorking(false);
    if (message !== undefined) setError(message);
  };

  const options = (exclude?: string): React.JSX.Element[] => props.bodies.filter((body) => body.id !== exclude).map((body) => <option key={body.id} value={body.id}>{body.name}{body.visible ? "" : " (hidden)"}</option>);

  return <div className="engineering-confirmation-backdrop">
    <section ref={dialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact combine-dialog" role="dialog" aria-modal="true" aria-labelledby="combine-title" aria-describedby="combine-description">
      <header><div><span>PART / COMBINE</span><h2 id="combine-title">Combine bodies</h2></div><button onClick={props.onCancel} aria-label="Close Combine">×</button></header>
      <div className="engineering-review-copy" id="combine-description">
        <label className="combine-field"><span>Target</span><select data-dialog-initial-focus aria-label="Target body" value={targetId} onChange={(event) => { setTargetId(event.target.value); if (event.target.value === toolId) setToolId(props.bodies.find((body) => body.id !== event.target.value)?.id ?? ""); }}>{options()}</select></label>
        <label className="combine-field"><span>Tool</span><select aria-label="Tool body" value={toolId} onChange={(event) => setToolId(event.target.value)}>{options(targetId)}</select></label>
        <label className="combine-field"><span>Operation</span><select aria-label="Combine operation" value={mode} onChange={(event) => setMode(event.target.value as BooleanMode)}>{(Object.keys(MODE_COPY) as BooleanMode[]).map((candidate) => <option key={candidate} value={candidate}>{MODE_COPY[candidate].label}</option>)}</select></label>
        <p>{MODE_COPY[mode].help}</p>
        <label className="combine-check"><input type="checkbox" checked={keepTool} onChange={(event) => setKeepTool(event.target.checked)} /><span>Keep the tool body</span></label>
        <p className="combine-note">This is a tessellated Boolean: curved faces are the facets of the source meshes, and the result is a labelled-region mesh solid, not an exact B-rep. A result that is not a clean closed solid is refused and nothing changes.</p>
        {error !== undefined && <p className="combine-error" role="alert">{error}</p>}
      </div>
      <footer><button onClick={props.onCancel}>Cancel</button><button className="primary" disabled={working || props.bodies.length < 2} onClick={() => void apply()}>{working ? "Combining…" : `${MODE_COPY[mode].label} bodies`}</button></footer>
    </section>
  </div>;
}
