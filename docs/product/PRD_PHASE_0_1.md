# PS3D CAD Studio — Phase 0 and Phase 1 Product Requirements

**Status:** Draft for approval  
**Release scope:** Phase 0 foundation and Phase 1 public alpha/beta  
**Product type:** Browser-based computer-aided design application  
**License:** Original project code released under the MIT License  
**Commercial posture:** Phase 1 is free, public, and usable without payment or an account

## 1. Product summary

PS3D CAD Studio is a new browser-based CAD system built from first principles. It will begin as a focused single-part parametric modeling tool and establish an architecture that can later support richer sketching, solid modeling, assemblies, surfacing, technical drawings, standards-based exchange, and AI-model/provider-neutral Model Context Protocol connectivity.

The long-term goal is to become exceptionally capable, predictable, and accurate among browser CAD tools. This is a north star, not a Phase 1 claim. Comparative claims may be made only after reproducible benchmarks demonstrate them.

Phase 0 is a technical and product feasibility stage. Phase 1 is a narrowly scoped, public CAD release for creating and editing simple parametric solid parts. It is not presented as a complete professional CAD replacement.

## 2. Governing constraints

### 2.1 Independent implementation

The product must be designed and implemented independently.

Permitted inputs are:

- General mathematical and CAD concepts.
- Independently written product requirements and design research.
- Public technical standards and legally obtained normative specifications.
- General-purpose browser, rendering, testing, build, and mathematics libraries that pass license and provenance review.
- Original research, source code, tests, schemas, fixtures, documentation, icons, illustrations, and interface designs created for this project.

Prohibited inputs include another CAD product's source code, repository files or history, internal schemas, test suites, assets, interface implementation, design files, private documentation, or copied workflows. No compatibility or behavioral cloning work is in scope.

The team must maintain:

- An origin and license record for every dependency and externally sourced asset.
- Contributor attestation that submitted work was authored for this project.
- An architecture decision log showing that major decisions arose from product needs, general engineering principles, mathematics, or public standards.
- A software bill of materials for every public release.
- An independently created design system, terminology set, icons, layout, and interaction model.

### 2.2 Licensing

- All project-owned source code must be published under MIT.
- Original documentation and assets must have an explicit project-approved license.
- Third-party notices and upstream licenses must remain intact.
- Dependencies must be redistributable in a public, free application. Any dependency with unclear or incompatible terms blocks release until replaced or approved.
- The public repository must include `LICENSE`, third-party notices, contribution guidance, build instructions, a security policy, and provenance policy.

### 2.3 Truthful product communication

Each release must publish:

- Supported workflows and browsers.
- Tested model-size and dimensional ranges.
- Known geometry limitations.
- File-format stability status.
- Performance results and the hardware/browser used.
- Features that are experimental or may produce an explicit unsupported-operation error.

The product must not describe Phase 1 as production-ready, enterprise-ready, or broadly compatible with professional CAD exchange formats.

## 3. Problem statement

Browser CAD lowers installation and hardware barriers, but users still need a tool that is precise, understandable, recoverable after errors, and transparent about its supported operating range. Early learners and makers also need a no-cost entry point that does not require an account before they can model and save a part.

PS3D CAD Studio will address this initially by offering a local-first browser workspace in which users can construct a constrained sketch, create a small solid, edit its parameters, regenerate it safely, save it, reopen it, and export a fabrication-oriented mesh.

## 4. Target users and jobs

### Primary users

- Students and CAD learners creating dimensioned introductory parts.
- Makers creating simple parts for visualization or additive manufacturing.
- Engineers and designers making early single-part concepts.
- Open-source contributors evaluating and extending a clearly documented CAD foundation.

### Core Phase 1 jobs

- Create a dimensionally defined solid without installing desktop software.
- Modify a dimension and have dependent geometry regenerate.
- Understand whether a sketch is under-constrained, fully constrained, or conflicting.
- Recover from an invalid feature without losing earlier valid work.
- Save a project locally and reopen it with equivalent parameters and geometry.
- Export a watertight tessellated mesh for downstream use.

## 5. Product principles

