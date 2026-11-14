import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EdgePickSettings } from "../../../../packages/viewport-three/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { menuHost } from "./TimelineBar.js";

export const CREASE_CHOICES: readonly number[] = [10, 20, 30, 45, 60];
export const TOLERANCE_CHOICES: readonly number[] = [4, 6, 8, 12, 16];

export interface MenuBox { readonly left: number; readonly top: number; readonly maxHeight: number }

/**
 * Where the pop-up goes: above its button when it fits there, else below, else on the roomier side with its height bounded so the
 * rest scrolls inside it; always inside the window. Pure so the rule is tested without a window.
 */
export function placeAbove(trigger: { readonly left: number; readonly top: number; readonly bottom: number }, size: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, margin = 8, gap = 6): MenuBox {
  const width = Math.min(size.width, Math.max(0, viewport.width - 2 * margin));
  const left = Math.max(margin, Math.min(trigger.left, viewport.width - width - margin));
  const room = { above: trigger.top - gap - margin, below: viewport.height - trigger.bottom - gap - margin };
  if (size.height <= room.above) return { left, top: trigger.top - gap - size.height, maxHeight: room.above };
  if (size.height <= room.below) return { left, top: trigger.bottom + gap, maxHeight: room.below };
  if (room.above >= room.below) return { left, top: margin, maxHeight: Math.max(0, room.above) };
  return { left, top: trigger.bottom + gap, maxHeight: Math.max(0, room.below) };
}

const choicesWith = (choices: readonly number[], value: number): readonly number[] => choices.includes(value) ? choices : [...choices, value].sort((p, q) => p - q);

/** The two settings and their explanation, as plain form rows (also rendered on its own in tests). */
export function EdgePickForm({ settings, onChange }: { readonly settings: EdgePickSettings | undefined; readonly onChange: (settings: Partial<EdgePickSettings>) => void }): React.JSX.Element {
  const crease = settings?.creaseAngleDeg ?? 30;
  const tolerance = settings?.tolerancePx ?? 8;
  return <div className="edge-pick-form">
    <label><span>Crease angle</span><select value={crease} onChange={(event) => onChange({ creaseAngleDeg: Number(event.target.value) })} aria-label="Crease angle for picking edges on meshes">{choicesWith(CREASE_CHOICES, crease).map((value) => <option key={value} value={value}>{value}°</option>)}</select></label>
    <label><span>Pick radius</span><select value={tolerance} onChange={(event) => onChange({ tolerancePx: Number(event.target.value) })} aria-label="How close in pixels the pointer must be to an edge">{choicesWith(TOLERANCE_CHOICES, tolerance).map((value) => <option key={value} value={value}>{value} px</option>)}</select></label>
    <p>Imported meshes, primitives and bodies without named faces offer an edge where the surface bends by at least the crease angle. Double-click an edge for its tangent chain. Click the same spot again to reach an edge behind it.</p>
  </div>;
}

/** The "Edge pick" button of the view bar and its pop-up, fixed to the window beside the button so no ancestor can clip it. */
export function EdgePickMenu({ settings, onChange }: { readonly settings: EdgePickSettings | undefined; readonly onChange: (settings: Partial<EdgePickSettings>) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<MenuBox | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) { setBox(undefined); return; }
    const button = trigger.current;
    const menu = panel.current;
    if (button === null || menu === null) return;
    const rect = button.getBoundingClientRect();
    setBox(placeAbove(rect, { width: menu.offsetWidth, height: menu.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (): void => setOpen(false);
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target !== null && (panel.current?.contains(target) === true || trigger.current?.contains(target) === true)) return;
      close();
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.stopPropagation(); close(); trigger.current?.focus(); } };
    // A scroll inside the pop-up itself is not "outside".
    const onScroll = (event: Event): void => { if (!(event.target instanceof Node) || panel.current?.contains(event.target) !== true) close(); };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return <>
    <button ref={trigger} className={open ? "active" : ""} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} title="How edges are picked: crease angle and pick radius"><CommandIcon name="edge" />Edge pick</button>
    {open && createPortal(
      <div ref={panel} className="edge-pick-menu" role="dialog" aria-label="Edge picking settings" style={box === undefined ? { left: 0, top: 0, visibility: "hidden" } : { left: box.left, top: box.top, maxHeight: box.maxHeight }}>
        <strong>Edge picking</strong>
        <EdgePickForm settings={settings} onChange={onChange} />
      </div>,
      menuHost(trigger.current)
    )}
  </>;
}
