# PS3D Pending Deployment Update

> **Status: LOCAL ONLY — NOT COMMITTED, NOT PUSHED, NOT DEPLOYED**

This note records the complete working-tree delta planned for the next PS3D GitHub and Vercel deployment. It is a deployment handoff, not a claim that the listed changes are already live.

## Comparison boundary

| Item | Value |
| --- | --- |
| Capture date | 2026-08-27 (Asia/Calcutta) |
| Git comparison baseline | `953f20a5327e6799eaf8e8567b734ecbe5be079a` |
| Baseline subject | `Merge pull request #5 from sagar25-Code-it/ps3d-final-mcp-20260826` |
| Working branch | `mcp-token-store-fix` |
| Upstream | `origin/main` |
| Baseline divergence | 0 ahead / 0 behind |
| Delta before adding this note | 33 modified paths and 10 new paths |

The Git baseline above matches `origin/main` at capture time and is the repository baseline used as the last deployed state for this comparison. Confirm the same commit in the Vercel deployment details before promoting the next build.

## Release summary

The pending update adds five connected capability groups:

1. A professional File and session center with validated New, Open, Save, Save As, Save a Copy, recent-project, recovery, import/export, properties, print, Help, and cache controls.
2. A linked, non-destructive Render Studio for materials, environments, lighting, cameras, ground, resolution, and PNG/JPEG output.
3. A bounded analytic Part feature layer for revolve, pattern, mirror, Boolean, trim, detail, shell, draft, and recognized face edits.
4. A responsive CAD shell and nested, keyboard-accessible right-click menus that remain usable on smaller windows and browser zoom.
5. Safer and more actionable MCP token-storage diagnostics plus the least-privilege Supabase service-role repair migration.

## 1. File and session workflow

### New user-visible commands

- New design (`Ctrl+N`).
- Open PS3D project (`Ctrl+O`) with project validation before replacing the active session.
- Open recent project when a reusable browser file or workspace handle is available.
- Save (`Ctrl+S`), Save As (`Ctrl+Shift+S`), and Save a Copy.
- Download a validated native project copy.
- Recover the latest validated browser-private autosave.
- Open 3D Exchange, Drawing, Render Studio, project properties, print, Help, and storage utilities from the File center.

### Local folder and cache behavior

- After an explicit browser directory-picker approval, PS3D creates a `PS CAD Studio` folder inside the user-selected location, with `Projects`, `Exports`, `Renders`, `Recovery`, and `Cache` subfolders.
- The picker starts in Downloads when the browser supports that hint, but a public browser application cannot silently create or scan a system Downloads folder.
- Without directory permission, normal browser downloads remain available.
- Browser-private OPFS stores the current validated recovery/cache copy; IndexedDB stores session metadata and reusable handles where permitted.
- Recent-project history is bounded to 12 entries.
- Native project input is bounded to 50 MB and validated before use.
- Clearing fast cache removes browser-private recovery/render cache only; it does not delete visible user project files.

### Main implementation paths

- `apps/studio-web/src/file-workspace.ts`
- `apps/studio-web/src/ui/FileApplicationMenu.tsx`
- `apps/studio-web/src/ui/SaveProjectDialog.tsx`
- `apps/studio-web/src/styles/file-studio.css`
- `apps/studio-web/src/workbench-store.ts`
- `tests/file-workspace.test.ts`

## 2. Render Studio

The new Render Studio opens as a linked, non-destructive visualization workspace. It does not modify manufacturing geometry.

### Implemented controls

- Selectable Part, Assembly, Surface, and Vehicle scene sources.
- Original/source color or studio material overrides.
- Body color, roughness, and metalness controls.
- Softbox, daylight, graphite, white-cyclorama, and warm-studio environments.
- Exposure plus key, fill, and rim light intensity.
- Optional receiving ground with shadows.
- Perspective/orthographic projection and named orientation controls.
- Bounded raster resolutions from 256 to 4096 pixels.
- PNG and JPEG capture, quality control, a session gallery, and output to `PS CAD Studio/Renders` or browser download fallback.

### Truthful boundary

This is a real-time WebGL raster studio. It is not a path tracer, photometric certification tool, physically validated optical solver, or cloud render farm.

### Main implementation paths

- `apps/studio-web/src/workspaces/RenderStudioWorkspace.tsx`
- `packages/viewport-three/src/index.ts`
- `apps/studio-web/src/App.tsx`

