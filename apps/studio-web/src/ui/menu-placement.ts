/**
 * Where a fixed-position menu goes. A menu that opens at a click is kept whole inside the window: it opens below the point when it
 * fits, above when only that side fits, and otherwise on the roomier side with its height bounded so the rest scrolls inside it.
 * Pure, so the rule is tested without a window.
 */
export interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  /** The tallest the menu may be where it is placed; taller content scrolls inside it. */
  readonly maxHeight: number;
}

export function placeMenu(anchor: { readonly x: number; readonly y: number }, size: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, margin = 8): MenuPlacement {
  const width = Math.min(size.width, Math.max(0, viewport.width - 2 * margin));
  const left = Math.max(margin, Math.min(anchor.x, viewport.width - width - margin));
  const below = viewport.height - anchor.y - margin;
  const above = anchor.y - margin;
  if (size.height <= below) return { left, top: Math.max(margin, anchor.y), maxHeight: below };
  if (size.height <= above) return { left, top: anchor.y - size.height, maxHeight: above };
  // Neither side holds the whole menu: take the roomier one and let the menu scroll.
  if (below >= above) return { left, top: Math.max(margin, anchor.y), maxHeight: Math.max(0, below) };
  return { left, top: margin, maxHeight: Math.max(0, above) };
}

/** The slot whose centre is nearest `x` (slot centres in window order). Returns -1 when there are no slots. */
export function nearestSlot(centers: readonly number[], x: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  centers.forEach((center, index) => {
    const distance = Math.abs(center - x);
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  });
  return best;
}
