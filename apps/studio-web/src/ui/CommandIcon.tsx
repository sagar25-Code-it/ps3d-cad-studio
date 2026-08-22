export interface CommandIconProps {
  readonly name: string;
  readonly className?: string;
}

export function CommandIcon({ name, className = "" }: CommandIconProps): React.JSX.Element {
  return <svg
    className={`command-icon ${className}`.trim()}
    data-icon={name}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.65"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {geometry(name)}
  </svg>;
}

export function inferCommandIcon(text: string, workspace = ""): string {
  const source = `${text} ${workspace}`.toLowerCase();
  const rules: readonly (readonly [string, string])[] = [
    ["rectangle", "rectangle"], ["circle", "circle"], ["arc", "arc"],
    ["line", "line"], ["spline", "spline"], ["select", "select"],
    ["horizontal", "horizontal"], ["vertical", "vertical"], ["parallel", "parallel"],
    ["perpendicular", "perpendicular"], ["collinear", "collinear"], ["concentric", "concentric"],
    ["tangent", "tangent"], ["equal", "equal"], ["fixed", "fixed"],
    ["automatic view", "auto-view"], ["general tolerance", "tolerance"], ["gd&t", "gdt-position"],
    ["datum", "datum"], ["flatness", "flatness"], ["construction", "construction"], ["dimension", "dimension"], ["constraint", "constraint"], ["trim", "trim"],
    ["offset", "offset"], ["extrude", "extrude"], ["bore", "bore"],
    ["hole", "bore"], ["fillet", "edge"], ["chamfer", "edge"],
    ["edge", "edge"], ["pattern", "pattern"], ["revolve", "revolve"],
    ["sweep", "sweep"], ["loft", "loft"], ["shell", "shell"],
    ["boolean", "boolean"], ["combine", "boolean"], ["measure", "measure"],
    ["interference", "interference"], ["fit", "fit"], ["home", "home"],
    ["orbit", "orbit"], ["pan", "pan"], ["orthographic", "projection"],
    ["perspective", "projection"], ["grid", "grid"], ["axis", "axes"],
    ["3d pdf", "pdf-3d"], ["pdf", "pdf-package"], ["exchange", "exchange"],
    ["import", "import"], ["export", "export"], ["download", "download"], ["open", "open"],
    ["save", "save"], ["json", "json"], ["insert", "insert"],
    ["component", "box"], ["cylinder", "cylinder"], ["box", "box"],
    ["assemble", "assemble"], ["explode", "explode"], ["move", "move"],
    ["ground", "ground"], ["hide", "eye-off"], ["show", "eye"],
    ["delete", "trash"], ["mate", "mate"], ["joint", "joint"],
    ["motion", "motion"], ["bézier", "bezier"], ["bezier", "bezier"],
    ["flatten", "flatten"], ["canopy", "canopy"], ["stitch", "stitch"],
    ["thicken", "thicken"], ["section", "section"], ["detail", "detail"],
    ["bom", "bom"], ["python", "python"], ["mcp", "mcp"],
    ["battery", "battery"], ["fuse", "fuse"], ["breaker", "breaker"],
    ["disconnect", "disconnect"], ["contactor", "contactor"], ["inverter", "inverter"],
    ["transformer", "transformer"], ["motor", "motor"], ["sensor", "sensor"],
    ["linked 3d", "circuit-3d"], ["circuit to", "circuit-3d"], ["circuit", "electrical"], ["electrical", "electrical"], ["net", "wire"], ["container", "container"],
    ["hardpoint", "hardpoint"], ["suspension", "suspension"], ["brake", "brake"],
    ["steering", "steering"], ["wheel", "wheel"], ["chassis", "chassis"],
    ["scooter", "scooter"], ["three-wheel", "three-wheel"], ["three wheeler", "three-wheel"],
    ["cg", "cg"], ["vehicle", "vehicle"],
    ["undo", "undo"], ["redo", "redo"], ["drawing", "drawing"],
    ["surface", "surface"], ["assembly", "assembly"], ["sketch", "sketch"],
    ["part", "part"]
  ];
  return rules.find(([term]) => source.includes(term))?.[1] ?? "command";
}

