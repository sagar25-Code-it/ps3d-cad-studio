import type { LearningManual, LearningModule } from "./learning-content.js";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

export function buildLearningManualPdf(manual: LearningManual): Blob {
  const pages = [coverPage(manual), pathwayPage(manual), ...manual.modules.map((item) => modulePage(item)), finalPage(manual)];
  const objects: Uint8Array[] = [
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
    ascii(`<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`)
  ];
  for (let index = 0; index < pages.length; index += 1) {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const stream = ascii(pages[index]!);
    objects.push(ascii(`<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 1 0 R /F2 2 0 R >> >> /Contents ${contentId} 0 R >>`));
    objects.push(concat(ascii(`<< /Length ${stream.length} >>\nstream\n`), stream, ascii("\nendstream")));
  }
  const catalogId = objects.length + 1;
  const infoId = objects.length + 2;
  objects.push(ascii("<< /Type /Catalog /Pages 3 0 R /PageLayout /OneColumn >>"));
  objects.push(ascii(`<< /Title (${pdfText(manual.title)}) /Author (${pdfText(manual.owner)}) /Subject (PS3D CAD learning, safe practice, and MCP connection manual) /Creator (PS3D Studio) >>`));
  return new Blob([assemblePdf(objects, catalogId, infoId)], { type: "application/pdf" });
}

function coverPage(manual: LearningManual): string {
  const out: string[] = [background(), rect(0, 604, PAGE_WIDTH, 238, "0.04 0.11 0.18"), rect(48, 748, 76, 8, "0.10 0.85 0.72")];
  out.push(text(48, 712, 11, "F2", "PS3D STUDIO / PUBLIC LEARNING SERIES", "0.35 0.93 0.82"));
  for (const [index, line] of wrap(manual.title, 29).entries()) out.push(text(48, 665 - index * 34, 28, "F2", line, "0.96 0.98 1"));
  out.push(text(48, 554, 13, "F1", manual.edition, "0.08 0.20 0.29"));
  out.push(rect(48, 488, 499, 2, "0.12 0.70 0.61"));
  let y = 446;
  for (const line of wrap(manual.introduction, 78)) { out.push(text(48, y, 11, "F1", line, "0.16 0.24 0.31")); y -= 17; }
  out.push(rect(48, 184, 499, 142, "0.93 0.96 0.97"));
  out.push(text(68, 290, 11, "F2", "READ THIS BEFORE ENGINEERING USE", "0.75 0.22 0.17"));
  const warning = "PS3D is a bounded public preview. Qualified, preview, and unavailable capabilities are labeled separately. Nothing in this manual is manufacturing release, certification, roadworthiness, homologation, or professional engineering approval.";
  y = 260;
  for (const line of wrap(warning, 70)) { out.push(text(68, y, 10, "F1", line, "0.20 0.25 0.29")); y -= 16; }
  out.push(text(48, 82, 9, "F1", `Copyright 2026 ${manual.owner}. Source distributed under the MIT License.`, "0.33 0.39 0.44"));
  out.push(text(48, 58, 9, "F1", "Manual generated from the same source content as the PS3D Learning Center.", "0.33 0.39 0.44"));
  return out.join("\n");
}

