# Command and MCP Verification

**Verification date:** 2026-08-26  
**Target:** local PS3D CAD Studio public-preview source  
**Method:** deterministic contract audit, automated package tests, direct MCP
process exchange, production build gates, and live in-app-browser interaction

## Result

The inspected command and MCP surfaces have one canonical operation namespace,
exhaustive dispatch checks, stable machine-readable IDs, explicit capability
labels, and a stateless coordination handshake for external AI hosts. The
verification does **not** claim that PS3D implements every command shown by a
commercial CAD system.

| Surface | Verified result |
| --- | --- |
| CAD command catalog | 331 unique command IDs audited |
| Executable contracts | 142 total: 2 `qualified`, 140 `preview` |
| Truthfully unavailable commands | 189; each retains an explicit boundary and implementation requirement |
| Workbench operation namespace | 55 canonical operation kinds; compile-time completeness check |
| MCP tools | 11 registered tools; all 11 built-in handlers executed in the live Automate workspace |
| MCP protocol | Modern `2026-07-28` discovery plus the retained 2025-era compatibility path |
| Browser console | 0 errors on the main workbench and command-audit route after the interaction pass |
| Responsive command symbols | Every inspected ribbon control had a non-empty label, an inline SVG symbol, a positive hit box, and no material internal overflow |

`qualified` means the specifically named and tested bounded path. `preview`
means functional but not production-qualified. `unavailable` means the command
is discoverable for planning and education but cannot be executed; PS3D does
not silently substitute a different operation.

## Live interaction checks

The local application was exercised at 1280 × 720 in the in-app browser.

- Direct sketch dimension editing selected an existing circle, exposed its
  definition points, changed the driving radius, created a revision, and
  propagated the parameter to the linked Part history.
- Sketch `Hide` reduced the visible-entity count from 5/5 to 4/5 and `Show`
  restored 5/5.
- The Top ViewCube face changed the named view to Top and updated the WCS to the
  same camera convention. The control remained a bounded cube; no oversized
  radial overlay appeared.
- A real cross-workspace defect was reproduced and corrected: broad project
  Undo had been disabled after switching from Sketch to Part whenever the
  native Part-worker history was empty. History-lane selection now preserves
  broad project Undo/Redo across workspace switches, while still preferring
  native Part history when that lane has entries.
- The corrected Undo restored the previous sketch radius after switching to
  Part; returning to Sketch displayed the restored value.
- Part, Sketch, Assembly, Surface, Drawing, Electrical, Vehicle, Automate, and
  Master Cart ribbons were inspected for symbols, labels, hit boxes, disabled
  boundaries, and clipping.

The ribbon audit observed:

| Workspace | Controls | Intentionally disabled | Symbol/layout failures |
| --- | ---: | ---: | ---: |
| Sketch | 31 | 18 | 0 |
| Part | 25 | 8 | 0 |
| Assembly | 15 | 4 | 0 |
| Surface | 6 | 0 | 0 |
| Drawing | 18 | 0 | 0 |
| Electrical | 15 | 0 | 0 |
| Vehicle | 15 | 0 | 0 |
| Automate | 13 | 1 | 0 |
| Master Cart | 8 | 0 | 0 |

Disabled controls are not counted as failures when the UI states the missing
solver/kernel boundary. Examples include general B-rep Booleans, freeform
spline solving, and topology-dependent edge operations.

## MCP tool execution

All eleven built-in Automate handlers were invoked against the local fixture
project. The observed schemas and safety behavior were:

| Tool | Observed result |
| --- | --- |
| `ps3d_guide` | `ps3d-ai-collaboration/3` |
| `ps3d_agent_handshake` | `ps3d-agent-handshake/1`, bounded recipe plus correction contract |
| `ps3d_find_commands` | `ps3d-command-search/1` |
| `ps3d_capabilities` | `ps3d-capabilities/1` |
| `ps3d_inspect_project` | `ps3d-project-summary/1` |
| `ps3d_design_health` | `ps3d-design-health/1` |
| `ps3d_analyze_vehicle` | `ps3d-vehicle-mcp-analysis/2` |
| `ps3d_electromechanical_catalog` | `ps3d-electromechanical-catalog/1` |
| `ps3d_preview_electromechanical` | `ps3d-electromechanical-preview/1` plus receipt |
| `ps3d_preview_operation` | `ps3d-operation-preview/1` plus receipt |
| `ps3d_apply_preview` | `ps3d-applied-operation/1` only after matching receipt and explicit confirmation |

The apply test returned a new project revision; browser Undo then restored the
fixture. No MCP handler wrote a file, mutated the open browser implicitly, or
accessed an operating-system secret.

## External-AI coordination contract

`ps3d_agent_handshake` is a deterministic PS3D coordination agent, not an
undisclosed second language model and not a persistent autonomous session. On
each request it:

1. adapts explanation depth for child, beginner, engineer, advanced, or PhD
   audiences;
2. maps a bounded goal to registered recipes without executing it;
3. checks proposed MCP tool IDs and recipe IDs;
4. returns exact correction codes for unknown, ambiguous, or mismatched input;
5. requires inspect/health, preview, confirmation, receipt, and apply stages as
   appropriate; and
6. returns a next-step contract that the host AI can use to correct and retry.

The live PhD-level request `dimension the selected sketch circle radius to 8
mm` resolved to `ai-command:sketch-dimension` with status
`ready-to-inspect`. No CAD command ran during the handshake.

Representative feedback codes are `UNKNOWN_MCP_TOOL`, `UNKNOWN_RECIPE_ID`,
`NO_BOUNDED_RECIPE`, `AMBIGUOUS_INTENT`, `PROPOSED_TOOL_MISMATCH`, and
`PROPOSED_RECIPE_MISMATCH`. This makes confusion observable to the external AI;
it does not pretend that arbitrary natural-language geometry or an unsupported
mate can be repaired automatically.

## Evidence

- [Command/MCP audit screenshot](screenshots/77-command-mcp-audit.jpg)
- [AI collaboration-agent screenshot](screenshots/78-ai-collaboration-agent.jpg)
- [Direct sketch dimension and ViewCube screenshot](screenshots/76-sketch-direct-dimension-viewcube.jpg)

## Remaining professional boundaries

PS3D remains a browser CAD research preview. It does not yet provide a general
exact B-rep/NURBS kernel, persistent face naming, a general sketch constraint
solver, production drawing certification, arbitrary collision-aware assembly
motion, qualified FEA/CFD/vehicle simulation, or live remote takeover of an
open browser tab. Those boundaries are deliberately represented as
`unavailable` rather than as decorative or misleading commands.

The external AI remains responsible for conversation, judgment, and obtaining
human approval. PS3D supplies a bounded command vocabulary, project inspection,
design-health feedback, deterministic validation, preview receipts, and exact
recovery instructions.

