import { PS3D_BRAND } from "../brand.js";
import { BrandLogo } from "../ui/BrandLogo.js";

export function PublicPageHeader(props: { readonly active: "studio" | "learn" | "access" | "about" }): React.JSX.Element {
  return <header className="public-page-header">
    <a className="public-brand" href="/about" aria-label={`About ${PS3D_BRAND.name}`}>
      <BrandLogo decorative />
      <span><strong>{PS3D_BRAND.name}</strong><small>Digital Engineering Suite</small></span>
    </a>
    <nav aria-label="Public pages">
      <a className={props.active === "studio" ? "active" : ""} href="/">CAD Studio</a>
      <a className={props.active === "learn" ? "active" : ""} href="/learn">Learning Center</a>
      <a className={props.active === "access" ? "active" : ""} href="/access">MCP Access</a>
      <a className={props.active === "about" ? "active" : ""} href="/about">About PS3D</a>
      <a href="https://github.com/sagar25-Code-it/ps3d-cad-studio" target="_blank" rel="noreferrer">Source</a>
    </nav>
  </header>;
}
