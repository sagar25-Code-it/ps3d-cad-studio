# Design Health and deterministic rebuild review

## Purpose

PS3D Design Health is a project-wide, read-only engineering review layer. It
turns the eight separate workspaces into one visible readiness contract without
claiming unsupported associativity or exact-kernel behavior. The same pure
analysis powers the browser Design Health Center, the project tree, command
catalog, Automate workbench, Python client, and `ps3d_design_health` MCP tool.

The report schema is `ps3d-design-health/1`. Its only input is one complete,
validated `ps3d-workbench-project/1` value supplied by the caller. It performs
no filesystem, browser-profile, credential, environment-secret, or network
access and never mutates the supplied project.

## Workspace review

Every report contains exactly one record for Sketch, Part, Surface,
Electrical, Assembly, Vehicle, Drawing, and Automate. Checks use existing
deterministic project analyzers:

- Sketch: entity presence, bounded degrees of freedom, and constraint conflict;
- Part: exact qualification boundary versus preview-only feature intent;
- Surface: tessellation degeneracy, resolution, normal variation, and open-patch boundary;
- Electrical: structural ERC and circuit-to-3D readiness;
- Assembly: component presence, grounding, mate status, conservative overlap candidates, and ECAD trace state;
- Vehicle: geometry/calculation errors, warnings, and supplier-evidence status;
- Drawing: view coverage, dimension visibility, datum/GD&T consistency, and general-tolerance scale;
- Automate: caller-owned state boundary and bounded audit capacity.

Each workspace is labeled `healthy`, `review`, or `blocked`. The score starts
at 100, subtracts 24 for each error and 7 for each warning, and never drops
below zero. Information findings document limits but do not reduce the score.
The overall score is the rounded mean of the eight workspace scores. Any
blocked workspace blocks the report; otherwise any warning produces review.

Scores are navigation and triage aids, not engineering acceptance criteria.
Projects with a high score can still be unsuitable for manufacture or use.

## Actual dependency contract

The report distinguishes four dependency modes:

- `associative`: the downstream artifact is regenerated from current upstream intent;
- `trace-linked`: a recorded source signature connects two workspaces and can become stale;
- `snapshot`: an explicit caller-supplied project copy is read without a live link;
- `detached`: no current regeneration contract exists.

Current truthful links are:

- Part to Drawing is associative for the bounded automatic part sheet;
- Electrical to Assembly is trace-linked only after a reviewed physical candidate is applied;
- Automate reads caller-supplied snapshots;
- Sketch to Part and Surface/Assembly/Vehicle to Drawing are detached.

Detached relationships stay visible so a user or AI cannot mistake proximity
in the interface for parametric associativity.

## Deterministic review order

The current dependency-safe review order is:

1. Sketch
2. Part
3. Surface
4. Electrical
5. Assembly
6. Vehicle
7. Drawing
8. Automate

This is a review and derived-analysis order. It is not an exact B-rep feature
rebuild, nonlinear solve, PDM transaction, or automatic repair operation.

## User interface and automation

The Design Health Center is available from the header, quick-command strip,
Inspect and Help menus, status bar, `Ctrl+Shift+H`, and the 119-command catalog.
It provides an eight-workspace matrix, capability counts, dependency table,
severity filters, evidence, recovery guidance, and the stable review order.

MCP and Python use the same deterministic engine:

- MCP: `ps3d_design_health({ project })`;
- Python: `client.design_health(project)`.

Both are read-only. AI hosts must continue to use inspect, preview, exact
candidate disclosure, explicit confirmation, and returned-project review for
any mutation.

The reviewed browser state is retained as
[`49-design-health-center.jpg`](../screenshots/49-design-health-center.jpg).

## Release boundary

Design Health is not a solver certificate, geometry-kernel validation,
manufacturing release, GD&T approval, drawing release, electrical code result,
functional-safety result, roadworthiness or homologation approval, or
substitute for qualified engineering review. Exact persistent dependency
graphs, selective feature rebuild, cycle diagnostics, rollback, multi-user PDM,
and signed release workflows require separate architecture and qualification.