## 3. Bounded analytic Part feature layer

The Part workspace now exposes 16 newly executable preview commands through the ribbon, All Commands, right-click context actions, the revisioned operation layer, validation, deterministic geometry, and MCP recipes.

| Command | Implemented bounded behavior |
| --- | --- |
| Revolve | Closed analytic annular revolve, including an optional partial sweep. |
| Pattern Feature | Linear, traceable analytic instances along a supported axis. |
| Mirror Feature | Traceable analytic copy across the global YZ datum plane. |
| Unite | Exact union for aligned compatible blocks or coaxial equal-diameter cylinders. |
| Subtract | Coaxial through-cylinder cut from a supported block or cylinder. |
| Trim Body | Local-Z analytic trim with an explicit kept side. |
| Edge Blend | Closed-mesh rounding of the four supported vertical edges of a plain block. |
| Chamfer | Closed-mesh bevel of the four supported vertical edges of a plain block. |
| Draft | Bounded local-Z taper on a supported plain block or cylinder. |
| Shell | Uniform-wall open-top shell on a supported plain block or cylinder. |
| Move Face | Move a supported local planar face and regenerate adjacent faces. |
| Offset Face | Offset a supported analytic face along its outward normal. |
| Replace Face | Replace a supported planar face using a parallel analytic datum position. |
| Delete Face | Recognize and heal the first supported bore/detail/shell/draft feature set. |
| Resize Blend | Recognize and regenerate the supported vertical blend chain at a new radius. |
| Update Model | Revalidate and rebuild the bounded analytic feature stack in one revision. |

Additional pending Part changes include:

- `revolved` analytic body identity and feature-trace records.
- Closed deterministic meshes for revolved, bored, shelled, drafted, rounded, and chamfered bodies.
- Feature-stack information and revolved inner/outer diameter editing in the Part inspector.
- Distinct project-owned SVG command symbols.
- Direct Part right-click feature groups and pattern/mirror submenus.
- Revision checks and fail-closed diagnostics for unsupported topology or modifier combinations.
- An expanded catalog of 340 unique commands with explicit qualified, preview, and unavailable levels.

### Exact limitation that must remain visible

This update does **not** implement a general commercial B-rep/NURBS kernel. Arbitrary rotations, freeform Boolean topology, arbitrary persistent face naming, general Intersect, unrestricted face operations, general trimming/sewing, and incompatible feature stacks remain unavailable and must fail rather than approximate success.

### Main implementation paths

- `packages/workbench-core/src/part-features.ts`
- `packages/workbench-core/src/types.ts`
- `packages/workbench-core/src/operations.ts`
- `packages/workbench-core/src/validation.ts`
- `packages/workbench-core/src/commands.ts`
- `packages/workbench-core/src/context-commands.ts`
- `packages/workbench-geometry/src/part.ts`
- `apps/studio-web/src/ui/WorkbenchRibbon.tsx`
- `apps/studio-web/src/workspaces/PartInspector.tsx`
- `tests/workbench-part-features.test.ts`

## 4. Professional shell, context menus, and responsive behavior

- The compact File dropdown is replaced by a full application-style File center.
- Render Studio is available from the application menu, workspace tabs, View/Create flows, and command catalog.
- Right-click menus now support nested named-view/projection and Part feature groups.
- Nested menus support mouse access, `ArrowRight`, `ArrowLeft`, and `Escape`, and flip away from the right viewport edge.
- Toolbar and context commands use additional distinct PS3D-owned SVG symbols.
- Responsive policies cover small laptops, narrow windows, phones, browser zoom, and short-height windows.
- Dense ribbons and public navigation remain reachable through bounded scrolling instead of widening the document.
- At the narrow CAD breakpoint, the primary canvas is presented before the model browser and inspector content.
- Master Cart, public pages, MCP Access, File center, Render Studio, drawings, tables, and engineering workspaces remove desktop-only minimum widths where required.

Main style contract: `apps/studio-web/src/styles/responsive.css`, loaded last from `apps/studio-web/src/styles.css`.

## 5. MCP command and AI collaboration update

New machine-readable MCP recipes are pending for:

- `part-revolve`
- `part-pattern`
- `part-boolean`
- `part-detail`
- `part-face-edit`
- `part-update-model`

