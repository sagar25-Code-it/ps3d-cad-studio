# Architecture Research Sources

**Recorded:** 2026-08-19  
**Scope:** Factual research used by the initial system architecture, numerical
contract, and ADRs

## Use and approval boundary

Only official project, standards-body, and platform-owner sources are recorded
below. They were used for factual understanding of public APIs, platform
behavior, project scope, and declared licenses. No external source code,
sample, test fixture, diagram, wording, or asset was copied into an
implementation. The original Phase 0 implementation and bounded Phase 1
workbench preview used the factual API and platform concepts recorded here;
their exact installed artifacts are
separately reviewed in [`dependencies.json`](./dependencies.json) and
[`DEPENDENCY_AUDIT.md`](./DEPENDENCY_AUDIT.md).

A citation is not dependency approval. The exact selected version and artifact
must receive the review, integrity hash, transitive inventory, approval, and
notice record required by [`SOURCE_POLICY.md`](./SOURCE_POLICY.md) before use.
That gate is recorded separately for the current Phase 1 graph. License
findings below remain a research snapshot and must be reverified for any future
artifact change.

## Geometry and numerical research

### RS-001 - Manifold official repository

- **Owner/publisher:** Manifold project
- **URL:** <https://github.com/elalish/manifold>
- **Accessed:** 2026-08-19
- **Facts used:** The project describes a geometry library for manifold
  triangle-mesh solids, Boolean operations, cross sections, WASM/TypeScript
  bindings, validation status, and its build/test facilities.
- **Declared license:** Apache-2.0.
- **Informed:** System architecture section 8; ADR 0001; Phase 1 solid and
  adapter boundaries in the numerical contract.
- **Use limit:** Candidate dependency facts only. No source code or project
  fixtures were used.

### RS-002 - Manifold official releases

- **Owner/publisher:** Manifold project
- **URL:** <https://github.com/elalish/manifold/releases>
- **Accessed:** 2026-08-19
- **Facts used:** The current release line and upstream report of
  cross-platform double-precision determinism and deterministic batch work.
- **Declared license:** Repository license is Apache-2.0.
- **Informed:** Deterministic-profile qualification language in ADR 0001 and
  the numerical contract.
- **Use limit:** An upstream release statement is not PS3D conformance
  evidence. The selected artifact must pass the project's own matrix.

### RS-003 - Manifold official JavaScript APIs

- **Owner/publisher:** Manifold project
- **URLs:**
  - <https://manifoldcad.org/docs/jsuser/classes/Manifold.html>
  - <https://manifoldcad.org/docs/jsuser/classes/CrossSection.html>
- **Accessed:** 2026-08-19
- **Facts used:** Public availability of cross-section construction,
  extrusion, revolution, mesh-solid Boolean operations, and robust-predicate
  claims for cross-section operations.
- **Declared license:** Documentation accompanies the Apache-2.0 project;
  exact documentation terms must be rechecked before reproducing content.
- **Informed:** Feasibility and capability-boundary analysis only.
- **Use limit:** No API example or documentation prose was copied.

### RS-004 - Truck official repository

- **Owner/publisher:** Truck project
- **URL:** <https://github.com/ricosjp/truck>
- **Accessed:** 2026-08-19
- **Facts used:** The project publicly lists Rust crates for parametric
  geometry, NURBS, topology, modeling, shape operations, tessellation,
  JavaScript, and STEP-related work.
- **Declared license:** Apache-2.0.
- **Informed:** Future exact-kernel adapter seam and the deferred alternative
  in ADR 0001.
- **Use limit:** Research candidate only. API breadth and repository activity
  are not treated as production qualification.

### RS-005 - nalgebra official documentation and repository

- **Owner/publisher:** Dimforge
- **URLs:**
  - <https://www.nalgebra.rs/docs/>
  - <https://github.com/dimforge/nalgebra>
- **Accessed:** 2026-08-19
- **Facts used:** Availability of Rust linear-algebra facilities suitable for
  a project-owned numerical solver.
- **Declared license:** Apache-2.0.
- **Informed:** Sketch-solver feasibility and candidate license review.
- **Use limit:** Selection of an exact version, features, and transitive graph
  is deferred.

## Browser, worker, rendering, and build research

### RS-006 - WebAssembly Core Specification

