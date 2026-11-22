// GitHub Actions expressions, the part of the language the workflows use, evaluated against contexts a test gives:
// literals, context paths (case-insensitive), `!`, `==`/`!=` (strings compared ignoring case, mixed types as numbers),
// `&&`/`||` (which return an operand, as GitHub's do), and fromJSON, toJSON, contains, startsWith, endsWith, format and
// the status functions.

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Contexts = Record<string, Value>;

type Token = { kind: "string" | "number" | "name" | "op"; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let at = 0; at < source.length; ) {
    const rest = source.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) { at += space[0].length; continue; }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string) { tokens.push({ kind: "string", text: string[1]!.replace(/''/g, "'") }); at += string[0].length; continue; }
    const number = /^-?\d+(\.\d+)?/.exec(rest);
    if (number) { tokens.push({ kind: "number", text: number[0] }); at += number[0].length; continue; }
    const name = /^[A-Za-z_][\w-]*/.exec(rest);
    if (name) { tokens.push({ kind: "name", text: name[0] }); at += name[0].length; continue; }
    const op = /^(==|!=|&&|\|\||[!().,[\]])/.exec(rest);
    if (!op) throw new Error(`cannot read the expression at: ${rest}`);
    tokens.push({ kind: "op", text: op[0] });
    at += op[0].length;
  }
  return tokens;
}

export const truthy = (value: Value): boolean => !(value === null || value === false || value === 0 || value === "" || Number.isNaN(value));
const asNumber = (value: Value): number => (value === null ? 0 : typeof value === "boolean" ? Number(value) : typeof value === "number" ? value : typeof value === "string" ? (value.trim() === "" ? 0 : Number(value)) : NaN);
function equal(left: Value, right: Value): boolean {
  if (typeof left === "string" && typeof right === "string") return left.toLowerCase() === right.toLowerCase();
  // null is no object here: against another type it counts as 0, as false and '' do
  if (left === null || right === null) {
    const other = left === null ? right : left;
    return other === null || (typeof other !== "object" && asNumber(other) === 0);
  }
  if (typeof left === "object" || typeof right === "object") return left === right;
  return typeof left === typeof right ? left === right : asNumber(left) === asNumber(right);
}
const text = (value: Value): string => (value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
function member(object: Value, key: string): Value {
  if (object === null || typeof object !== "object") return null;
  if (Array.isArray(object)) return /^\d+$/.test(key) ? (object[Number(key)] ?? null) : null;
  const found = Object.keys(object).find((name) => name.toLowerCase() === key.toLowerCase());
  return found === undefined ? null : (object[found] ?? null);
}

const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  fromjson: (value) => JSON.parse(text(value)) as Value,
  tojson: (value) => JSON.stringify(value, null, 2),
  contains: (search, item) => (Array.isArray(search) ? search.some((entry) => equal(entry, item)) : text(search).toLowerCase().includes(text(item).toLowerCase())),
  startswith: (value, prefix) => text(value).toLowerCase().startsWith(text(prefix).toLowerCase()),
  endswith: (value, suffix) => text(value).toLowerCase().endsWith(text(suffix).toLowerCase()),
  format: (pattern, ...args) => text(pattern).replace(/\{(\d+)\}/g, (_, index: string) => text(args[Number(index)] ?? null)),
  always: () => true,
  success: () => true,
  failure: () => false,
  cancelled: () => false,
};

export function evaluate(expression: string, contexts: Contexts): Value {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = (text?: string): boolean => tokens[at] !== undefined && (text === undefined || (tokens[at]!.kind === "op" && tokens[at]!.text === text));
  const expect = (text: string): void => {
    if (!peek(text)) throw new Error(`expected '${text}' in: ${expression}`);
    at++;
  };
  const or = (): Value => {
    let left = and();
    while (peek("||")) { at++; const right = and(); left = truthy(left) ? left : right; }
    return left;
  };
  const and = (): Value => {
    let left = equality();
    while (peek("&&")) { at++; const right = equality(); left = truthy(left) ? right : left; }
    return left;
  };
  const equality = (): Value => {
    let left = unary();
    while (peek("==") || peek("!=")) { const negate = tokens[at++]!.text === "!="; const right = unary(); left = equal(left, right) !== negate; }
    return left;
  };
  const unary = (): Value => {
    if (peek("!")) { at++; return !truthy(unary()); }
    return postfix();
  };
  const postfix = (): Value => {
    let value = primary();
    for (;;) {
      if (peek(".")) { at++; value = member(value, tokens[at++]!.text); }
      else if (peek("[")) { at++; const key = or(); expect("]"); value = member(value, text(key)); }
      else return value;
    }
  };
  const primary = (): Value => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`the expression ends early: ${expression}`);
    if (token.kind === "string") return token.text;
    if (token.kind === "number") return Number(token.text);
    if (token.kind === "op" && token.text === "(") { const value = or(); expect(")"); return value; }
    if (token.kind !== "name") throw new Error(`unexpected '${token.text}' in: ${expression}`);
    const name = token.text.toLowerCase();
    if (name === "true" || name === "false") return name === "true";
    if (name === "null") return null;
    if (peek("(")) {
      at++;
      const args: Value[] = [];
      while (!peek(")")) { args.push(or()); if (peek(",")) at++; }
      expect(")");
      const call = FUNCTIONS[name];
      if (call === undefined) throw new Error(`unknown function ${token.text} in: ${expression}`);
      return call(...args);
    }
    return member(contexts, token.text);
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`cannot read past '${tokens[at]!.text}' in: ${expression}`);
  return value;
}

/** A workflow value: one whole `${{ }}` gives its value, text around expressions makes a string; `if:` may omit `${{ }}`. */
export function evaluateValue(value: unknown, contexts: Contexts, isCondition = false): Value {
  if (typeof value !== "string") return (value ?? null) as Value;
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value);
  if (whole && !whole[1]!.includes("}}")) return evaluate(whole[1]!, contexts);
  if (isCondition && !value.includes("${{")) return evaluate(value, contexts);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression: string) => text(evaluate(expression, contexts)));
}