- **Correctness before feature count:** unsupported geometry must fail clearly and non-destructively.
- **Semantic model before display mesh:** tessellation is a view/export derivative, not the authoritative model.
- **Local-first ownership:** Phase 1 projects remain on the user's device unless the user explicitly exports them.
- **Inspectability:** parameters, dependencies, errors, units, and regeneration state must be visible.
- **Reversibility:** edits use commands with undo/redo; failed operations preserve the last valid state.
- **Progressive capability:** each stage has measurable exit criteria and explicit exclusions.
- **Protocol neutrality:** future automation contracts must not depend on one AI vendor, model, or client.

## 6. Phase definitions

### Phase 0: feasibility and foundation

Phase 0 produces internal prototypes, technical contracts, and a go/no-go decision. It is not a user release.

Its purpose is to prove that the team can independently deliver:

- A viable numerical tolerance and units policy.
- A valid analytic solid representation for the Phase 1 subset.
- Sketch solving for the Phase 1 constraint subset.
- Boolean and extrusion behavior adequate for the reference workflows.
- Responsive browser execution using a background worker boundary.
- Deterministic feature regeneration and versioned persistence.
- An original, usable interaction concept.

### Phase 1: free public single-part CAD

Phase 1 delivers a public source repository and hosted browser application. Its supported product envelope is intentionally limited to desktop browsers, single documents, simple parametric sketches, and simple solid parts.

The release may be labeled **alpha** until all release criteria are met and **beta** once the independently authored conformance suite, usability criteria, and reliability targets pass.

## 7. Reference architecture requirements

The architecture is a product requirement because later expansion must not require replacing the document model.

The system must separate:

1. **Application shell:** commands, panels, keyboard handling, accessibility, and session lifecycle.
2. **Canonical document model:** units, parameters, sketches, features, bodies, dependencies, and stable project object identifiers.
3. **Command and transaction layer:** validated mutations, undo/redo, preview, commit, and error results.
4. **Sketch solver:** constraint graph, degrees-of-freedom reporting, and conflict diagnostics.
5. **Geometry engine:** analytic geometry, topology, feature evaluation, validation, and Boolean operations.
6. **Tessellation and rendering:** disposable display meshes and selection metadata.
7. **Persistence:** versioned native documents, migrations, autosave, and recovery.
8. **Adapter boundary:** future import/export and protocol integrations, including MCP, without direct access to UI state.

Geometry and sketch solving must run outside the browser UI thread. Rendering code must not mutate the canonical model directly. Derived meshes and caches must be safely discardable and reproducible from semantic document data.

## 8. Phase 0 requirements and exit criteria

### P0-01 — Provenance and project foundation

Deliver the repository structure, license, provenance policy, dependency policy, contribution rules, design decision log, security policy, and automated license/SBOM checks.

**Exit criteria:**

- Every included file has a known origin.
- All project code is MIT-licensed.
- Every dependency is recorded with version, purpose, source, and license.
- A clean build succeeds from the documented procedure.
- No externally sourced CAD application code, schema, fixture, test, asset, or UI artifact is present.

### P0-02 — Numerical and geometry contract

Define:

- Internal unit convention and unit conversion rules.
- Supported Phase 1 dimensional envelope.
- Absolute and relative tolerance rules.
- Coincidence, tangency, containment, and degeneracy classifications.
- Solid validity invariants.
- Tessellation chord and angular error behavior.
- User-facing treatment of geometry outside the supported envelope.

**Exit criteria:**

- The contract is documented and executable as tests.
- Analytic box, cylinder, line, arc, circle, plane, and extrusion cases pass the independently authored suite.
- Invalid or near-degenerate inputs return a typed error rather than corrupting the document.
- Display tessellation error is demonstrably separate from modeling accuracy.

### P0-03 — Sketch solver feasibility

Prototype lines, circles, arcs, rectangles, driving dimensions, and the Phase 1 constraint subset.

**Exit criteria:**

- The solver reports remaining degrees of freedom.
- Fully constrained reference sketches remain stable across repeated solves.
- Contradictory constraints are detected and identified without changing the last valid sketch.
- Solver output is reproducible within the numerical contract.

### P0-04 — Solid modeling feasibility

Prototype new-body extrusion, additive extrusion, subtractive extrusion, and the limited Boolean subset.

**Exit criteria:**

