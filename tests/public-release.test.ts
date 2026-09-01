import { readFileSync } from "node:fs";
import {
  PERSONAL_TOKEN_PATTERN,
  generatePersonalAccessToken,
  hashPersonalAccessToken,
  normalizeScopes
} from "../api/_lib/cloud.js";
import { classifyTokenStoreFailure } from "../api/_lib/token-store-error.js";
import { PS3D_LEARNING_MANUAL } from "../apps/studio-web/src/learning/learning-content.js";
import { buildLearningManualPdf } from "../apps/studio-web/src/learning/learning-pdf.js";
import { PS3D_BRAND, PS3D_PUBLIC_TOOLS } from "../apps/studio-web/src/brand.js";
import { deriveFaultBrainNotices, mergeFaultBrainNotices, runtimeFaultNotice } from "../apps/studio-web/src/ui/fault-brain.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

const TEST_PEPPER = "ps3d-public-release-test-pepper-32-bytes-minimum";

export const publicReleaseTests: readonly TestCase[] = [
  {
    name: "public identity matches the owner-supplied PS3D Master profile",
    run: () => {
      equal(PS3D_BRAND.name, "PS3D Master", "the public owner brand should be exact");
      equal(PS3D_BRAND.productName, "PS3D CAD Studio", "the CAD product name should remain distinct from the owner brand");
      equal(PS3D_BRAND.serviceLine, "Precision CAD Design & Mechanical Services", "the official service line should remain exact");
      equal(PS3D_BRAND.tagline, "Engineering intelligence for precision motion systems.", "the official tagline should remain exact");
      equal(PS3D_BRAND.founder, "Sagar Patel", "the owner attribution should remain exact");
      equal(PS3D_BRAND.instagramHandle, "@ps3dmaster", "the public social handle should remain exact");
      equal(PS3D_BRAND.logoPath, "/ps3d-master-logo.png", "every public surface should use the reviewed official logo asset");
      equal(PS3D_PUBLIC_TOOLS.length, 5, "the portfolio profile should retain all five listed public-tool entries");
      assert(PS3D_PUBLIC_TOOLS.every((tool) => tool.name.length > 0 && tool.description.length > 0), "every marketing tool card should be complete");
    }
  },
  {
    name: "responsive policy loads last and preserves bounded CAD and public layouts",
    run: () => {
      const styleImports = readFileSync("apps/studio-web/src/styles.css", "utf8").trim();
      const responsive = readFileSync("apps/studio-web/src/styles/responsive.css", "utf8");
      assert(styleImports.endsWith('@import "./styles/responsive.css";'), "responsive policy must load after every workspace and brand stylesheet");
      assert(responsive.includes("@media (max-width: 1220px)"), "small-laptop layout should have an explicit breakpoint");
      assert(responsive.includes("@media (max-width: 700px)"), "single-column CAD layout should have an explicit breakpoint");
      assert(responsive.includes("@media (max-width: 480px)"), "phone layout should have an explicit breakpoint");
      assert(responsive.includes("@media (max-height: 700px)"), "high-zoom and short-window layout should have an explicit height breakpoint");
      assert(/\.studio-app\s*\{[\s\S]*?overflow-x:\s*hidden;/u.test(responsive), "the CAD shell should never widen the document viewport");
      assert(/\.master-cart-workspace\s*\{[\s\S]*?min-width:\s*0;/u.test(responsive), "the catalog must remove its desktop-only minimum width responsively");
      assert(/\.public-page-header nav\s*\{[\s\S]*?overflow-x:\s*auto;/u.test(responsive), "public navigation should remain reachable without overflowing the page");
    }
  },
  {
    name: "hand runtime uses exact development routes instead of Vite public-module imports",
    run: () => {
      const viteConfig = readFileSync("apps/studio-web/vite.config.mjs", "utf8");
      assert(viteConfig.includes("publicDir: false"), "Vite publicDir must remain disabled because MediaPipe imports its loader as a module");
      assert(viteConfig.includes("configureServer(server)"), "development must serve the reviewed hand runtime before Vite transform middleware");
      for (const runtimePath of [
        "/mediapipe/runtime-manifest.json",
        "/mediapipe/models/hand_landmarker-float16-v1.task",
        "/mediapipe/wasm/vision_wasm_module_internal.js",
        "/mediapipe/wasm/vision_wasm_module_internal.wasm"
      ]) {
        assert(viteConfig.includes(runtimePath), `the exact hand-runtime route ${runtimePath} must remain explicit`);
      }
      assert(viteConfig.includes('candidate.url === pathname'), "development routing must reject every non-allowlisted runtime path");
      assert(viteConfig.includes('request.method !== "GET" && request.method !== "HEAD"'), "runtime middleware must remain read-only");
    }
  },
  {
    name: "Smart Brain deduplicates engineering faults and redacts runtime secrets",
    run: () => {
      const report = buildDesignHealthReport(createWorkbenchProject("project:fault-brain-test"));
      const engineeringNotices = deriveFaultBrainNotices(report);
      assert(engineeringNotices.length > 0, "the default broad project should expose its truthful review findings");
      assert(engineeringNotices.every((notice) => notice.severity === "warning" || notice.severity === "error"), "informational health records should not become fault notifications");
      const runtime = runtimeFaultNotice("unhandled-rejection", "Bearer secret-token ps3d_privatecredential123 at C:\\private\\system\\key.txt");
      assert(!runtime.message.includes("secret-token"), "bearer credentials must be redacted from runtime notifications");
      assert(!runtime.message.includes("privatecredential"), "PS3D credential-like values must be redacted");
      assert(!runtime.message.includes("C:\\private"), "local system paths must be redacted");
      equal(mergeFaultBrainNotices([runtime, runtime]).length, 1, "repeated runtime failures should produce one stable notification");
    }
  },
  {
    name: "personal MCP tokens are random, namespaced, and never used as their database hash",
    run: () => {
      const first = generatePersonalAccessToken();
      const second = generatePersonalAccessToken();
      assert(PERSONAL_TOKEN_PATTERN.test(first), "first personal token should match the public PS3D format");
      assert(PERSONAL_TOKEN_PATTERN.test(second), "second personal token should match the public PS3D format");
      assert(first !== second, "independent token generation must not repeat a token");
      const hash = hashPersonalAccessToken(first, TEST_PEPPER);
      equal(hash.length, 64, "stored HMAC should be a 256-bit lowercase hexadecimal digest");
      assert(!hash.includes(first), "the stored digest must not contain the raw token");
      equal(hashPersonalAccessToken(first, TEST_PEPPER), hash, "the same token and pepper should validate deterministically");
    }
  },
  {
    name: "MCP scope normalization requires read access and returns canonical least-privilege order",
    run: () => {
      equal(normalizeScopes(["mcp:preview"]), undefined, "preview-only credentials should be rejected");
      equal(normalizeScopes(["mcp:read", "unknown"]), undefined, "unknown scopes should be rejected");
      const normalized = normalizeScopes(["mcp:apply", "mcp:read", "mcp:apply"]);
      assert(normalized !== undefined, "valid scope selection should normalize");
      equal(normalized.join(","), "mcp:read,mcp:apply", "scope order should be canonical and duplicates removed");
    }
  },
  {
    name: "token-store failures expose safe and actionable deployment reasons",
    run: () => {
      const permission = classifyTokenStoreFailure("create", { status: 403, code: "42501", message: "permission denied for table mcp_tokens" });
      equal(permission.status, 503, "database permission failures should be reported as deployment availability errors");
      equal(permission.code, "TOKEN_STORE_PERMISSION", "permission failures should have a stable support reference");
      assert(permission.message.includes("latest Supabase migration"), "permission guidance should identify the administrator action");
      assert(!permission.message.includes("mcp_tokens"), "the public error must not expose the internal table name");

      const migration = classifyTokenStoreFailure("list", { status: 404, code: "PGRST205", message: "table was not found" });
      equal(migration.code, "TOKEN_STORE_MIGRATION", "missing schema objects should identify the migration boundary");

      const limit = classifyTokenStoreFailure("create", { status: 500, code: "P0001", message: "active MCP token limit reached" });
      equal(limit.status, 409, "the active-token cap should remain a user-correctable conflict");
      equal(limit.code, "TOKEN_LIMIT", "the active-token cap should preserve its public error contract");

      const unknown = classifyTokenStoreFailure("revoke", { status: 500, code: "XX000", message: "sensitive internal detail" });
      equal(unknown.code, "TOKEN_REVOKE_FAILED", "unknown failures should retain an operation-specific safe fallback");
      assert(!unknown.message.includes("sensitive internal detail"), "raw database details must never reach the browser");
    }
  },
  {
    name: "the forward MCP migration grants only the required service-role table access",
    run: () => {
      const migration = readFileSync("supabase/migrations/202608260001_grant_mcp_service_role.sql", "utf8");
      assert(/grant usage on schema public to service_role;/u.test(migration), "the server role needs schema usage");
      assert(/grant select, insert, update on table public\.mcp_tokens to service_role;/u.test(migration), "the server role needs only token list, create, and update privileges");
      assert(!/\bto\s+(?:anon|authenticated|public)\b/iu.test(migration), "the forward repair must not grant token-table access to browser roles");
      assert(!/\b(?:delete|truncate|references|trigger)\b/iu.test(migration.replace(/^--.*$/gmu, "")), "the server role must not receive unnecessary destructive or ownership-adjacent privileges");
    }
  },
  {
    name: "learning manual generator emits a complete 15-page PDF artifact",
    run: async () => {
      const blob = buildLearningManualPdf(PS3D_LEARNING_MANUAL);
      equal(blob.type, "application/pdf", "manual should use the PDF MIME type");
      assert(blob.size > 25_000, "manual should contain the full curriculum rather than an empty shell");
      const source = new TextDecoder("latin1").decode(await blob.arrayBuffer());
      assert(source.startsWith("%PDF-1.7"), "manual should begin with the PDF 1.7 header");
      assert(source.includes("/Count 15"), "manual should declare all 15 pages");
      assert(source.includes("PS3D CAD Studio Learning and Safe Practice Manual"), "manual metadata should carry its durable product title");
      assert(source.includes("PS3D CAD Studio / PS3D Master"), "manual metadata should carry the product and owner brand");
      assert(source.includes("xref") && source.trimEnd().endsWith("%%EOF"), "manual should include a cross-reference table and EOF marker");
    }
  }
];
