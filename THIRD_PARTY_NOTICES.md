# Third-Party Notices

This bounded PS3D workbench preview uses the exact npm artifacts recorded in
`provenance/dependencies.json`. Package authors retain all rights to their
components; the repository MIT License does not relicense third-party work.

## Browser runtime components

| Component | Version | License | Purpose |
| --- | ---: | --- | --- |
| React | 19.2.8 | MIT | Accessible presentation shell |
| React DOM | 19.2.8 | MIT | Browser rendering for React |
| three | 0.185.1 | MIT | Disposable 3D viewport adapter |

The project-owned pure MCP handler/simulator code is part of the browser
source. No external MCP SDK, Node server code, Zod runtime, Manifold package,
or WASM payload is bundled into the browser artifact.

## Local MCP stdio runtime

| Component | Version | License | Purpose |
| --- | ---: | --- | --- |
| @modelcontextprotocol/server | 2.0.0 | MIT | Official local stdio server SDK |
| @modelcontextprotocol/core | 2.0.0 | MIT | Protocol primitives used by the server SDK |
| zod | 4.4.3 | MIT | Runtime input schemas for MCP tools |

## Development components

| Component | Version | License | Purpose |
| --- | ---: | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0 | Strict type checking and compilation |
| Vite | 7.3.6 | MIT | Static development and production build |
| @types/node | 24.13.3 | MIT | Node and MCP declarations |
| @types/react | 19.2.18 | MIT | React declarations |
| @types/react-dom | 19.2.4 | MIT | React DOM declarations |
| @types/three | 0.185.4 | MIT | three.js declarations |
| manifold-3d | 3.5.1 | Apache-2.0 | Evaluation-only candidate adapter and Node qualification test |
| esbuild-wasm | 0.27.3 | MIT | Declared peer for that development-only candidate |
| pnpm | 11.9.0 | MIT | Pinned workspace package manager |

The full direct and transitive artifact list, including registry tarball URLs,
integrity values, scopes, licenses, and notice obligations, is maintained in
`provenance/dependencies.json` and checked against the lockfile during tests
and builds.

MIT components require preservation of their copyright and permission text.
Apache-2.0 components require preservation of the Apache License 2.0 text,
copyright and attribution notices, modification notices where applicable, and
any upstream `NOTICE` supplied with a distribution. Release packaging must
reproduce applicable upstream license files and notices; this summary is not a
substitute for those texts.

The production `dist` license payload is generated from modules actually
bundled into the browser artifact. The build gate fails if Manifold, its WASM,
the Node-only MCP SDK, or dynamic code generation becomes reachable from that
graph. Development and source distributions that include the evaluation
candidate or MCP server must retain their exact inventoried upstream notices.
