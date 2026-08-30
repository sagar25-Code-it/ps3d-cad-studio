# PS3D double-verification record — 2026-08-29

This note records the confirmed state **before** corrective edits for the fault-notification and touch-controlled assembly work. It deliberately separates verified behavior from requested capability.

## Baseline

- Latest user-visible worktree: `ps3d-mcp-fix-lf-20260826`, branch `mcp-token-store-fix`, base `953f20a`.
- Companion unfinished worktree: `ps3d-live-main-audit-20260826`, branch `main`, same base `953f20a`.
- Latest UI worktree: `git diff --check` clean, `115/115` compiled tests pass, full `pnpm test` passes, production `pnpm build` passes.
- Companion engineering-intent/MCP worktree: `git diff --check` clean, `111/111` compiled tests pass, full `pnpm test` passes, production `pnpm build` passes.
- The open local PS3D page at `http://127.0.0.1:5173/` was confirmed to be serving the latest UI worktree.

## Pass 1 — code, contracts, dependencies, and release gates

| ID | Severity | Confirmed finding | Evidence before fix |
|---|---|---|---|
| DV-001 | High | Pending features are split across two dirty worktrees based on the same commit. The latest file menu, render studio, part features, and responsive work are in one tree; engineering-intent planning and expanded MCP/Python guidance are in the other. | Independent status/diff inspection of both worktrees. Neither state alone contains all pending user-approved work. |
| DV-002 | Pass | Both individual states compile, pass their own tests, and build for production. | Commands and counts listed in Baseline. |
| DV-003 | Pass | Current assembly explosion is a revision-checked project operation and the geometry/interference preview consumes `assembly.explodeMm`. | `set-assembly-explode`, `buildAssemblyPreview`, and interference tests. |

## Pass 2 — rendered UI, responsive layout, and interactions

| ID | Severity | Confirmed finding | Evidence before fix |
|---|---|---|---|
| DV-004 | High | At compact widths the latest responsive rules force `.studio-app` to `100dvh` with hidden overflow while the inspector is placed below the viewport. This makes lower inspector content unreachable. | At 768×900 the inspector ended at y=2251 while document scroll height remained 900. At 520×900 it ended at y=2469 while document scroll height remained 900. |
| DV-005 | High | The Three.js viewport has one shared drag record and no active-pointer map. A second touch overwrites the first drag; either pointer release clears the gesture. Two-finger vertical assembly explosion cannot work. | Pointer handler inspection in `packages/viewport-three/src/index.ts`. |
| DV-006 | Medium | A single touch follows the selected desktop navigation mode. The default mode is Select, so one-finger assembly orbit is not available without changing modes. | Default `navigationMode: "select"` plus current pointer-down mode selection. |
| DV-007 | Medium | The assembly explode range has no accessible name and only submits on pointer/key release. It has no shared live controller for a canvas gesture and no explicit assembled/exploded percentage. | Rendered accessibility snapshot and `AssemblyInspector.tsx`. |
| DV-008 | Medium | Design Health and operation diagnostics exist, but there is no proactive, deduplicated fault-notification brain that announces new health faults, runtime errors, or unhandled promise failures. | `App.tsx`, `DesignHealthCenter`, and existing single diagnostic toast. |
| DV-009 | Pass | Wide 1440×900 layout has no document-level horizontal overflow; ribbon overflow is intentionally contained in its horizontal scroller. | Rendered geometry inspection. |
| DV-010 | Pass | ViewCube, WCS, mouse orbit, assembly scene generation, interference response, direct mates, and existing explode operation have automated coverage. | Existing interaction, geometry, core, and MCP tests. |

## Corrective order

1. Reconcile the two unfinished source states without overwriting either owner change.
2. Repair compact-layout scrolling and re-test the same viewports.
3. Add a deterministic fault-notification brain with runtime error capture and a user-openable notification center.
4. Add a shared continuous explosion controller, labeled slider, one-finger assembly orbit, and two-finger vertical explosion.
5. Re-run both functional and production gates, then repeat responsive and interaction verification.

## Corrective work completed locally

| Finding | Corrective result |
|---|---|
| DV-001 | Reconciled the engineering-intent planner, expanded MCP/Python contracts, File/Render work, analytic Part features, and responsive UI into the latest UI worktree without replacing the newer owner changes. |
| DV-004 | Replaced the compact fixed-height/hidden-overflow policy with a scrollable document flow. At the in-app browser's minimum available width, document width equals viewport width and document height now reaches the complete inspector. |
| DV-005 | Added an active touch-pointer map, stable centroid tracking, continuous 0–120 mm explosion preview, and a single revisioned commit at gesture completion. |
| DV-006 | Assembly touch input now maps one finger directly to 360-degree orbit regardless of the desktop selection tool. Desktop mouse behavior remains unchanged. |
| DV-007 | Added an accessible exploded-view distance control with live millimetres, percentage, Assemble/Full commands, preview/commit separation, and on-canvas gesture help. |
| DV-008 | Added a deterministic Smart Fault Brain that deduplicates Design Health, dependency, operation, browser-error, and unhandled-rejection notices; sanitizes credentials and local paths; announces new faults; and routes the user to recovery without silently changing CAD. |

## Post-fix verification evidence

- TypeScript test compilation passes.
- The compiled behavioral suite passes **124/124** cases, including touch-explode mapping and Smart Fault Brain redaction/deduplication.
- The real MCP stdio verifier discovers and validates all **12** tool schemas.
- The production Vite bundle compiles successfully.
- `git diff --check` is clean.
- The targeted source scan reports no accidental shell-output blocks, TODO/FIXME markers, dynamic evaluation, raw console logging, or `dangerouslySetInnerHTML` in the changed gesture/fault-brain surface.
- At the in-app browser minimum width (758 × 900), there is no document-level horizontal overflow, the complete inspector is reachable by scrolling, and the Smart Fault Brain drawer fits inside the viewport.
- The rendered Assembly workspace exposes the one-finger orbit and two-finger vertical-explode guidance, a labeled 18.0 mm / 15% live controller, and the deduplicated fault count.

Automated tests validate the multi-pointer state machine and continuous preview/commit contract. A final physical capacitive-screen smoke test is still required before release because desktop browser automation cannot truthfully reproduce the user's actual fingers, device palm rejection, or OS touch-driver behavior.

After this record was finalized, the exact recorded source passed repository-boundary verification, dependency policy, deterministic SBOM verification, all 124 behavioral tests, the 12-tool MCP stdio lifecycle, evaluator identity, generated source-set identity, strict-CSP production-boundary verification, and the complete production build.
