# ADR 0009: Original color and command visual language

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

The broad workbench already exposed truthful commands, but two-letter ribbon
codes and a mostly single-hue interface slowed recognition. A mature local CAD
preview also needs a stable top-level menu hierarchy and keyboard-first command
discovery without adopting another CAD product's protected artwork or layout.

## Decision

PS3D owns a dependency-free inline SVG symbol component and a two-layer color
system. Six color-wheel hues identify workspaces, while semantic hues identify
create, modify, inspect, data, confirmation, and destructive operations. Text,
symbols, state, and capability labels are always used together.

A persistent File/Edit/Create/View/Inspect/Automate/Help menu row provides only
implemented local actions. The command launcher remains the complete search
surface and adds workspace filters, token-prefix relevance, and keyboard
navigation. Compact layouts retain horizontal ribbon navigation instead of
hiding commands.

## Consequences

- No external icon dependency, asset license, or icon network request is added.
- Ribbon, model browser, sketch constraints, viewport controls, menus, and the
  command launcher share one symbol language.
- Workspace switching changes a restrained accent rather than recoloring the
  full canvas.
- Color is never the only indication of action or capability state.
- New commands should map to an existing semantic icon or add an original
  elementary SVG construction with a matching accessible text label.
- Formal contrast, keyboard traversal, and assistive-technology testing remain
  required before a public release.

