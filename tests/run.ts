import { evidenceAndSolidTests } from "./evidence-and-solid.test.js";
import { exchange3dTests } from "./exchange-3d.test.js";
import { modelAndCommandTests } from "./model-and-commands.test.js";
import { revisionBoundaryTests } from "./revision-boundaries.test.js";
import { sketchTests } from "./sketch.test.js";
import { workbenchCoreTests } from "./workbench-core.test.js";
import { workbenchDrawingTests } from "./workbench-drawing.test.js";
import { workbenchGeometryTests } from "./workbench-geometry.test.js";
import { workbenchMcpTests } from "./workbench-mcp.test.js";
import { workbenchTemplateTests } from "./workbench-templates.test.js";
import { workbenchElectricalTests } from "./workbench-electrical.test.js";
import { workbenchElectromechanicalTests } from "./workbench-electromechanical.test.js";
import { workbenchVehicleTests } from "./workbench-vehicle.test.js";
import { workbenchHealthTests } from "./workbench-health.test.js";
import { workbenchMasterCartTests } from "./workbench-master-cart.test.js";
import { workbenchInteractionTests } from "./workbench-interaction.test.js";
import { workbenchPartFeatureTests } from "./workbench-part-features.test.js";
import { workbenchEngineeringIntentTests } from "./workbench-engineering-intent.test.js";
import { publicReleaseTests } from "./public-release.test.js";
import { fileWorkspaceTests } from "./file-workspace.test.js";
import { cameraLandmarkTests } from "./camera-landmarks.test.js";
import type { TestCase } from "./test-kit.js";

const tests: readonly TestCase[] = [
  ...modelAndCommandTests,
  ...sketchTests,
  ...evidenceAndSolidTests,
  ...exchange3dTests,
  ...revisionBoundaryTests,
  ...workbenchCoreTests,
  ...workbenchGeometryTests,
  ...workbenchDrawingTests,
  ...workbenchTemplateTests,
  ...workbenchElectricalTests,
  ...workbenchElectromechanicalTests,
  ...workbenchVehicleTests,
  ...workbenchHealthTests,
  ...workbenchMasterCartTests,
  ...workbenchInteractionTests,
  ...cameraLandmarkTests,
  ...workbenchPartFeatureTests,
  ...workbenchEngineeringIntentTests,
  ...workbenchMcpTests,
  ...fileWorkspaceTests,
  ...publicReleaseTests
];
let failures = 0;

for (const test of tests) {
  try {
    await test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

console.log(`${tests.length - failures}/${tests.length} tests passed`);
if (failures > 0) throw new Error(`${failures} test${failures === 1 ? "" : "s"} failed.`);