function pathwayPage(manual: LearningManual): string {
  const out = pageFrame("LEARNING PATHWAYS", "Choose a route, then complete every verification gate for the modules you use.", 2, manual.modules.length + 3);
  const paths = [
    ["BEGINNER", "First session", "01 Orientation -> 02 Navigation", "Learn the interface, local project safety, and spatial controls."],
    ["STUDENT", "Design intent", "03 Sketch -> 04 Part", "Build constrained intent and a bounded qualified solid revision."],
    ["PROFESSIONAL", "Multidisciplinary review", "05 Assembly -> 10 Exchange", "Review assemblies, surfaces, drawings, electrical realization, and controlled exchange."],
    ["ADVANCED", "Research and automation", "09 Vehicle -> 11 MCP -> 12 Release", "Use deterministic studies, secure AI collaboration, and evidence-led release gates."]
  ] as const;
  let y = 654;
  for (const [label, titleValue, route, description] of paths) {
    out.push(rect(48, y - 104, 499, 112, "0.94 0.97 0.98"));
    out.push(rect(48, y - 104, 8, 112, label === "ADVANCED" ? "0.55 0.25 0.82" : label === "PROFESSIONAL" ? "0.03 0.54 0.72" : "0.08 0.70 0.60"));
    out.push(text(72, y - 18, 9, "F2", label, "0.09 0.53 0.47"));
    out.push(text(72, y - 40, 16, "F2", titleValue, "0.07 0.14 0.20"));
    out.push(text(72, y - 61, 9, "F2", route, "0.20 0.35 0.44"));
    out.push(text(72, y - 82, 9, "F1", description, "0.25 0.31 0.35"));
    y -= 132;
  }
  out.push(text(48, 108, 10, "F2", "Recommended discipline", "0.07 0.14 0.20"));
  for (const [index, line] of wrap("Save a project copy before destructive template replacement. Change one engineering input at a time. Read diagnostics and Design Health after every major revision. Never convert a preview label into a qualification claim.", 82).entries()) out.push(text(48, 88 - index * 15, 9, "F1", line, "0.25 0.31 0.35"));
  return out.join("\n");
}

function modulePage(item: LearningModule): string {
  const moduleTitle = `${item.number} / ${item.title.toUpperCase()}`;
  const out = pageFrame(moduleTitle, `${item.level} - ${item.workspace}`, Number(item.number) + 2, 15);
  // Leave a deliberate gutter below the shared page subtitle. Module summaries
  // may wrap to two lines, so starting at the subtitle baseline caused visual
  // collisions in rendered PDFs even though the PDF structure was valid.
  let y = wrap(moduleTitle, 42).length > 1 ? 635 : 660;
  for (const line of wrap(item.summary, 80)) { out.push(text(48, y, 11, "F1", line, "0.15 0.24 0.30")); y -= 17; }
  y -= 18;
  y = listSection(out, y, "LEARNING OUTCOMES", item.outcomes, "0.08 0.70 0.60");
  y -= 8;
  y = listSection(out, y, "GUIDED PRACTICE", item.practice, "0.03 0.54 0.72");
  y -= 8;
  y = listSection(out, y, "VERIFICATION GATE", item.verification, "0.55 0.25 0.82");
  y -= 8;
  const boundaryLines = wrap(item.boundary, 72);
  const boundaryHeight = 40 + boundaryLines.length * 15;
  out.push(rect(48, y - boundaryHeight, 499, boundaryHeight, "0.99 0.94 0.91"));
  out.push(text(66, y - 21, 9, "F2", "PROFESSIONAL BOUNDARY", "0.72 0.22 0.16"));
  boundaryLines.forEach((line, index) => out.push(text(66, y - 41 - index * 15, 9, "F1", line, "0.30 0.25 0.23")));
  return out.join("\n");
}

function finalPage(manual: LearningManual): string {
  const out = pageFrame("PUBLIC RELEASE CHECKLIST", "A live URL is the start of operations, not the end of security work.", 15, 15);
  const checks = [
    "Clean CI: typecheck, deterministic tests, MCP checks, repository boundary, dependency inventory, SBOM, build and source identity.",
    "Cloud identity: verified-email sign-up, password recovery, tenant-isolated token list, 7/30/90-day expiry, revocation, and five-token cap.",
    "Remote MCP: HTTPS, OAuth protected-resource metadata, bearer validation, strict Origin handling, 1 MB payload cap, allowlisted methods, and rate limiting.",
    "Secrets: no .env file, password, raw token, database secret, deployment token, private key, or private system path in GitHub or built assets.",
    "Public repository: MIT notice, third-party notices, security policy, private vulnerability reporting, dependency updates, and protected release checks.",
    "Live review: desktop and small-screen UI, keyboard focus, error states, manual PDF rendering, token create/revoke, initialize, tools/list, and one read-only tool call.",
    "Operations: owner-controlled backups, patching, abuse monitoring, incident response, disclosure handling, and an explicit human release decision."
  ];
  let y = 670;
  for (const [index, item] of checks.entries()) {
    out.push(rect(48, y - 52, 499, 62, index % 2 === 0 ? "0.94 0.97 0.98" : "0.97 0.98 0.99"));
    out.push(text(66, y - 17, 12, "F2", String(index + 1).padStart(2, "0"), "0.08 0.70 0.60"));
    const lines = wrap(item, 72);
    lines.slice(0, 3).forEach((line, lineIndex) => out.push(text(102, y - 12 - lineIndex * 14, 8.5, lineIndex === 0 ? "F2" : "F1", line, "0.16 0.23 0.28")));
    y -= 72;
  }
  out.push(rect(48, 104, 499, 74, "0.04 0.11 0.18"));
  out.push(text(68, 150, 11, "F2", "FINAL RULE", "0.35 0.93 0.82"));
  out.push(text(68, 126, 10, "F1", "If evidence is missing, keep the result labeled Preview and stop the release.", "0.96 0.98 1"));
  out.push(text(48, 70, 9, "F1", `${manual.edition} - ${manual.owner}`, "0.33 0.39 0.44"));
  return out.join("\n");
}

