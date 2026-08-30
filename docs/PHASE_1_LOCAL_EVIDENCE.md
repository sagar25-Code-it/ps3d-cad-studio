# Phase 1 / Public-Preview Release-Candidate Evidence

**Evidence date:** 2026-08-22  
**Scope:** Protected-workstation broad-workbench preview plus reviewed cloud-release source  
**Publication status:** Publication authorized; GitHub/Vercel creation and live integration verification are pending

## Implemented result

The original PS3D browser application preserves one revisioned semantic project
across Sketch, Part, Assembly, Surface, Drawing, Electrical, Vehicle, and
Automate. The current interface exposes a truth-labeled command catalog,
capability records, a deterministic Design Health Center, and ten stateless
local MCP tools. Only the
worker-qualified centered-bore part path
is `qualified`; every broader functional path is `preview` or `unavailable`.

The public-release candidate adds a responsive twelve-module Learning Center,
a generated and visually inspected fifteen-page PDF manual, verified-email
account/recovery flows, tenant-isolated scoped and expiring personal MCP tokens,
OAuth protected-resource/consent routes, an HTTPS remote MCP function, Supabase
RLS/quota migration, restrictive Vercel headers, and pinned GitHub CI/security
workflows. Cloud-dependent controls fail closed until production environment
configuration exists.

The latest cross-workbench delta analyzes all eight workspaces, presents the
actual associative/trace-linked/snapshot/detached dependency contract, exposes
a stable review order and evidence-backed repair queue, and makes the same
read-only `ps3d-design-health/1` report available through the browser, MCP, and
Python adapter. It does not claim exact-kernel rebuild, solver certification,
manufacturing release, code compliance, or regulatory approval.

The latest delta upgrades the pinned 13-kind catalog to
`ps3d-generic-panel/2` and adds a review-gated Circuit → wired mounting plate
workflow. It preserves the source schematic, creates one plate with exact
DIN-rail/duct/PE/standoff infrastructure and panel-scale generic packages,
derives bounded terminal-to-duct conductor paths, records exact
device/terminal/net traceability, detects stale links, and cross-probes between
Electrical and Assembly without changing the revision. It does not infer
manufacturer geometry, electrical ratings, cable sizing, compliance, or
construction approval.

The vehicle-engineering delta adds five original generic templates: an ICE road
motorcycle, step-through scooter, EV street motorcycle, delta cargo
three-wheeler, and tadpole geometry study. Each uses one SI-native parameter
model, revisioned full-droop/design-ride/full-bump hardpoints, independently
toggleable CAD layers, and deterministic preliminary geometry, suspension,
load-transfer, brake, stopping-distance, road-load, powertrain, two-wheel lean,
or three-wheel support-polygon calculations. The templates and calculations
are illustrative and unvalidated; they do not establish structural adequacy,
tire or brake suitability, functional safety, roadworthiness, homologation, or
fabrication readiness.

## Current browser review

The application was reviewed in the in-app Chromium browser at 1280 × 720. The
review exercised:

- all eight workspaces, top CAD menu, workspace tabs, context ribbon, model and
  feature-history tree, inspector, status bar, command launcher, and color/symbol
  system;
- named views, view box, WCS triad, orbit/pan/zoom/fit, projection, selection
  controls, triangle-ray measurement, sketch constraints, and driving dimensions;
- assembly insertion/editing/mates/explode/interference, surface previews,
  automatic drawing views/dimensions/tolerances/basic explicit GD&T, and local 3D
  exchange controls;
- cargo, high-cube, BESS, and three schematic templates;
- the complete circuit-to-wired-panel review, acknowledgement, one-revision generation,
  current-link inspection, and exact source-device cross-probe; and
- all five vehicle templates, suspension-state changes, layer toggles, named
  views, model/feature history, live calculation findings, and the delta and
  tadpole three-wheel contact/support geometry.

The shared confirmation dialog opens at its visible header with the close
control focused, traps keyboard focus, isolates workspace shortcuts, supports
Escape cancellation, and restores the invoking control or active workspace
tab. A live review caught and corrected a DOM/CAD-document name-shadowing
regression before this evidence was recorded.

### Latest electromechanical evidence

