# PRD: Phase 1 Broad Workbench Preview

**Requirement baseline:** 2026-08-19  
**Status:** Approved for original local implementation; not approved for public release  
**Product:** PS3D CAD Studio  
**Authoring input:** Sagar Patel's request for one integrated browser workbench
covering sketching, part modeling, assemblies, surfacing, drafting, and
model-neutral MCP connectivity

## 1. Objective

Deliver a useful, local-first, original browser CAD preview that demonstrates
an integrated semantic workflow across eight workspaces without claiming exact
kernel behavior or feature parity with any existing CAD product. A user must
be able to create and inspect bounded geometry, move between workspaces, save
the project locally, export useful artifacts, and connect an MCP-capable host
to a vendor-neutral tool surface.

The existing worker-validated centered-bore part remains the strongest solid
evaluation path. New broad capabilities are bounded semantic and tessellated
preview capabilities until their individual geometry contracts and
qualification gates mature.

## 2. Product principles

- Original information architecture, wording, graphics, samples, and code.
- One canonical project with stable IDs and revisioned operations.
- Local-first operation with no login, telemetry, remote storage, or secret.
- Clear capability labels: `qualified`, `preview`, or `unavailable`.
- Unsupported cases fail visibly and preserve the prior valid project.
- AI/model integration is protocol-neutral and read-only by default.
- A mutation is never hidden: preview, diff, confirmation, commit, and undo
  must remain distinct concepts.
- Browser rendering geometry is derived and disposable.

## 3. Users and primary journeys

1. A maker sketches a profile with line, rectangle, circle, or arc entities,
   sees snap/constraint information, and understands remaining freedom.
2. A designer changes the bounded plate, bore, and edge parameters and gets a
   regenerated validated mesh-solid part.
3. A product designer places reusable component instances, grounds one, edits
   its XYZ position and visibility, applies bounded rigid/axis mate records,
   and inspects an exploded state.
4. A shape designer modifies a bicubic patch or two-profile loft preview and
   inspects the tessellation and continuity indicators.
5. A drafter creates an associative vector sheet with orthographic and
   isometric views, dimensions, notes, and an original title block.
6. An MCP host lists PS3D tools, inspects capabilities/project summaries, and
   requests a bounded mutation preview without filesystem or network access.
7. A Python user connects to the same local MCP tools through an explicit,
   dependency-free stdio client in an approved development environment.

## 4. Functional requirements

### FR-WB-01 — Unified workbench shell

- Provide Sketch, Part, Assembly, Surface, Drawing, Electrical, and Automate workspaces.
- Preserve project state and selection while switching workspaces.
- Provide a searchable command launcher, project tree, central canvas, context
  inspector, status line, units, revision, and capability badge.
- Catalog broad professional CAD command families with one of three honest
  levels: qualified, functional preview, or visible-but-unavailable.
- Keyboard focus, labels, and reduced-motion behavior are required.

### FR-WB-02 — Canonical preview project

- Use schema `ps3d-workbench-project/1` with stable namespaced IDs.
- Store units, revision, sketch entities/constraints, part parameters,
  component instances/mates, surface parameters, drawing settings, and the
  automation audit log.
- Every accepted operation increments revision and records a bounded audit
  entry. Invalid operations return a typed error without mutation.
- Local save/load uses one IndexedDB record and exact schema validation.

### FR-SK-01 — General sketch subset

- Create line, center rectangle, circle, and three-point arc entities on XY.
- Support grid/snap/profile/dimension/constraint visibility plus construction
  geometry controls.
- Support horizontal, vertical, parallel, perpendicular, tangent, collinear,
  coincident, concentric, equal, radius, distance, and fixed constraint records.
- Select one entity or Shift-select a pair, delete and constrain by stable ID,
  and display in-canvas constraint glyphs.
- Apply bounded driving dimensions to line length, rectangle width/height, and
  circle radius as atomic geometry-plus-record operations.
- Report an explainable degrees-of-freedom estimate and conflicts for the
  supported subset. The estimate is not a general nonlinear solver claim.
- Default example: an original mounting profile using a rectangle, two circles,
  a centerline, dimensions, and symmetry intent.