export function iconTone(name: string): "create" | "modify" | "inspect" | "data" | "danger" | "neutral" {
  if (["line", "rectangle", "circle", "arc", "extrude", "bore", "box", "cylinder", "insert", "bezier", "loft", "battery", "fuse", "breaker", "disconnect", "contactor", "inverter", "transformer", "motor", "sensor", "wire", "container", "vehicle", "scooter", "three-wheel", "wheel", "chassis"].includes(name)) return "create";
  if (["trim", "offset", "spline", "edge", "pattern", "revolve", "sweep", "shell", "boolean", "move", "ground", "explode", "flatten", "canopy", "stitch", "thicken"].includes(name)) return "modify";
  if (["measure", "fit", "home", "orbit", "pan", "projection", "grid", "axes", "interference", "section", "detail", "dimension", "constraint", "horizontal", "vertical", "parallel", "perpendicular", "collinear", "concentric", "equal", "tangent", "fixed", "auto-view", "tolerance", "datum", "gdt-position", "flatness", "hardpoint", "suspension", "steering", "brake", "cg"].includes(name)) return "inspect";
  if (["json", "open", "save", "import", "export", "download", "exchange", "cube-file", "scene-file", "mesh-file", "triangle-file", "points-file", "package-file", "pdf-package", "pdf-3d", "matrix", "link-file", "mcp", "python", "bom", "circuit-3d"].includes(name)) return "data";
  if (["trash", "cancel", "eye-off"].includes(name)) return "danger";
  return "neutral";
}

