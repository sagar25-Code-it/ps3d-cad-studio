import { useEffect, useState } from "react";
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

/** A planar face of a solid the sketch can sit on, already reduced to its plane and offset. */
export interface SketchFaceOption {
  readonly plane: SketchPlane;
  readonly offsetMm: number;
  /** "Plate · z = 25 mm" */
  readonly label: string;
  /** "Top face · 2400 mm²" */
  readonly hint: string;
}

interface SketchPlaneDialogProps {
  readonly open: boolean;
  readonly initialPlane: SketchPlane;
  readonly initialOffsetMm: number;
  /** Axis-aligned planar faces of the shown solids; picking one starts the sketch on that face. */
  readonly faces: readonly SketchFaceOption[];
  readonly onConfirm: (plane: SketchPlane, offsetMm: number) => void;
  readonly onClose: () => void;
}

/** Asks where a sketch goes: a datum plane, the same offset along its normal, or a planar face of a solid. */
export function SketchPlaneDialog(props: SketchPlaneDialogProps): React.JSX.Element | null {
  const [plane, setPlane] = useState<SketchPlane>(props.initialPlane);
  const [offsetText, setOffsetText] = useState("0");
  const [problem, setProblem] = useState("");
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);

  useEffect(() => {
    if (!props.open) return;
    setPlane(props.initialPlane);
    setOffsetText(String(Number(props.initialOffsetMm.toFixed(3))));
    setProblem("");
  }, [props.open, props.initialPlane, props.initialOffsetMm]);

  if (!props.open) return null;
  const selected = SKETCH_PLANES.find((option) => option.plane === plane) ?? SKETCH_PLANES[0]!;

  const confirm = (chosenPlane: SketchPlane, rawOffset: string): void => {
    const parsed = rawOffset.trim() === "" ? 0 : Number(rawOffset.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) { setProblem("Enter an offset in millimetres (up to ±100000)."); return; }
    props.onConfirm(chosenPlane, parsed);
  };

  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog new-project-dialog sketch-plane-dialog" role="dialog" aria-modal="true" aria-labelledby="sketch-plane-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="sketch" /></span><div><small>SKETCH / SELECT PLANE</small><h2 id="sketch-plane-title">Where do you want to sketch?</h2></div><button onClick={props.onClose} aria-label="Cancel plane selection">×</button></header>
      <div className="save-project-content">
        <div className="new-project-types sketch-plane-types" role="radiogroup" aria-label="Sketch plane">
          {SKETCH_PLANES.map((option) => <button
            key={option.plane}
            {...(plane === option.plane ? { "data-dialog-initial-focus": "" } : {})}
            onKeyDown={(event) => {
              // Radio-group keys: arrows move the choice, Enter confirms.
              const current = SKETCH_PLANES.findIndex((candidate) => candidate.plane === plane);
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); setPlane(SKETCH_PLANES[(current + 1) % SKETCH_PLANES.length]!.plane); }
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); setPlane(SKETCH_PLANES[(current + SKETCH_PLANES.length - 1) % SKETCH_PLANES.length]!.plane); }
              else if (event.key === "Enter") { event.preventDefault(); confirm(plane, offsetText); }
            }}
            type="button"
            role="radio"
            aria-checked={plane === option.plane}
            className={plane === option.plane ? "active" : ""}
            onClick={() => setPlane(option.plane)}
            onDoubleClick={() => confirm(option.plane, offsetText)}
          ><CommandIcon name={option.icon} /><strong>{option.label}</strong><small>{option.hint}</small></button>)}
        </div>
        <label className="sketch-plane-offset">
          <span>Offset from the plane</span>
          <div className="feature-edit-field">
            <input
              inputMode="decimal"
              aria-label="Offset from the plane in millimetres"
              value={offsetText}
              onChange={(event) => { setOffsetText(event.target.value); setProblem(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirm(plane, offsetText); } }}
            />
            <small>mm along the plane normal · 0 is the plane itself</small>
          </div>
        </label>
        {props.faces.length > 0 && <div className="sketch-plane-faces">
          <small className="sketch-plane-faces-title">Or sketch on a face of a solid</small>
          {props.faces.map((face, index) => <button
            key={`${face.plane}:${face.offsetMm}:${index}`}
            type="button"
            className="sketch-plane-face"
            onClick={() => props.onConfirm(face.plane, face.offsetMm)}
          ><CommandIcon name="face" /><span><strong>{face.label}</strong><small>{face.hint}</small></span></button>)}
        </div>}
        {problem !== "" && <div className="inline-warning" role="alert">{problem}</div>}
        <div className="save-project-note"><CommandIcon name="shield" /><span>The sketch opens face-on, looking at the {selected.view}. The plane and offset are saved with the sketch, and Create solid builds from it.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Cancel</button><button className="primary" onClick={() => confirm(plane, offsetText)}><CommandIcon name="sketch" />Start sketch</button></footer>
    </section>
  </div>;
}
