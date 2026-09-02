import { assemblyKinematicsTests } from "./assembly-kinematics.test.js";

let failures = 0;
for (const test of assemblyKinematicsTests) {
  try {
    await test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}
console.log(`${assemblyKinematicsTests.length - failures}/${assemblyKinematicsTests.length} tests passed`);
if (failures > 0) throw new Error(`${failures} assembly kinematics tests failed.`);