| State | Verified result | Screenshot |
| --- | --- | --- |
| Professional Electrical workspace | Component library, canonical single-line, device/net/ERC/mapping summaries, explicit concept boundary | [`32-professional-electrical-workspace.jpg`](screenshots/32-professional-electrical-workspace.jpg) |
| Initial review | Explicit replacement scope and non-construction acknowledgement | [`33-circuit-to-3d-review.jpg`](screenshots/33-circuit-to-3d-review.jpg) |
| Initial linked assembly | Generic packages, support, routes, and trace inspector | [`34-linked-electromechanical-assembly.jpg`](screenshots/34-linked-electromechanical-assembly.jpg) |
| Final review dialog | Exact removal and generation disclosure for 20 bodies, 20 fixed mates, 7 unsized conductors, and 8 links; complete prior/generated Assembly snapshots; 0 ERC errors and 1 acknowledged warning | [`35-reviewed-circuit-to-3d-dialog.jpg`](screenshots/35-reviewed-circuit-to-3d-dialog.jpg) |
| Final linked assembly | Revision 1, one plate, 8 linked panel packages, 12 infrastructure bodies, 7 terminal-to-duct conductor paths, current `ps3d-generic-panel/2` source link, 0 conservative AABB candidates | [`36-linked-electromechanical-current.jpg`](screenshots/36-linked-electromechanical-current.jpg) |
| Cross-probed source | BAT1 selected in Electrical from its linked 3D package without creating revision 3 | [`37-cross-probed-electrical-device.jpg`](screenshots/37-cross-probed-electrical-device.jpg) |

### Design-health evidence

| State | Verified result | Screenshot |
| --- | --- | --- |
| Design Health Center | Eight-workspace readiness matrix, 97/100 review state, 0 blocking and 3 review findings, four current and five detached dependency links, evidence/recovery queue, stable review order, and explicit release boundary | [`49-design-health-center.jpg`](screenshots/49-design-health-center.jpg) |

### Vehicle-engineering evidence

Images 40–43 are retained as historical v1 records and are superseded because
their visual state predates the schema-2 topology, brake, wheel-orientation,
and verification corrections. The current evidence images below were rendered
from the live browser DOM by the standalone read-only evidence entrypoint; each
orthographic view consumes the same `solveVehicleGeometry()` graph as the 3D
workspace. They are not photographs, certification evidence, or substitutes
for qualified engineering review.

| State | Verified result | Screenshot |
| --- | --- | --- |
| ICE motorcycle solved graph | Design-ride side projection, 27 hardpoints, 15 members, six passing invariants, achieved brake screen, and explicit evidence boundary | [`44-vehicle-v2-ice-side.png`](screenshots/44-vehicle-v2-ice-side.png) |
| Scooter full-bump solved graph | Unit-swing full-bump side projection with state-dependent review finding preserved rather than hidden | [`45-vehicle-v2-scooter-bump-side.png`](screenshots/45-vehicle-v2-scooter-bump-side.png) |
| Delta cargo solved graph | One-front/two-rear top projection, solved 1,250 mm track, support topology, and equal per-wheel brake contract | [`46-vehicle-v2-delta-top.png`](screenshots/46-vehicle-v2-delta-top.png) |
| Tadpole wishbone solved graph | Front projection with separate UCA/LCA/upright/steering hardpoints, solved 1,200 mm track, and nine passing invariants | [`47-vehicle-v2-tadpole-front.png`](screenshots/47-vehicle-v2-tadpole-front.png) |
| Vehicle browser gate | Six independent browser-runtime groups passed after the final physical, render-pose, invalid-state, and MCP corrections | [`48-vehicle-v2-browser-gate.png`](screenshots/48-vehicle-v2-browser-gate.png) |

### Public-release evidence

| State | Verified result | Screenshot |
| --- | --- | --- |
| Learning Center | Responsive beginner-to-advanced curriculum, explicit capability truth labels, local progress, PDF download/preview, and AI-connection route | [`50-learning-center.jpg`](screenshots/50-learning-center.jpg) |
| MCP access portal | Fail-closed local state, account controls, separate password/token explanation, and deployment-required status | [`51-mcp-access-portal.jpg`](screenshots/51-mcp-access-portal.jpg) |
| CAD release-candidate home | Existing professional ribbon, history browser, Design Health, local MCP/Python guidance, and public navigation retained | [`52-public-release-cad-home.jpg`](screenshots/52-public-release-cad-home.jpg) |
| Manual cover | Corrected title panel, edition, safety boundary, ownership notice, and no clipping | [`53-learning-manual-cover.png`](screenshots/53-learning-manual-cover.png) |
| Manual module | Rendered module hierarchy, outcomes, practice, verification, and professional boundary without collisions | [`54-learning-manual-module.png`](screenshots/54-learning-manual-module.png) |
| Manual release checklist | Fifteen-page document terminates with cloud, MCP, secrets, repository, live-review, and operations gates | [`55-learning-manual-checklist.png`](screenshots/55-learning-manual-checklist.png) |

