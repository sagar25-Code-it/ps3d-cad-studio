import { planEngineeringIntent } from "../packages/workbench-core/src/index.js";
import { handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchEngineeringIntentTests: readonly TestCase[] = [
  {
    name: "engineering intent compiler creates an ordered reusable tube feature plan",
    run: () => {
      const request = "Create a 100 x 50 x 3 mm RHS tube 1200 mm long with two diameter 12 mm holes 50 mm from each end.";
      const first = planEngineeringIntent({ request, unit: "mm", workspace: "part", projectRevision: 7 });
      const second = planEngineeringIntent({ request, unit: "mm", workspace: "part", projectRevision: 7 });
      equal(JSON.stringify(first), JSON.stringify(second), "the same request should produce the same complete engineering plan");
      equal(first.schema, "ps3d-engineering-intent-plan/1", "engineering plan schema should be versioned");
      equal(first.interpretation.scope, "part", "a standalone RHS request should be classified as a part");
      equal(first.status, "ready-for-review", "fully dimensioned supported intent should be ready for review even when release material remains open");
      const tube = first.partDefinitions.find((part) => part.id === "definition:tube");
      assert(tube !== undefined, "RHS should resolve to one hollow-section definition");
      equal(tube.quantity, 1, "a standalone part should propose one occurrence");
      assert(["datum", "sketch", "extrude", "hole", "linear-pattern", "verify"].every((kind) => tube.features.some((feature) => feature.kind === kind)), "tube plan should include the complete ordered base, hole, pattern, and verification sequence");
      assert(tube.features.every((feature, index, values) => index === 0 || values[index - 1]!.order <= feature.order), "features should remain in dependency order");
      assert(first.dimensionFacts.some((fact) => fact.label === "length" && fact.valueMm === 1200), "trailing length notation should be normalized to millimetres");
      assert(first.dimensionFacts.some((fact) => fact.label === "diameter" && fact.valueMm === 12), "hole diameter should be captured as a stated fact");
      assert(first.questions.every((question) => question.blocks === "release"), "the compiler should not invent geometry blockers for a fully dimensioned supported part");
      equal(first.interpretation.executionPerformed, false, "planning must never claim CAD execution");
    }
  },
  {
    name: "engineering intent compiler blocks unsupported exact features instead of claiming geometry",
    run: () => {
      const plan = planEngineeringIntent({
        request: "Create a 120 x 80 x 20 mm machined mounting bracket with a pocket, draft, shell, chamfer and fillet.",
        unit: "mm",
        workspace: "part"
      });
      equal(plan.status, "partially-plannable", "unsupported exact features should preserve the plan but block completed geometry claims");
      assert(plan.execution.unavailableFeatureIds.some((id) => id.endsWith(":pocket")), "pocket should retain an explicit unavailable route");
      assert(plan.execution.unavailableFeatureIds.some((id) => id.endsWith(":draft")), "draft should retain an explicit unavailable route");
      assert(plan.execution.unavailableFeatureIds.some((id) => id.endsWith(":shell")), "shell should retain an explicit unavailable route");
      equal(plan.execution.canCreateCandidateNow, false, "an unavailable exact feature must prevent automatic candidate creation");
      assert(plan.warnings.some((warning) => warning.includes("no qualified execution route")), "the plan should disclose the kernel boundary");
    }
  },
  {
    name: "engineering intent compiler reuses child definitions and asks for standard evidence",
    run: () => {
      const plan = planEngineeringIntent({
        request: "Build a bottom frame assembly with two side rails, four identical cross-members and ISO corner blocks. Align members from named datums.",
        unit: "mm",
        workspace: "assembly"
      });
      assert(plan.partDefinitions.some((part) => part.id === "definition:side-rail" && part.quantity === 2), "two side rails should be one definition with two occurrences");
      assert(plan.partDefinitions.some((part) => part.id === "definition:cross-member" && part.quantity === 4), "four identical cross-members should be one reusable definition");
      assert(plan.commonDefinitionIds.includes("definition:cross-member"), "repeated child definitions should be explicitly reusable");
      assert(plan.questions.some((question) => question.code === "STANDARD_DEFINITION_REQUIRED" && question.relatedDefinitionIds.includes("definition:corner-fitting")), "ISO wording without an edition or approved drawing must not authorize guessed corner geometry");
      assert(plan.questions.some((question) => question.code === "CHILD_QUANTITIES_REQUIRED" && question.relatedDefinitionIds.includes("definition:corner-fitting")), "missing corner-fitting quantity should remain a typed assembly question");
      const bottom = plan.assemblyPackages.find((assembly) => assembly.id === "assembly-package:bottom");
      assert(bottom !== undefined && bottom.status === "blocked", "bottom assembly should be the first blocked approval package until evidence is resolved");
      assert(bottom.childDefinitionIds.includes("definition:side-rail") && bottom.childDefinitionIds.includes("definition:cross-member"), "the package should reference reusable child definitions rather than copied geometry");
    }
  },
  {
    name: "engineering intent compiler proposes dependency-ordered container approvals",
    run: () => {
      const plan = planEngineeringIntent({ request: "Create a cargo container assembly from approved child parts.", workspace: "assembly", unit: "mm" });
      assert(plan.assemblyPackages.length >= 5, "a container request without named packages should receive a reviewable subassembly decomposition");
      const final = plan.assemblyPackages.at(-1);
      assert(final?.name === "Final integration assembly", "the last package should be final integration");
      equal(final.dependencyPackageIds.length, plan.assemblyPackages.length - 1, "final integration should depend on every earlier package");
      assert(plan.questions.some((question) => question.code === "PRIMARY_DIMENSIONS_REQUIRED"), "an unscaled container request must ask for controlled dimensions or drawings");
      assert(plan.execution.requiredSequence.some((step) => step.includes("one complete subassembly")), "execution policy should enforce assembly-by-assembly approval");
    }
  },
  {
    name: "engineering intent compiler treats fit allowance as controlled input and exposes MCP directly",
    run: async () => {
      const request = "Create an assembly with a 100 x 50 x 3 mm tube and allow plus/minus 5 on selected gap-filling members.";
      const direct = planEngineeringIntent({ request, workspace: "assembly", unit: "mm", targetCad: ["ps3d", "fusion-360"] });
      assert(direct.questions.some((question) => question.code === "FIT_ADJUSTMENT_SCOPE_REQUIRED"), "plus/minus five must become a named-member fit question, not a general tolerance");
      const mcp = await handleWorkbenchMcpTool("ps3d_plan_engineering_intent", { request, workspace: "assembly", unit: "mm", targetCad: ["ps3d", "fusion-360"] });
      assert(mcp.isError !== true, "MCP should expose the planner without a pasted prompt or mutation acknowledgement");
      equal(mcp.structuredContent["schema"], "ps3d-engineering-intent-plan/1", "MCP should return the same versioned planner contract");
      equal((mcp.structuredContent["interpretation"] as Readonly<Record<string, unknown>>)["executionPerformed"], false, "MCP planning should stay read-only");
      const invalid = await handleWorkbenchMcpTool("ps3d_plan_engineering_intent", { request: "x" });
      assert(invalid.isError === true, "undersized intent requests should fail closed");
    }
  },
  {
    name: "engineering intent compiler asks for design definition when an unfamiliar part is only an envelope",
    run: () => {
      const plan = planEngineeringIntent({
        request: "Create a custom indexing carrier with an overall diameter of 180 mm and thickness 35 mm.",
        unit: "mm",
        workspace: "part"
      });
      equal(plan.partDefinitions[0]?.classification, "custom", "an unfamiliar part must remain a custom definition instead of being forced into a guessed base family");
      assert(plan.questions.some((question) => question.code === "DESIGN_DEFINITION_REQUIRED"), "an envelope alone must request profiles, sections, manufacturing intent, and interfaces");
      equal(plan.execution.canCreateCandidateNow, false, "PS3D must not claim it can create unfamiliar geometry from its envelope alone");
    }
  },
  {
    name: "engineering intent compiler does not assign one dimension list to several child definitions",
    run: () => {
      const plan = planEngineeringIntent({
        request: "Build an assembly with one mounting plate and two brackets, using dimensions 200 x 120 x 8 mm.",
        unit: "mm",
        workspace: "assembly"
      });
      assert(plan.partDefinitions.filter((part) => part.kind === "manufactured-part").length >= 2, "the request should identify multiple manufactured definitions");
      assert(plan.questions.some((question) => question.code === "DIMENSION_OWNERSHIP_REQUIRED"), "unscoped dimensions must be assigned to explicit child definitions before geometry planning");
      equal(plan.execution.canCreateCandidateNow, false, "ambiguous cross-part dimensions must block candidate creation");
    }
  },
  {
    name: "engineering intent compiler bounds whitespace parsing and distinguishes hole size from hole count",
    run: () => {
      const longWhitespace = " ".repeat(11_000);
      const startedAt = Date.now();
      const adversarial = planEngineeringIntent({
        request: `Create a mounting plate with length${longWhitespace}not-a-number and a diameter 4 mm hole.`,
        unit: "mm",
        workspace: "part"
      });
      assert(Date.now() - startedAt < 1_000, "uncontrolled whitespace must not cause polynomial regular-expression work");
      assert(adversarial.dimensionFacts.some((fact) => fact.label === "diameter" && fact.valueMm === 4), "a bounded diameter expression should still capture valid dimensions");
      const plate = adversarial.partDefinitions.find((part) => part.id === "definition:plate");
      assert(plate !== undefined, "the adversarial request should still resolve its intended part definition");
      assert(!plate.features.some((feature) => feature.kind === "linear-pattern"), "a 4 mm hole diameter must not be misread as a four-hole count");

      const oversized = planEngineeringIntent({
        request: `Create a plate ${" ".repeat(12_100)} with two mounting holes.`,
        unit: "mm",
        workspace: "part"
      });
      assert(oversized.warnings.some((warning) => warning.includes("12,000 characters") && warning.includes("truncated")), "direct callers should receive an explicit warning when an oversized request is safely truncated");
    }
  }
];
