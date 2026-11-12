import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, type TestCase } from "./test-kit.js";

/**
 * Layout rules that must hold at every window size. They guard two defects found on the live site at 1280 x 650 (same build, different
 * window): the workbench row grew to the side panels' full content height, so the canvas was 2,326 px tall and Fit centred the sketch
 * below the fold; and the New Sketch dialog was taller than the window with its primary button out of reach.
 *
 * These are static checks of the style sheets. The behaviour itself is checked in a real browser with `scripts/layout-probe.js` at the
 * window sizes listed in docs/RELEASE_CHECKLIST.md.
 */
const RESPONSIVE = "apps/studio-web/src/styles/responsive.css";
const FILE_STUDIO = "apps/studio-web/src/styles/file-studio.css";

function sourceFiles(directory: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path, extension));
    else if (entry.name.endsWith(extension)) found.push(path);
  }
  return found;
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

export const layoutWindowSizeTests: readonly TestCase[] = [
  {
    name: "Short window, three columns: the workbench row has a definite height, so the canvas cannot grow to the side panels' content height",
    run: () => {
      const css = readFileSync(RESPONSIVE, "utf8");
      const block = /@media \(max-height: 700px\) and \(min-width: 981px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
      assert(block !== "", "the short-window three-column block exists");
      const height = /\.studio-app \.workbench-grid \{[^}]*\bheight: (\d+)px;/.exec(block)?.[1];
      assert(height !== undefined, "the workbench grid gets a height in pixels there (not auto)");
      assert(Number(height) >= 466 && Number(height) <= 640, `the height leaves room for the 420 px canvas and its timeline strip and stays near one screen: ${height}`);
      // The general short-window block still lets the page scroll and still sets the minimum the fixed height matches.
      const general = /@media \(max-height: 700px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
      assert(/\.studio-app \.workbench-grid \{ height: auto; min-height: 520px; \}/.test(general), "the general short-window rule is unchanged for the stacked narrow layouts");
    }
  },
  {
    name: "Dialogs are never taller than the window: the frame is bounded, the content scrolls and its rows cannot collapse",
    run: () => {
      const css = readFileSync(FILE_STUDIO, "utf8");
      const backdrop = declarations(css, ".dialog-backdrop");
      assert(/position: fixed/.test(backdrop) && /inset: 0/.test(backdrop), "the backdrop covers the window");
      const padding = /padding: ([\d.]+)rem/.exec(backdrop)?.[1];
      assert(padding !== undefined, "the backdrop has a padding in rem");
      const dialog = declarations(css, ".save-project-dialog");
      assert(/display: flex/.test(dialog) && /flex-direction: column/.test(dialog), "the dialog is a column: header, content, footer");
      const limit = /max-height: calc\(100dvh - ([\d.]+)rem\)/.exec(dialog)?.[1];
      assert(limit !== undefined, "the dialog height is limited by the window height");
      assert(Number(limit) >= 2 * Number(padding), `the limit leaves the backdrop padding free at the top and the bottom: ${limit} against ${padding}`);
      const fixedParts = declarations(css, ".save-project-dialog > header, .save-project-dialog > footer");
      assert(/flex: 0 0 auto/.test(fixedParts), "the header and the footer (with the primary button) never shrink or scroll away");
      const content = declarations(css, ".save-project-dialog > .save-project-content");
      assert(/overflow-y: auto/.test(content) && /min-height: 0/.test(content), "the content is the part that scrolls");
      assert(/grid-auto-rows: max-content/.test(content), "content rows keep their full height (auto rows let a clipped child collapse and the next row draw over it)");
    }
  },
  {
    name: "The command palette is bounded by the window below its top offset, and its list gives way instead of its footer",
    run: () => {
      const css = readFileSync(RESPONSIVE, "utf8");
      const offset = /\.palette-backdrop \{ padding-top: ([^;]+);/.exec(readFileSync("apps/studio-web/src/styles/theme-upgrade.css", "utf8"))?.[1];
      assert(offset !== undefined, "the palette's top offset is declared in the theme sheet");
      const palette = declarations(css, ".palette-backdrop > .command-palette");
      assert(/display: flex/.test(palette) && /flex-direction: column/.test(palette), "the palette is a column");
      assert(palette.includes(`max-height: calc(100dvh - ${offset} - `), `its height limit subtracts the same top offset the backdrop uses (${offset})`);
      assert(/flex: 0 0 auto/.test(declarations(css, ".palette-backdrop > .command-palette > *")), "header, filters and footer keep their height");
      const list = declarations(css, ".palette-backdrop > .command-palette > .command-browser-main");
      assert(/flex: 1 1 auto/.test(list) && /min-height: 0/.test(list), "the list area shrinks (its 440 px minimum no longer applies) and scrolls inside");
    }
  },
  {
    name: "Menu-bar menus end above the bottom of the window and scroll (the Modify menu is taller than a laptop screen)",
    run: () => {
      const menu = declarations(readFileSync(RESPONSIVE, "utf8"), ".studio-app .cad-menu-popover");
      const reserved = /max-height: calc\(100dvh - (\d+)px\)/.exec(menu)?.[1];
      assert(reserved !== undefined, "the menu height is limited by the window height");
      assert(Number(reserved) >= 100, `the limit leaves room for the header and the menu bar above the menu (58 + 42 px at most): ${reserved}`);
      assert(/overflow-y: auto/.test(menu), "a menu longer than that scrolls inside itself");
      assert(/grid-auto-rows: max-content/.test(menu), "menu rows keep their height when the menu is limited");
    }
  },
  {
    name: "Every modal dialog uses the bounded dialog frame",
    run: () => {
      const offenders: string[] = [];
      let dialogs = 0;
      for (const file of sourceFiles("apps/studio-web/src", ".tsx")) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (!/className="[^"]*\bdialog-backdrop\b/.test(line)) return;
          dialogs += 1;
          const frame = lines.slice(index + 1, index + 4).find((candidate) => /role="dialog"/.test(candidate)) ?? "";
          if (!/className="[^"]*\bsave-project-dialog\b/.test(frame)) offenders.push(`${file.replace(/\\/g, "/")}:${index + 1}`);
        });
      }
      assert(dialogs >= 8, `the scan found the app's dialogs: ${dialogs}`);
      assert(offenders.length === 0, `a dialog inside .dialog-backdrop must use .save-project-dialog so it is bounded by the window: ${offenders.join(", ")}`);
    }
  }
];
