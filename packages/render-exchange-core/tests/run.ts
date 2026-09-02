import { renderExchangeTests } from "./render-exchange.test.js";

let failures = 0;
for (const test of renderExchangeTests) {
  try {
    await test.run();
    console.log(`PASS ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${test.name}`);
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

console.log(`${renderExchangeTests.length - failures}/${renderExchangeTests.length} tests passed`);
if (failures > 0) throw new Error(`${failures} render/exchange tests failed.`);
