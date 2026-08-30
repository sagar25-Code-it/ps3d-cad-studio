# Python linking boundary

PS3D's Python link is a thin client for the same model-neutral MCP tools used
by other compliant hosts. It is not an embedded arbitrary-code console and it
does not give Python direct access to browser state, geometry-worker memory, or
the user's filesystem.

The client in `sdk/python` implements:

- modern `server/discover` negotiation in a disposable probe process plus
  2025-era initialize/initialized fallback;
- `tools/list` and `tools/call` over newline-framed JSON-RPC stdio;
- twelve typed tool helpers for the AI guide, stateless collaboration-agent
  handshake, built-in engineering-intent planning, deterministic command discovery,
  capabilities, project inspection, all-workspace design health, read-only vehicle analysis, generic
  operation preview, electromechanical catalog inspection,
  circuit-to-linked-3D preview, and confirmed apply;
- a finite request timeout and captured stderr tail for diagnostics;
- explicit argv with `shell=False` and a non-secret environment allowlist.

The project and operation remain complete in-memory JSON values. The
`agent_handshake(...)` helper sets the explanation level, checks the user goal
against bounded recipes, validates optional proposed tool/recipe stable IDs,
and returns correction feedback without executing a command or persisting a
session. The
`plan_engineering_intent(...)` helper decomposes a complete ordinary request
into reusable definitions, ordered features, standards/evidence questions,
interfaces, dependency packages, approval gates, and truth-labeled execution
routes. It never asks for a pasted master prompt or claims geometry execution.
The
electromechanical helper returns the exact generated operation and receipt but
does not apply it. Every mutation remains receipt-gated and requires
`confirmed=True`. That Boolean is a caller assertion, not cryptographic proof
of human approval, so a host must show the exact preview before invoking apply.
The receipt is an integrity checksum, not a signature. Generic preview includes
the exact candidate project, base/candidate content references, retry
disposition, and receipt metadata so a host can present the actual result.
Execution is intentionally
deferred on protected enterprise systems; use a personal or IT-approved
development or CI environment for the real process exchange.

`design_health(project)` sends the complete in-memory project to
`ps3d_design_health`. The returned `ps3d-design-health/1` document contains all
eight workspace records, actual dependency modes and status, a deterministic
review order, and explicit release exclusions. It is read-only and does not
rebuild or modify the caller's project.

`analyze_vehicle(project)` sends the complete in-memory project to
`ps3d_analyze_vehicle` and returns outer schema
`ps3d-vehicle-mcp-analysis/2` with nested `ps3d-vehicle-analysis/2`. The result
is a preliminary engineering screen only; it never asserts roadworthiness,
homologation, structural adequacy, braking approval, tire approval,
functional-safety compliance, or fabrication readiness.

This client does not implement remote HTTP MCP, authentication, cloud storage,
or secret management. Those require a separate threat model and deployment
review.

Build once with `pnpm mcp:build`, then launch the built server directly with
`["node", "apps/mcp-server/dist/apps/mcp-server/src/server.js"]`. Do not place a
package-manager build command on the MCP stdio channel because stdout is
reserved for protocol JSON.
