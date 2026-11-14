import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NAMED_VIEWS, namedViewById } from "../apps/studio-web/src/ui/named-views.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { plateHoleFillet } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-23: the browser starts with Document settings (the unit, editable) and Named views (Front, Top, Right, Home). */

const noop = (): void => undefined;
const tree = (extra: Record<string, unknown>, unit?: "mm" | "in"): string => {
  const project = { ...plateHoleFillet(), ...(unit === undefined ? {} : { displayUnit: unit }) };
  return renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: noop, onContextMenu: noop, ...extra } as never));
};

export const browserDocumentTests: readonly TestCase[] = [
  {
    name: "Document settings holds the project and a Units control that shows the document's unit and offers the other; the footer reads the same unit",
    run: () => {
      const millimetres = tree({ onUnit: noop, displayUnit: "mm" });
      assert(millimetres.includes("Document settings") && millimetres.includes('aria-label="Document units"'), "a Units select in Document settings");
      assert(/<option value="mm" selected="">Millimeters<\/option>/u.test(millimetres) || millimetres.includes('value="mm"'), "millimetres is the chosen unit");
      assert(millimetres.includes("<strong>millimeters</strong>"), "the footer says millimeters");
      const inches = tree({ onUnit: noop, displayUnit: "in" });
      assert(inches.includes("<strong>inches</strong>") && !inches.includes("<strong>millimeters</strong>"), "with inches chosen the footer says inches, not a fixed millimeters");
      const fromProject = tree({ onUnit: noop }, "in");
      assert(fromProject.includes("<strong>inches</strong>"), "without a host value it reads the project's own display unit");
      const plain = tree({});
      assert(!plain.includes("<select") && plain.includes("Millimeters"), "a host that cannot change the unit shows it as text, with no dead control");
    }
  },
  {
    name: "Named views lists Front, Top, Right and Home, each going to a viewport orientation; the section is absent where there is no 3D view",
    run: () => {
      const html = tree({ onView: noop });
      assert(html.includes("Named views"), "the section is there");
      for (const view of NAMED_VIEWS) assert(html.includes(`<strong>${view.label}</strong>`), `${view.label} is a row`);
      equal(NAMED_VIEWS.map((view) => view.orientation).join(","), "front,top,right,isometric", "going to the standard orientations, Home being the isometric view");
      equal(namedViewById("home")?.orientation, "isometric", "Home looks up");
      equal(namedViewById("nope"), undefined, "an unknown view is not found");
      assert(!tree({}).includes("Named views"), "a 2D environment shows no named views");
    }
  },
];