function pageFrame(titleValue: string, subtitle: string, page: number, total: number): string[] {
  const titleLines = wrap(titleValue, 42);
  const titleSize = titleLines.length > 1 ? 16.5 : 21;
  const subtitleY = titleLines.length > 1 ? 670 : 694;
  const out = [background(), rect(0, 782, PAGE_WIDTH, 60, "0.04 0.11 0.18"), rect(48, 754, 84, 5, "0.10 0.85 0.72"), text(48, 802, 9, "F2", "PS3D STUDIO / LEARNING MANUAL", "0.35 0.93 0.82")];
  titleLines.forEach((line, index) => out.push(text(48, 716 - index * 20, titleSize, "F2", line, "0.06 0.14 0.20")));
  out.push(text(48, subtitleY, 9, "F1", subtitle, "0.32 0.39 0.43"), text(48, 34, 8, "F1", "PS3D public preview - verify truth labels before engineering use", "0.42 0.47 0.50"), text(520, 34, 8, "F2", `${page}/${total}`, "0.12 0.32 0.39"));
  return out;
}

function listSection(out: string[], y: number, heading: string, items: readonly string[], color: string): number {
  out.push(text(48, y, 9, "F2", heading, color));
  y -= 20;
  for (const item of items) {
    const lines = wrap(item, 76);
    out.push(rect(50, y - 2, 5, 5, color));
    lines.forEach((line, index) => out.push(text(66, y - index * 14, 8.7, "F1", line, "0.20 0.27 0.31")));
    y -= lines.length * 14 + 9;
  }
  return y;
}

function background(): string { return rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, "0.985 0.99 0.992"); }
function rect(x: number, y: number, width: number, height: number, color: string): string { return `${color} rg ${x} ${y} ${width} ${height} re f`; }
function text(x: number, y: number, size: number, font: "F1" | "F2", value: string, color: string): string { return `BT ${color} rg /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET`; }

function wrap(value: string, maxCharacters: number): readonly string[] {
  const words = asciiOnly(value).split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length <= maxCharacters) line = candidate;
    else { if (line.length > 0) lines.push(line); line = word.length <= maxCharacters ? word : word.slice(0, maxCharacters); }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function pdfText(value: string): string { return asciiOnly(value).replace(/([\\()])/gu, "\\$1"); }
function asciiOnly(value: string): string { return value.normalize("NFKD").replace(/[^\x20-\x7e]/gu, "-"); }
function ascii(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...chunks: readonly Uint8Array[]): Uint8Array { const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }

function assemblePdf(objects: readonly Uint8Array[], rootObject: number, infoObject: number): Uint8Array {
  const chunks: Uint8Array[] = [concat(ascii("%PDF-1.7\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n"))];
  const offsets: number[] = [0];
  let length = chunks[0]!.length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length);
    const object = concat(ascii(`${index + 1} 0 obj\n`), objects[index]!, ascii("\nendobj\n"));
    chunks.push(object);
    length += object.length;
  }
  const xrefOffset = length;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (let index = 1; index <= objects.length; index += 1) xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n `);
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root ${rootObject} 0 R /Info ${infoObject} 0 R >>`, `startxref\n${xrefOffset}`, "%%EOF");
  chunks.push(ascii(`${xref.join("\n")}\n`));
  return concat(...chunks);
}