- **Owner/publisher:** W3C WebAssembly Working Group
- **URL:** <https://www.w3.org/TR/wasm-core/>
- **Accessed:** 2026-08-19
- **Facts used:** WebAssembly is a portable low-level execution format with a
  defined core numerical and validation model; web integration is provided by
  separate platform interfaces.
- **Informed:** WASM boundary, deterministic-profile caution, and worker-hosted
  solver/kernel architecture.
- **Use limit:** Specification facts were paraphrased; no specification text
  was reproduced.

### RS-007 - WHATWG Web Workers specification

- **Owner/publisher:** WHATWG
- **URL:** <https://html.spec.whatwg.org/multipage/workers.html>
- **Accessed:** 2026-08-19
- **Facts used:** Dedicated workers have a message-based execution context
  separate from the document's main event loop.
- **Informed:** ADR 0002 and the worker protocol boundary.
- **Use limit:** Platform behavior only.

### RS-008 - wasm-bindgen official repository

- **Owner/publisher:** Rust and WebAssembly project contributors
- **URL:** <https://github.com/wasm-bindgen/wasm-bindgen>
- **Accessed:** 2026-08-19
- **Facts used:** Candidate generation of narrow Rust/WebAssembly and
  JavaScript bindings.
- **Declared license:** Dual MIT or Apache-2.0, at the user's option.
- **Informed:** Proposed Rust sketch-solver WASM bridge.
- **Use limit:** Candidate only; generated outputs and exact version require
  inventory and reproducibility review.

### RS-009 - Comlink official repository

- **Owner/publisher:** GoogleChromeLabs contributors
- **URL:** <https://github.com/GoogleChromeLabs/comlink>
- **Accessed:** 2026-08-19
- **Facts used:** A small RPC abstraction is available over `postMessage`-like
  endpoints and supports Web Workers.
- **Declared license:** Apache-2.0.
- **Informed:** Considered as an optional worker-protocol helper.
- **Use limit:** The architecture requires an explicit versioned project
  protocol whether or not this helper is selected.

### RS-010 - three.js official license and manual

- **Owner/publisher:** three.js authors
- **URLs:**
  - <https://threejs.org/license/>
  - <https://threejs.org/manual/en/installation.html>
- **Accessed:** 2026-08-19
- **Facts used:** Candidate browser three-dimensional rendering and official
  npm/build-tool installation guidance.
- **Declared license:** MIT.
- **Informed:** Viewport adapter boundary and candidate license posture.
- **Use limit:** Renderer only; it cannot define modeling geometry or
  persistent document IDs.

### RS-011 - React official repository

- **Owner/publisher:** React contributors
- **URL:** <https://github.com/facebook/react>
- **Accessed:** 2026-08-19
- **Facts used:** Candidate browser UI library and declared license.
- **Declared license:** MIT.
- **Informed:** Presentation-stack feasibility only.
- **Use limit:** The architecture is not coupled to React semantics.

### RS-012 - Vite official documentation and repository

- **Owner/publisher:** VoidZero Inc. and Vite contributors
- **URLs:**
  - <https://vite.dev/>
  - <https://vite.dev/guide/features>
  - <https://github.com/vitejs/vite>
- **Accessed:** 2026-08-19
- **Facts used:** Static production asset generation, worker/WASM build
  feasibility, and the `build.license` facility for a bundled-license report.
- **Declared license:** MIT.
- **Informed:** Static deployment and release-notice design.
- **Use limit:** Exact build version and plugins remain unselected.

### RS-013 - Zod official package metadata and repository

- **Owner/publisher:** Zod contributors
- **URLs:**
  - <https://github.com/colinhacks/zod>
  - <https://github.com/colinhacks/zod/blob/main/packages/zod/package.json>
- **Accessed:** 2026-08-19
- **Facts used:** Runtime schema validation for the local MCP transport.
- **Declared license:** MIT for the exact selected Zod 4.4.3 artifact.
- **Informed:** Local MCP tool input schemas.
- **Use limit:** Zod is Node-transport-only; domain validation and browser
  tool semantics remain project-owned.

## Canonicalization, deployment, and protocol research

### RS-014 - RFC 8785, JSON Canonicalization Scheme

- **Owner/publisher:** IETF
- **URL:** <https://datatracker.ietf.org/doc/html/rfc8785>
- **Accessed:** 2026-08-19
- **Facts used:** A standards-defined canonical JSON representation can be used
  as the input to cryptographic hashing.
