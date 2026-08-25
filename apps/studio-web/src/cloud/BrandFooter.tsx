import { PS3D_BRAND } from "../brand.js";
import { BrandLogo } from "../ui/BrandLogo.js";

export function BrandFooter(props: { readonly note?: string }): React.JSX.Element {
  return <footer className="public-footer brand-footer">
    <a className="brand-footer-lockup" href="/about" aria-label={`About ${PS3D_BRAND.name}`}>
      <BrandLogo decorative />
      <span><strong>{PS3D_BRAND.name}</strong><small>{PS3D_BRAND.serviceLine}</small></span>
    </a>
    <div className="brand-footer-copy">
      <strong>{PS3D_BRAND.tagline}</strong>
      {props.note !== undefined && <small>{props.note}</small>}
    </div>
    <nav aria-label="PS3D Master public links">
      <a href={PS3D_BRAND.calculatorUrl} target="_blank" rel="noreferrer">Calculator</a>
      <a href={PS3D_BRAND.portfolioUrl} target="_blank" rel="noreferrer">Portfolio</a>
      <a href={PS3D_BRAND.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn</a>
      <a href={PS3D_BRAND.instagramUrl} target="_blank" rel="noreferrer">{PS3D_BRAND.instagramHandle}</a>
      <a href={`mailto:${PS3D_BRAND.email}`}>Email</a>
    </nav>
  </footer>;
}