Each recipe uses the existing inspect/preview/receipt/confirm boundary. Unsupported topology returns corrective diagnostics instead of claiming success. External MCP clients will see the new schemas only after this release is deployed and their MCP connection is rebuilt or restarted.

The File lifecycle and Render Studio commands are also discoverable through the audited command guide, while actual browser file permission remains a user gesture and is not granted to an AI host.

## 6. MCP access-token and Supabase repair

### Pending server behavior

- Token list, create, and revoke failures are classified into safe public errors.
- Permission failures explain that the administrator must apply the latest Supabase migration.
- Missing-table/schema failures explain that token storage is not provisioned.
- Invalid server credentials point to Supabase server-key configuration.
- The five-active-token limit remains a user-correctable `409` response.
- Raw database details and internal table names are not returned to the browser.
- The MCP Access portal now displays the stable public error reference code with the safe explanation.

### Pending migration

`supabase/migrations/202608260001_grant_mcp_service_role.sql` grants only:

- schema usage to `service_role`; and
- `select`, `insert`, and `update` on `public.mcp_tokens` to `service_role`.

It does not grant token-table access to `anon`, `authenticated`, or `public`, and it does not grant delete, truncate, ownership, or other unnecessary privileges.

## 7. Security and repository boundary

- No private key or raw personal MCP token is added to source control.
- `SUPABASE_SECRET_KEY`/service-role credentials and `MCP_TOKEN_PEPPER` remain server-only Vercel environment variables.
- User-visible project writes require an explicit browser-approved handle or normal browser download.
- The application does not scan unrelated system folders.
- Saved/opened projects are validated before becoming the active workbench state.
- Source-set and repository-boundary scripts now explicitly ignore `.git` traversal while continuing to reject symbolic links and excluded build/cache directories.
- The generated-material provenance record has been updated for the File, Render, responsive, token-store, and analytic-Part work.

## 8. Verification evidence completed locally

The implementation state and the post-note integrity rerun passed:

- `pnpm typecheck`
- `pnpm exec tsc -p tsconfig.tests.json`
- `node .test-dist/tests/run.js` — **115/115 tests passed**
- `pnpm build`
- repository-boundary verification
- dependency and supply-chain policy verification
- deterministic SBOM generation
- strict CSP, no dynamic evaluation, and prohibited runtime checks
- generated source-set verification
- `git diff --check`

The post-note production build transformed 149 modules and passed the 59-asset production-boundary check.

Manual local browser checks completed without application warning/error logs included:

- New Block and analytic Edge Blend.
- Closed analytic Revolve.
- Part right-click direct-feature and submenu access.
- Unite discoverability with its preview label.
- Responsive CAD layout at 900×700 and 700×600, including the narrow-layout canvas-first correction.

The canonical source-set record was recomputed after adding this note. The browser and cloud smoke checks must run again against the deployed Vercel URL.

## 9. Required actions before this becomes live