- Independently authored reference models regenerate as valid closed solids.
- The suite includes disjoint, contained, intersecting, tangent, and explicitly unsupported near-degenerate cases.
- Every supported case passes; unsupported cases fail with a specific diagnostic.
- Repeated regeneration does not accumulate visible or measured geometric drift.

### P0-05 — Browser architecture feasibility

Prototype a viewport, worker-hosted modeling engine, selection identifiers, command transactions, and incremental tessellation.

**Exit criteria:**

- Long-running modeling work does not freeze input handling.
- Cancellation or worker failure preserves the last committed document.
- Selection resolves from rendered elements to canonical semantic objects.
- The prototype demonstrates save, close, reopen, and equivalent regeneration.

### P0-06 — Original UX concept

Produce task flows and a working interaction prototype from user goals rather than product references.

**Exit criteria:**

- A novice can discover how to create a sketch, add a dimension, extrude it, and edit the dimension.
- The design has original visual language, terminology, icons, and component definitions.
- Errors identify what failed, why it matters, and a reasonable recovery action.
- Keyboard focus order and non-canvas controls meet the accessibility plan.

### Phase 0 gate

Phase 1 may start only when P0-01 through P0-06 pass. If Boolean reliability or sketch-solving criteria fail, the program must either extend Phase 0 or reduce the Phase 1 modeling subset. Schedule pressure must not silently weaken correctness criteria.

## 9. Phase 1 functional requirements

Priority terminology: **Must** is release-blocking; **Should** may move to a later Phase 1 beta increment if clearly labeled.

### F1-01 — Document lifecycle — Must

Users can:

- Create a blank document.
- Name and rename it.
- Select millimeters or inches at creation.
- See whether the document has unsaved changes.
- Save to browser-local storage.
- Download a native project file.
- Open a native project file through a file picker or drag-and-drop.
- Duplicate a document.
- Recover the latest valid autosave after a crash or unexpected close.

Unit changes must not silently reinterpret existing physical sizes.

### F1-02 — Viewport and navigation — Must

Provide:

- Orbit, pan, zoom, fit-to-model, and fit-to-selection.
- Perspective and orthographic projection.
- Standard front, rear, left, right, top, bottom, and isometric views.
- Origin indicator, axes, grid, active work plane, and scale cues.
- Configurable visible grid spacing appropriate to document units.
- Face, edge, body, sketch-entity, and feature selection.
- Hover and selection highlighting that remains distinguishable without relying solely on color.
- Show/hide controls for sketches, bodies, planes, grid, and origin.

Desktop mouse/trackpad and keyboard are required. Full touch modeling is not required.

### F1-03 — Structure and parameters — Must

The application must show a document structure containing datum geometry, sketches, features, and bodies.

Users can:

- Select an item in either the structure view or viewport and see the same selection elsewhere.
- Rename sketches, features, and bodies.
- Inspect feature inputs, dependencies, parameters, and regeneration state.
- Edit supported dimensions and feature parameters.
- Identify the feature that caused a regeneration failure.
- Return to the last valid state or amend the failing parameters.

Arbitrary feature reordering is excluded.

### F1-04 — Datum geometry — Must

Every document contains origin axes and three principal planes. Users can sketch on a principal plane or a planar solid face. Offset, angled, or user-defined datum planes are excluded from the first public release.

### F1-05 — Sketch creation — Must

On a supported plane, users can create and edit:

- Line and connected polyline.
- Axis-aligned or freely oriented rectangle.
- Circle.
- Center-radius arc and three-point arc.
- Construction lines.
- Points used for constraint references.

Users can move unconstrained entities, delete entities, select multiple entities, and exit or re-enter sketch editing.

Trim, offset, spline, text, projected external geometry, and automatic profile repair are excluded.

### F1-06 — Sketch constraints — Must

Supported geometric constraints:

- Coincident.
- Horizontal.
- Vertical.
- Parallel.
- Perpendicular.
- Tangent for supported line/circle/arc combinations.
- Equal length or radius.
- Concentric.
- Fixed point/entity.

Supported driving dimensions:

- Horizontal distance.
- Vertical distance.
- Point-to-point distance.
- Line length.
- Circle/arc radius or diameter.
- Line angle.

The application must show under-constrained, fully constrained, and conflicting states. It must report remaining degrees of freedom and identify at least one conflicting constraint when a solve fails.

