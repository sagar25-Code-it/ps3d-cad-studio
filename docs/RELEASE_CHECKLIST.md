# PS3D public release checklist

All boxes are release blocking unless the limitation is explicitly recorded as
Preview or Unavailable in the user interface and release notes.

## Source and legal

- [ ] Independent-development and provenance records are current.
- [ ] MIT copyright notice names the owner and is included in distributions.
- [ ] Third-party notices, dependency inventory, lockfile, and SBOM reconcile.
- [ ] No copied CAD source, model, UI asset, private key, token, password, user
      data, private path, or unexplained binary is present.
- [ ] The owner understands that MIT permits reuse; it does not reserve exclusive
      use of the published source.

## Engineering evidence

- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build` pass on clean CI.
- [ ] Repository boundary, dependency, MCP, source identity, generated material,
      output graph, and header gates pass.
- [ ] Learning Center and all 15 PDF pages render without clipping or corruption.
- [ ] Desktop and small-screen workbench, navigation, access, consent, error,
      recovery, and empty states were reviewed.
- [ ] Qualified, Preview, and Unavailable labels match implemented evidence.

## Window sizes and saved state

The same build behaves differently in different windows when layout or view logic
depends on the window size, the display scale, or what the browser has stored. Two
defects of this kind reached production: Fit pushed the sketch to the left edge on
wide windows only, and on a 1280 x 650 window the canvas grew to 2,326 px with the
sketch below the fold. Passing tests and one browser pane do not show either.

- [ ] Every change to a canvas, panel, dialog, style sheet, or view command (Fit,
      zoom, pan, frame) was run in a real browser with `scripts/layout-probe.js`
      at all of: 1024 x 640, 1280 x 650, 1366 x 768, 1536 x 730, 1920 x 1080 and
      2560 x 1300, and `problems` was empty at each one.
- [ ] The check was made in each workspace the change touches, with the longest
      dialog of that workspace open.
- [ ] The check was repeated on a project with a long browser tree and inspector
      (not only the default project): long side panels are what stretched the page.
- [ ] After the push, the same probe ran on the production address at a short
      window (1280 x 650) and a wide one (1920 x 1080), on build hash shown in
      the footer.

## Identity and MCP

- [ ] Email verification, login, logout, refresh, recovery, and password update
      were exercised with a dedicated test user.
- [ ] Token creation, shown-once handling, hashed persistence, list, expiry,
      five-token cap, cross-user isolation, and revocation were exercised.
- [ ] OAuth discovery, PKCE consent, approve, deny, refresh, and exact callback
      allowlisting were exercised with a registered test client.
- [ ] MCP auth, scope filtering, Origin rejection, rate limiting, body cap,
      malformed requests, tool discovery, preview, receipt, and returned-copy
      behavior were exercised.
- [ ] No MCP payload, password, raw token, or CAD project is stored in database
      audit/rate tables or application logs.

## Hosting and operations

- [ ] GitHub Release gates, CodeQL, dependency review, Dependabot, secret
      scanning/push protection where available, private reporting, and main
      ruleset are enabled and reviewed.
- [ ] Vercel production points to the reviewed main commit and server-only
      environment values are present only in encrypted project settings.
- [ ] Supabase migration, Site URL, redirects, email confirmation, OAuth server,
      asymmetric signing key, and exact client callbacks are configured.
- [ ] Health and public config return ready; response security headers are live.
- [ ] Rollback, secret rotation, token revocation, abuse response, backup, and
      vulnerability-disclosure owners are named outside the public repository.
- [ ] The owner makes the final release decision after reviewing all evidence.