Earlier browser evidence for the qualified part, sketch, assembly, surface,
drawing, Automate, viewport, measurement, command system, exchange/PDF UI,
drawing/GD&T, cargo/BESS, and electrical template states remains under
[`artifacts/screenshots`](../artifacts/screenshots) and
[`docs/screenshots`](screenshots).

## Current deterministic checks

- The dedicated no-subprocess vehicle browser entrypoint passed **6/6**
  independent vehicle groups after schema-2 topology, all-state kinematics,
  physical cross-field validation, rendered wheel/brake pose, JSON-finiteness,
  contact-ID, and MCP boundary corrections.
- The broader browser-compatible entrypoint passed **76/76** deterministic cases
  from the current source. It deliberately excludes the ten Node-only
  solid-kernel, evidence, cryptographic-token, and PDF-structure cases rather
  than polyfilling or weakening them.
- The existing Vite/TypeScript transform pipeline parsed **99/102** authored
  TypeScript/TSX files in-process. The only three rejected entries were the
  intentionally Node/development-only MCP server, Manifold adapter, and its
  evidence test, each stopped by the production browser-boundary plugin rather
  than a syntax failure.
- The earlier temporary no-subprocess runner passed **51/51** cases after the
  wired-panel delta; that result is historical evidence for its recorded source.
- Earlier 42/42, 31/31, and 48/48 browser runs remain historical evidence for
  their recorded source revisions.
- The cases cover workbench validation/operations, sketch intent, assembly and
  surface geometry, rotated AABB bounds, drawing generation, cargo/BESS
  templates, electrical endpoint and sheet-coordinate validity, SVG escaping,
  ERC, catalog migration-to-stale behavior, generic catalog coverage, one exact
  plate/rail/duct/PE/standoff set, rotation-aware terminal transforms,
  renderer-derived detail budgets, deterministic package transforms, edit
  behavior, exact catalog-terminal sets and terminal roles, self-short
  rejection, rotation/text-footprint-aware panel avoidance, ellipsized and
  width-constrained on-sheet text with full-title retention, one shared
  core/UI/MCP route plan, outward terminal escape portals, occupied-segment and
  label separation between distinct nets, routing around panels and unrelated
  component footprints, fail-closed blocked-route ERC, complete in-envelope
  orthogonal terminal-to-duct conductor paths,
  capped 48/24 primary/extended corridor sets, a deterministic 250,000
  obstacle-check budget with explicit affected-net diagnostics, one reused route
  plan through render/ERC/readiness, lazy 3D candidate generation, and a
  100-component/200-net completion regression,
  fail-closed 16-device and 8-conductor-path panel limits, unique 14 mm
  collision-separated route lanes, undirected branch-segment deduplication, and
  terminal-first detail retention at the supported device limit,
  explicit partial-table disclosure plus complete SVG BOM/ERC metadata,
  centralized undoable template-replacement review, source identity and
  staleness, protected exact component/mate/infrastructure sets and safety
  metadata, deterministic collision-resistant IDs, complete
  prior/candidate MCP disclosure, generated mate change disclosure,
  layout/interference bounds, all-workspace health/dependency analysis, and all
  ten pure MCP handlers.
- The repository contains **100 authored typed-suite cases**, including four
  new unified-interaction cases covering camera/WCS agreement, connected and
  tangent sketch selection, truthful context commands, and revision-checked
  assembly mate records. All 100 passed in the current local run.
- An earlier, pre-electromechanical revision passed strict TypeScript, production
  build, dependency reconciliation, peer checks, registry audits, SBOM creation,
  and a real MCP initialize/list/preview/receipt/apply stdio exchange. These are
  historical evidence only, not substitutes for current clean gates.
- The current browser application loaded, completed the reviewed wired-panel
  workflow through revision 2, and then exercised the EV, delta, and tadpole
  vehicle workflows through revision 9 without a visible application error.
  A tadpole wheelbase edit from 2000 mm to 2100 mm created an audited
  `set vehicle parameter` revision and updated the displayed turning radius
  from 3.20 m to 3.36 m.

## Unified CAD interaction evidence

The following images were captured from the independent local PS3D build. They
are reviewed product evidence, not copied Autodesk or Siemens assets.