function geometry(name: string): React.ReactNode {
  switch (name) {
    case "select": return <><path d="m5 3 12 8-6 1.4-2.7 5.8z" /><path d="m11 12 4.8 6" /></>;
    case "line": return <><circle cx="5" cy="18" r="1.5" /><circle cx="19" cy="6" r="1.5" /><path d="M6.2 17 17.8 7" /></>;
    case "rectangle": return <rect x="4" y="6" width="16" height="12" rx="1.5" />;
    case "circle": return <circle cx="12" cy="12" r="7" />;
    case "arc": return <><path d="M5 17A10 10 0 0 1 19 7" /><circle cx="5" cy="17" r="1.2" /><circle cx="19" cy="7" r="1.2" /></>;
    case "cancel": return <><path d="M6 6l12 12M18 6 6 18" /><circle cx="12" cy="12" r="9" /></>;
    case "plane": case "grid": return <><path d="M4 7h16M4 12h16M4 17h16M7 4v16M12 4v16M17 4v16" /></>;
    case "dimension": return <><path d="M5 6v12M19 6v12M5 12h14" /><path d="m8 9-3 3 3 3m8-6 3 3-3 3" /></>;
    case "auto-view": return <><path d="M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4z" /><path d="m14 16 2-1 2 1-2 1zM14 16v2l2 1 2-1v-2M16 17v2" /></>;
    case "tolerance": return <><path d="M4 7h16M4 17h16M7 4v6M17 14v6" /><path d="M9 12h6m-3-3v6" /></>;
    case "datum": return <><path d="M12 4 7 11h10zM12 11v4" /><rect x="8" y="15" width="8" height="6" rx=".5" /><path d="M10 19h4" /></>;
    case "gdt-position": return <><circle cx="12" cy="12" r="6" /><path d="M3 12h18M12 3v18" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>;
    case "flatness": return <path d="M5 17h11l3-10H8z" />;
    case "constraint": return <><path d="M5 17 12 5l7 12z" /><circle cx="12" cy="12" r="2" /></>;
    case "horizontal": return <><path d="M4 12h16" /><path d="M5 8v8m14-8v8" /></>;
    case "vertical": return <><path d="M12 4v16" /><path d="M8 5h8M8 19h8" /></>;
    case "parallel": return <><path d="M5 9h14M5 15h14" /><path d="m8 6-3 3 3 3m8 0 3 3-3 3" /></>;
    case "perpendicular": return <><path d="M5 5v14h14" /><path d="M9 15v-4h4" /></>;
    case "collinear": return <><path d="M4 12h16" /><circle cx="7" cy="12" r="1.5" fill="currentColor" /><circle cx="17" cy="12" r="1.5" fill="currentColor" /></>;
    case "concentric": return <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r=".7" fill="currentColor" /></>;
    case "equal": return <><path d="M5 9h14M5 15h14" /></>;
    case "tangent": return <><circle cx="8" cy="12" r="5" /><circle cx="17" cy="12" r="4" /><circle cx="13" cy="12" r=".8" fill="currentColor" /></>;
    case "fixed": return <><path d="m12 4 4 5-4 3-4-3zM12 12v8" /><path d="M8 20h8" /></>;
    case "construction": return <><path d="M4 12h3m2 0h3m2 0h3m2 0h1" /><circle cx="4" cy="12" r="1" /><circle cx="20" cy="12" r="1" /></>;
    case "trim": return <><circle cx="8" cy="17" r="2.2" /><circle cx="16" cy="17" r="2.2" /><path d="m9.5 15.4 7-10.4M14.5 15.4 7.5 5" /></>;
    case "offset": return <><path d="M5 17 17 5" /><path d="M8 20 20 8" /><path d="m5 12-2 5 5-2" /></>;
    case "spline": return <><path d="M4 16c4-13 8 5 16-8" /><circle cx="4" cy="16" r="1.2" /><circle cx="20" cy="8" r="1.2" /></>;
    case "extrude": return <><path d="M5 10 12 6l7 4-7 4z" /><path d="M5 10v7l7 4 7-4v-7M12 14v7" /></>;
    case "bore": return <><ellipse cx="12" cy="8" rx="7" ry="3.5" /><path d="M5 8v8c0 2 3.1 3.5 7 3.5s7-1.5 7-3.5V8" /><ellipse cx="12" cy="8" rx="2.5" ry="1.3" /></>;
    case "edge": return <><path d="m5 16 7 4 7-4V8l-7-4-7 4z" /><path d="m5 8 7 4 7-4M12 12v8" /><path d="M5 16c2-1 3-2.2 3-4.2" /></>;
    case "pattern": return <><rect x="4" y="4" width="5" height="5" rx="1" /><rect x="15" y="4" width="5" height="5" rx="1" /><rect x="4" y="15" width="5" height="5" rx="1" /><rect x="15" y="15" width="5" height="5" rx="1" /></>;
    case "revolve": return <><path d="M8 6c-5 2-5 10 0 12M16 6c5 2 5 10 0 12" /><path d="m6 4 2 2-3 1m13-3-2 2 3 1" /><path d="M12 4v16" /></>;
    case "sweep": return <><path d="M5 17c1-9 7-12 14-10" /><path d="m16 4 3 3-4 2" /><rect x="3.5" y="15.5" width="4" height="4" rx="1" /></>;
    case "loft": return <><ellipse cx="12" cy="6" rx="6" ry="2.5" /><ellipse cx="12" cy="18" rx="3.5" ry="1.7" /><path d="M6 6 8.5 18M18 6l-2.5 12" /></>;
    case "shell": return <><path d="m4 8 8-4 8 4v9l-8 4-8-4z" /><path d="m8 10 4-2 4 2v5l-4 2-4-2z" /></>;
    case "boolean": return <><circle cx="9" cy="12" r="6" /><circle cx="15" cy="12" r="6" /><path d="M12 7.1a6 6 0 0 1 0 9.8" /></>;
    case "fit": return <><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></>;
    case "home": return <><path d="m4 11 8-7 8 7" /><path d="M6 10v10h12V10M10 20v-6h4v6" /></>;
    case "orbit": return <><circle cx="12" cy="12" r="4" /><path d="M4 10c1-6 10-8 15-4l1 1M20 14c-1 6-10 8-15 4l-1-1" /><path d="m17 7 3 0 0-3M7 17H4v3" /></>;
    case "pan": return <><path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7l2-2c2-2 4 1.2 2 3.2L17 20H9l-5-6c-1.4-1.8 1-3.8 2.5-2.3z" /></>;
    case "measure": return <><path d="m5 17 12-12 3 3L8 20z" /><path d="m9 15 2 2m1-5 2 2m1-5 2 2" /></>;
    case "projection": return <><path d="m4 8 8-4 8 4-8 4zM4 8v8l8 4 8-4V8M12 12v8" /><path d="M2 4h3M19 20h3" /></>;
    case "axes": return <><path d="M6 18 18 6M6 18h12M6 18V6" /><path d="m18 6-4 1 3 3M18 18l-3-2v4M6 6 4 9h4" /></>;
    case "json": return <><path d="M9 4H6v6l-2 2 2 2v6h3M15 4h3v6l2 2-2 2v6h-3" /><circle cx="12" cy="9" r=".7" fill="currentColor" stroke="none" /><circle cx="12" cy="15" r=".7" fill="currentColor" stroke="none" /></>;
    case "open": return <><path d="M4 7h6l2 2h8v10H4z" /><path d="m11 15 4-4m0 0h-3m3 0v3" /></>;
    case "save": return <><path d="M5 4h12l2 2v14H5z" /><path d="M8 4v6h8V4M8 20v-6h8v6" /></>;
    case "import": return <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 17v3h14v-3" /><path d="M4 6h4" /></>;
    case "export": case "download": return <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 17v3h14v-3" /></>;
    case "exchange": return <><path d="M5 7h13m-3-3 3 3-3 3M19 17H6m3 3-3-3 3-3" /><path d="M4 4v6m16 4v6" /></>;
    case "cube-file": return <><path d="M7 4h8l4 4v12H7zM15 4v5h4" /><path d="m10 13 3-1.6 3 1.6-3 1.6zM10 13v3l3 1.6 3-1.6v-3M13 14.6v3" /></>;
    case "scene-file": return <><path d="M6 4h9l3 3v13H6zM15 4v4h3" /><circle cx="11" cy="12" r="2" /><path d="m13 12 3-2m-3 4 3 2" /></>;
    case "mesh-file": return <><path d="M6 4h9l3 3v13H6zM15 4v4h3" /><path d="m9 16 3-6 3 6zM9 16h6" /></>;
    case "triangle-file": return <><path d="M6 4h9l3 3v13H6zM15 4v4h3" /><path d="m9 17 3-7 3 7z" /></>;
    case "points-file": return <><path d="M6 4h9l3 3v13H6zM15 4v4h3" /><circle cx="10" cy="12" r=".8" fill="currentColor" /><circle cx="14" cy="11" r=".8" fill="currentColor" /><circle cx="12" cy="16" r=".8" fill="currentColor" /><circle cx="15" cy="15" r=".8" fill="currentColor" /></>;
    case "package-file": return <><path d="M6 4h9l3 3v13H6zM15 4v4h3" /><path d="m9 12 3-1.5 3 1.5-3 1.5zM9 12v3l3 1.5 3-1.5v-3" /></>;
    case "link-file": return <><path d="M6 4h9l3 3v13H6zM15 4v4h3" /><path d="m10 15-1 1a2 2 0 0 0 3 3l1-1m1-5 1-1a2 2 0 0 1 3 3l-1 1m-6 0 5-3" /></>;
    case "pdf-package": return <><path d="M6 3h9l4 4v14H6zM15 3v5h4" /><path d="M9 12h3a2 2 0 0 1 0 4H9v-4m0 0v7M15 12v7m0-7h2" /></>;
    case "pdf-3d": return <><path d="M5 3h10l4 4v14H5zM15 3v5h4" /><path d="m8 13 4-2 4 2-4 2zM8 13v4l4 2 4-2v-4M12 15v4" /></>;
    case "matrix": return <><path d="M5 5h14v14H5zM5 10h14M5 15h14M10 5v14M15 5v14" /></>;
    case "scan": return <><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /><path d="m8 11 4-2 4 2-4 2zM8 11v4l4 2 4-2v-4" /></>;
    case "cube-check": return <><path d="m4 8 8-4 8 4-8 4zM4 8v8l8 4 8-4V8M12 12v8" /><path d="m14 15 1.5 1.5L19 13" /></>;
    case "arrow-right": return <><path d="M4 12h16m-5-5 5 5-5 5" /></>;
    case "layers": return <><path d="m4 8 8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4" /></>;
    case "shield": return <><path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6z" /><path d="m9 12 2 2 4-5" /></>;
    case "kernel": return <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M18.4 5.6l-2.1 2.1m-8.6 8.6-2.1 2.1" /></>;
    case "return": return <><path d="m9 7-5 5 5 5" /><path d="M5 12h9c3 0 5 2 5 5" /></>;
    case "units-mm": return <><path d="M4 17V7l4 6 4-6v10M15 17V9l2.5 4L20 9v8" /></>;
    case "units-in": return <><path d="M6 6h12v12H6zM10 6v3m4-3v2m4 2h-3m3 4h-2m-6 4v-3m4 3v-2M6 10h3m-3 4h2" /></>;
    case "box": case "part": return <><path d="m4 8 8-4 8 4-8 4zM4 8v8l8 4 8-4V8M12 12v8" /></>;
    case "cylinder": return <><ellipse cx="12" cy="6" rx="6" ry="3" /><path d="M6 6v12c0 1.7 2.7 3 6 3s6-1.3 6-3V6" /><path d="M6 18c0 1.7 2.7 3 6 3s6-1.3 6-3" /></>;
    case "assemble": case "mate": return <><path d="M4 8h7v8H4zM13 8h7v8h-7z" /><path d="M9 12h6m-2-2 2 2-2 2" /></>;
    case "explode": return <><path d="m8 9 4-2 4 2-4 2zM8 15l4-2 4 2-4 2z" /><path d="M4 12H1m3 0-2-2m2 2-2 2M20 12h3m-3 0 2-2m-2 2 2 2" /></>;
    case "move": return <><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3m0 12-3 3-3-3M6 9l-3 3 3 3m12 0 3-3-3-3" /></>;
    case "ground": return <><path d="M12 4v8M8 8l4 4 4-4M5 15h14M7 18h10M10 21h4" /></>;
    case "eye": return <><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6" /><circle cx="12" cy="12" r="2.5" /></>;
    case "eye-off": return <><path d="M4 4l16 16M3 12s3.5-6 9-6c2 0 3.7.8 5.1 1.8M21 12s-3.5 6-9 6c-2 0-3.7-.8-5.1-1.8" /></>;
    case "trash": return <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7m4-7v7" /></>;
    case "interference": return <><rect x="4" y="6" width="10" height="10" rx="1" /><rect x="10" y="9" width="10" height="10" rx="1" /><path d="M10 9h4v7h-4z" /></>;
    case "joint": return <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="12" r="3" /><path d="M10 12h4" /></>;
    case "motion": return <><path d="M4 15c4 0 4-6 8-6s4 6 8 6" /><path d="m17 12 3 3-3 3" /></>;
    case "bezier": case "surface": return <><path d="M4 17C7 4 17 4 20 17" /><path d="M5 8h14M5 8v9M19 8v9" /><circle cx="5" cy="8" r="1" fill="currentColor" /><circle cx="19" cy="8" r="1" fill="currentColor" /></>;
    case "flatten": return <><path d="M4 15h16M5 10c4-3 10-3 14 0" /><path d="m12 5 0 5m-2-2 2 2 2-2" /></>;
    case "canopy": return <><path d="M4 17c3-10 13-10 16 0M4 17h16" /><path d="M8 17c1-5 7-5 8 0" /></>;
    case "stitch": return <><path d="M5 5v14M19 5v14" /><path d="m5 8 4 2-4 2 4 2-4 2m14-8-4 2 4 2-4 2 4 2" /></>;
    case "thicken": return <><path d="m4 9 8-4 8 4-8 4zM4 14l8 4 8-4" /><path d="M4 9v5m16-5v5" /></>;
    case "sheet": case "drawing": return <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h4M9 12h7M9 16h7" /></>;
    case "scale": return <><path d="M5 17 17 5l2 2L7 19z" /><path d="m9 15 2 2m1-5 2 2m1-5 2 2" /></>;
    case "section": return <><path d="m4 8 8-4 8 4-8 4zM4 8v8l8 4 8-4V8" /><path d="M12 4v16M8 6l4 2m0 4 4 2m-8 2 4 2" /></>;
    case "detail": return <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5M7 10h6M10 7v6" /></>;
    case "bom": return <><path d="M5 5h14v14H5zM5 10h14M9 5v14M13 5v14" /></>;
    case "electrical": return <><path d="M5 5h14v14H5zM5 12h4l2-4 3 8 2-4h3" /><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>;
    case "wire": return <><circle cx="5" cy="17" r="1.6" /><circle cx="19" cy="7" r="1.6" /><path d="M6.5 17h5V7h6" /></>;
    case "circuit-3d": return <><path d="M3 6h7v6H3zM5 9h3M14 8l4-2 3 2-4 2zM14 8v7l3 2 4-2V8M17 10v7" /><path d="M10 9h3v4h2" /><circle cx="15" cy="13" r="1" fill="currentColor" /></>;
    case "battery": return <><path d="M8 5v14M14 8v8M3 12h5M14 12h7" /><path d="M5 7h3M6.5 5.5v3M14 6h3" /></>;
    case "fuse": return <><path d="M3 12h4m10 0h4" /><rect x="7" y="8" width="10" height="8" rx="1.5" /><path d="m9 14 6-4" /></>;
    case "disconnect": return <><circle cx="7" cy="15" r="1.6" /><circle cx="17" cy="15" r="1.6" /><path d="M3 15h2m14 0h2M8.5 14l7-7" /></>;
    case "breaker": return <><path d="M3 12h4m10 0h4" /><rect x="7" y="6" width="10" height="12" rx="1.5" /><path d="m9 15 6-6M9 9v6h6" /></>;
    case "contactor": return <><path d="M3 9h5m8 0h5M8 9l7-5" /><rect x="8" y="14" width="8" height="5" rx="2.5" /><path d="M12 14v-2" /></>;
    case "inverter": return <><rect x="4" y="5" width="16" height="14" rx="2" /><text x="6" y="11" fontSize="5" fill="currentColor" stroke="none">DC</text><path d="M7 15h3m2 0c2-3 4 3 6 0" /></>;
    case "transformer": return <><path d="M3 12h3m12 0h3M11 5v14M13 5v14" /><path d="M9 7c-5 2-5 4 0 6-5 2-5 4 0 6M15 7c5 2 5 4 0 6 5 2 5 4 0 6" /></>;
    case "motor": return <><circle cx="12" cy="12" r="7" /><path d="M3 12h2M19 12h2" /><text x="9" y="15" fontSize="8" fill="currentColor" stroke="none">M</text></>;
    case "sensor": return <><path d="M12 4 20 12 12 20 4 12z" /><circle cx="12" cy="12" r="2.5" /></>;
    case "container": return <><rect x="3" y="6" width="18" height="12" rx="1" /><path d="M6 6v12m12-12v12M8 9h8M8 12h8M8 15h8" /></>;
    case "vehicle": return <><circle cx="7" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><path d="m7 17 4-8h4l3 8M9 13h7M11 9 9 6h4" /></>;
    case "scooter": return <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 18h7l3-9h3M16 9l-2-4h4M9 14h5" /></>;
    case "three-wheel": return <><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><circle cx="12" cy="7" r="2.5" /><path d="m7.5 15 3-6m3 0 3 6M8.5 17h7" /></>;
    case "wheel": return <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 4v5m0 6v5M4 12h5m6 0h5m-2.3-5.7-3.5 3.5m-4.4 4.4-3.5 3.5m11.4 0-3.5-3.5M9.8 9.8 6.3 6.3" /></>;
    case "chassis": return <><path d="M4 17h16M6 17l3-8h7l3 8M9 9l3-4 4 4M8 13h9" /><circle cx="7" cy="17" r="1.5" /><circle cx="18" cy="17" r="1.5" /></>;
    case "suspension": return <><path d="M7 3v4m0 10v4M17 3v4m0 10v4M4 7h6l-6 3 6 3-6 4h6M14 7h6l-6 3 6 3-6 4h6" /></>;
    case "steering": return <><circle cx="12" cy="8" r="5" /><path d="M7 8h10M12 8v11M9 19h6M12 13l-4-3m4 3 4-3" /></>;
    case "brake": return <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 4v5m0 6v5M4 12h5m6 0h5" /><path d="M16 6h4v6h-4" /></>;
    case "hardpoint": return <><path d="M4 12h16M12 4v16" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>;
    case "cg": return <><circle cx="12" cy="12" r="8" /><path d="M12 4v16M4 12h16" /><path d="M12 12 7 7a7 7 0 0 1 5-3zM12 12l5 5a7 7 0 0 1-5 3z" fill="currentColor" stroke="none" /></>;
    case "arrow-up": return <><path d="M12 20V4m-6 6 6-6 6 6" /></>;
    case "arrow-down": return <><path d="M12 4v16m-6-6 6 6 6-6" /></>;
    case "mcp": return <><circle cx="12" cy="12" r="3" /><circle cx="5" cy="7" r="2" /><circle cx="19" cy="7" r="2" /><circle cx="12" cy="20" r="2" /><path d="m7 8 3 2m7-2-3 2m-2 5v3" /></>;
    case "python": return <><path d="M8 4h5v4H7c-2 0-3 1-3 3v3h4" /><path d="M16 20h-5v-4h6c2 0 3-1 3-3v-3h-4" /><circle cx="10.5" cy="6" r=".6" fill="currentColor" /><circle cx="13.5" cy="18" r=".6" fill="currentColor" /></>;
    case "undo": return <><path d="m8 7-4 4 4 4" /><path d="M5 11h8c4 0 6 2 6 6" /></>;
    case "redo": return <><path d="m16 7 4 4-4 4" /><path d="M19 11h-8c-4 0-6 2-6 6" /></>;
    case "insert": return <><circle cx="12" cy="12" r="8" /><path d="M12 8v8M8 12h8" /></>;
    case "inspect": return <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>;
    case "command": return <><path d="M8 5h11M8 12h11M8 19h11" /><circle cx="4" cy="5" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="19" r="1" fill="currentColor" /></>;
    case "sketch": return <><path d="M5 18 17 6l2 2L7 20H5z" /><path d="m14 7 3 3M5 18l3 1" /></>;
    case "assembly": return <><path d="m3 8 6-3 6 3-6 3zM3 8v7l6 3 6-3V8M9 11v7" /><path d="m15 11 3-1.5 3 1.5-3 1.5zM15 11v5l3 1.5 3-1.5v-5" /></>;
    case "automate": return <><path d="M6 5h12v14H6z" /><path d="m9 9 2 2-2 2m4 0h2" /></>;
    case "file": return <><path d="M6 3h9l4 4v14H6zM15 3v5h4" /></>;
    case "view": return <><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6" /><circle cx="12" cy="12" r="2.5" /></>;
    case "help": return <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.7 2.7 0 1 1 4.2 2.3c-1.3.8-1.7 1.3-1.7 2.7M12 18h.01" /></>;
    default: return <><path d="M5 5h14v14H5z" /><path d="M8 12h8M12 8v8" /></>;
  }
}
