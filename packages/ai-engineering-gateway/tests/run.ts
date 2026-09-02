import { aiEngineeringGatewayTests } from "./ai-engineering-gateway.test.js";

let failures = 0;
for (const test of aiEngineeringGatewayTests) {
  try {
    await test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

console.log(`${aiEngineeringGatewayTests.length - failures}/${aiEngineeringGatewayTests.length} tests passed`);
if (failures > 0) throw new Error(`${failures} AI engineering gateway tests failed.`);
