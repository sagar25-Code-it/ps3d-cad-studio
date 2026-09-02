# Exact Parametric CAD Platform

**Status:** Foundation implementation in progress

**Date:** 2026-09-02

**Scope:** General mechanical CAD document, exact-kernel boundary, associative
rebuild, sketch solving, assemblies, drawings, surfacing, exchange, and MCP

## 1. Product boundary

PS3D is moving from a bounded tessellated workbench preview toward a general,
associative mechanical CAD platform. This is a kernel and document-model
programme, not a command-presentation programme. A command is promoted from
`unavailable` only after its semantic definition, evaluator, reference
stability, validation, persistence, replay, and user workflow all pass.

The current Manifold/bracket evaluator remains supported for its published
bounded envelope. It must not be relabeled as exact B-rep geometry. The new
platform is additive until the exact evaluator passes its qualification gate.

## 2. Canonical ownership model

The persistent hierarchy is:

```text
CAD document
  component definitions
    origin and construction geometry
    sketches
    bodies
    ordered feature graph
    child component occurrences
    joints and motion relationships
  root occurrences
  drawing sheets and associative views
  materials, appearances, configurations, and parameters
  revision journal and evidence
```

Definitions own design intent. Occurrences own assembly placement and
instance-specific state. Kernel handles, tessellations, solver caches, render
objects, and generated drawing paths are derived and never persisted as the
source of truth.

All references use stable semantic IDs plus typed roles. An exact-kernel
adapter returns topology provenance for every result. A reference that cannot
be resolved uniquely becomes `broken` or `ambiguous`; it is never silently
retargeted to a nearest face or edge.

Canonical revisions cross a separate persistence boundary. The implemented
store contract uses immutable snapshots, append-only events, optimistic CAS,
idempotency records, schema-bound migration traces, hash-bound preview/apply
receipts, and a required external authorization interface. It verifies its
history but does not claim rollback protection without an independently
anchored authorized head. The in-memory port is a test/reference adapter.
IndexedDB and authenticated server ports, authority policy, and head anchoring
remain host integrations and are not yet production storage.

## 3. Rebuild transaction

Every mutation uses the same deterministic transaction:

1. Validate command envelope, base revision, identity, units, and limits.
2. Apply the semantic change to an isolated candidate document.
3. Validate the feature graph and compute the dirty downstream subgraph.
4. Solve affected sketches and reject conflicts or unsupported operations.
5. Evaluate features in stable dependency order through a capability-negotiated
   kernel port.
6. Heal and independently validate every changed body.
7. Resolve topology references and classify unresolved references.
8. Regenerate dependent occurrences, joints, drawings, measurements, and
   render artifacts.
9. Produce diagnostics, semantic diff, evidence, and an immutable preview
   receipt.
10. Commit only after explicit confirmation; otherwise retain the prior valid
    revision unchanged.

Suppression, rollback, undo, redo, replay, MCP, imports, and UI editing use this
same transaction boundary.

## 4. Exact-kernel boundary

The application owns the kernel contract. Open CASCADE Technology is the
candidate exact evaluator for browser WebAssembly and native worker profiles.
No OCCT pointer or dependency-specific object may cross the adapter boundary.

The exact adapter must expose:

- analytic and NURBS curve/surface construction;
- B-rep vertices, edges, wires, faces, shells, solids, and compounds;
- primitives, profile features, Booleans, sweeps, lofts, blends, chamfers,
  drafts, shells, offsets, trimming, sewing, and thickening;
- topology provenance and persistent-reference recovery candidates;
- shape checks, healing, measurements, mass properties, and tessellation;
- STEP, IGES, and BREP exchange with typed transfer reports; and
- cancellation, memory disposal, capability negotiation, and build identity.

The implemented `occt-kernel-adapter` is the activation gate for such a
runtime. Its factory returns no adapter unless trusted-loader-observed source,
binary, build configuration, license/exception evidence, capability manifest
and qualification result exactly match the selected deployment manifest. It
then binds sessions to document revisions, validates result envelopes, rejects
duplicate requests, and quarantines a runtime generation after timeout,
cancellation, or invalid output. It contains no OCCT binary and performs no
geometry by itself.

OCCT is LGPL-2.1 with an additional exception. An implementation may keep
project-owned source under MIT, but distribution must satisfy the OCCT notice,
source-availability, replacement, and license-text obligations. The dependency
cannot enter the public build until those obligations and artifact provenance
are verified.

## 5. Sketch solver boundary

