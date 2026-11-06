import { useEffect, useRef, useState } from "react";
import type { SketchPlane } from "../general-modeling.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface SketchPlaneOption {
  readonly plane: SketchPlane;
  readonly label: string;
  readonly view: string;
  readonly icon: string;
  readonly hint: string;
}

/** The three primary datum planes, matching the Fusion-style "choose a plane to sketch on" step. */
const SKETCH_PLANES: readonly SketchPlaneOption[] = [
  { plane: "xy", label: "Top (XY)", view: "Top view", icon: "axes", hint: "Floor plane · Z up" },
  { plane: "xz", label: "Front (XZ)", view: "Front view", icon: "axes", hint: "Looking along −Y" },
  { plane: "yz", label: "Right (YZ)", view: "Right view", icon: "axes", hint: "Looking along +X" }
];

interface SketchPlaneDialogProps {
  readonly open: boolean;
  readonly initialPlane: SketchPlane;
  readonly onConfirm: (plane: SketchPlane) => void;
  readonly onClose: () => void;
}

/** Asks which datum plane a new sketch is created on, the way Fusion, SolidWorks, and NX do. */
export function SketchPlaneDialog(props: SketchPlaneDialogProps): React.JSX.Element | null {
  const [plane, setPlane] = useState<SketchPlane>(props.initialPlane);
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);

  useEffect(() => {
    if (props.open) setPlane(props.initialPlane);
  }, [props.open, props.initialPlane]);

  if (!props.open) return null;
  const selected = SKETCH_PLANES.find((option) => option.plane === plane) ?? SKETCH_PLANES[0]!;

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog new-project-dialog sketch-plane-dialog" role="dialog" aria-modal="true" aria-labelledby="sketch-plane-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="sketch" /></span><div><small>SKETCH / SELECT PLANE</small><h2 id="sketch-plane-title">Which plane do you want to sketch on?</h2></div><button onClick={props.onClose} aria-label="Cancel plane selection">×</button></header>
      <div className="save-project-content">
        <div className="new-project-types sketch-plane-types" role="radiogroup" aria-label="Sketch plane">
          {SKETCH_PLANES.map((option, index) => <button
            key={option.plane}
            {...(plane === option.plane ? { "data-dialog-initial-focus": "" } : {})}
            onKeyDown={(event) => {
              // Radio-group keys: arrows move the choice, Enter confirms.
              const current = SKETCH_PLANES.findIndex((candidate) => candidate.plane === plane);
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); setPlane(SKETCH_PLANES[(current + 1) % SKETCH_PLANES.length]!.plane); }
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); setPlane(SKETCH_PLANES[(current + SKETCH_PLANES.length - 1) % SKETCH_PLANES.length]!.plane); }
              else if (event.key === "Enter") { event.preventDefault(); props.onConfirm(plane); }
            }}
            type="button"
            role="radio"
            aria-checked={plane === option.plane}
            className={plane === option.plane ? "active" : ""}
            onClick={() => setPlane(option.plane)}
            onDoubleClick={() => props.onConfirm(option.plane)}
          ><CommandIcon name={option.icon} /><strong>{option.label}</strong><small>{option.hint}</small></button>)}
        </div>
        <div className="save-project-note"><CommandIcon name="shield" /><span>The sketch opens face-on, looking at the {selected.view}. The plane is saved with the sketch and Create solid builds from it.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" onClick={() => props.onConfirm(plane)}><CommandIcon name="sketch" />Start sketch</button></footer>
    </section>
  </div>;
}
