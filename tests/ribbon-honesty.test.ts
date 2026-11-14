import { readFileSync } from "node:fs";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-16: ribbon buttons do what their name says. These are static checks of the ribbon source, the same way the layout
 * tests read the style sheets: the Extrude and Revolve buttons start the real sketch-driven commands, the canned ring
 * is sold as a primitive with its fixed sizes in the label, and the one-click tools that used to apply fixed values
 * (trim 70 %, Ø 6 hole, 2 mm face moves) now say they take a typed value. The clicks themselves run in the browser.
 */
const RIBBON = "apps/studio-web/src/ui/WorkbenchRibbon.tsx";
const APP = "apps/studio-web/src/App.tsx";

export const ribbonHonestyTests: readonly TestCase[] = [
  {
    name: "The ribbon Extrude and Revolve start the Part commands, the ring primitive names its fixed sizes, and no modelling button hides a fixed value behind a command name",
    run: () => {
      const ribbon = readFileSync(RIBBON, "utf8");
      const extrudeButton = ribbon.split("\n").find((line) => line.includes('label="Extrude"'));
      assert(extrudeButton !== undefined && extrudeButton.includes('onPartCreate("extrude")'), `the Extrude button starts the Part extrude: ${extrudeButton ?? "missing"}`);
      const revolveButton = ribbon.split("\n").find((line) => line.includes('label="Revolve"') && !line.includes("Revolve to"));
      assert(revolveButton !== undefined && revolveButton.includes('onPartCreate("revolve")'), `the Revolve button starts the Part revolve: ${revolveButton ?? "missing"}`);
      assert(!ribbon.includes('"feature:plate-extrusion", icon: "extrude", label: "Extrude"'), "no button named Extrude selects the template plate record");
      const ring = ribbon.split("\n").find((line) => line.includes('label="Ring primitive"'));
      assert(ring !== undefined && /Ø30/.test(ring) && /12 mm/.test(ring), `the canned ring is a primitive whose label names its sizes: ${ring ?? "missing"}`);
      assert(!ribbon.includes('hint="keep 70%"'), "Trim Body no longer hides its fixed 70 %");
      assert(!ribbon.includes('hint="Ø 6 · through"'), "the Hole button no longer promises a fixed Ø 6");
      assert(!ribbon.includes("· 2 mm\""), "no face tool promises a silent 2 mm");
    }
  },
  {
    name: "The analytic one-click tools ask their one number instead of applying a fixed value",
    run: () => {
      const app = readFileSync(APP, "utf8");
      const section = app.slice(app.indexOf('if (operation === "trim-body")'), app.indexOf('if (operation === "resize-blend")'));
      assert(section.length > 0, "the analytic tool handlers are where this test expects them");
      for (const tool of ["trim-body", "edge-blend", "draft", "shell", "move-face", "replace-face"]) {
        const start = section.indexOf(`"${tool}"`);
        assert(start >= 0, `${tool} handler found`);
      }
      const asks = (section.match(/onView\.ask\(/g) ?? []).length;
      assert(asks >= 6, `each analytic tool asks its number first: ${asks} asks found`);
    }
  }
];
