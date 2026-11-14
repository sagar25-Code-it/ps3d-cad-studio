import { readFileSync } from "node:fs";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-17 (and the sketch audit's SK-21 convention): the Part toolbar is grouped into Fusion-style panels — Create,
 * Modify, Construct, Inspect, Sheet Metal and Output — each showing a few large buttons plus a named drop-down with the
 * rest, and the solid commands start and ask for what is missing instead of sitting disabled until a body is selected.
 * Static checks of the ribbon source and its style sheet, the same way the layout and ribbon-honesty tests read theirs.
 */
const RIBBON = "apps/studio-web/src/ui/WorkbenchRibbon.tsx";
const CSS = "apps/studio-web/src/styles/command-panel.css";

export const ribbonPanelTests: readonly TestCase[] = [
  {
    name: "The Part toolbar is six named panels with drop-downs, in the Fusion order",
    run: () => {
      const ribbon = readFileSync(RIBBON, "utf8");
      const panels = ["Create", "Modify", "Construct", "Inspect", "Sheet Metal", "Output"];
      let position = -1;
      for (const panel of panels) {
        const next = ribbon.indexOf(`<RibbonPanel label="${panel}"`);
        assert(next > position, `the ${panel} panel exists and comes after the previous one`);
        position = next;
      }
      assert(ribbon.includes("ribbon-panel-drop"), "each panel's remaining commands live in a drop-down");
      // The primary rows stay small: each panel shows at most five large buttons before its drop-down takes over.
      const partSection = ribbon.slice(ribbon.indexOf('activeWorkspace === "part" && <>'), ribbon.indexOf('activeWorkspace === "assembly" && <>'));
      for (const block of partSection.split("</RibbonPanel>").slice(0, -1)) {
        const primaries = block.slice(block.lastIndexOf("</>}>")).split("<RibbonButton").length - 1;
        assert(primaries >= 1 && primaries <= 5, `a panel shows between one and five large buttons, not a flat wall (${primaries})`);
      }
    }
  },
  {
    name: "Solid commands start and ask instead of being disabled until a body is selected",
    run: () => {
      const ribbon = readFileSync(RIBBON, "utf8");
      assert(!ribbon.includes("disabled={!generalBodySelected}"), "no command is gated on a selected general body; it starts and asks (or names the choices)");
      for (const label of ["Fillet", "Chamfer", "Shell", "Hole Wizard", "Edge Flange", "Move Body", "Rectangular Pattern"]) {
        const line = ribbon.split("\n").find((candidate) => candidate.includes(`label="${label}"`));
        assert(line !== undefined && !line.includes("disabled"), `${label} is always clickable: ${line ?? "missing"}`);
      }
    }
  },
  {
    name: "The panel drop-down is fixed to the window and placed under its panel name, so the clipping, sideways-scrolling ribbon cannot cut it off",
    run: () => {
      const css = readFileSync(CSS, "utf8");
      const drop = css.slice(css.indexOf(".ribbon-panel-drop {"), css.indexOf("}", css.indexOf(".ribbon-panel-drop {")));
      assert(/position:\s*fixed/.test(drop), "the drop-down is position: fixed (an absolute one was clipped by the ribbon's overflow)");
      const ribbon = readFileSync("apps/studio-web/src/ui/WorkbenchRibbon.tsx", "utf8");
      assert(ribbon.includes("getBoundingClientRect") && ribbon.includes("window.innerHeight - top"), "its position and its height come from where the panel name is and how much window is left below it");
      assert(ribbon.includes('window.addEventListener("pointerdown", outside, true)') && ribbon.includes('event.key === "Escape"'), "it closes on a click elsewhere and on Esc");
    }
  },
  {
    name: "The panel drop-down is bounded by the window height and scrolls inside",
    run: () => {
      const css = readFileSync(CSS, "utf8");
      const drop = css.slice(css.indexOf(".ribbon-panel-drop {"), css.indexOf("}", css.indexOf(".ribbon-panel-drop {")));
      assert(/max-height:\s*min\(60vh/.test(drop), "the drop-down is bounded by a share of the viewport height");
      assert(/overflow-y:\s*auto/.test(drop), "a long family scrolls inside the drop-down");
      const panel = css.slice(css.indexOf(".command-panel {"), css.indexOf("}", css.indexOf(".command-panel {")));
      assert(/max-height:\s*calc\(100% - 24px\)/.test(panel) && /overflow-y:\s*auto/.test(panel), "the command panel is bounded and scrolls inside too");
      assert(!/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/.test(css), "no text in these panels goes under 12 px");
    }
  }
];
