import { readFileSync, readdirSync } from "node:fs";
import { menuHost } from "../apps/studio-web/src/ui/TimelineBar.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Review: the timeline step menu paints above every docked panel, the command panel and the dialogs, because it is not inside the strip's stacking context. */

const STYLES = "apps/studio-web/src/styles";

export const timelineMenuLayerTests: readonly TestCase[] = [
  {
    name: "The step menu's z-index is above every other layer in the style sheets, and it is mounted outside the strip that creates a stacking context",
    run: () => {
      const strip = readFileSync(`${STYLES}/timeline.css`, "utf8");
      const stripLayer = /\.timeline-bar\s*\{[^}]*z-index:\s*(\d+)/u.exec(strip);
      assert(stripLayer !== null, "the strip is layered (position: fixed with a z-index), which makes it a stacking context");
      const menu = /\.studio-app \.timeline-menu\s*\{[^}]*z-index:\s*(\d+)/u.exec(strip);
      assert(menu !== null, "the menu has a z-index");
      const menuLayer = Number(menu![1]);
      let highest = 0;
      for (const file of readdirSync(STYLES).filter((name) => name.endsWith(".css"))) {
        const css = readFileSync(`${STYLES}/${file}`, "utf8").replace(/\.studio-app \.timeline-menu\s*\{[^}]*\}/u, "");
        for (const match of css.matchAll(/z-index:\s*(\d+)/gu)) highest = Math.max(highest, Number(match[1]));
      }
      assert(highest >= 200, `the scan found the command panel and dialog layers: ${highest}`);
      assert(menuLayer > highest, `the menu (${menuLayer}) is above the highest other layer (${highest}): the docked Edit panel is 160, the command panel 200`);
      const source = readFileSync("apps/studio-web/src/ui/TimelineBar.tsx", "utf8");
      assert(/createPortal\(<TimelineMenu/u.test(source) && source.includes("menuHost(trackRef.current)"), "the menu is portalled out of the strip, whose z-index would otherwise cap it");
    }
  },
  {
    name: "The menu is mounted on the app root so the .studio-app styles still reach it",
    run: () => {
      const root = { name: "app root" } as unknown as Element;
      const inside = { closest: (selector: string) => selector === ".studio-app" ? root : null } as unknown as Element;
      equal(menuHost(inside), root, "the closest .studio-app");
      const fallback = { name: "body" };
      (globalThis as { document?: unknown }).document = { body: fallback };
      try { equal(menuHost(null), fallback as unknown as Element, "no strip yet: the document body"); }
      finally { delete (globalThis as { document?: unknown }).document; }
    }
  },
];
