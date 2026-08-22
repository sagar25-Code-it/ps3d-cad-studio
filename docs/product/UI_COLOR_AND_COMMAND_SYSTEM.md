# PS3D UI Color and Command System

**Status:** Implemented local Phase 1 interface layer  
**Date:** 2026-08-20

## Design objective

The PS3D interface uses an original, compact engineering visual language. The
system separates workspace identity from command meaning so color accelerates
recognition without becoming the only source of information. Text labels,
vector symbols, pressed state, focus state, capability badges, and disabled
state remain present.

No third-party icon package, copied CAD icon, external font, or image asset is
used. Every command symbol is a project-owned inline SVG built from elementary
lines, arcs, rectangles, circles, and polygons. The icons inherit CSS color and
add no network request or runtime package.

## Color-wheel selection

Six evenly distributed, high-visibility hues identify workspaces against the
near-black blue engineering canvas:

| Workspace | Accent | Hex | Intended association |
| --- | --- | --- | --- |
| Sketch | Amber | `#F7C35F` | construction, dimensions, editable intent |
| Part | Cyan | `#42D7FF` | solid modeling and precise geometry |
| Assembly | Violet | `#A78BFA` | relationships and component structure |
| Surface | Mint | `#5EE6B4` | flowing patches and shape control |
| Drawing | Orange | `#FF9D66` | documentation and output |
| Automate | Magenta | `#F178D2` | MCP, Python, and programmable workflows |

The circular spectrum mark in the menu bar exposes the source palette without
turning the interface into a rainbow. Most surfaces remain neutral. Accent
color is limited to workspace tabs, focus/selection rails, active tools, small
status signals, and command symbols.

Commands use a second semantic color layer:

- create: cyan;
- modify: violet;
- inspect/navigation: amber;
- data/exchange/automation: magenta;
- confirmed save/success: mint;
- destructive actions: red.

These colors supplement readable names and symbols; they do not replace them.
A formal accessibility audit remains a release gate.

## Menu hierarchy

The persistent application menu bar contains only functional local actions:

- **File:** open, save to IndexedDB, and download a project copy;
- **Edit:** undo, redo, and all-command search;
- **Create:** switch directly to Sketch, Part, Assembly, or Surface tools;
- **View:** fit, home, grid control, and Drawing workspace;
- **Inspect:** point measure, fit, and capability catalog;
- **Automate:** MCP workspace, Python linking, and automation search;
- **Help:** command/shortcut and capability-label discovery.

The right-side quick strip exposes Fit, Measure, and All Commands. Menus close
after execution, on outside pointer input, or with Escape. Disabled menu items
remain explicit when the current workspace cannot perform the action.

## Fast command launcher

`Ctrl+K` opens the 76-record command catalog. It provides:

- All, Sketch, Part, Assembly, Surface, Drawing, Electrical, and Automate filters;
- token-prefix search to avoid irrelevant substring matches;
- original SVG symbols inferred from command semantics;
- workspace color, category, capability level, and shortcut metadata;
- Arrow Up/Down navigation, Enter execution, and Escape close;
- an explicit count of matching commands and the complete catalog size.

Unavailable commands remain searchable and visibly labeled; the launcher does
not imply that an unavailable kernel or solver operation can run.

## Responsive and performance boundary

The 1280 × 720 workbench keeps project history, canvas, and inspector visible.
At compact desktop widths the header reflows, the menu/workspace/ribbon rows
become sticky, the ribbon remains horizontally navigable, and the inspector
moves below the canvas. The icon system is inline, dependency-free, and uses
CSS `currentColor`, so the complete visual upgrade adds no fetch or image decode
path.
