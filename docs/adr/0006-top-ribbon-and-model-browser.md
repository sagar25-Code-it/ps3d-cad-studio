# ADR 0006: Use a Top Command Ribbon and Persistent Model Browser

**Status:** Accepted  
**Date:** 2026-08-19

## Context

The initial broad-workbench shell placed workspace commands in canvas overlays
and mixed model structure with workspace-specific tool lists in the left
panel. User review found that this obscured modeling history and made commands
feel disconnected across Sketch, Part, Assembly, Surface, Drawing, and
Automate.

## Decision

Use three horizontal command levels:

1. a compact project header for file, history, and save actions;
2. workspace tabs for switching the active CAD domain; and
3. a context-sensitive top ribbon for modeling, view, exchange, and automation
   commands belonging to the active workspace.

The left sidebar becomes a persistent model browser. It shows the document,
origin/reference planes, sketches, ordered feature history, bodies, active
workspace objects, and a revision timeline. Document and Origin start
collapsed so Feature History is visible without scrolling. The right sidebar
is a properties and diagnostics inspector; duplicate toolbar-style action rows
are removed from it.

Ribbon selection and model-browser selection share the same stable semantic
ID. Selecting a feature in either surface therefore highlights the other
without creating a second state model.

## Consequences

- Primary tools are consistently discoverable at the top of every workspace.
- Part and feature history remain visible beside the modeling canvas.
- The viewport no longer loses space to floating toolbar overlays.
- Context inspectors remain focused on editable values, evidence, and
  diagnostics rather than duplicate global actions.
- Narrow viewports horizontally scroll the ribbon while preserving keyboard
  and accessible button names.
- The ribbon represents only qualified or explicitly preview-labeled PS3D
  capabilities; it does not imply unsupported commercial-CAD parity.

## Evidence

`artifacts/screenshots/07-top-ribbon-feature-history.jpg` records the 1280 ×
720 Part workspace. Browser checks confirmed every workspace ribbon, Sketch
Line activation, shared Part feature selection, and zero console warnings or
errors.
