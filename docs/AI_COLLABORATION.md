# PS3D AI collaboration contract

PS3D exposes one provider-neutral Model Context Protocol boundary through local
stdio and authenticated remote HTTPS transports. A
host can use any AI model behind that boundary; PS3D tools do not import a
model-vendor SDK. Direct compatibility means the host supports MCP tools over
stdio or remote Streamable HTTP. A product without MCP needs an application
adapter such as the included Python client. Compatibility is not automatic for
every AI product.

## Local build and stdio connection

Build in a personal or IT-approved development/CI environment:

```powershell
pnpm mcp:build
```

Configure the host to launch the built server directly:

```json
{
  "name": "ps3d",
  "transport": "stdio",
  "command": "node",
  "arguments": ["apps/mcp-server/dist/apps/mcp-server/src/server.js"],
  "workingDirectory": "<absolute-path-to-ps3d-repository>"
}
```

The direct Node command matters: MCP reserves stdout for newline-framed JSON.
Build-tool output must not share that channel. The host must be given the
working directory explicitly; PS3D does not scan files, browser profiles,
credentials, environment secrets, or private system locations.

The server uses the official MCP v2 serving entry and supports modern
`2026-07-28` discovery plus `2025-11-25`, `2025-06-18`, and `2025-03-26`
legacy negotiation. Its machine-readable guide is available through:

- tool `ps3d_guide`;
- stateless coordinator `ps3d_agent_handshake`;
- engineering compiler `ps3d_plan_engineering_intent`;
- resource `ps3d://ai/collaboration-guide`;
- prompt `ps3d-guided-change`.

## Guided workflow

1. Connect by launching the prebuilt local stdio server, or authorize the
   deployed `/api/mcp` endpoint with OAuth or one expiring personal token.
2. Discover with `ps3d_guide` and `tools/list`. Retain the guide digest for the
   preview/apply acknowledgement.
3. Coordinate by calling `ps3d_agent_handshake` with the exact user request,
   experience level, optional workspace, and any proposed tool/recipe stable
   IDs. Resolve every correction or clarification it returns.
4. For a new part, assembly, product, or drawing, call
   `ps3d_plan_engineering_intent` with the complete request. Resolve its
   dimensions, standards, evidence, quantities, interfaces, and truthful
   feature-capability gates; the user does not paste a master prompt.
5. Understand existing state by supplying a complete caller-owned project to
   `ps3d_inspect_project`.
6. Review cross-workspace readiness with `ps3d_design_health`. Its dependency
   table distinguishes associative, trace-linked, snapshot, and detached links.
7. Use `ps3d_find_commands` to select a bounded recipe for one approved
   dependency package; do not execute fuzzy
   text or invent operation fields.
8. Preview write intent with `ps3d_preview_operation`, or use
   `ps3d_preview_electromechanical` for circuit-to-mounted-3D realization.
9. Show the exact candidate project, changed IDs, engineering disclosures,
   base/candidate content references, receipt details, and revision.
10. Obtain user confirmation tied to that exact preview.
11. Call `ps3d_apply_preview` with the same project, canonical operation,
   receipt, and `confirmed: true`.
12. Review and open/import the returned project copy.

The server is stateless and never writes a file or changes the live browser
project. A receipt is an unkeyed deterministic SHA-256 integrity checksum. It
detects project/operation/candidate mismatch; it is not authentication, a
digital signature, or proof that a human saw or approved the preview.

## Easy command understanding

`ps3d_find_commands` accepts a 2–160 character goal, optional workspace, and
result limit. It uses deterministic tokens, explicit synonyms, and a bounded
recipe catalog. It never sends text to an AI, executes text, or invents an
operation. Each result includes:

- the real MCP tool;
- the preview policy;
- an explicit argument template;
- workspace and engineering boundary;
- `executionPerformed: false`.

Three namespaces remain deliberately separate:

- `mcp-tool`: callable protocol methods;
- `workbench-operation`: canonical revision-checked mutations accepted only
  through preview/apply;
- `ui-command`: browser interaction records, never callable through MCP command
  search.

