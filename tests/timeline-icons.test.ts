import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TIMELINE_ICONS } from "../apps/studio-web/src/ui/TimelineBar.js";
import { CommandIcon } from "../apps/studio-web/src/ui/CommandIcon.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-26: every kind of timeline step has a glyph of its own; two kinds share one only when they are the same operation in two forms. */

const glyph = (name: string): string => renderToStaticMarkup(createElement(CommandIcon, { name })).replace(/data-icon="[^"]*"/u, "");

export const timelineIconTests: readonly TestCase[] = [
  {
    name: "Every step kind's glyph is drawn (not the empty placeholder), and no two kinds share one except a fillet and an edge blend",
    run: () => {
      const placeholder = glyph("no-such-icon-name");
      const byIcon = new Map<string, string[]>();
      for (const [kind, icon] of Object.entries(TIMELINE_ICONS)) {
        assert(glyph(icon) !== placeholder, `${kind} uses ${icon}, which is drawn`);
        byIcon.set(icon, [...(byIcon.get(icon) ?? []), kind]);
      }
      const shared = [...byIcon.values()].filter((kinds) => kinds.length > 1).map((kinds) => kinds.sort().join("+"));
      equal(shared.join(","), "edge-blend+edge-fillet", `only the two forms of a fillet share a glyph: ${shared.join(", ")}`);
    }
  },
  {
    name: "The steps that used to borrow another command's glyph now have their own",
    run: () => {
      const wasBorrowed = ["sweep", "loft", "rib", "dome", "helix", "thread", "web", "emboss", "wrap", "flex", "indent", "offset-face", "sheet-base", "sheet-flange", "sheet-hem", "sheet-edge-flange", "sheet-jog", "sheet-lofted-bend"] as const;
      const others = new Set(Object.entries(TIMELINE_ICONS).filter(([kind]) => !(wasBorrowed as readonly string[]).includes(kind)).map(([, icon]) => icon));
      for (const kind of wasBorrowed) {
        const icon = TIMELINE_ICONS[kind];
        assert(!others.has(icon), `${kind} no longer shares ${icon} with an unrelated step`);
      }
      assert(!["extrude", "revolve", "move", "scale", "chamfer"].some((borrowed) => wasBorrowed.some((kind) => TIMELINE_ICONS[kind] === borrowed)), "none of them is still Extrude's, Revolve's, Move's, Scale's or Chamfer's glyph");
    }
  },
];
