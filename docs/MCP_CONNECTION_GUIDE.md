# Connecting an AI host to PS3D MCP

PS3D works with an AI product only when that product or its host application
supports remote MCP over HTTPS, or can send MCP JSON-RPC requests with an HTTP
Authorization header. The model itself does not receive a universal hidden key.
Every PS3D account owns its own connections.

## Recommended: OAuth 2.1

Give the AI host one URL:

```text
https://your-ps3d-domain.example/api/mcp
```

A compatible host discovers
`/.well-known/oauth-protected-resource`, starts Authorization Code with PKCE,
opens the PS3D consent screen, and receives a revocable Supabase access token.
The host never receives the PS3D web password. Register each OAuth client and
its exact callback URI in the Supabase OAuth Apps settings.

## Compatibility path: personal MCP token

Sign in at `/access`, create a separate expiring token for one AI host, and copy
the raw value when it is shown. PS3D stores only a peppered HMAC digest and
cannot show the raw value again.

Generic JSON configuration:

```json
{
  "mcpServers": {
    "ps3d": {
      "url": "https://your-ps3d-domain.example/api/mcp",
      "headers": {
        "Authorization": "Bearer ps3d_mcp_REPLACE_WITH_SHOWN_ONCE_TOKEN"
      }
    }
  }
}
```

Generic TOML configuration:

```toml
[mcp_servers.ps3d]
url = "https://your-ps3d-domain.example/api/mcp"

[mcp_servers.ps3d.http_headers]
Authorization = "Bearer ps3d_mcp_REPLACE_WITH_SHOWN_ONCE_TOKEN"
```

Never use the account password in either configuration. Never commit a raw
token. Revoke it immediately after suspected exposure.

## Scopes

| Scope | Allows |
| --- | --- |
| `mcp:read` | Guide, discovery, capability, inspection, health, vehicle analysis, and catalog tools |
| `mcp:preview` | Deterministic electromechanical and model-operation previews |
| `mcp:apply` | Return a confirmed new project copy after a matching preview receipt |

Every token includes `mcp:read`. Select only the additional permissions the
client needs. A maximum of five active tokens per account is enforced with
7-day, 30-day, or 90-day expiry.

## Safe command sequence

1. Call `initialize`.
2. Call `tools/list` rather than inventing a tool or input field.
3. Call `ps3d_guide` and `ps3d_find_commands`.
4. Inspect the complete bounded project supplied by the user.
5. Create a preview and show its diagnostics and exact operation.
6. Apply only after review, `confirmed: true`, and a matching SHA-256 receipt.
7. Treat the returned project as a new copy. Remote MCP does not click the live
   CAD browser, open private files, or write an external project automatically.

The ten tools are `ps3d_guide`, `ps3d_find_commands`, `ps3d_capabilities`,
`ps3d_inspect_project`, `ps3d_design_health`, `ps3d_analyze_vehicle`,
`ps3d_electromechanical_catalog`, `ps3d_preview_electromechanical`,
`ps3d_preview_operation`, and `ps3d_apply_preview`.

## Local Python and stdio option

The existing dependency-free Python client and Node stdio server remain useful
for approved local hosts. They are stateless, take explicit input, and perform
no browser-profile, filesystem-secret, credential, or network discovery. See
`docs/PYTHON_LINKING.md` and `docs/AI_COLLABORATION.md`.

## Troubleshooting

- HTTP 401: sign in/authorize again, or replace an expired/revoked personal
  token. Do not retry a leaked value.
- HTTP 403: the browser Origin is not the production PS3D origin.
- HTTP 413: reduce the complete JSON request below 1 MB.
- HTTP 429: wait until the returned reset time; the limit is 60 requests per
  minute per identity.
- JSON-RPC `-32003`: the token lacks the tool's required scope.
- Receipt mismatch: regenerate the preview against the current project revision.

