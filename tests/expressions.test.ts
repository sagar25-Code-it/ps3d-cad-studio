import {
  EMPTY_EXPRESSION_ENVIRONMENT,
  describeExpressionError,
  evaluateExpression,
  formatQuantity,
  parseExpression,
  renameOwnerReferences,
  renameParameterReferences,
  type ExpressionEnvironment,
  type Quantity
} from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const scalar = (value: number): Quantity => ({ value, length: 0, angle: 0 });
const length = (value: number): Quantity => ({ value, length: 1, angle: 0 });

/** A small environment: plain names and `Owner.name` references, nothing else. */
const environment: ExpressionEnvironment = {
  resolve: (reference) => {
    const key = reference.owner === undefined ? reference.name : `${reference.owner}.${reference.name}`;
    const table: Readonly<Record<string, Quantity>> = { pin_r: length(4), pin_r2: length(99), count: scalar(3), "Extrude1.distance": length(12), tilt: { value: 30, length: 0, angle: 1 } };
    const found = Object.hasOwn(table, key) ? table[key] : undefined;
    return found === undefined ? { ok: false, message: `Unknown name "${key}".` } : { ok: true, quantity: found };
  }
};

function value(source: string, env: ExpressionEnvironment = EMPTY_EXPRESSION_ENVIRONMENT): Quantity {
  const result = evaluateExpression(source, env);
  assert(result.ok, `"${source}" evaluates: ${result.ok ? "" : describeExpressionError(result.error)}`);
  return result.quantity;
}

function failure(source: string, env: ExpressionEnvironment = EMPTY_EXPRESSION_ENVIRONMENT): { readonly message: string; readonly position: number } {
  const result = evaluateExpression(source, env);
  assert(!result.ok, `"${source}" is refused`);
  return result.error;
}