This separation prevents a fuzzy phrase from becoming an unreviewed mutation.

## Engineering intent compiler

`ps3d_plan_engineering_intent` accepts a complete 2–12,000 character request
plus optional unit, workspace, experience level, revision, target CAD list,
and evidence references. It deterministically returns:

- reusable manufactured and standard-part definitions;
- datum → sketch → base → detail → finish → verification feature order;
- normalized dimension facts and controlled fit-up questions;
- standard/supplier evidence gates instead of guessed catalog geometry;
- semantic interfaces and mate-reference strategy;
- dependency-ordered subassembly packages with one-package approval gates; and
- qualified, preview, or unavailable PS3D routes plus honest portability
  levels for external CAD targets.

This is a planning compiler, not an exact geometry kernel or hidden language
model. An unrecognized or incomplete request remains useful as a blocked plan
with specific questions; it never becomes invented geometry.

## PS3D collaboration agent

`ps3d_agent_handshake` is the in-tool agent boundary. It is a deterministic
contract validator, not a bundled language model, background process, or
persistent MCP session. The connected host AI and PS3D divide work explicitly:

- the host AI converses with the user, reasons about intent, asks for missing
  decisions, and explains the result;
- PS3D matches only registered tools, recipes, operations, and stable IDs,
  validates supplied data, and returns typed diagnostics and recovery; and
- both must inspect feedback and revalidate before retrying. Neither may invent
  a command, selection ID, sketch relation, mate, geometry result, live-browser
  mutation, or approval.

The caller chooses `child`, `beginner`, `engineer`, `advanced`, or `phd`.
The returned audience profile changes explanation depth—from small plain steps
to assumptions, derivations, dimensional consistency, uncertainty, and
validation evidence—but never changes the safety or geometry capability
boundary. The handshake also checks optional proposed MCP tool and
`ai-command:*` recipe IDs. Unknown or mismatched names produce machine-readable
feedback and an exact next action; no CAD command is executed.

Typical recovery is deterministic: refresh discovery for an unknown command,
inspect the current project for a missing selection, repair the named sketch or
mate precondition, discard stale receipts after a revision change, and report
unsupported exact-kernel behavior as unavailable rather than approximating it
as completed.

## Design health boundary

`ps3d_design_health` is a read-only deterministic review of the exact supplied
project. It returns eight workspace records, evidence-based findings, actual
dependency status, and a stable review order. It does not change the project,
run an exact CAD kernel rebuild, certify a solver result, or grant
manufacturing, electrical, vehicle, code-compliance, or regulatory release.
Detached links are reported as detached rather than inferred as associative.

## Python adapter

The Python 3.11+ client uses only the standard library, performs modern
discovery with legacy fallback, launches explicit argv with `shell=False`, and
has no network or secret-discovery code.

```python
from pathlib import Path
from ps3d_client import Ps3dClient

with Ps3dClient(
    ["node", "apps/mcp-server/dist/apps/mcp-server/src/server.js"],
    cwd=Path("<absolute-path-to-ps3d-repository>"),
    protocol="auto",
) as client:
    print(client.protocol_info())
    print(client.guide()["workflow"])
    print(client.agent_handshake(
        "set motorcycle wheelbase", "engineer", workspace="vehicle"
    ))
    print(client.find_commands("set motorcycle wheelbase", workspace="vehicle"))
```

## Honest deployment boundary

Available now: caller-supplied project JSON, local stdio, authenticated
stateless HTTPS JSON-RPC, modern and legacy discovery, read-only
inspection/analysis, deterministic command recipes, exact candidate preview,
scope filtering, rate limiting, and receipt-gated immutable return values.

Unavailable now: automatic access to an open browser tab, shared cloud CAD
document collaboration, server-side project persistence/concurrency authority,
and automatic compatibility with every remote AI product. Remote MCP never
reads a browser project implicitly; the host must supply the bounded value and
the user must review the returned copy. See `docs/MCP_CONNECTION_GUIDE.md` and
`docs/PUBLIC_DEPLOYMENT.md` for the authentication and operational contract.

Protocol references: [MCP stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
and [MCP server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover).
