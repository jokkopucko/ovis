import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { evaluate, evaluateValue } from "./workflow-expression.ts";

describe("workflow expressions, as GitHub evaluates them", () => {
  test("loose equality: null, false, 0 and '' are equal across types; mixed types compare as numbers; strings ignore case", () => {
    for (const [expression, value] of [
      ["null == ''", true], ["null == false", true], ["null == 0", true], ["null == '0'", true], ["null == null", true],
      ["null == 'x'", false], ["null == true", false], ["null == 1", false], ["null != ''", false],
      ["false == 0", true], ["'1' == 1", true], ["true == '1'", true], ["'abc' == 'ABC'", true], ["'abc' == 0", false],
      ["inputs.missing == false", true], ["inputs.missing == ''", true], ["inputs.missing != false", false],
    ] as const) {
      expect([expression, evaluate(expression, { inputs: {} })]).toEqual([expression, value]);
    }
  });

  test("an object or array equals only itself, never null", () => {
    expect(evaluate("github.event == null", { github: { event: {} } })).toBe(false);
    expect(evaluate("fromJSON('[]') == null", {})).toBe(false);
  });

  test("&& and || return an operand; ! binds tighter than ==, == than &&, && than ||", () => {
    expect(evaluate("inputs.x && 'a' || 'b'", { inputs: {} })).toBe("b");
    expect(evaluate("inputs.x && 'a' || 'b'", { inputs: { x: true } })).toBe("a");
    expect(evaluate("'' || null", {})).toBeNull();
    expect(evaluate("!inputs.x == true", { inputs: {} })).toBe(true);
    expect(evaluate("true || false && false", {})).toBe(true);
  });

  test("contexts ignore case, functions follow GitHub, a whole ${{ }} keeps its type", () => {
    expect(evaluate("GitHub.Ref", { github: { ref: "refs/heads/main" } })).toBe("refs/heads/main");
    expect(evaluate("contains(fromJSON('[\"Self-Hosted\"]'), 'self-hosted')", {})).toBe(true);
    expect(evaluate("contains('ubuntu-24.04', 'UBUNTU')", {})).toBe(true);
    expect(evaluateValue("${{ fromJSON('[1,2]') }}", {})).toEqual([1, 2]);
    expect(evaluateValue("a-${{ 'b' }}-${{ 1 }}", {})).toBe("a-b-1");
    expect(evaluateValue("inputs.missing == false", { inputs: {} }, true)).toBe(true);
  });
});

test("only the light-runner job test uses this helper, never a security rule", () => {
  const users = spawnSync("git", ["grep", "-l", "workflow-expression", "--", "*.ts", "*.tsx"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  expect(users, "This helper evaluates both sides of && and || and skips format()'s {{ }} escapes, so it is not GitHub's evaluator: keep security rules such as scripts/privileged-jobs-workflow.test.ts off it.")
    .toEqual(["scripts/light-runner-workflow.test.ts", "scripts/workflow-expression.test.ts"]);
});