### FR-PT-01 — Part modeling subset

- Retain the worker-qualified centered-bore extrusion with width, height,
  thickness, bore diameter, units, topology, measurements, evidence, history,
  local save, native JSON, and STL export.
- Provide preview feature records for base extrusion, bore cut, edge treatment,
  linear pattern, and revolve. Only the centered-bore extrusion is marked
  `qualified`; edge treatment, pattern, and revolve are marked `preview`.
- Values are bounded and invalid wall thickness or envelope values are rejected.

### FR-VP-01 — Viewport interaction and inspection

- Provide select, orbit, pan, wheel zoom, fit, and isometric home behavior.
- Provide front, back, left, right, top, bottom, and isometric named camera views.
- Provide perspective and orthographic projection using one shared camera target.
- Display an original PS3D named-view box, WCS axis viewer, grid, and scene axes.
- Provide automatic, body, and component selection priorities. Face and edge
  priority stay visibly unavailable until persistent topology exists.
- Measure two actual visible triangle intersections and report both WCS points,
  XYZ delta, Euclidean distance, and persistent viewport markers.

### FR-AS-01 — Assembly subset

- Provide stable component instances with part reference, transform, visibility,
  grounded state, and color.
- Insert bounded box/cylinder components, delete a selected component and its
  dependent direct mates, edit XYZ translation, and toggle visibility or
  grounding through revisioned operations.
- Support fixed, coincident-origin, and aligned-axis mate records.
- Compute deterministic transforms for the supported mate subset.
- Provide exploded distance, component selection, mate status, structure tree,
  and axis-aligned interference candidates.
- Default example: base plate, spacer, pin, and cap assembled from original
  procedural preview components.

### FR-SU-01 — Surface subset

- Provide a bicubic Bézier patch defined by a 4 × 4 control net.
- Provide a ruled loft between two bounded section profiles.
- Tessellate deterministically with configurable U/V segments from 4 through 48.
- Report triangle count, approximate area, normal variation, and boundary state.
- Control-net height, crown, twist, and tessellation are editable.
- Trimming, sewing, offsets, exact NURBS, and surface-to-solid conversion are
  unavailable and must be labeled as such.

### FR-DR-01 — Drafting subset

- Generate vector front, top, right, and isometric views from the current
  bounded part parameters.
- Show linear, radial/diameter, and thickness dimensions plus center marks.
- Provide A4/A3 sheet choice, first/third-angle label, scale, notes, and an
  original PS3D title block.
- Download sanitized standalone SVG. PDF/DXF/DWG are unavailable in this phase.

### FR-MCP-01 — Model-neutral MCP subset

- Ship a local stdio server based on the official MCP TypeScript SDK.
- Advertise deterministic tool schemas and annotations.
- Tools:
  - `ps3d_guide` — read-only machine-readable collaboration contract;
  - `ps3d_find_commands` — deterministic bounded recipe matching without execution;
  - `ps3d_capabilities` — read-only capability matrix;
  - `ps3d_inspect_project` — read-only bounded project summary;
  - `ps3d_design_health` — read-only all-workspace readiness, dependency, and rebuild-order review;
  - `ps3d_analyze_vehicle` — read-only preliminary vehicle calculations with qualification exclusions;
  - `ps3d_electromechanical_catalog` — read-only generic physical-package catalog;
  - `ps3d_preview_electromechanical` — non-mutating, fully disclosed circuit-to-mounted-3D candidate;
  - `ps3d_preview_operation` — non-mutating validation and diff preview;
  - `ps3d_apply_preview` — apply only a matching preview receipt plus explicit
    confirmation, returning a new project rather than writing files.
- The server reads no files, environment secrets, browser profile, network
  resource, or OS credential store. The entire project is supplied in the call
  and returned in the result.
- stdio writes protocol JSON only to stdout; diagnostics use stderr.
- Remote Streamable HTTP and OAuth are deferred to the deployment phase.
- Provide a Python 3.11+ standard-library client that implements modern MCP
  discovery with 2025-era initialize fallback, tools/list, tools/call, and typed
  helpers for all eleven PS3D tools. It must use
  explicit argv, `shell=False`, a finite timeout, and no network or automatic
  project/secret discovery.

