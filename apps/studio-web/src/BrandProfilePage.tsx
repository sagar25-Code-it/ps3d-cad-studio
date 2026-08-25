import { PS3D_BRAND, PS3D_PUBLIC_TOOLS } from "./brand.js";
import { BrandFooter } from "./cloud/BrandFooter.js";
import { PublicPageHeader } from "./cloud/PublicPageHeader.js";
import { BrandLogo } from "./ui/BrandLogo.js";

export function BrandProfilePage(): React.JSX.Element {
  return <main className="public-page brand-profile-page">
    <PublicPageHeader active="about" />
    <section className="brand-profile-hero">
      <div>
        <span className="eyebrow">Brand and product profile</span>
        <h1>{PS3D_BRAND.name}</h1>
        <h2>{PS3D_BRAND.serviceLine}</h2>
        <p>{PS3D_BRAND.tagline}</p>
        <div className="hero-actions">
          <a className="primary link-button" href={PS3D_BRAND.calculatorUrl} target="_blank" rel="noreferrer">Open flagship calculator</a>
          <a href={PS3D_BRAND.portfolioUrl} target="_blank" rel="noreferrer">View owner portfolio</a>
        </div>
      </div>
      <aside aria-label="Official PS3D Master brand mark">
        <BrandLogo />
        <span>Official owner-supplied brand asset</span>
      </aside>
    </section>

    <section className="brand-expertise" aria-labelledby="brand-expertise-title">
      <header><span className="eyebrow">Brand and expertise</span><h2 id="brand-expertise-title">Practical engineering made visible</h2></header>
      <div className="brand-expertise-grid">
        <article><b>01</b><h3>Precision CAD</h3><p>Design-led thinking for clear mechanical concepts and build-ready communication.</p></article>
        <article><b>02</b><h3>Mechanical services</h3><p>Engineering support rooted in practical mechanical systems and motion applications.</p></article>
        <article><b>03</b><h3>Motion control</h3><p>Tools and analysis that organize the key inputs behind stepper-driven systems.</p></article>
      </div>
    </section>

    <section className="brand-suite" aria-labelledby="brand-suite-title">
      <header><span className="eyebrow">Public web tools</span><h2 id="brand-suite-title">Digital Engineering Suite</h2><p>Practical calculators and traceable workbenches for real engineering decisions.</p></header>
      <div className="brand-tool-grid">
        {PS3D_PUBLIC_TOOLS.map((tool, index) => <article key={tool.id}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <small>{tool.category}</small>
          <h3>{tool.name}</h3>
          <p>{tool.description}</p>
          {"href" in tool
            ? <a href={tool.href} target="_blank" rel="noreferrer">Open tool</a>
            : <b>Portfolio-listed concept</b>}
        </article>)}
      </div>
    </section>

    <section className="brand-founder" aria-labelledby="brand-founder-title">
      <div><span className="eyebrow">Owner / creator / technical voice</span><h2 id="brand-founder-title">{PS3D_BRAND.founder}</h2><strong>{PS3D_BRAND.founderTitle}</strong><p>{PS3D_BRAND.experience} - {PS3D_BRAND.location}.</p></div>
      <dl>
        <div><dt>Specialty</dt><dd>{PS3D_BRAND.specialty}</dd></div>
        <div><dt>Instagram</dt><dd><a href={PS3D_BRAND.instagramUrl} target="_blank" rel="noreferrer">{PS3D_BRAND.instagramHandle}</a></dd></div>
        <div><dt>LinkedIn</dt><dd><a href={PS3D_BRAND.linkedinUrl} target="_blank" rel="noreferrer">Sagar Patel</a></dd></div>
        <div><dt>Email</dt><dd><a href={`mailto:${PS3D_BRAND.email}`}>{PS3D_BRAND.email}</a></dd></div>
      </dl>
    </section>
    <BrandFooter note="Official public-facing identity and links from the owner-supplied PS3D Master profile." />
  </main>;
}

