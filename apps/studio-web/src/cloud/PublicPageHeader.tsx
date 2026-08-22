export function PublicPageHeader(props: { readonly active: "studio" | "learn" | "access" }): React.JSX.Element {
  return <header className="public-page-header">
    <a className="public-brand" href="/" aria-label="PS3D Studio home">
      <span className="brand-mark" aria-hidden="true"><i>P</i><i>3</i><b /></span>
      <span><strong>PS3D Studio</strong><small>Independent browser CAD</small></span>
    </a>
    <nav aria-label="Public pages">
      <a className={props.active === "studio" ? "active" : ""} href="/">CAD Studio</a>
      <a className={props.active === "learn" ? "active" : ""} href="/learn">Learning Center</a>
      <a className={props.active === "access" ? "active" : ""} href="/access">MCP Access</a>
      <a href="https://github.com/sagar25-Code-it/ps3d-cad-studio" target="_blank" rel="noreferrer">Source</a>
    </nav>
  </header>;
}
