# PS3D Python MCP client

This optional SDK links Python 3.11+ to the local PS3D MCP stdio server using
only the Python standard library. It is original MIT-licensed project code and
has no runtime package dependency.

The caller explicitly supplies the process argument vector, working directory,
project object, operation object, receipt, and confirmation. The client uses
`shell=False`, performs no network request or automatic file discovery, and
passes only a small non-secret runtime environment allowlist to the configured
process.

Use it only in a personal or IT-approved development environment:

```python
from pathlib import Path
from ps3d_client import Ps3dClient

with Ps3dClient(
    ["node", "apps/mcp-server/dist/apps/mcp-server/src/server.js"],
    cwd=Path("<path-to-ps3d-repository>"),
    protocol="auto",
) as client:
    print(client.protocol_info())
    guide = client.guide()
    print(guide["workflow"])
    guide_acknowledgement = {
        "manifestSha256": guide["manifestSha256"],
        "understood": True,
    }
    print(client.find_commands("change motorcycle wheelbase", workspace="vehicle"))
    # health = client.design_health(project_mapping)
```

Run `pnpm mcp:build` once before this example. Launching the built Node server
directly keeps stdout reserved for MCP JSON rather than build-tool status text.
`protocol="auto"` probes modern `2026-07-28` discovery in a disposable process
and falls back to the latest supported 2025-era initialization when required.

`analyze_vehicle(project)` is read-only. It returns deterministic preliminary
geometry, suspension, axle-load, brake, road-load, powertrain, lean, and
three-wheel support-polygon results with explicit warnings. It does not return
roadworthiness, homologation, structural, brake, tire, functional-safety, or
fabrication approval.

`design_health(project)` is also read-only. It returns the deterministic
eight-workspace health matrix, truthful associative/detached dependency map,
rebuild review order, findings, and release boundary for the supplied project.

```python
# project_mapping is a complete caller-owned ps3d-workbench-project/1 value.
vehicle_screen = client.analyze_vehicle(project_mapping)
print(vehicle_screen["analysis"]["status"])
```

Run the example with `sdk/python` on `PYTHONPATH`, or vendor the small
`ps3d_client` package into an approved Python project. No package installation
is required.

For a write-intent workflow, first read `guide()` and retain its current
`manifestSha256` with `understood=True` (or call `guide_acknowledgement()`).
Pass that acknowledgement to `preview(project, operation,
guide_acknowledgement)`, present
the returned candidate project, project references, engineering disclosures,
receipt information, and diff for approval, and only then call
`apply(project, operation, receipt, confirmed=True,
guide_acknowledgement=guide_acknowledgement)`. Missing or stale guide digests
fail closed, forcing the client to read the current contract. The MCP server returns a
new project object; neither the server nor the client writes the project to a
file.

The browser project is not automatically connected. The caller supplies a
complete project mapping and must review and open/import the returned copy.

No private key, token, `.env` value, browser profile, or enterprise credential
belongs in this SDK or its examples.
