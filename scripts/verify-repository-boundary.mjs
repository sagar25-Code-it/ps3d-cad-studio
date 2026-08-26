import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const excludedDirectories = new Set([".git", ".vercel", "node_modules", ".pnpm-store", "dist", ".test-dist", ".mcp-dist"]);
const reviewedImageExtensions = new Set([".jpg", ".jpeg", ".png"]);
const reviewedBinaryFiles = new Map([
  ["apps/studio-web/public/ps3d-master-logo.png", "png"],
  ["artifacts/screenshots/01-part-workspace.jpg", "jpeg"],
  ["artifacts/screenshots/02-sketch-workspace.jpg", "jpeg"],
  ["artifacts/screenshots/03-assembly-workspace.jpg", "jpeg"],
  ["artifacts/screenshots/04-surface-workspace.jpg", "jpeg"],
  ["artifacts/screenshots/05-drawing-workspace.jpg", "jpeg"],
  ["artifacts/screenshots/06-automate-workspace.jpg", "jpeg"],
  ["artifacts/screenshots/07-top-ribbon-feature-history.jpg", "jpeg"],
  ["artifacts/screenshots/08-assembly-editing.jpg", "jpeg"],
  ["artifacts/screenshots/09-python-mcp-linking.jpg", "jpeg"],
  ["artifacts/screenshots/10-command-catalog.jpg", "jpeg"],
  ["artifacts/screenshots/11-viewport-navigation.jpg", "jpeg"],
  ["artifacts/screenshots/12-sketch-dimensions.jpg", "jpeg"],
  ["artifacts/screenshots/13-measure-tool.jpg", "jpeg"],
  ["artifacts/screenshots/14-ui-color-command-system.jpg", "jpeg"],
  ["artifacts/screenshots/15-fast-command-launcher.jpg", "jpeg"],
  ["artifacts/screenshots/16-sketch-color-constraints.jpg", "jpeg"],
  ["artifacts/screenshots/17-cad-menu-system.jpg", "jpeg"],
  ["docs/screenshots/18-exchange-center-import.jpg", "jpeg"],
  ["docs/screenshots/19-exchange-center-export.jpg", "jpeg"],
  ["docs/screenshots/20-exchange-import-audit.jpg", "jpeg"],
  ["docs/screenshots/21-imported-reference-viewport.jpg", "jpeg"],
  ["docs/screenshots/22-exchange-3d-pdf.jpg", "jpeg"],
  ["docs/screenshots/23-pdf-model-package-render.jpg", "jpeg"],
  ["docs/screenshots/24-exchange-format-matrix.jpg", "jpeg"],
  ["docs/screenshots/25-automatic-drawing-gdt.jpg", "jpeg"],
  ["docs/screenshots/26-drawing-tolerance-controller.jpg", "jpeg"],
  ["docs/screenshots/27-engineering-drawing-method.jpg", "jpeg"],
  ["docs/screenshots/28-explicit-gdt-specification.jpg", "jpeg"],
  ["docs/screenshots/29-bess-container-arrangement.jpg", "jpeg"],
  ["docs/screenshots/30-cargo-container-template.jpg", "jpeg"],
  ["docs/screenshots/31-electrical-schematic-workspace.jpg", "jpeg"],
  ["docs/screenshots/32-professional-electrical-workspace.jpg", "jpeg"],
  ["docs/screenshots/33-circuit-to-3d-review.jpg", "jpeg"],
  ["docs/screenshots/34-linked-electromechanical-assembly.jpg", "jpeg"],
  ["docs/screenshots/35-reviewed-circuit-to-3d-dialog.jpg", "jpeg"],
  ["docs/screenshots/36-linked-electromechanical-current.jpg", "jpeg"],
  ["docs/screenshots/37-cross-probed-electrical-device.jpg", "jpeg"],
  ["docs/screenshots/40-vehicle-engineering-workspace.jpg", "jpeg"],
  ["docs/screenshots/41-ev-motorcycle-hardpoints.jpg", "jpeg"],
  ["docs/screenshots/42-delta-three-wheeler-support-polygon.jpg", "jpeg"],
  ["docs/screenshots/43-tadpole-three-wheeler-top-study.jpg", "jpeg"],
  ["docs/screenshots/44-vehicle-v2-ice-side.png", "png"],
  ["docs/screenshots/45-vehicle-v2-scooter-bump-side.png", "png"],
  ["docs/screenshots/46-vehicle-v2-delta-top.png", "png"],
  ["docs/screenshots/47-vehicle-v2-tadpole-front.png", "png"],
  ["docs/screenshots/48-vehicle-v2-browser-gate.png", "png"],
  ["docs/screenshots/49-design-health-center.jpg", "jpeg"],
  ["docs/screenshots/50-learning-center.jpg", "jpeg"],
  ["docs/screenshots/51-mcp-access-portal.jpg", "jpeg"],
  ["docs/screenshots/52-public-release-cad-home.jpg", "jpeg"],
  ["docs/screenshots/53-learning-manual-cover.png", "png"],
  ["docs/screenshots/54-learning-manual-module.png", "png"],
  ["docs/screenshots/55-learning-manual-checklist.png", "png"],
  ["docs/screenshots/56-professional-sketch-profile-extrude.jpg", "jpeg"],
  ["docs/screenshots/57-sketch-linked-qualified-part.jpg", "jpeg"],
  ["docs/screenshots/58-part-snapshot-in-assembly.jpg", "jpeg"],
  ["docs/screenshots/59-light-cad-gray-part.jpg", "jpeg"],
  ["docs/screenshots/60-part-display-shading-color.jpg", "jpeg"],
  ["docs/screenshots/61-custom-red-body-appearance.jpg", "jpeg"],
  ["docs/screenshots/62-feature-wireframe-display.jpg", "jpeg"],
  ["docs/screenshots/63-ui-aligned-part-workspace.jpg", "jpeg"],
  ["docs/screenshots/64-ui-aligned-drawing-workspace.jpg", "jpeg"],
  ["docs/screenshots/65-ui-aligned-sketch-workspace.jpg", "jpeg"],
  ["docs/screenshots/66-ui-aligned-assembly-workspace.jpg", "jpeg"],
  ["docs/screenshots/67-unified-part-workspace.jpg", "jpeg"],
  ["docs/screenshots/68-part-context-menu.jpg", "jpeg"],
  ["docs/screenshots/69-unified-sketch-workspace.jpg", "jpeg"],
  ["docs/screenshots/70-profile-extrude-handoff.jpg", "jpeg"],
  ["docs/screenshots/71-profile-extrude-controls.jpg", "jpeg"],
  ["docs/screenshots/72-assembly-component-mates.jpg", "jpeg"],
  ["docs/screenshots/73-direct-mate-controls.jpg", "jpeg"],
  ["docs/screenshots/74-mate-relationship-panel.jpg", "jpeg"],
  ["docs/screenshots/75-assembly-context-menu.jpg", "jpeg"],
  ["docs/screenshots/76-sketch-direct-dimension-viewcube.jpg", "jpeg"],
  ["docs/screenshots/77-command-mcp-audit.jpg", "jpeg"],
  ["docs/screenshots/78-ai-collaboration-agent.jpg", "jpeg"],
  ["docs/screenshots/master-cart/01-fastener-socket-head.jpg", "jpeg"],
  ["docs/screenshots/master-cart/02-bearings-bushings.jpg", "jpeg"],
  ["docs/screenshots/master-cart/03-gears.jpg", "jpeg"],
  ["docs/screenshots/master-cart/04-chain-sprockets.jpg", "jpeg"],
  ["docs/screenshots/master-cart/05-belts-pulleys.jpg", "jpeg"],
  ["docs/screenshots/master-cart/06-o-rings-seals.jpg", "jpeg"],
  ["docs/screenshots/master-cart/07-linear-motion.jpg", "jpeg"],
  ["docs/screenshots/master-cart/08-hose-fittings.jpg", "jpeg"],
  ["docs/screenshots/master-cart/09-tube-fittings.jpg", "jpeg"],
  ["docs/screenshots/master-cart/10-hand-tools.jpg", "jpeg"],
  ["docs/screenshots/master-cart/11-configured-m10-fastener.jpg", "jpeg"],
  ["docs/screenshots/master-cart/12-assembly-grouped-insertion.jpg", "jpeg"],
  ["docs/screenshots/master-cart/13-assembly-trace-card.jpg", "jpeg"],
  ["docs/screenshots/master-cart/14-all-commands-catalog.jpg", "jpeg"],
  ["docs/screenshots/master-cart/15-ps3d-brand-profile.jpg", "jpeg"],
  ["output/pdf/ps3d-exchange-model-package-sample.pdf", "pdf"],
  ["output/pdf/ps3d-cad-studio-learning-and-safe-practice-manual.pdf", "pdf"]
]);
const forbiddenCredentialExtensions = new Set([".key", ".pem", ".p12", ".pfx", ".jks", ".kdbx"]);
const forbiddenPatterns = [
  { label: "private-key block", pattern: /-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u },
  { label: "GitHub token", pattern: /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { label: "payment secret", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/u },
  {
    label: "assigned high-risk secret",
    pattern: /\b(?:VERCEL_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{16,}/iu
  },
  { label: "private Windows profile path", pattern: /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^<>\s"'`]+/iu },
  { label: "private Unix profile path", pattern: /(?:^|[\s"'(])\/(?:Users|home)\/[^<>\s"'`]+/imu }
];

export async function verifyRepositoryBoundary() {
  const files = await listFiles(root, "");
  const fileSet = new Set(files);
  const missingReviewed = [...reviewedBinaryFiles.keys()].filter((path) => !fileSet.has(path));
  if (missingReviewed.length > 0) throw new Error(`Reviewed binary evidence is missing: ${missingReviewed.join(", ")}`);
  let textCount = 0;
  let binaryCount = 0;

  for (const relativePath of files) {
    const extension = extname(relativePath).toLowerCase();
    const baseName = relativePath.split("/").at(-1)?.toLowerCase() ?? "";
    if (forbiddenCredentialExtensions.has(extension)) throw new Error(`Forbidden credential-like file: ${relativePath}`);
    if ((baseName === ".env" || baseName.startsWith(".env.")) && baseName !== ".env.example") {
      throw new Error(`Environment secret file is not allowed: ${relativePath}`);
    }

    const bytes = await readFile(resolve(root, ...relativePath.split("/")));
    if (reviewedImageExtensions.has(extension) || extension === ".pdf") {
      const expectedKind = reviewedBinaryFiles.get(relativePath);
      if (expectedKind === undefined) {
        throw new Error(`Binary evidence is outside the reviewed allowlist: ${relativePath}`);
      }
      if (!hasExpectedMagic(bytes, expectedKind)) throw new Error(`Reviewed binary evidence has invalid ${expectedKind.toUpperCase()} magic: ${relativePath}`);
      binaryCount += 1;
      continue;
    }

    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Unexpected binary file in source set: ${relativePath}`);
    }

    textCount += 1;
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.pattern.test(source)) throw new Error(`Repository boundary found ${forbidden.label} in ${relativePath}.`);
    }
  }

  return { textCount, binaryCount };
}

function hasExpectedMagic(bytes, kind) {
  if (kind === "jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (kind === "png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function listFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Repository boundary rejects symbolic links: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(resolve(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

if (typeof process !== "undefined" && process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await verifyRepositoryBoundary();
  process.stdout.write(`Verified repository boundary: ${result.textCount} text files, ${result.binaryCount} reviewed binary evidence files.\n`);
}