- **Informed:** ADR 0003 and semantic evidence hashing.
- **Use limit:** The implementation must validate its own RFC conformance and
  version its evidence format.

### RS-015 - Vercel official Vite and project-configuration documentation

- **Owner/publisher:** Vercel
- **URLs:**
  - <https://vercel.com/docs/frameworks/frontend/vite>
  - <https://vercel.com/docs/project-configuration/vercel-json>
- **Accessed:** 2026-08-19
- **Facts used:** Vite static sites are deployable on Vercel and project
  configuration can define rewrites and response headers.
- **Informed:** Static Phase 1 deployment and the later shared-memory header
  gate.
- **Use limit:** Hosting documentation only; no service is provisioned by this
  architecture work.

### RS-016 - Model Context Protocol 2026-07-28 specification

- **Owner/publisher:** Model Context Protocol project
- **URLs:**
  - <https://modelcontextprotocol.io/specification/2026-07-28>
  - <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>
- **Accessed:** 2026-08-19
- **Facts used:** The current protocol uses self-contained stateless requests,
  JSON-RPC messages, resources and tools, and standard stdio and Streamable
  HTTP transports.
- **Informed:** The bounded local model-neutral MCP boundary, ADR 0005, and
  executing stdio verification.
- **Use limit:** Only local stateless stdio is implemented. Remote HTTP,
  identity, authorization, and tenancy remain separately gated.

### RS-017 - Official MCP TypeScript SDK v2 and license

- **Owner/publisher:** Model Context Protocol project
- **URLs:**
  - <https://ts.sdk.modelcontextprotocol.io/v2/>
  - <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE>
- **Accessed:** 2026-08-19
- **Facts used:** SDK v2 is the stable line for the 2026-07-28 protocol and
  supports server transports and structured schemas.
- **Declared license:** The exact selected
  `@modelcontextprotocol/server@2.0.0` and locked core artifact declare MIT in
  official npm package metadata; repository history may contain differently
  licensed contributions outside these selected package records.
- **Informed:** Local stdio transport and four-tool registration.
- **Use limit:** SDK transport only; project operations, consent flow, and
  bounded domain rules remain project-owned. Remote transports are excluded.

### RS-021 - Autodesk official CAD interaction documentation

- **Owner/publisher:** Autodesk
- **URLs:**
  - <https://help.autodesk.com/cloudhelp/ENU/BIM-360/files/GUID-5C15A82B-E1CB-435A-87A2-C07D5512225B.htm>
  - <https://help.autodesk.com/cloudhelp/ENU/BIM-360/files/GUID-A25EDAB0-DB1A-46A3-8F7D-35F1D55D3531.htm>
  - <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-SELECTION.htm>
  - <https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-3D-SKETCH.htm>
  - <https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-MEASURE.htm>
- **Accessed:** 2026-08-19
- **Facts used:** Mature CAD interfaces commonly provide named orthographic and
  isometric views, orbit/pan/zoom navigation, perspective/orthographic
  projection, selection priorities, sketch palette visibility controls,
  constrained-state feedback, driving dimensions, and typed measurement
  results including XYZ delta.
- **Informed:** `CAD_INTERACTION_ESSENTIALS.md`, ADR 0008, and the original PS3D
  viewport/sketch interaction requirements.
- **Use limit:** Public product-behavior research only. No Autodesk source code,
  icon, image, screenshot, UI asset, tutorial fixture, or documentation wording
  was copied into PS3D. Product names and interface concepts are not treated as
  implementation specifications.

### RS-022 - Official engineering-drawing workflow documentation

- **Owners/publishers:** Autodesk, Dassault Systèmes SOLIDWORKS, Siemens
  Digital Industries Software, ASME, and ISO
- **URLs:**
  - <https://help.autodesk.com/view/fusion360/ENU/?contextId=DWG-VIEWS>
  - <https://help.autodesk.com/view/fusion360/ENU/?contextId=DWG-CREATE-PROJECTED-VIEW>
  - <https://help.autodesk.com/view/fusion360/ENU/?contextId=DWG-SECTION-VIEW>
  - <https://help.autodesk.com/cloudhelp/ENU/Fusion-Drawing/files/DWG-REF-DIMENSION-DLG.htm>
  - <https://help.solidworks.com/2020/English/SolidWorks/sldworks/c_projected_view.htm>
  - <https://help.solidworks.com/2026/english/SolidWorks/sldworks/HIDD_DVE_INSERT_MODEL_ITEMS.htm>
  - <https://help.solidworks.com/2026/english/SolidWorks/sldworks/c_datum_feature_symbols.htm>
  - <https://help.solidworks.com/2026/english/SolidWorks/sldworks/HIDD_GTOL.htm>
  - <https://blogs.sw.siemens.com/wp-content/uploads/sites/2/2020/11/NX-Add-on-Module-Brochure.pdf>
  - <https://www.asme.org/codes-standards/find-codes-standards/y14-5-dimensiones-y-tolerancias>
  - <https://www.iso.org/standard/7748.html>
  - <https://www.iso.org/standard/85741.html>
  - <https://www.iso.org/standard/72514.html>