1. Review the complete working-tree diff and confirm no unrelated enterprise-system file is included.
2. Recompute and record the canonical source-set hash after this note.
3. Rerun typecheck, all authored tests, production build, repository boundary, dependency policy, SBOM, CSP, secret scanning, and `git diff --check`.
4. Confirm the target Supabase project has the new migration applied.
5. Confirm Vercel Production and Preview environments contain the intended values for `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (or service-role alias), `MCP_TOKEN_PEPPER`, and `PUBLIC_APP_URL` without exposing their values.
6. Commit the complete reviewed delta to the existing repository and push it to `main` only after user approval.
7. Redeploy the existing Vercel project from that Git commit.
8. Verify the deployed commit SHA, build log, primary routes, responsive layout, File fallback, Render Studio, Google/email authentication, MCP token create/list/revoke, and an external MCP handshake.
9. Restart/rebuild connected MCP clients so they receive the new command recipes.

## 10. Deployment decision

**Current decision: HOLD.** The release is documented and locally verified, but it remains pending until the user explicitly authorizes this complete new delta for commit and deployment.

## 11. Double-verification, touch assembly control, and fault intelligence

This local, not-yet-deployed delta now also contains:

- the reconciled engineering-intent planner and 12-tool MCP surface;
- a compact-layout correction that keeps the inspector and all controls reachable at narrow widths and browser zoom;
- an open-right-palm acquisition gate that requires model-label and palm-chirality agreement, an index-fingertip CAD cursor, and mirrored 4x thumb-index pinch-and-hold 360-degree orbit;
- independent near/far palm-depth control for continuous assembly explosion and reassembly up to 50% of the assembled model's largest dimension;
- one revisioned exploded-view commit when a gesture completes;
- an accessible inspector slider with live distance, percentage, Assemble, and Full controls;
- an on-canvas assembly gesture guide; and
- a Smart Fault Brain notification center for Design Health findings, detached dependencies, operation diagnostics, runtime failures, and unhandled promise rejections.

The Smart Fault Brain is advisory and fail-safe: it deduplicates and sanitizes messages, points to a recovery workspace, and never silently mutates the project. Physical touch-device validation remains a required pre-release smoke test even though the multi-pointer controller and UI contract have automated coverage.

## 12. On-device camera hand control

The pending local delta now uses the landmark architecture in
[`ADR 0015`](./adr/0015-landmark-camera-gesture-control.md). Camera access begins
only after a user click. A dedicated same-origin Worker mirrors each transferred
`ImageBitmap`, runs a hash-pinned MediaPipe Hand Landmarker, returns only 21
landmarks plus handedness/confidence/timing, and closes the frame immediately.
One-frame backpressure prevents an inference queue and keeps synchronous video
inference off the UI thread.

Project-owned validation and gesture logic require a stable open right palm,
require the model label to agree with mirrored wrist-index-pinky palm chirality,
apply scale-aware continuity rejection and One Euro filtering, keep index
movement cursor-only, and engage orbit only during a hysteretic thumb-index
pinch hold. The CAD boundary inverts both mirrored screen deltas and applies a
bounded 4x gain, so the model follows the visible hand direction. Left,
ambiguous, malformed, low-confidence, missing, and discontinuous frames produce
no CAD motion. A handedness change immediately suspends pinch and cannot inherit
the prior lock. Assembly Explode separately maps calibrated palm width to the
shared 50%-of-model travel limit and commits only through the existing
preview/commit boundary. Stop, Close, timeout, worker failure, or frame-transfer
failure releases all media and worker resources.

Preview blur remains optional and visual only. The thirteen owner-supplied
webcam photos informed the failure analysis and requested gestures; no photo or
derived frame is copied, uploaded, retained, or used for model training.

Deployment policy changes from `camera=()` to the narrower
`camera=(self)`. Microphone, geolocation, payment, and USB remain disabled.
The production build gate rejects a deployment that does not keep that exact
same-origin camera boundary. It also permits only the reviewed MediaPipe
loader/WASM/model paths and exact SHA-256 identities, verifies the runtime
manifest and Apache notice, rejects any additional `.wasm` or `.task` file, and
continues to reject general `unsafe-eval`, dynamic evaluation, geometry WASM,
Manifold, and Node-only MCP code.

Deterministic tests cover open-right acquisition, true-left and handedness-
disagreement rejection, fist rejection, pinch engage/release and identity-loss
behavior, finite/confidence validation, temporal smoothing, discontinuous-jump
rejection, mirrored 4x orbit direction, depth stops, and the model-scale 50%
limit. A physical webcam smoke test remains required
before this delta can be called hardware-verified.

## 13. MediaPipe development-loader routing hotfix

The local Vite preview originally exposed the prepared hand runtime through
`publicDir`. That is invalid for the MediaPipe ES-module loader: Vite blocks a
JavaScript module imported from `publicDir` because public assets bypass module
transforms. The browser therefore displayed a red development overlay even
though the same files were valid production assets.

The pending hotfix disables `publicDir` and adds an exact-route development
middleware for only four reviewed same-origin assets: the runtime manifest,
hand-landmarker model, ES-module loader, and WASM binary. It accepts only `GET`
and `HEAD`, rejects writes with `405`, sets explicit content types and security
headers, and cannot resolve arbitrary filesystem paths. Production bundle
completion copies the same four-file allowlist to `dist`; the existing build
verifier continues to enforce the pinned hashes and rejects extra runtime files.

Local regression evidence confirms the loader and model return `200`, a write
attempt returns `405`, the refreshed application has no Vite overlay or browser
error log, and the authored suite now contains 136 passing cases. A fresh
production bundle transforms 156 modules and passes the strict 61-asset
production-boundary verifier with the one approved, hash-pinned vision
WASM/model pair. Physical webcam behavior remains a separate hardware
smoke-test requirement.
