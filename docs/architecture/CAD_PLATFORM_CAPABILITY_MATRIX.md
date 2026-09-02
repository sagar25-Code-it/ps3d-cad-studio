# CAD platform capability matrix

**Evidence date:** 2026-09-02

**Claim rule:** a contract is not a production capability

| Area | Foundation implemented locally | Still required for production promotion |
| --- | --- | --- |
| Canonical document | Immutable component-owned document, definitions vs occurrences, stable IDs, feature graph, suppression, rollback, rebuild planning, validation | UI tree/edit workflows, long-document performance and compatibility tests |
| Revision storage | Immutable snapshot/event chains, optimistic CAS, idempotent replay, schema-bound migration registry, tenant/project keys, required external authority checks, non-mutating preview, signed preview-bound apply, SHA receipts and hash-chain verification | Durable IndexedDB/server adapters, production authority policy, independent authorized-head anchoring for rollback protection, backup/restore, retention, multi-region conflict and load qualification |
| Exact geometry | Exact B-rep operation/provenance protocol, deterministic persistent-topology resolver without generic nearest-role fallback, recorded-evidence adapter, browser worker transport, and an OCCT adapter factory that requires trusted-loader source/artifact/build/license/capability/qualification attestation and quarantines bad runtime generations | Reproducibly build and ship a licensed OCCT WASM/native runtime, implement real operation mappings, and pass geometry, memory, cancellation, exchange and topology corpora |
| Sketching | Persistent points/lines/circles/arcs/ellipses/polygons/slots/splines/projected geometry, construction state, expression parser with unary precedence, driving/driven dimensions, qualified analytic constraints, residual and plane-frame validation, DOF/conflict classification, shape-preserving midpoint edits and commit-once constrained drag | General nonlinear solver; tangent/symmetric/point-on-curve solving; associative offset; topology trim/extend/project and robust profile extraction; canvas integration |
| Parametric rebuild | Deterministic feature-DAG plan, rollback/suppression diagnostics, exact-kernel orchestration, and order-independent topology resolution with explicit exact/recovered/ambiguous/missing outcomes | Wire the engine and storage transaction into every editing command; qualify reference recovery against a real OCCT topology corpus |
| Solid commands | Typed exact operation contracts for primitives, extrude/revolve/sweep/loft, hole/thread, fillet/chamfer/draft/shell, rib/thin, Boolean, pattern/mirror and direct face edits | Real OCCT evaluators and command dialogs; each command remains unavailable outside its existing bounded preview until its corpus passes |
| Assemblies | Definitions/occurrences, grounding, rigid groups, seven joint schemas, limits, motion links, DOF, safe analytic joint subset, explode and collision-service contracts | Nonlinear solver for pin-slot/planar/ball, exact interference backend, edit-in-context UI, referenced-component persistence and motion studies |
| Drawings | Associative base/projected/section/detail/auxiliary schemas, topology-linked dimensions/notes/GD&T/BOM, selective invalidation and receipts | Exact HLR/projection backend, standards-complete layout, annotation placement UI, PDF/DXF/SVG release qualification |
| Surfacing | Exact-topology operation contracts for extrude/revolve/sweep/loft/patch/offset/trim/extend/stitch/thicken, G0/G1/G2 boundary validation, rails, gap reports and analysis-result contracts | Qualified exact evaluator, interactive edge matching and real zebra/reflection/curvature/draft/comb visualization |
| Rendering | Engineering-material/PBR separation, digest-bound texture/decal/HDR references, derived-tessellation scene validation, raster/path-trace request contracts and receipts | Qualified asset library and render backends, interactive appearance UI, offline path tracing and color-management tests |
| Exchange | STEP/IGES/BREP/STL/OBJ/3MF/DXF/SVG job contracts, healing/units/preservation reports and licensed-native-translator gates | Real neutral-format round trips and conformance corpus; licensed proprietary translators only where selected and entitled |
| MCP/AI | Manifest-first handshake, stable-ID feature plans, ambiguity/evidence gates, preview/approval/apply binding, audit receipts and provider-neutral envelopes | Connect the gateway transactionally to authenticated cloud storage and the rebuild engine; target-host validate generated CAD automation adapters |

## Current release boundary

The existing PS3D browser workbench remains a bounded preview. The packages in
this matrix are an additive next-generation platform foundation. The current
acceptance harness proves orchestration and fail-closed behavior with a
recorded exact-kernel fixture; it does not evaluate geometry. A real attested
OCCT runtime, durable storage integration, exact command evaluators and the
acceptance slice in `EXACT_PARAMETRIC_CAD_PLATFORM.md` must pass before the
public capability registry changes from `preview`/`unavailable` to
`qualified`.