- **Accessed:** 2026-08-20
- **Facts used:** Mature drawing workflows use parent base views, aligned
  projected views governed by first/third-angle convention, derived section
  views, per-view edge appearance, selective model annotation insertion with
  duplicate elimination, explicit datum/feature-control-frame authoring, and
  rules/templates for company drawing automation. Standards-body pages were
  used to keep general tolerance and GD&T claims separate and version-aware.
- **Informed:** Corrected PS3D drawing view hierarchy, projection layout,
  section A-A, selected dimension strategy, explicit GD&T contract, title
  block, `AUTOMATIC_DRAWING_AND_TOLERANCE.md`, and ADR 0011.
- **Use limit:** Public product and standards behavior only. No vendor source
  code, template, icon, screenshot, tutorial model, example drawing, asset,
  standard text, or documentation wording was copied. PS3D's source, SVG
  geometry, controls, tests, and sheet layout are original.

## Test-tool license research

### RS-018 - Vitest official repository and license

- **Owner/publisher:** VoidZero Inc. and Vitest contributors
- **URL:** <https://github.com/vitest-dev/vitest>
- **Accessed:** 2026-08-19
- **Facts used:** Candidate TypeScript unit-test runner compatible with the
  proposed build stack.
- **Declared license:** MIT; published artifacts may include permissively
  licensed bundled dependencies whose notices still require review.
- **Informed:** Test-stack feasibility only.

### RS-019 - fast-check official repository and license

- **Owner/publisher:** fast-check contributors
- **URLs:**
  - <https://github.com/dubzzz/fast-check>
  - <https://github.com/dubzzz/fast-check/blob/main/LICENSE>
- **Accessed:** 2026-08-19
- **Facts used:** Candidate property-based testing for generated schemas,
  sketches, command sequences, and metamorphic properties.
- **Declared license:** MIT.
- **Informed:** Numerical and geometry verification strategy.

### RS-020 - Playwright official repository and license

- **Owner/publisher:** Microsoft and Playwright contributors
- **URLs:**
  - <https://github.com/microsoft/playwright>
  - <https://github.com/microsoft/playwright/blob/main/LICENSE>
- **Accessed:** 2026-08-19
- **Facts used:** Candidate automated testing across Chromium, Firefox, and
  WebKit browser engines.
- **Declared license:** Apache-2.0.
- **Informed:** Supported-browser and determinism test matrix.

## Candidate license summary

| Candidate | Research-time declared license | Intended boundary |
| --- | --- | --- |
| Manifold / `manifold-3d` | Apache-2.0 | Phase 1 mesh-solid adapter |
| Truck | Apache-2.0 | Future research adapter only |
| nalgebra | Apache-2.0 | Sketch-solver linear algebra |
| wasm-bindgen | MIT OR Apache-2.0 | Rust/WASM bridge |
| Comlink | Apache-2.0 | Optional worker RPC helper |
| three.js | MIT | Viewport adapter |
| React | MIT | Presentation candidate |
| Vite | MIT | Build candidate |
| Zod 4.4.3 | MIT | Local MCP runtime schemas |
| MCP server/core 2.0.0 | MIT for exact npm artifacts | Local MCP stdio transport |
| Vitest | MIT | Unit tests |
| fast-check | MIT | Property tests |
| Playwright | Apache-2.0 | Browser tests |

The table is not an SBOM and does not authorize installation. Project-owned
source remains MIT licensed; approved dependencies will retain the licenses
and notices of their exact selected artifacts. Apache-2.0, MIT, BSD, ISC, and
other policy-allowed components can be distributed alongside MIT project code
only while their respective terms remain satisfied. The project MIT license
does not relicense third-party code, generated bindings, WASM binaries, or
assets.
