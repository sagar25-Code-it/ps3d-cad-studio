import {
  PERSONAL_TOKEN_PATTERN,
  generatePersonalAccessToken,
  hashPersonalAccessToken,
  normalizeScopes
} from "../api/_lib/cloud.js";
import { PS3D_LEARNING_MANUAL } from "../apps/studio-web/src/learning/learning-content.js";
import { buildLearningManualPdf } from "../apps/studio-web/src/learning/learning-pdf.js";
import { PS3D_BRAND, PS3D_PUBLIC_TOOLS } from "../apps/studio-web/src/brand.js";
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
