import { useEffect, useState } from "react";
import type { SketchPlaneFrame, SketchPlaneTilt } from "../../../../packages/workbench-core/src/index.js";
import { frameThroughPoints } from "../../../../packages/workbench-geometry/src/index.js";
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

/** An angle construction plane of the part: a datum plane turned about a world axis. Picking it starts a tilted sketch. */
export interface SketchAngleOption {
  readonly plane: SketchPlane;
  readonly tilt: SketchPlaneTilt;
  readonly label: string;
}

/** A three-point construction plane of the part, already reduced to the frame a sketch on it uses. */
export interface SketchFrameOption {
  readonly frame: SketchPlaneFrame;
  readonly label: string;
}

/** Reads "x, y, z" (commas, semicolons or spaces) as a point in millimetres, or undefined when it is not three numbers. */
function parsePointText(text: string): readonly [number, number, number] | undefined {
  const parts = text.trim().split(/[\s,;]+/).filter((part) => part !== "").map((part) => Number(part.replace(",", ".")));
  return parts.length === 3 && parts.every((part) => Number.isFinite(part) && Math.abs(part) <= 100_000) ? [parts[0]!, parts[1]!, parts[2]!] : undefined;
}

interface SketchPlaneDialogProps {
  readonly open: boolean;
  readonly initialPlane: SketchPlane;
  readonly initialOffsetMm: number;
  readonly initialTilt?: SketchPlaneTilt | undefined;
  /** The part's angle construction planes, offered as ready-made tilted sketch planes. */
  readonly anglePlanes?: readonly SketchAngleOption[];
  /** The part's three-point construction planes, offered as ready-made sketch planes. */
  readonly framePlanes?: readonly SketchFrameOption[];
  /** Axis-aligned planar faces of the shown solids; picking one starts the sketch on that face. */
  readonly faces: readonly SketchFaceOption[];
  readonly onConfirm: (plane: SketchPlane, offsetMm: number, tilt?: SketchPlaneTilt, frame?: SketchPlaneFrame) => void;
  readonly onClose: () => void;
}

/** Asks where a sketch goes: a datum plane, the same offset along its normal, or a planar face of a solid. */
export function SketchPlaneDialog(props: SketchPlaneDialogProps): React.JSX.Element | null {
  const [plane, setPlane] = useState<SketchPlane>(props.initialPlane);
  const [offsetText, setOffsetText] = useState("0");
  const [tiltAxis, setTiltAxis] = useState<"none" | "x" | "y" | "z">("none");
  const [tiltText, setTiltText] = useState("45");
  const [pointTexts, setPointTexts] = useState<readonly [string, string, string]>(["", "", ""]);
  const [problem, setProblem] = useState("");
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);

  useEffect(() => {
    if (!props.open) return;
    setPlane(props.initialPlane);
    setOffsetText(String(Number(props.initialOffsetMm.toFixed(3))));
    setTiltAxis(props.initialTilt?.axis ?? "none");
    setTiltText(String(props.initialTilt?.angleDeg ?? 45));
    setPointTexts(["", "", ""]);
    setProblem("");
  }, [props.open, props.initialPlane, props.initialOffsetMm, props.initialTilt]);

  if (!props.open) return null;
  const selected = SKETCH_PLANES.find((option) => option.plane === plane) ?? SKETCH_PLANES[0]!;

  const confirm = (chosenPlane: SketchPlane, rawOffset: string): void => {
    const parsed = rawOffset.trim() === "" ? 0 : Number(rawOffset.trim().replace(",", "."));
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) { setProblem("Enter an offset in millimetres (up to ±100000)."); return; }
    if (tiltAxis === "none") { props.onConfirm(chosenPlane, parsed); return; }
    const angle = Number(tiltText.trim().replace(",", "."));
    if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 180) { setProblem("Enter a tilt angle from -180° to 180°, other than 0."); return; }
    props.onConfirm(chosenPlane, parsed, { axis: tiltAxis, angleDeg: angle });
  };

  /** Starts the sketch on the plane through the three typed points. */
  const confirmPoints = (): void => {
    const points = pointTexts.map(parsePointText);
    if (points.some((point) => point === undefined)) { setProblem("Type each point as three numbers in millimetres, like 10, 0, 5."); return; }
    const frame = frameThroughPoints(points as unknown as readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]);
    if ("error" in frame) { setProblem(frame.error); return; }
    props.onConfirm("xy", 0, undefined, frame);
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
        <label className="sketch-plane-offset">
          <span>Tilt the plane</span>
          <div className="feature-edit-field">
            <select aria-label="Tilt axis" value={tiltAxis} onChange={(event) => { setTiltAxis(event.target.value as "none" | "x" | "y" | "z"); setProblem(""); }}>
              <option value="none">Not tilted</option>
              <option value="x">About the X axis</option>
              <option value="y">About the Y axis</option>
              <option value="z">About the Z axis</option>
            </select>
            <input
              inputMode="decimal"
              aria-label="Tilt angle in degrees"
              disabled={tiltAxis === "none"}
              value={tiltText}
              onChange={(event) => { setTiltText(event.target.value); setProblem(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirm(plane, offsetText); } }}
            />
            <small>degrees, right-handed about the world axis, applied after the offset</small>
          </div>
        </label>
        {(props.anglePlanes?.length ?? 0) > 0 && <div className="sketch-plane-faces">
          <small className="sketch-plane-faces-title">Or sketch on an angle plane of this part</small>
          {props.anglePlanes!.map((option, index) => <button
            key={`${option.label}:${index}`}
            type="button"
            className="sketch-plane-face"
            onClick={() => props.onConfirm(option.plane, 0, option.tilt)}
          ><CommandIcon name="projection" /><span><strong>{option.label}</strong><small>{option.plane.toUpperCase()} turned {option.tilt.angleDeg}° about {option.tilt.axis.toUpperCase()}</small></span></button>)}
        </div>}
        {(props.framePlanes?.length ?? 0) > 0 && <div className="sketch-plane-faces">
          <small className="sketch-plane-faces-title">Or sketch on a three-point plane of this part</small>
          {props.framePlanes!.map((option, index) => <button
            key={`${option.label}:${index}`}
            type="button"
            className="sketch-plane-face"
            onClick={() => props.onConfirm("xy", 0, undefined, option.frame)}
          ><CommandIcon name="projection" /><span><strong>{option.label}</strong><small>Through 3 points · the sketch starts at the first point</small></span></button>)}
        </div>}
        <div className="sketch-plane-faces sketch-plane-points">
          <small className="sketch-plane-faces-title">Or sketch on the plane through three points</small>
          {pointTexts.map((text, index) => <label key={index} className="sketch-plane-offset">
            <span>{`Point ${index + 1} (x, y, z in mm)`}</span>
            <div className="feature-edit-field">
              <input
                inputMode="text"
                aria-label={`Point ${index + 1} x, y, z in millimetres`}
                placeholder={["0, 0, 0", "50, 0, 0", "0, 50, 25"][index]}
                value={text}
                onChange={(event) => { const next = [...pointTexts] as [string, string, string]; next[index] = event.target.value; setPointTexts(next); setProblem(""); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirmPoints(); } }}
              />
            </div>
          </label>)}
          <button type="button" className="sketch-plane-face" onClick={confirmPoints}><CommandIcon name="projection" /><span><strong>Start sketch through these points</strong><small>The first point is the sketch origin, the second sets its X direction</small></span></button>
        </div>
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
