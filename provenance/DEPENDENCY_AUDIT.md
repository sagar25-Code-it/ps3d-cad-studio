# Phase 1 Dependency Audit

**Audit date:** 2026-08-19  
**Decision:** Approved for the bounded local workbench preview; public-release review remains required  
**Policy:** [`SOURCE_POLICY.md`](SOURCE_POLICY.md)

## Method

Exact package versions, official npm tarball URLs, SHA-512 integrity values,
declared licenses, intended use, and scope are recorded in
[`dependencies.json`](dependencies.json). The original Phase 0 graph was
reviewed before installation. The six-package Phase 1 MCP/type peer delta was
reviewed against official npm package-version metadata and reconciled with the
lock immediately after the lock update.

`scripts/verify-dependency-inventory.mjs` now enforces a deny-by-default,
one-to-one match between every `packages` entry in `pnpm-lock.yaml` and the
inventory. The current lock contains 139 exact package artifacts. pnpm 11.9.0
is recorded separately as the external package-manager artifact, bringing the
recorded total to 140.

| SPDX declaration | Locked artifacts |
| --- | ---: |
| MIT | 111 |
| Apache-2.0 | 25 |
| ISC | 2 |
| BSD-3-Clause | 1 |

pnpm adds one MIT external-tool record. Floating versions, CDN imports,
vendored third-party source, fonts, icons, and media are absent.

## Direct selection

| Package | Version | License | Scope |
| --- | ---: | --- | --- |
| React | 19.2.8 | MIT | browser presentation |
| React DOM | 19.2.8 | MIT | browser presentation |
| three | 0.185.1 | MIT | disposable viewport adapter |
| @modelcontextprotocol/server | 2.0.0 | MIT | local Node stdio MCP server only |
| zod | 4.4.3 | MIT | local MCP runtime schemas only |
| TypeScript | 7.0.2 | Apache-2.0 | development |
| Vite | 7.3.6 | MIT | development/build |
| @types/node | 24.13.3 | MIT | development and MCP declarations |
| @types/react | 19.2.18 | MIT | development |
| @types/react-dom | 19.2.4 | MIT | development |
| @types/three | 0.185.4 | MIT | development |
| manifold-3d | 3.5.1 | Apache-2.0 | development-only candidate qualification |
| esbuild-wasm | 0.27.3 | MIT | declared peer for the development-only candidate |
| pnpm | 11.9.0 | MIT | external package manager |

`@modelcontextprotocol/core` is a locked transitive runtime dependency of the
official local server. The MCP SDK, its protocol core, and Zod run only in the
local Node stdio process. The browser's Automate workspace imports the
project-owned pure handler layer and does not import the SDK or Zod.

## Rejected and excluded artifacts

Vite 8.2.1 was not used because its then-current graph introduced an MPL-2.0
build dependency outside the routine allowlist. Vite 7.3.6 was selected and
its exact graph was audited.

The development-only `manifold-3d` candidate exposes optional image-processing
paths whose `sharp` platform artifacts can include LGPL-licensed libvips
binaries. Candidate qualification does not perform image processing.
`pnpm-workspace.yaml` sets `autoInstallPeers: false`, ignores `@img/sharp-*`,
and permits no dependency build scripts. Those artifacts are absent from the
lock graph and installation.

The deployed worker continues to use the project-owned, bracket-specific f64
kernel for its one qualified solid path. Production build gates reject
Manifold/WASM artifacts, dynamic code generation, and the Node-only MCP SDK
from the browser graph.

## Installation and verification

The exact graph is installed with lifecycle scripts disabled:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm peers check
pnpm verify:deps
```

The frozen install must not alter the lockfile. On 2026-08-19,
`pnpm peers check` reported no peer issues. `pnpm audit --json` checked all 139
locked packages and `pnpm audit --prod --json` checked the seven production
dependencies; both reported zero informational, low, moderate, high, or
critical vulnerabilities. Typecheck also passed against this graph.

Registry advisory results are time-dependent and must be rerun at release
time. Package metadata review does not replace security, export-control,
trademark, patent, or public-release legal review.