| Evidence | Coverage |
| --- | --- |
| [`67-unified-part-workspace.jpg`](screenshots/67-unified-part-workspace.jpg) | Shared Z-up WCS, camera-driven ViewCube, top navigation/selection controller, and professional document tree |
| [`68-part-context-menu.jpg`](screenshots/68-part-context-menu.jpg) | Body-specific right-click commands with topology-dependent actions truthfully unavailable |
| [`69-unified-sketch-workspace.jpg`](screenshots/69-unified-sketch-workspace.jpg) | Sketch plane inside the common 3D orbit environment with Profile, Curve, Connected, and Tangent intent |
| [`70-profile-extrude-handoff.jpg`](screenshots/70-profile-extrude-handoff.jpg) | Closed profile selection and associative handoff to Extrude |
| [`71-profile-extrude-controls.jpg`](screenshots/71-profile-extrude-controls.jpg) | New Body/New Component operation controls and explained Boolean boundary |
| [`72-assembly-component-mates.jpg`](screenshots/72-assembly-component-mates.jpg) | New component in the shared tree and assembly relationship workspace |
| [`73-direct-mate-controls.jpg`](screenshots/73-direct-mate-controls.jpg) | Direct mate authoring controls |
| [`74-mate-relationship-panel.jpg`](screenshots/74-mate-relationship-panel.jpg) | Parent/child and mate relationship inspection |
| [`75-assembly-context-menu.jpg`](screenshots/75-assembly-context-menu.jpg) | Component-specific Assembly right-click menu |
| [`76-sketch-direct-dimension-viewcube.jpg`](screenshots/76-sketch-direct-dimension-viewcube.jpg) | Direct driving-dimension editor, visible definition points, and bounded ViewCube/WCS controls |
| [`77-command-mcp-audit.jpg`](screenshots/77-command-mcp-audit.jpg) | Historical 331-command contract audit with executable/unavailable evidence and zero registry issues; the current catalog adds the engineering-intent command for 332 total |
| [`78-ai-collaboration-agent.jpg`](screenshots/78-ai-collaboration-agent.jpg) | PhD-level stateless coordination handshake resolving a sketch-dimension goal without CAD execution |

The current local functional suite passed **111/111** cases and the direct MCP
stdio exchange across all twelve tools plus evaluator identity. The current
`pnpm build` run produced 59 assets, enforced the strict CSP, and verified that
Node-only MCP SDK, WASM/Manifold, and dynamic-evaluation paths are absent from
the browser production boundary. The source-set gate is resealed only after
the current documentation and reviewed browser evidence are final.

## Repository and PDF evidence boundary

The repository-boundary verifier rejects symbolic links, credential-like files,
non-example environment files, high-risk token patterns, private profile paths,
and unreviewed binary files. Its exact binary manifest now includes the reviewed
historical interface evidence, current vehicle/release screenshots, the exchange
sample, and the generated learning manual; it validates file signatures instead
of trusting extensions. The current in-process verifier passed **254 UTF-8 text
files and 94 explicitly reviewed binary evidence files**. The standalone verifier
runs again in clean CI.

The PDF runtime requests a fresh viewport JPEG and embeds a GLB attachment. The
committed PDF sample passes structural PDF/attachment checks, but its recorded
page image is blank. It is therefore structural evidence only; a fresh non-blank
runtime export and independent render comparison remain release gates.

## Enterprise-system safety boundary

No security control was disabled, inspected, modified, or bypassed. The current
verification used only the project workspace and the bundled development
runtime. It did not inspect browser credential stores, private enterprise files,
or unrelated system locations. The direct MCP test launched only the repository's
reviewed local server entry point and completed normally.

## Remaining release gates

- Human provenance, technical, electrical-safety, accessibility, and security
  review.
- Fresh frozen install, strict typecheck, all 103 authored tests, production
  build, real stdio exchange, repository/secret scan, SBOM check, and two-build
  comparison in the approved GitHub Actions clean environment. The equivalent
  local gates pass; clean CI remains the independent release proof.
- Chromium, Firefox, and WebKit matrix; responsive/zoom keyboard review; and a
  broader rendering/interaction performance budget beyond the bounded router.
- Fresh non-blank PDF model-package capture and independent PDF render check.
- Successful GitHub Actions, Vercel build, Supabase migration/configuration,
  verified-email auth, token create/revoke, OAuth metadata, and remote MCP live
  integration exercise before changing the Preview label.

This evidence supports a substantial bounded preview. It does not support claims
of Fusion 360/NX/SOLIDWORKS parity, universal CAD import, production electrical
engineering, manufacturing qualification, safety certification, legal
clearance, or public-release readiness.
