# PS3D CAD Studio Roadmap

This roadmap stages capability behind measurable quality gates. Dates are deliberately omitted until Phase 0 establishes geometry feasibility and team throughput. A stage starts only when the preceding exit criteria are met; feature count never overrides correctness, recoverability, or transparent limitations.

## Phase 0 — Feasibility and foundation

**Objective:** Prove the independently designed browser CAD foundation before committing to a public modeling release.

**Primary outcomes:**

- Provenance, MIT licensing, dependency review, and software-bill-of-materials process.
- Published units, tolerance, geometric validity, and tessellation contracts.
- Feasibility prototypes for sketch solving, analytic topology, extrusion, and limited Booleans.
- Canonical document model, transaction boundary, worker-hosted geometry, and versioned persistence prototype.
- Original design system and validated core modeling flow.

**Exit gate:** All Phase 0 requirements in `PRD_PHASE_0_1.md` pass. If geometry reliability is insufficient, extend this phase or narrow Phase 1; do not silently weaken validity criteria.

## Phase 1 — Free public single-part CAD

**Objective:** Release a useful, local-first browser tool for simple parametric solid parts.

**Primary outcomes:**

- No-account public web application and MIT-licensed public source.
- Principal planes, 2D sketch entities, a bounded geometric/dimensional constraint set, and degrees-of-freedom diagnostics.
- Boxes, cylinders, sketch extrusion, a bounded Boolean subset, parametric regeneration, and failure containment.
- Structure and parameter inspection, undo/redo, measurement, autosave, recovery, and versioned native projects.
- Validated STL export and independently authored learning materials.
- Published performance, browser support, dimensional envelope, and known limitations.

**Exit gate:** All supported conformance cases, persistence migrations, cross-browser scenarios, release acceptance workflows, security checks, licensing checks, and beta reliability targets pass.

## Phase 1A — Broad workbench preview

**Objective:** Validate one original integrated product architecture across
Sketch, Part, Assembly, Surface, Drawing, Electrical, and Automate workspaces before
promoting broad capabilities to production support.

**Primary outcomes:**

- A shared versioned preview project, stable IDs, revision audit, local save,
  capability matrix, a 116-command truth-labeled catalog, command search, and
  original multi-workbench shell.
- Functional bounded sketch entities/constraints, procedural part intent,
  editable component instances/mates, bicubic and loft surfaces, associative
  SVG sheets, and a local stateless MCP stdio server with an optional
  standard-library Python client.
- Original CAD interaction layer with named views, orbit/pan/zoom/fit,
  orthographic and perspective projection, view box, WCS axis viewer, selection
  priorities, point measurement, sketch palette, and bounded driving dimensions.
- Deterministic generic-envelope electromechanical realization with terminal
traceability, one wired mounting plate with unsized conductor paths, stale-link detection, explicit review,
  and model-neutral MCP preview/apply semantics.
- Explicit `qualified`, `preview`, and `unavailable` labels so visual output is
  never mistaken for exact or manufacturing-qualified geometry.

**Exit gate:** The acceptance criteria in
`PRD_PHASE_1_WORKBENCH_PREVIEW.md` pass locally, the interface screenshots are
approved, and the release gates remain green. This preview does not bypass the
deeper gates in the later roadmap sections.

## Parametric depth

**Objective:** Expand from a bounded part modeler to a more expressive and resilient feature system.

Candidate increments include named parameters and expressions, richer constraint diagnostics, projected geometry, additional datum geometry, revolve, sweep, loft, patterns, fillet, chamfer, shell, draft, feature suppression, and improved semantic reference repair.

**Gate:** Every new feature receives an explicit supported geometry envelope, deterministic regeneration tests, error behavior, migration coverage, and performance budget.

## Assemblies

**Objective:** Compose reusable part documents into constrained multi-part products.

Candidate increments include part instances, hierarchical assembly structure, rigid and limited-motion mates, grounded components, mate diagnostics, interference checks, mass properties, exploded states, and bills of materials.

**Gate:** Stable instance identity, deterministic mate solving, cycle/conflict diagnostics, scalable loading, and safe cross-document reference behavior are demonstrated on published reference assemblies.

## Surfacing

**Objective:** Support controlled creation, inspection, and conversion of surface geometry.

Candidate increments include parametric curves, surface sweep and loft, boundary surfaces, trimming, sewing, continuity analysis, and solid/surface interoperability.

**Gate:** The project publishes mathematical definitions, tolerance behavior, continuity diagnostics, trimming/sewing validity rules, and an independently authored conformance corpus before claiming support.

## Drawings and exchange

**Objective:** Communicate designs in technical drawings and exchange data through carefully validated public standards.

Candidate increments include associative drawing views, sections, details, dimensions, annotations, title-block templates, vector output, and staged standards-based import/export.

**Gate:** Each format or drawing capability has a separate conformance plan, round-trip policy, supported-subset declaration, legal/specification review, and failure behavior. Format names must not appear as supported until that gate passes.

## Model-neutral MCP connectivity

**Objective:** Allow authorized tools and AI clients to inspect and propose changes without coupling the CAD system to one model, vendor, or user interface.

The connection layer will expose versioned resources and capability-scoped commands over the canonical document and transaction APIs. It will default to read-only discovery and require explicit authorization for mutation. Write operations must support validation, preview, diff, commit, rollback/undo, stable object identifiers, bounded resource use, and an auditable local action record.

**Gate:** A separate protocol PRD and threat model define consent, authentication, authorization, schema versioning, transaction semantics, privacy, prompt/data boundaries, malformed-client handling, and interoperability tests with multiple independent clients.

## Persistent program rules

- Public claims follow reproducible measurements, not roadmap intent.
- Unsupported operations fail clearly and preserve the last valid document.
- Derived rendering data never replaces the canonical semantic model.
- Project code remains MIT-licensed; dependencies and assets retain reviewed provenance.
- New stages require their own bounded PRD, acceptance criteria, risks, and explicit exclusions.