Expression-driven parameters, equations, configuration tables, and global variables are excluded.

### F1-07 — Primitive solids — Must

Users can create parametrically defined boxes and cylinders as new bodies. A sphere may be included only if it passes the same validity and editing criteria; it is not release-blocking.

### F1-08 — Extrusion — Must

A closed planar sketch profile can be extruded:

- As a new body.
- Additively into one selected target body.
- Subtractively from one selected target body.
- To a specified positive or negative distance.
- Symmetrically about the sketch plane.
- Through all in the selected direction for subtractive use.

Multiple nested loops may represent holes only when the profile is unambiguous under the documented containment rules. Drafted extrusion, thin-wall extrusion, up-to-face, and two-direction unequal extrusion are excluded.

### F1-09 — Boolean operations — Must

Users can union, subtract, or intersect two selected bodies where the input lies within the tested Phase 1 geometry subset.

The operation must produce a valid closed solid or return an explicit error. It must not commit an open, non-manifold, self-intersecting, or otherwise invalid result.

### F1-10 — Parametric regeneration — Must

Changing a sketch dimension, primitive parameter, or extrusion distance must regenerate dependent features in dependency order.

Requirements:

- The previous valid result remains visible if regeneration fails.
- Failed and downstream-suppressed features are clearly differentiated.
- Regeneration is atomic from the user's perspective.
- A repeated regeneration without input changes produces equivalent topology and measurements for the supported reference corpus.
- Semantic references must remain stable for the documented supported edits. Arbitrary reference recovery after major topology changes is excluded and must be disclosed.

### F1-11 — Undo and redo — Must

All committed modeling, naming, visibility, and parameter-edit commands are undoable and redoable within the current session. Preview changes do not enter history until committed. Failed operations do not enter history.

Undo/redo must preserve document validity and selection must degrade safely if the referenced object no longer exists.

### F1-12 — Inspection — Must

Users can inspect:

- Point coordinates.
- Edge length for supported analytic edges.
- Circle/arc radius.
- Distance between supported selections.
- Body axis-aligned bounding dimensions.
- Surface area and volume for valid solids.
- Document units and regeneration warnings.

Measurement results must indicate units and an appropriate number of significant digits without implying greater accuracy than the geometry policy supports.

### F1-13 — Native persistence — Must

The native format must:

- Be original, versioned, and documented.
- Store canonical semantic data and parameters rather than relying solely on tessellated output.
- Use stable object identifiers.
- Record the producing application version and units.
- Validate types, ranges, graph structure, and resource limits before evaluation.
- Reject unsupported major versions without modifying local data.
- Preserve unknown optional fields where practical.
- Migrate documents from every earlier Phase 1 minor format once a migration is released.

Pre-1.0 format evolution must be labeled experimental.

### F1-14 — Mesh export — Must

Export binary or ASCII STL with:

- Explicit unit selection or a clear unit declaration in the export flow.
- User-selectable coarse, normal, and fine tessellation presets.
- Validation that exported bodies are closed and manifold.
- A warning if no valid body is selected.
- Chord-error information for each preset.

Native project import is required. General mesh import and professional CAD exchange formats are excluded.

### F1-15 — Errors and recovery — Must

Errors must be typed and actionable. At minimum, distinguish:

- Invalid numeric input.
- Under-defined selection.
- Open or self-intersecting sketch profile.
- Constraint conflict.
- Degenerate geometry.
- Unsupported geometric case.
- Invalid solid result.
- Resource limit exceeded.
- Unsupported or corrupt file.
- Worker or persistence failure.

An error must never replace a valid saved document with invalid state.

### F1-16 — Learning support — Should

Include independently authored:

- First-run guided part tutorial.
- Command descriptions and shortcuts.
- Short explanations of sketch constraint states.
- Known-limitations page.
- Sample projects created specifically for this product.
- “Report an issue” flow that does not upload project data without explicit consent.

### F1-17 — Public availability — Must

The Phase 1 public release must provide:

- A hosted HTTPS application with no mandatory account, subscription, or payment.
- A public MIT-licensed source repository.
- Reproducible local build instructions.
- Public issue reporting and release notes.
- Download/export that works without a backend account.
- A clear statement that locally stored browser data may be lost if site storage is cleared.

