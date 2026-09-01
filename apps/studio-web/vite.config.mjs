import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { productionGeometryBoundaryPlugin } from "../../scripts/production-boundary.mjs";

const distDirectory = fileURLToPath(new URL("../../dist", import.meta.url));
const handRuntimeDirectory = fileURLToPath(new URL("../../node_modules/.cache/ps3d-hand-runtime", import.meta.url));
const handRuntimeAssets = [
  { url: "/mediapipe/runtime-manifest.json", relativePath: "mediapipe/runtime-manifest.json", contentType: "application/json; charset=utf-8" },
  { url: "/mediapipe/models/hand_landmarker-float16-v1.task", relativePath: "mediapipe/models/hand_landmarker-float16-v1.task", contentType: "application/octet-stream" },
  { url: "/mediapipe/wasm/vision_wasm_module_internal.js", relativePath: "mediapipe/wasm/vision_wasm_module_internal.js", contentType: "text/javascript; charset=utf-8" },
  { url: "/mediapipe/wasm/vision_wasm_module_internal.wasm", relativePath: "mediapipe/wasm/vision_wasm_module_internal.wasm", contentType: "application/wasm" }
];
const rootLicense = fileURLToPath(new URL("../../LICENSE", import.meta.url));
const builtLicense = fileURLToPath(new URL("../../dist/LICENSE.txt", import.meta.url));
const thirdPartyNotices = fileURLToPath(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url));
const builtThirdPartyNotices = fileURLToPath(new URL("../../dist/THIRD_PARTY_NOTICES.md", import.meta.url));
const builtLicenseReport = fileURLToPath(new URL("../../dist/third-party-licenses.txt", import.meta.url));
const apacheLicense = fileURLToPath(new URL("../../node_modules/typescript/LICENSE", import.meta.url));
const builtApacheLicense = fileURLToPath(new URL("../../dist/licenses/APACHE-2.0.txt", import.meta.url));

function handRuntimePlugin() {
  return {
    name: "ps3d-hand-runtime",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname;
        try {
          pathname = new URL(request.url ?? "/", "http://ps3d.local").pathname;
        } catch {
          next();
          return;
        }
        const asset = handRuntimeAssets.find((candidate) => candidate.url === pathname);
        if (asset === undefined) {
          next();
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          response.end();
          return;
        }
        readFile(resolve(handRuntimeDirectory, asset.relativePath)).then((payload) => {
          response.statusCode = 200;
          response.setHeader("Content-Type", asset.contentType);
          response.setHeader("Content-Length", String(payload.byteLength));
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(request.method === "HEAD" ? undefined : payload);
        }).catch(next);
      });
    },
    async closeBundle() {
      for (const asset of handRuntimeAssets) {
        const source = resolve(handRuntimeDirectory, asset.relativePath);
        const target = resolve(distDirectory, asset.relativePath);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    }
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  // MediaPipe imports its loader as a module. Vite intentionally forbids
  // importing modules from publicDir, so development uses the exact-route
  // middleware above and production copies the same reviewed four-file set.
  publicDir: false,
  plugins: [productionGeometryBoundaryPlugin(), handRuntimePlugin(), {
    name: "ps3d-project-license",
    apply: "build",
    async closeBundle() {
      await copyFile(rootLicense, builtLicense);
      await copyFile(thirdPartyNotices, builtThirdPartyNotices);
      await mkdir(dirname(builtApacheLicense), { recursive: true });
      await copyFile(apacheLicense, builtApacheLicense);
      const report = await readFile(builtLicenseReport, "utf8");
      if (!report.includes("@mediapipe/tasks-vision - 1.0.1")) {
        await writeFile(
          builtLicenseReport,
          `${report.trimEnd()}\n\n## @mediapipe/tasks-vision - 1.0.1 (Apache-2.0)\n\n` +
            "Copyright 2023 The MediaPipe Authors. Licensed under the Apache License, Version 2.0. " +
            "The full Apache License 2.0 text is included at licenses/APACHE-2.0.txt; " +
            "redistribution obligations are summarized in THIRD_PARTY_NOTICES.md.\n",
          "utf8"
        );
      }
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
