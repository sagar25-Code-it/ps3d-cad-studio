export const PS3D_BRAND = {
  name: "PS3D Master",
  productName: "PS3D CAD Studio",
  serviceLine: "Precision CAD Design & Mechanical Services",
  tagline: "Engineering intelligence for precision motion systems.",
  founder: "Sagar Patel",
  founderTitle: "Mechanical Design and Automation Engineer",
  specialty: "Motion Control Specialist",
  experience: "8+ years across EV battery systems, robotics, BIW, and automation",
  location: "Bangalore, India",
  logoPath: "/ps3d-master-logo.png",
  calculatorUrl: "https://stepper-calculator.onrender.com/",
  portfolioUrl: "https://sagar-portfolio-v1.vercel.app/",
  linkedinUrl: "https://www.linkedin.com/in/sagar-patel-1b6522100",
  instagramUrl: "https://www.instagram.com/ps3dmaster",
  instagramHandle: "@ps3dmaster",
  email: "sagarpatel25121995.sp@gmail.com"
} as const;

export const PS3D_PUBLIC_TOOLS = [
  {
    id: "motion-control",
    category: "Motion control",
    name: "Stepper Motor Calculator",
    description: "Lead screw, timing belt, and conveyor drive screening grounded in SI units.",
    href: PS3D_BRAND.calculatorUrl
  },
  {
    id: "bess-packaging",
    category: "BESS packaging",
    name: "BESS Packaging Calculator",
    description: "Cell-to-container packaging and electrical string design workspace.",
    href: "https://bess-packaging-calculator.vercel.app/"
  },
  {
    id: "vehicle-engineering",
    category: "Vehicle engineering",
    name: "2W Engineering Workbench",
    description: "Traceable two-wheeler calculations and vehicle-dynamics visualization.",
    href: "https://two-wheeler-engineering.vercel.app/"
  },
  {
    id: "mass-bom",
    category: "Mass and BOM",
    name: "Mass and BOM Workbench",
    description: "Theoretical mass, material planning, and visible engineering assumptions.",
    href: "https://ps3d-hub-bom-weight-calculator.vercel.app/#calculator"
  },
  {
    id: "busbar-routing",
    category: "Electrical packaging",
    name: "LFP Busbar Router",
    description: "A PS3D digital-engineering portfolio item listed in the official brand profile."
  }
] as const;