## 10. Nonfunctional requirements

### Accuracy and validity

- Parameters must round-trip through the native format without unintended value changes.
- Analytic primitives must retain analytic definitions; rendering meshes must not become the modeling source.
- Every committed body must pass closed-shell, manifoldness, orientation, and finite-coordinate checks.
- The Phase 0 numerical contract must define the supported dimensional envelope before public release.
- The independently authored conformance suite must pass 100% of supported reference cases.
- Known unsupported cases must produce deterministic typed errors.
- Comparative accuracy claims require published methodology, models, settings, and results.

### Performance

Measured on a published baseline desktop with at least four modern CPU cores, 8 GB RAM, an integrated GPU, and a current supported browser:

- Visual input acknowledgement: within 100 ms for 95% of ordinary UI commands.
- Orbit/pan/zoom: at least 30 FPS at the 95th percentile and a 50 FPS median on a reference scene of 100,000 visible triangles.
- Simple sketch solve of up to 100 entities and 150 supported constraints: under 250 ms at the 95th percentile.
- Full regeneration of the release reference model with up to 30 features: under 2 seconds at the 95th percentile.
- Autosave must not cause a visible interaction pause over 100 ms.
- Resource limits must stop excessively large or malicious documents before browser instability.

Measured results, not aspirational figures, determine the published supported envelope.

### Reliability and data integrity

- Autosave is triggered after committed changes and completes within five seconds when storage is available.
- Crash recovery loses no more than the most recent five seconds of committed edits under test conditions.
- Save uses atomic replacement or equivalent staging so an interrupted write does not destroy the prior valid copy.
- A failed feature operation, import, migration, or regeneration cannot corrupt the last saved document.
- Public beta target: at least 99.5% crash-free measured sessions among users who explicitly opt into diagnostics.
- Native round-trip and migration tests must pass before release.

### Security

- Enforce a restrictive Content Security Policy.
- Do not evaluate code contained in project files.
- Parse untrusted files with size, nesting-depth, entity-count, and execution-time limits.
- Isolate geometry/file processing from the UI thread and recover from worker termination.
- Make no network upload of project contents without an explicit user action and confirmation.
- Run dependency, secret, and known-vulnerability checks in release automation.
- No unresolved critical-severity vulnerability may ship without a documented, time-bounded exception.

### Privacy

- No account is required.
- Project geometry and native files remain local by default.
- Analytics and crash reports are opt-in and must disclose their exact contents.
- Diagnostic submissions must exclude project geometry unless the user separately attaches it.
- Phase 1 has no advertising, behavioral profiling, or sale of user data.

### Browser compatibility

Support the current and immediately previous stable desktop versions at release time of:

- Chromium-based Chrome.
- Chromium-based Edge.
- Firefox.
- Safari.

Where direct filesystem APIs are unavailable, upload/download must provide an equivalent document workflow. Mobile and tablet browsers may display an unsupported-device notice.

### Accessibility

- Application chrome and non-canvas controls target WCAG 2.2 AA.
- All commands available in menus or toolbars must also be reachable through keyboard navigation or a searchable command interface.
- Focus, error, selection, and disabled states must not depend only on color.
- Viewport-only spatial manipulation may require a pointing device in Phase 1, but equivalent numeric parameter editing must be available.
- Screen-reader limitations of the 3D viewport must be disclosed.

### Maintainability and quality

- Strictly typed public interfaces between application, solver, geometry worker, renderer, persistence, and adapters.
- Automated unit, property, invariant, migration, end-to-end, and cross-browser tests.
- Geometry fixtures and expected results must be authored independently from analytic definitions and public standards; outputs from another CAD application are not accepted as golden truth.
- Reproducible release builds and versioned database/file migrations.
- Architecture changes require an entry in the decision log.
- No renderer-specific identifiers may become persistent document identifiers.

## 11. Phase 1 release acceptance scenarios

The release is accepted only when all scenarios pass on every supported browser.

### A. Parametric bracket workflow

1. Create a millimeter document.
2. Sketch a constrained 60 × 40 mm rectangle.
3. Extrude it 10 mm as a new body.
4. Sketch a centered 10 mm diameter circle on its top planar face.
5. Cut through all.
6. Change the rectangle width to 70 mm.
7. Regenerate successfully.
8. Confirm dimensions, valid closed solid, volume, and hole placement.

