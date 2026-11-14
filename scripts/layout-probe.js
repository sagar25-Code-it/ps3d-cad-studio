// PS3D layout probe. Not part of the app bundle: it is pasted into a running page from the browser's developer tools (or an
// automation tool) to check that the layout holds at a given window size. See docs/RELEASE_CHECKLIST.md, "Window sizes and saved state".
//
// Layout probe: paste into the page (browser javascript tool), then call __layoutProbe() after each resize.
// It reports facts and a `problems` list. An empty list at every window size is the pass condition.
// Selectors are parameters so it works on any app: pass { surface, content, overlays, dialogs }.
window.__layoutProbe = (options = {}) => {
  const surfaceSelector = options.surface ?? "svg.sketch-canvas, .workspace-canvas canvas, main canvas, canvas";
  const contentSelector = options.content ?? "svg.sketch-canvas .sketch-entity";
  const overlaySelector = options.overlays ?? ".sketch-palette, .viewport-controller, .navigation-bar, .canvas-hud";
  const dialogSelector = options.dialogs ?? "[role='dialog']";
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const page = document.scrollingElement ?? document.documentElement;
  const r0 = (n) => Math.round(n);
  const box = (r) => ({ left: r0(r.left), top: r0(r.top), right: r0(r.right), bottom: r0(r.bottom), width: r0(r.width), height: r0(r.height) });
  const union = (rects) => rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const problems = [];
  window.scrollTo(0, 0);
  const report = { window: [vw, vh], devicePixelRatio: window.devicePixelRatio, pageOverflow: { x: page.scrollWidth - vw, y: page.scrollHeight - vh }, problems };
  if (report.pageOverflow.x > 1) problems.push(`page scrolls sideways by ${report.pageOverflow.x} px`);

  const surface = document.querySelector(surfaceSelector);
  if (surface !== null) {
    // Where the page itself scrolls (short or narrow windows), look at the surface the way a user would: scrolled into view.
    if (report.pageOverflow.y > 1) surface.scrollIntoView({ block: "center" });
    const s = surface.getBoundingClientRect();
    const visibleHeight = Math.max(0, Math.min(s.bottom, vh) - Math.max(s.top, 0));
    const visibleWidth = Math.max(0, Math.min(s.right, vw) - Math.max(s.left, 0));
    report.surface = { ...box(s), visibleWidth: r0(visibleWidth), visibleHeight: r0(visibleHeight) };
    if (s.height > vh) problems.push(`work surface is ${r0(s.height)} px tall in a ${vh} px window (it should never be taller than the window)`);
    if (s.width > vw) problems.push(`work surface is ${r0(s.width)} px wide in a ${vw} px window`);
    if (visibleHeight < Math.min(s.height, 240)) problems.push(`only ${r0(visibleHeight)} px of the work surface is on screen`);

    const items = [...document.querySelectorAll(contentSelector)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
    if (items.length > 0) {
      const c = union(items);
      const gaps = { left: r0(c.left - s.left), right: r0(s.right - c.right), top: r0(c.top - s.top), bottom: r0(s.bottom - c.bottom) };
      report.content = { left: r0(c.left), top: r0(c.top), right: r0(c.right), bottom: r0(c.bottom), gaps };
      if (c.left < 0 || c.right > vw || c.top < 0 || c.bottom > vh) problems.push(`fitted content is off screen: ${JSON.stringify(report.content)}`);
      // Overlays that sit over the surface narrow the free area; the content should be centred in what is left, so compare the two side gaps
      // after removing side panels. A lopsided fit (one gap several times the other) is the "sketch pushed to one side" bug.
      const overlays = [...document.querySelectorAll(overlaySelector)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      let freeLeft = s.left;
      let freeRight = s.right;
      const covering = [];
      for (const o of overlays) {
        const overlapsVertically = o.top < c.bottom && o.bottom > c.top;
        const overlapsContent = overlapsVertically && o.left < c.right && o.right > c.left;
        if (overlapsContent) covering.push(box(o));
        const tall = o.height > s.height * 0.5;
        if (tall && o.right <= s.left + s.width * 0.5) freeLeft = Math.max(freeLeft, o.right);
        if (tall && o.left >= s.left + s.width * 0.5) freeRight = Math.min(freeRight, o.left);
      }
      const sideGaps = { left: r0(c.left - freeLeft), right: r0(freeRight - c.right) };
      report.content.sideGapsInFreeArea = sideGaps;
      if (Math.abs(sideGaps.left - sideGaps.right) > Math.max(24, 0.15 * (freeRight - freeLeft))) problems.push(`fitted content is not centred: ${sideGaps.left} px free at the left, ${sideGaps.right} px at the right`);
      if (covering.length > 0) problems.push(`${covering.length} floating panel(s) cover the fitted content`);
    }
  }

  report.dialogs = [...document.querySelectorAll(dialogSelector)].filter((d) => d.getBoundingClientRect().height > 0).map((dialog) => {
    const d = dialog.getBoundingClientRect();
    const scrollers = [dialog, ...dialog.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    const primary = dialog.querySelector("footer .primary, button.primary, button[type='submit']");
    const p = primary?.getBoundingClientRect();
    const primaryVisible = p === undefined ? undefined : p.top >= 0 && p.bottom <= vh && p.left >= 0 && p.right <= vw;
    // A button that sits inside a scrolling part of the dialog can be reached by scrolling; one outside every scroller cannot.
    const primaryReachable = primary === null || primary === undefined ? undefined : primaryVisible || scrollers.some((scroller) => scroller.contains(primary));
    const label = (dialog.getAttribute("aria-labelledby") ?? dialog.className ?? "").toString().slice(0, 60);
    const outside = d.top < 0 || d.bottom > vh || d.left < 0 || d.right > vw;
    if (outside) problems.push(`dialog "${label}" runs outside the window (top ${r0(d.top)}, bottom ${r0(d.bottom)} of ${vh})`);
    if (primaryReachable === false) problems.push(`dialog "${label}": the primary button is off screen and cannot be scrolled to`);
    // Stacked children that draw over each other: a squeezed layout often collapses one row instead of scrolling.
    let overlapping = 0;
    for (const parent of [dialog, ...dialog.querySelectorAll("*")]) {
      if (!(parent instanceof HTMLElement)) continue; // shapes inside an SVG overlap by design
      const style = getComputedStyle(parent);
      if (style.display !== "grid" && style.display !== "flex" && style.display !== "block") continue;
      const kids = [...parent.children].filter((k) => getComputedStyle(k).position === "static" || getComputedStyle(k).position === "relative").map((k) => k.getBoundingClientRect()).filter((r) => r.height > 0 && r.width > 0);
      for (let i = 1; i < kids.length; i += 1) {
        const a = kids[i - 1]; const b = kids[i];
        const sameColumn = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4;
        if (sameColumn && b.top < a.bottom - 2 && b.top > a.top + 2) overlapping += 1;
      }
    }
    if (overlapping > 0) problems.push(`dialog "${label}": ${overlapping} stacked element(s) draw over the one above`);
    return { label, ...box(d), scrollsInside: scrollers.length > 0, primaryVisible, primaryReachable, overlapping };
  });
  // Open menus and popovers: none may run past the edge of the window (a menu that is too long must scroll inside itself).
  report.menus = [...document.querySelectorAll(options.menus ?? "[role='menu'], [class*='popover']")].filter((m) => m.getBoundingClientRect().height > 0 && m.closest("details:not([open])") === null).map((menu) => {
    const m = menu.getBoundingClientRect();
    const label = (menu.getAttribute("aria-label") ?? menu.className ?? "").toString().slice(0, 60);
    if (m.top < 0 || m.bottom > vh || m.left < 0 || m.right > vw) problems.push(`menu "${label}" runs outside the window (top ${r0(m.top)}, bottom ${r0(m.bottom)} of ${vh}; left ${r0(m.left)}, right ${r0(m.right)} of ${vw})`);
    return { label, ...box(m), scrollsInside: menu.scrollHeight > menu.clientHeight + 1 };
  });
  return report;
};
"installed";