The sketch source of truth stores geometry, construction state, external
references, constraints, dimensions, expressions, and solve state. Supported
operations must return solved coordinates, remaining degrees of freedom,
redundancy/conflict diagnostics, and a stable profile/wire projection.

The current analytic implementation qualifies a bounded subset. It validates
right-handed sketch-plane frames and stored constraint residuals, preserves
entity shape when moving midpoint references, treats drag frames as temporary,
and advances a revision only at a successful commit. Associative offset,
general nonlinear relations, topology-backed trim/extend/project, and robust
profile extraction remain explicitly unsupported.

Interactive dragging is a solver transaction with temporary cursor constraints
and continuation state. It must not directly mutate point coordinates in a way
that bypasses driving dimensions or constraints.

## 6. Associative consumers

- **Solids and surfaces** consume solved profiles and exact topology references.
- **Assemblies** consume component definitions and occurrences, then solve
  joints, limits, rigid groups, motion links, and contact/interference requests.
- **Drawings** consume exact model revisions and stable view projections. A
  model change invalidates only affected views and annotations.
- **Rendering** consumes tessellated artifacts and material/appearance state;
  it never changes model precision.
- **Exchange** distinguishes semantic PS3D documents, exact neutral geometry,
  and non-associative mesh formats.
- **MCP** reads the schema and capability manifest, plans semantic commands,
  previews them, and applies only an approved receipt. AI never calls the
  geometry dependency directly.

## 7. Delivery increments

| Increment | Promotion gate |
| --- | --- |
| Canonical document and feature graph | Schema, graph, rollback, replay, migration, and cycle tests |
| Exact-kernel adapter | Provenance, license, deterministic corpus, healing, cancellation, and memory tests |
| Production sketching | Constraint matrix, DOF, drag, conflict, profile, and edit/rebuild tests |
| Core solids | New body/component, join/cut/intersect, failure recovery, and stable-reference tests |
| Assemblies | Occurrence ownership, joint DOF/limits, edit-in-context, interference, and explode tests |
| Drawings | HLR, projected/section/detail views, associative annotations, BOM, and update tests |
| Surfacing | G0/G1/G2, trim/sew/thicken, diagnostics, zebra, and curvature tests |
| Rendering/exchange | PBR fidelity, deterministic export, format conformance, and round-trip tests |
| MCP/AI | Manifest-first handshake, bounded planning, preview receipt, approval, and audit tests |

No increment is complete because its toolbar entry exists. The capability
registry is the public claim boundary and must reflect measured behavior.

## 8. Current foundation evidence

The local foundation now includes isolated tests for canonical ownership,
analytic sketch behavior, deterministic rebuilds, exact-kernel contracts,
worker transport, topology recovery, revision storage, assembly kinematics,
associative drawing state, surfacing analysis contracts, render/exchange jobs,
MCP approval gates and the cross-package recorded-fixture acceptance path.
These are contract and orchestration tests. They do not promote a command whose
live geometry, UI, persistence adapter or format corpus is still absent.

## 9. Initial end-to-end acceptance slice

The first general exact workflow is complete only when a user or MCP client can:

1. create a component and choose an origin plane or planar face;
2. author and fully constrain a sketch with lines, rectangles, circles, arcs,
   driving dimensions, and common geometric constraints;
3. select a closed profile and extrude it as new body, new component, join,
   cut, or intersect;
4. add a hole, fillet, chamfer, and shell;
5. edit a driving parameter and rebuild all dependent features without losing
   unambiguous references;
6. place two occurrences and apply a rigid or revolute joint;
7. generate an associative base/projected drawing with dimensions;
8. export STEP and reopen it as exact non-parametric geometry; and
9. repeat the semantic workflow through MCP preview and explicit approval.

Until this slice passes, advanced commands remain architecture contracts or
explicitly unavailable capabilities.

## 10. Primary technical references

- Open CASCADE Technology overview, modules, platform requirements, and
  license: <https://dev.opencascade.org/doc/overview/html/index.html>
- Autodesk Fusion component ownership:
  <https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-COMPONENTS.htm>
- Autodesk Fusion parametric modeling modes:
  <https://help.autodesk.com/view/fusion360/ENU/?contextId=DESIGN_HISTORY>
- Autodesk Fusion sketch dimensions:
  <https://help.autodesk.com/view/fusion360/ENU/?guid=SKT-CREATE-DIMENSIONS>
- Autodesk Fusion assembly relationships:
  <https://help.autodesk.com/view/fusion360/ENU/?contextId=ASM-JOINTS>
