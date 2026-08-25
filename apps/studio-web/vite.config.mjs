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
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (path.includes("/node_modules/three/build/") || path.includes("/node_modules/three/src/")) return "vendor-three";
          if (path.includes("/node_modules/react/") || path.includes("/node_modules/react-dom/")) return "vendor-react";
          if (path.includes("/packages/exchange-3d/")) return "cad-exchange";
          if (path.includes("/packages/workbench-vehicle/")) return "cad-vehicle";
          if (path.includes("/packages/workbench-electrical/")) return "cad-electrical";
          if (path.includes("/packages/workbench-drawing/")) return "cad-drawing";
          if (path.includes("/packages/workbench-templates/")) return "cad-templates";
        }
      }
    },
    license: {
      fileName: "third-party-licenses.txt"
    }
  }
});