export const expressionTests: readonly TestCase[] = [
  {
    name: "expressions follow arithmetic precedence, parentheses, unary minus and right-associative powers",
    run: () => {
      equal(value("2 + 3 * 4").value, 14, "multiplication binds tighter than addition");
      equal(value("(2 + 3) * 4").value, 20, "parentheses group");
      equal(value("10 - 4 - 3").value, 3, "subtraction is left associative");
      equal(value("100 / 10 / 5").value, 2, "division is left associative");
      equal(value("-2 ^ 2").value, -4, "unary minus applies after the power");
      equal(value("2 ^ 3 ^ 2").value, 512, "powers are right associative");
      equal(value("2 ^ -1").value, 0.5, "an exponent may be negative");
      equal(value("--3").value, 3, "double negation");
      equal(value("+5").value, 5, "unary plus");
      equal(value(".5 + 1.").value, 1.5, "leading and trailing dots are numbers");
      equal(value("1e3").value, 1000, "exponent notation");
      equal(value("  7\t+\n1 ").value, 8, "whitespace is ignored");
    }
  },
  {
    name: "unit suffixes convert exactly into millimetres and degrees",
    run: () => {
      equal(value("1 in").value, 25.4, "an inch is exactly 25.4 mm");
      equal(value("2 in").value, 50.8, "two inches are exactly 50.8 mm");
      equal(value("2.54 cm").value, 25.4, "2.54 cm is exactly 25.4 mm (no floating point noise)");
      equal(value("1 m").value, 1000, "a metre is 1000 mm");
      equal(value("1 cm").value, 10, "a centimetre is 10 mm");
      equal(value("12.5mm").value, 12.5, "no space is needed before the unit");
      near(value("1 rad").value, 180 / Math.PI, 1e-12, "a radian in degrees");
      equal(value("90 deg").value, 90, "degrees are the base angle unit");
      const mixed = value("0.5 in + 1 mm");
      near(mixed.value, 13.7, 1e-12, "lengths in different units add");
      equal(mixed.length, 1, "and stay a length");
      const ratio = value("25.4 mm / 1 in");
      equal(ratio.value, 1, "a length over a length is a plain number");
      equal(ratio.length, 0, "with no dimension left");
      equal(formatQuantity(value("1 in")), "25.4 mm", "a quantity prints in its base unit");
      equal(formatQuantity(value("45 deg")), "45 deg", "an angle prints in degrees");
      equal(formatQuantity(value("3")), "3", "a plain number prints bare");
    }
  },
  {
    name: "functions: trigonometry needs angles, sqrt halves dimensions, min/max/abs/round/floor/ceil keep them, pi is a constant",
    run: () => {
      equal(value("sin(30 deg)").value, 0.5, "sin of 30 degrees is exactly 0.5 after cleanup");
      equal(value("cos(90 deg)").value, 0, "cos of 90 degrees is exactly 0");
      equal(value("cos(60 deg)").value, 0.5, "cos of 60 degrees");
      near(value("tan(45 deg)").value, 1, 1e-12, "tan of 45 degrees");
      near(value("sin(pi / 2 * 1 rad)").value, 1, 1e-9, "radians work through the unit");
      near(value("atan(1)").value, 45, 1e-12, "atan gives degrees");
      equal(value("atan(1)").angle, 1, "and an angle");
      equal(value("sqrt(16)").value, 4, "sqrt");
      const root = value("sqrt(9 mm * 1 mm)");
      equal(root.value, 3, "sqrt of an area");
      equal(root.length, 1, "is a length");
      equal(value("abs(-3 mm)").value, 3, "abs");
      equal(value("abs(-3 mm)").length, 1, "abs keeps the dimension");
      equal(value("min(4, 2, 9)").value, 2, "min");
      equal(value("max(4 mm, 2 mm, 1 in)").value, 25.4, "max across units");
      equal(value("round(2.5)").value, 3, "round half up");
      equal(value("round(-2.5)").value, -3, "round half away from zero");
      equal(value("floor(2.9)").value, 2, "floor");
      equal(value("ceil(2.1)").value, 3, "ceil");
      equal(value("pi").value, Math.PI, "pi");
      equal(value("pi()").value, Math.PI, "pi() also works");
      equal(value("2 * pi").value, 2 * Math.PI, "pi in arithmetic");
    }
  },
  {
    name: "dimension mistakes are refused with the character where they happen",
    run: () => {
      const mixed = failure("1 mm + 1 deg");
      equal(mixed.position, 5, "adding a length and an angle points at the plus sign");
      assert(mixed.message.includes("length") && mixed.message.includes("angle"), "and names both");
      const bare = failure("sin(30)");
      equal(bare.position, 4, "sin of a bare number points at the argument");
      assert(bare.message.includes("needs an angle"), "and says an angle is needed");
      equal(failure("2 ^ (1 mm)").position, 5, "an exponent with a unit");
      equal(failure("(1 mm) ^ 0.5").position, 7, "a fractional power of a length");
      assert(failure("sqrt(2 mm)").message.includes("square root"), "the square root of a length that is not an area");
      assert(failure("min(1 mm, 1 deg)").message.includes("cannot compare"), "min of a length and an angle");
      assert(value("3 + 2 mm").length === 1, "a bare number beside a length takes the length unit");
      equal(value("3 + 2 mm").value, 5, "so 3 + 2 mm is 5 mm");
    }
  },
  {
    name: "syntax and arithmetic errors are deterministic and positioned",
    run: () => {
      equal(failure("2 + * 3").position, 4, "an operator where a value belongs");
      equal(failure("(1 + 2").position, 0, "a missing close bracket points at the open bracket");
      equal(failure("1 + 2)").position, 5, "an unmatched close bracket");
      equal(failure("1 / 0").position, 4, "division by zero points at the divisor");
      equal(failure("1 / (2 - 2)").position, 5, "also when the divisor is an expression");
      equal(failure("2 $ 3").position, 2, "an unexpected character");
      equal(failure("5 foo").position, 2, "a name glued to a number is not a unit");
      assert(failure("5 foo").message.includes("not a unit"), "and says so");
      assert(failure("1 +").message.includes("ends too early"), "an operator with nothing after it");
      equal(failure("1 +").position, 3, "at the end of the text");
      equal(failure("").position, 0, "empty text");
      assert(failure("   ").message.includes("empty"), "blank text is empty");
      assert(failure("foo(1)").message.includes("Unknown function"), "an unknown function");
      assert(failure("mm").message.includes("unit"), "a bare unit");
      assert(failure("sin").message.includes("function"), "a bare function name");
      assert(failure("max()").message.includes("takes"), "arity is checked");
      assert(failure("sqrt(-4)").message.includes("negative"), "sqrt of a negative");
      assert(failure("10 ^ 400").message.includes("too large"), "overflow is an error, not Infinity");
      assert(failure("1, 2").message.includes("comma"), "a stray comma");
      assert(failure("a.").message.includes("dot"), "a dot with no name after it");
      const deep = failure(`${"(".repeat(80)}1${")".repeat(80)}`);
      assert(deep.message.includes("nested too deeply"), "absurd nesting is refused instead of overflowing the stack");
      const long = failure(`1${"+1".repeat(300)}`);
      assert(long.message.includes("longer than"), "an over-long expression is refused");
      equal(describeExpressionError({ message: "x", position: 4, length: 1 }), "x (character 5)", "positions read from 1 for people");
      const first = evaluateExpression("1 + (2 * ", EMPTY_EXPRESSION_ENVIRONMENT);
      const second = evaluateExpression("1 + (2 * ", EMPTY_EXPRESSION_ENVIRONMENT);
      assert(JSON.stringify(first) === JSON.stringify(second), "the same text always gives the same error");
    }
  },
  {
    name: "names resolve through the environment, with owners, and an unknown name is positioned",
    run: () => {
      equal(value("2 * pin_r", environment).value, 8, "a parameter");
      equal(value("2 * pin_r", environment).length, 1, "keeps its dimension");
      equal(value("Extrude1.distance / 2 + 1.5 mm", environment).value, 7.5, "a feature value with arithmetic");
      equal(value("sin(tilt) * 10", environment).value, 5, "an angle parameter in a function");
      equal(value("count * pin_r", environment).value, 12, "a plain number times a length");
      const unknown = failure("pin_r + missing", environment);
      equal(unknown.position, 8, "an unknown name points at the name");
      assert(unknown.message.includes('"missing"'), "and quotes it");
      const owned = failure("1 + Nope.distance", environment);
      equal(owned.position, 4, "an unknown owner points at the start of the reference");
      assert(owned.message.includes("Nope.distance"), "and shows the whole reference");
      const parsed = parseExpression("pin_r * Extrude1.distance + pin_r");
      assert(parsed.ok, "it parses");
      if (!parsed.ok) return;
      equal(parsed.references.length, 3, "three references are collected");
      equal(parsed.references[1]!.owner, "Extrude1", "with their owner");
      equal(parsed.references[1]!.name, "distance", "and name");
      equal(parsed.references[1]!.start, 8, "and exact span");
      equal(parsed.references[1]!.end, 25, "to the end of the name");
    }
  },
  {
    name: "nothing is ever executed: prototype names, code-looking text and property tricks are just unknown names or syntax errors",
    run: () => {
      // The environment only knows its own table, so inherited object keys are not names.
      for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
        const result = evaluateExpression(name, environment);
        assert(!result.ok && result.error.message.includes("Unknown name"), `${name} is not a name`);
      }
      // Units are looked up with hasOwn, so a prototype key after a number is not a unit.
      assert(failure("2 constructor").message.includes("not a unit"), "constructor is not a unit");
      assert(failure("2 toString").message.includes("not a unit"), "toString is not a unit");
      for (const text of ["process.exit()", "globalThis.x", "(() => 1)()", "1; 2", "a = 1", "`1`", "'1'", "1 ? 2 : 3", "[1]", "{}", "import('x')", "x => x", "1 && 2", "1 % 2", "!1"]) {
        const result = evaluateExpression(text, environment);
        assert(!result.ok, `"${text}" is refused`);
      }
      assert(failure("process.exit()").message.length > 0, "a call to an unknown function is refused with a reason");
    }
  },
  {
    name: "renaming a parameter rewrites only whole-name references, never longer names, owners or fields",
    run: () => {
      const names = new Map([["pin_r", "post_r"]]);
      equal(renameParameterReferences("2 * pin_r + pin_r2", names), "2 * post_r + pin_r2", "pin_r2 is a different name");
      equal(renameParameterReferences("pin_r * Pin.pin_r", names), "post_r * Pin.pin_r", "a field called pin_r on a feature is not the parameter");
      equal(renameParameterReferences("max(pin_r, 3)", names), "max(post_r, 3)", "inside a function call");
      equal(renameParameterReferences("pin_r *", names), "pin_r *", "text that does not parse is left alone");
      const swapped = new Map([["a", "b"], ["b", "a"]]);
      equal(renameParameterReferences("a - b", swapped), "b - a", "two names can swap in one pass");
      equal(renameOwnerReferences("Extrude1.distance + Extrude1.angle + Extrude10.distance", new Map([["Extrude1", "Base"]])), "Base.distance + Base.angle + Extrude10.distance", "the owner of a reference is renamed exactly");
    }
  }
];
