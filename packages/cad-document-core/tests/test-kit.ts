export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function equal<Value>(actual: Value, expected: Value, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${message}\nexpected: ${String(expected)}\nactual: ${String(actual)}`);
}

export function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`${message}\nexpected: ${expectedJson}\nactual: ${actualJson}`);
}
