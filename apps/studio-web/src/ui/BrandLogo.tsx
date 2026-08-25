import { PS3D_BRAND } from "../brand.js";

export function BrandLogo(props: { readonly className?: string; readonly decorative?: boolean }): React.JSX.Element {
  return <img
    className={`ps3d-brand-logo ${props.className ?? ""}`.trim()}
    src={PS3D_BRAND.logoPath}
    alt={props.decorative === true ? "" : `${PS3D_BRAND.name} logo`}
    decoding="async"
  />;
}