### B. Constraint diagnostics

1. Create a partially constrained sketch and observe nonzero degrees of freedom.
2. Fully constrain it and observe the fully constrained state.
3. Add a contradictory dimension.
4. Confirm that the conflicting constraint is identified and the last valid geometry is preserved.

### C. Failure containment

1. Enter a degenerate or unsupported feature value.
2. Confirm the operation does not commit.
3. Confirm the prior valid body and editable parameters remain available.
4. Correct the input and regenerate successfully.

### D. Persistence and recovery

1. Create the bracket, rename its features, and alter visibility.
2. Save, close, and reopen it.
3. Confirm equivalent parameters, dependency order, names, visibility, measurements, and valid geometry.
4. Simulate interruption during autosave and confirm recovery from the last complete state.

### E. Undo/redo

Undo and redo every committed step in the bracket workflow. At each step, the document must remain valid and structure, parameters, viewport, and selection state must remain coherent.

### F. STL export

Export the valid bracket at each tessellation preset. Confirm the mesh is closed and manifold, the bounding dimensions fall within the published chord tolerance, and the selected unit behavior is clearly communicated.

### G. Public and licensing requirements

From a clean environment, a reviewer can:

- Open the hosted application without signing in or paying.
- Build the public source using documented commands.
- Locate the MIT license, dependency notices, SBOM, privacy statement, limitations, and release notes.
- Verify that project contents are not transmitted during ordinary modeling and local save.

### H. Usability

In moderated testing, at least 8 of 10 target users who know basic dimensional drawing concepts but have not used the product can complete the bracket workflow within 15 minutes using the tutorial or in-product help, without facilitator intervention.

## 12. Success measures

Phase 1 success is based on capability and reliability rather than raw sign-up volume:

- 100% pass rate for the supported geometry conformance corpus.
- 100% pass rate for native round-trip and migration tests.
- At least 80% unaided reference-task completion in usability testing.
- At least 99.5% crash-free opted-in public beta sessions.
- At least 90% successful project reopen rate among opted-in diagnostics, excluding deliberate deletion of browser storage.
- Median regeneration and viewport performance within published targets.
- All confirmed data-loss defects treated as release blockers until resolved or explicitly isolated from the supported workflow.

## 13. Explicit Phase 1 exclusions

Phase 1 does not include:

- Assemblies, instances, mates, kinematics, interference checking, or bills of materials.
- Multi-user editing, comments, cloud documents, synchronization, accounts, teams, or permissions.
- Paid plans or gated modeling features.
- NURBS or subdivision surfacing, loft, sweep, boundary surface, surface trim, or sewing.
- Fillet, chamfer, shell, draft, ribs, patterns, or advanced datum geometry unless separately approved after the core release.
- Revolve unless promoted through a formal scope change and full conformance coverage.
- Technical drawing sheets, projected drawing views, tolerancing, annotations, or title blocks.
- STEP, IGES, DXF, DWG, or other professional CAD import/export.
- General mesh import, mesh repair, reverse engineering, or scan processing.
- Feature scripting, macros, plugins, an extension marketplace, or arbitrary code execution.
- Simulation, CAM, toolpaths, rendering, materials, or manufacturing costing.
- External AI integrations or MCP endpoints.
- Full mobile/touch authoring.
- Offline-installable PWA support as a release requirement.
- Guaranteed recovery of downstream references after arbitrary topology-changing edits.
- Arbitrary feature-tree reordering, branching configurations, equations, or design tables.
- Enterprise support, availability SLAs, certification, or regulated-industry claims.
- A guarantee of backward compatibility before the native format reaches 1.0.
- Any claim that Phase 1 has already achieved the long-term capability or accuracy north star.

## 14. Risks and mitigations