### FR-WB-03 — Artifact and help flows

- Provide project JSON download/open for the broad preview schema.
- Provide drawing SVG and existing STL export.
- Present a capability matrix and limitations in-product.
- Provide copyable local MCP configuration without a key or secret.

## 5. Non-functional requirements

### NFR-01 — Security and privacy

- No remote fetch from product runtime, telemetry, account, secret, or private
  filesystem access.
- Exact schemas, finite-number checks, count limits, string limits, and
  deterministic error responses on all project and MCP inputs.
- MCP call size is capped at 1 MB; entities 500; components 100; mates 200;
  audit entries 500; surface tessellation 48 × 48 maximum.
- Existing restrictive CSP and production dependency boundary remain.

### NFR-02 — Performance

- Initial usable shell within 3 seconds on the qualification workstation.
- Workspace switch under 100 ms outside geometry regeneration.
- Bounded preview rebuild under 100 ms for default examples.
- Existing worker operation timeout remains 15 seconds.

### NFR-03 — Accessibility

- All operations have keyboard-reachable native controls and visible focus.
- Canvas/SVG views have useful accessible names and textual model summaries.
- Color is never the sole status indicator; reduced motion is honored.
- Target contrast is WCAG 2.2 AA for ordinary text and controls.

### NFR-04 — Determinism and evidence

- Pure project operations produce identical JSON for identical input and
  operation IDs.
- Surface tessellation and drawing SVG use deterministic ordering and formatting.
- Existing semantic/mesh evidence remains visible for the qualified part.
- Generated source identity, dependency inventory, audit, and two-build
  repeatability checks remain release gates.

## 6. Acceptance criteria

- AC-01: All six workspace tabs render and preserve one project revision.
- AC-02: A user can create each supported sketch entity and receive stable IDs,
  snap information, and a DOF/conflict result.
- AC-03: A valid part parameter edit regenerates the worker-qualified mesh;
  an invalid bore edit rolls back visibly.
- AC-04: Assembly insertion, XYZ movement, hide/show, grounding, deletion,
  explode, and mate controls update the canonical project and preview
  deterministically.
- AC-05: Surface controls rebuild a finite patch mesh and metrics.
- AC-06: Drawing controls rebuild a standalone safe SVG and download it.
- AC-07: MCP initialize, tools/list, and every listed tool pass an executing
  local client test; an apply call without a matching receipt is rejected.
- AC-08: Project save/load and JSON round trip preserve semantic state.
- AC-09: Typecheck, unit/integration tests, build boundary, dependency audit,
  secret scans, and executing browser smoke checks pass.
- AC-10: Interface screenshots show Part, Sketch, Assembly, Surface, Drawing,
  and Automate views for user review before any external publication.
- AC-11: The command launcher lists at least 50 unique truth-labeled commands,
  and an unavailable command returns a visible explanation without running a
  modeling operation.
- AC-12: Named-view and projection controls update the camera and orientation
  indicators without modifying project geometry.
- AC-13: Two measure picks on visible model triangles return persistent markers,
  WCS coordinates, XYZ delta, and distance.
- AC-14: A supported driving sketch dimension updates geometry and its dimension
  record in one revision, while an incompatible dimension is rejected.

## 7. Explicit exclusions

- Full parity with any commercial CAD suite.
- Exact B-rep/NURBS, arbitrary Boolean robustness, shells, exact blends,
  persistent face naming, topology healing, and standards-based STEP/IGES.
- General nonlinear geometric or assembly solvers and kinematic simulation.
- Surface trimming/sewing or production-class curvature continuity.
- Production drawing standards certification and DWG/DXF/PDF export.
- Cloud documents, multi-user collaboration, billing, identity, telemetry,
  remote MCP, OAuth, or server-side durable state.
- GitHub publication or Vercel deployment before separate release approval.

## 8. Release gate

This PRD authorizes local implementation and qualification only. Public release
still requires human provenance review, dependency and license reconciliation,
SBOM, signed source/build identities, browser matrix, accessibility review,
security review, final screenshots, and an explicit release action.
