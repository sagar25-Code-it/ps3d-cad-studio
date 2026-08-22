# ADR 0007: Truth-labeled commands, bounded assembly edits, and Python MCP

**Status:** Accepted for local preview  
**Date:** 2026-08-19

## Context

PS3D needs a more capable professional CAD interaction surface without copying
the structure, wording, assets, or implementation of another CAD product and
without implying that an exact geometry kernel already exists. Assembly users
also need useful editing beyond explode/ground controls. Python users need a
model-neutral way to reach the same bounded automation tools.

## Decision

Maintain one project-owned `CAD_COMMANDS` registry spanning Sketch, Part,
Assembly, Surface, Drawing, and Automate. Every record has a stable ID,
workspace, category, description, invocation intent, search terms, and one of
three capability levels. Qualified or preview commands may navigate to or run
implemented bounded behavior. Kernel/solver/interchange-dependent commands
remain visible but disabled or return an unavailable explanation.

Add revisioned workbench operations for bounded component insertion, deletion,
XYZ translation, visibility, and grounding. Deleting a component also removes
its dependent direct-mate records in the same atomic revision. The preview
continues to use simple procedural boxes/cylinders and conservative AABB
interference; it is not an exact assembly solver.

Add a Python 3.11+ client implemented with the standard library. It launches
only caller-supplied argv with `shell=False`, copies a small non-secret runtime
environment allowlist, performs modern MCP discovery with legacy fallback over
stdio, and exposes the same ten PS3D tools through typed helpers. It does not
embed Python in the browser or add a remote endpoint.

## Consequences

- The UI can behave like a coherent professional workbench while preserving
  honest capability boundaries.
- Assembly insertion/move/visibility/delete are useful functional previews and
  participate in the same revision, audit, undo, persistence, and MCP model.
- Any compliant AI host or approved Python process can use the same protocol
  contract without coupling the CAD domain to one model vendor.
- Exact sweep/loft/shell/Boolean, nonlinear sketch/assembly solving, surface
  trim/stitch, advanced drawing views, and remote authenticated MCP remain
  unavailable until their individual qualification and security gates pass.
