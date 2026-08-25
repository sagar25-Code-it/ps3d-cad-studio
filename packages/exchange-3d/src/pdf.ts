import type { Interactive3dPdfInput, PdfModelPackageInput } from "./types.js";

const encoder = new TextEncoder();

export function buildPdfModelPackage(input: PdfModelPackageInput): Blob {
  const date = input.generatedAt ?? new Date();
  const image = streamObject(`/Type /XObject /Subtype /Image /Width ${input.preview.width} /Height ${input.preview.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, input.preview.bytes);
  const embedded = streamObject(`/Type /EmbeddedFile /Subtype /model#2Fgltf-binary /Params << /Size ${input.glbBytes.length} /ModDate (${pdfDate(date)}) >>`, input.glbBytes);
  const content = pageContent(input);
  const objects: readonly Uint8Array[] = [
    ascii("<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(ps3d-model.glb) 9 0 R] >> >> /AF [9 0 R] >>"),
    ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 6 0 R >>"),
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
    streamObject("", ascii(content)),
    image,
    embedded,
    ascii(`<< /Type /Filespec /F (ps3d-model.glb) /UF (ps3d-model.glb) /EF << /F 8 0 R /UF 8 0 R >> /AFRelationship /Data /Desc (${pdfString("Embedded GLB runtime model")}) >>`),
    ascii(`<< /Title (${pdfString(input.title)}) /Subject (${pdfString("PS3D PDF model package with attached GLB")}) /Creator (PS3D CAD Studio / PS3D Master) /Producer (PS3D original browser PDF writer) /CreationDate (${pdfDate(date)}) >>`)
  ];
  return new Blob([copyToArrayBuffer(assemblePdf(objects, 1, 10))], { type: "application/pdf" });
}

export function buildInteractive3dPdf(input: Interactive3dPdfInput): Blob {
  const date = input.generatedAt ?? new Date();
  const content = interactivePageContent(input);
  const model = streamObject(`/Type /3D /Subtype /${input.subtype}`, input.payloadBytes);
  const objects: readonly Uint8Array[] = [
    ascii("<< /Type /Catalog /Pages 2 0 R >>"),
    ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>"),
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
    streamObject("", ascii(content)),
    model,
    ascii(`<< /Type /Annot /Subtype /3D /Rect [35 118 807 500] /3DD 7 0 R /3DA << /A /PO /DIS /I >> /Border [0 0 1] /Contents (${pdfString(`Embedded ${input.subtype} 3D annotation`)}) >>`),
    ascii(`<< /Title (${pdfString(input.title)}) /Subject (${pdfString(`Interactive ${input.subtype} 3D PDF pass-through`)}) /Creator (PS3D CAD Studio / PS3D Master) /Producer (PS3D original browser PDF writer) /CreationDate (${pdfDate(date)}) >>`)
  ];
  return new Blob([copyToArrayBuffer(assemblePdf(objects, 1, 9))], { type: "application/pdf" });
}

function pageContent(input: PdfModelPackageInput): string {
  const m = input.metrics;
  const size = m.bounds.sizeMeters.map((value) => `${(value * 1000).toFixed(2)} mm`).join(" x ");
  return [
    "q 0.027 0.055 0.098 rg 0 0 842 595 re f Q",
    "q 0.059 0.133 0.204 rg 0 522 842 73 re f Q",
    "q 0.255 0.839 0.918 rg 0 519 842 3 re f Q",
    textOp(34, 558, 22, "F2", "PS3D MODEL PACKAGE"),
    textOp(34, 535, 10, "F1", input.title),
    textOp(620, 557, 9, "F2", "LOCAL EXCHANGE"),
    textOp(620, 539, 8, "F1", "GLB attachment + audited report"),
    "q 0.039 0.094 0.153 rg 34 151 522 344 re f Q",
    "q 0.145 0.243 0.329 RG 34 151 522 344 re S Q",
    "q 488 0 0 274 51 185 cm /Im1 Do Q",
    textOp(578, 477, 8, "F2", "MODEL AUDIT"),
    metricCard(578, 424, "SOURCE", input.sourceLabel),
    metricCard(578, 363, "TRIANGLES", m.triangleCount.toLocaleString("en-US")),
    metricCard(578, 302, "VERTICES", m.vertexCount.toLocaleString("en-US")),
    metricCard(578, 241, "OBJECTS / MESHES", `${m.objectCount} / ${m.meshCount}`),
    metricCard(578, 180, "BOUNDS", size),
    "q 0.071 0.157 0.188 rg 34 73 773 55 re f Q",
    "q 0.255 0.839 0.918 RG 34 73 4 55 re f Q",
    textOp(52, 106, 9, "F2", "3D ASSET ATTACHED: ps3d-model.glb"),
    textOp(52, 88, 8, "F1", "Open the attachment in PS3D or another glTF viewer. This page is not a U3D/PRC interactive annotation."),
    textOp(34, 35, 7, "F1", `Generated ${dateLabel(input.generatedAt ?? new Date())} - local browser export - no upload`),
    textOp(625, 35, 7, "F1", "PS3D ORIGINAL / MIT PROJECT")
  ].join("\n");
}

function interactivePageContent(input: Interactive3dPdfInput): string {
  return [
    "q 0.027 0.055 0.098 rg 0 0 842 595 re f Q",
    "q 0.059 0.133 0.204 rg 0 522 842 73 re f Q",
    "q 0.965 0.716 0.365 rg 0 519 842 3 re f Q",
    textOp(34, 558, 21, "F2", "PS3D INTERACTIVE 3D PDF"),
    textOp(34, 535, 10, "F1", input.title),
    "q 0.039 0.094 0.153 rg 35 118 772 382 re f Q",
    "q 0.965 0.716 0.365 RG 35 118 772 382 re S Q",
    textOp(265, 323, 18, "F2", `${input.subtype} 3D ANNOTATION`),
    textOp(239, 292, 10, "F1", "Select this area in a compatible PDF viewer to activate 3D."),
    textOp(214, 268, 9, "F1", "Viewer security settings may require explicit trust before content is enabled."),
    "q 0.157 0.118 0.063 rg 35 63 772 38 re f Q",
    textOp(51, 78, 8, "F2", `PASS-THROUGH PAYLOAD: ${input.payloadName} - PS3D did not re-encode this model.`),
    textOp(35, 35, 7, "F1", `Generated ${dateLabel(input.generatedAt ?? new Date())} - interactive playback depends on viewer support`)
  ].join("\n");
}

function metricCard(x: number, y: number, label: string, value: string): string {
  const compact = value.length > 34 ? `${value.slice(0, 31)}...` : value;
  return [
    `q 0.039 0.094 0.153 rg ${x} ${y} 229 48 re f Q`,
    `q 0.145 0.243 0.329 RG ${x} ${y} 229 48 re S Q`,
    textOp(x + 13, y + 31, 7, "F1", label),
    textOp(x + 13, y + 13, 10, "F2", compact)
  ].join("\n");
}

function textOp(x: number, y: number, size: number, font: "F1" | "F2", value: string): string {
  return `BT /${font} ${size} Tf 0.88 0.94 0.98 rg ${x} ${y} Td (${pdfString(value)}) Tj ET`;
}

function assemblePdf(objects: readonly Uint8Array[], rootObject: number, infoObject: number): Uint8Array {
  const chunks: Uint8Array[] = [concat(ascii("%PDF-1.7\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n"))];
  const offsets = [0];
  let length = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = concat(ascii(`${index + 1} 0 obj\n`), body, ascii("\nendobj\n"));
    chunks.push(object);
    length += object.length;
  });
  const xrefOffset = length;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (let index = 1; index <= objects.length; index += 1) xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n `);
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root ${rootObject} 0 R /Info ${infoObject} 0 R >>`, `startxref\n${xrefOffset}`, "%%EOF");
  chunks.push(ascii(`${xref.join("\n")}\n`));
  return concat(...chunks);
}

function streamObject(dictionary: string, bytes: Uint8Array): Uint8Array {
  return concat(ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, ascii("\nendstream"));
}

function ascii(value: string): Uint8Array {
  return encoder.encode(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function pdfString(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
}

function pdfDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function dateLabel(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