| Risk | Probability / impact | Mitigation |
| --- | --- | --- |
| Robust Boolean and topology work exceeds estimates | High / High | Make geometry feasibility a hard Phase 0 gate; limit supported intersections; publish unsupported cases; extend schedule instead of weakening validity rules. |
| Sketch solver becomes unstable near redundant constraints | Medium / High | Limit the constraint subset; track degrees of freedom; use scale normalization; preserve the last valid solve; build property and perturbation tests. |
| Downstream references break after edits | High / High | Use semantic identifiers and provenance-based references; constrain supported topology changes; expose broken references; do not promise general persistent naming in Phase 1. |
| Browser memory or UI stalls | Medium / High | Worker isolation, incremental tessellation, cancellation, model/entity limits, disposable caches, and published reference-scene benchmarks. |
| Users mistake display facets for modeling inaccuracy | Medium / Medium | Separate analytic model from tessellation, expose export/view quality settings, and document chord error. |
| Local-only storage causes user data loss | Medium / High | Autosave, recovery snapshots, prominent download reminders, atomic writes, and clear browser-storage warnings. |
| Users expect broad exchange compatibility | High / Medium | Publish an explicit format support table; use “native project” and “STL mesh export” language; avoid unsupported file-picker extensions. |
| Public files are used to exhaust resources | Medium / High | Strict parser limits, validation before evaluation, worker timeouts, and safe cancellation. |
| Dependency or asset provenance is unclear | Low / High | Mandatory provenance records, SBOM, automated license checks, and release audit. |
| Scope expands before the foundation is stable | High / High | Enforce milestone gates and explicit exclusions; require product and engineering approval for scope changes. |
| Accessibility is limited by a 3D canvas | Medium / Medium | Make parameters and structure keyboard accessible, provide semantic announcements, test non-canvas paths, and disclose remaining limitations. |
| Long-term ambition leads to premature claims | Medium / High | Publish reproducible benchmarks only after independent validation; treat leadership in capability and accuracy as a roadmap objective. |

## 15. Indicative milestones

Dates are capacity estimates, not commitments. The following assumes approximately six to eight experienced engineering contributors plus product design and QA. A smaller team should expect a materially longer schedule.

### Phase 0 — approximately 8–12 weeks

- **M0.1, weeks 1–2:** Product boundary, provenance controls, design research plan, numerical requirements.
- **M0.2, weeks 3–6:** Sketch solver and analytic geometry prototypes; independently authored conformance corpus.
- **M0.3, weeks 5–9:** Solid-feature, worker, rendering, transaction, and persistence prototype.
- **M0.4, weeks 9–12:** UX validation, cross-browser measurements, risk review, and Phase 1 go/no-go gate.

### Phase 1 — approximately 9–12 months after the Phase 0 gate

- **M1, foundation:** Public project setup, document model, command transactions, worker boundary, renderer, datum geometry, and local persistence.
- **M2, sketching:** Entity tools, supported constraints and dimensions, degrees-of-freedom reporting, and diagnostics.
- **M3, solid subset:** Primitives, extrusion modes, limited Booleans, validity checking, and parametric regeneration.
- **M4, usability and recovery:** Structure/parameter interface, undo/redo, autosave, native file workflow, inspection, tutorial, and errors.
- **M5, export and hardening:** STL export, security limits, accessibility work, browser matrix, performance tuning, licensing audit, and public alpha.
- **M6, beta gate:** Resolve release-blocking defects, pass all acceptance scenarios, publish measured limitations, and label the release beta.

No calendar date should be announced until Phase 0 establishes the practical geometry envelope and team throughput.

## 16. Post-Phase 1 direction

Future phases are conditional on Phase 1 correctness and adoption:

1. **Parametric depth:** More constraints, named parameters, expressions, revolve, patterns, fillet/chamfer, shell, draft, robust reference repair, and larger feature graphs.
2. **Assemblies:** Reusable part instances, assembly structure, mating constraints, interference analysis, and bills of materials.
3. **Surfacing:** Independently implemented curve and surface foundations, sweep, loft, boundary surfaces, trimming, sewing, continuity diagnostics, and solid/surface interoperability.
4. **Drawings and exchange:** Standards-driven drawing views, dimensions, annotations, and carefully staged import/export. Each format requires a published conformance strategy before release.
5. **Model-neutral MCP connectivity:** A versioned, capability-scoped adapter over the canonical command and query layer. It must be independent of any one AI model or provider, use stable CAD object identifiers, default to read-only discovery, require explicit authorization for mutations, support preview/diff/commit/undo transactions, validate all inputs, and retain an auditable local action record.

Each future capability requires its own PRD, threat model, conformance plan, performance envelope, and release gate.
