import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { copyFile } from "node:fs/promises";
import { productionGeometryBoundaryPlugin } from "../../scripts/production-boundary.mjs";

const rootLicense = fileURLToPath(new URL("../../LICENSE", import.meta.url));
const builtLicense = fileURLToPath(new URL("../../dist/LICENSE.txt", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [productionGeometryBoundaryPlugin(), {
    name: "ps3d-project-license",
    apply: "build",
    async closeBundle() {
      await copyFile(rootLicense, builtLicense);
    }
  }],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    assetsInlineLimit: 0,
    license: {
      fileName: "third-party-licenses.txt"
    }
  }
});
