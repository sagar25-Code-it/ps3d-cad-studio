import { cadDocumentCoreTests } from "./cad-document-core.test.js";

let failures = 0;
for (const test of cadDocumentCoreTests) {
  try {
    test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}
console.log(`${cadDocumentCoreTests.length - failures}/${cadDocumentCoreTests.length} tests passed`);
if (failures > 0) throw new Error(`${failures} CAD document core tests failed.`);
