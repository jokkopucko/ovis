/**
 * TypeScript types for the herdr-core (`hc`) API, generated from hc's own OpenRPC document
 * (`hc schema`, herdr-core's schema/hc.openrpc.json, Apache-2.0). `generate-protocol-types.ts`
 * writes them to server/herdr-core/hc-api.generated.ts beside herdr's own wire types.
 *
 * Shape decisions, and why:
 *
 * - Only the methods Ovis calls are emitted, with the closure of the records they name, as for
 *   herdr's types. A method added here is typed from then on.
 * - Each method's params become `<Method>Params` (`terminal.attach` → `TerminalAttachParams`); a
 *   param is optional unless the schema marks it required. `HcMethods` maps every method to its
 *   params and result, which is what `HcConnection.call` and `open` are typed by.
 * - String enums widen with `(string & {})`, as herdr's do: hc grows its vocabulary between
 *   releases, and a word from a newer core must still flow through.
 * - Output is deterministic (sorted, no timestamps), so regenerating an unchanged schema is a
 *   no-op diff.
 */

type Json = Record<string, any>;

/** The hc methods Ovis calls: their params, results and every record those name are emitted. */
export const HC_METHODS = [
  "doc.get",
  "events.subscribe",
  "hello",
  "server.status",
  "terminal.attach",
  "terminal.get",
  "terminal.keys",
  "terminal.kill",
  "terminal.label",
  "terminal.list",
  "terminal.read",
  "terminal.rm",
  "terminal.run",
  "terminal.send",
] as const;

const REF_PREFIX = "#/components/schemas/";

function refName(ref: string): string {
  if (!ref.startsWith(REF_PREFIX)) throw new Error(`unsupported $ref: ${ref}`);
  return ref.slice(REF_PREFIX.length);
}

/** `terminal.attach` → `TerminalAttach` */
export function methodTypeName(method: string): string {
  return method.split(/[._]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function walkRefs(node: unknown, onRef: (name: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, onRef);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$ref" && typeof value === "string") onRef(refName(value));
    else walkRefs(value, onRef);
  }
}

function tsType(def: unknown, indent: string): string {
  // `true` (and `{}`) is JSON Schema for "any value"
  if (def === true || !def || typeof def !== "object" || Object.keys(def).length === 0) return "unknown";
  const node = def as Json;
  if (node.$ref) return refName(node.$ref);
  if (node.enum) {
    const literals = [...node.enum].sort().map((value: unknown) => JSON.stringify(value));
    return `${literals.join(" | ")} | (string & {})`;
  }
  if (node.anyOf || node.oneOf) {
    const variants: unknown[] = node.anyOf ?? node.oneOf;
    const rendered = [...new Set(variants.map((variant) => tsType(variant, indent)))];
    // a variant that admits any value makes the whole union any value
    return rendered.includes("unknown") ? "unknown" : rendered.join(" | ");
  }
  const types: string[] = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nullable = types.includes("null");
  const primary = types.filter((type) => type !== "null");
  if (primary.length === 0) return nullable ? "null" : "unknown";
  const render = (kind: string): string => {
    switch (kind) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "array": {
        const item = tsType(node.items, indent);
        // a fixed-length array of one kind (Display's `cell`) is a tuple
        if (typeof node.minItems === "number" && node.minItems === node.maxItems && node.minItems > 0 && node.minItems <= 4) {
          return `[${Array.from({ length: node.minItems }, () => item).join(", ")}]`;
        }
        return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
      }
      case "object":
        if (node.properties) return renderObject(node, indent);
        if (node.additionalProperties && node.additionalProperties !== true) return `Record<string, ${tsType(node.additionalProperties, indent)}>`;
        return "Record<string, unknown>";
      default:
        return "unknown";
    }
  };
  const body = primary.map(render).join(" | ");
  return nullable ? `${body} | null` : body;
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function renderFields(fields: { key: string; required: boolean; schema: unknown }[], indent: string): string {
  if (fields.length === 0) return "Record<string, never>";
  const inner = `${indent}  `;
  const lines = [...fields]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((field) => `${inner}${propertyKey(field.key)}${field.required ? "" : "?"}: ${tsType(field.schema, inner)};`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function renderObject(def: Json, indent: string): string {
  const required: string[] = def.required ?? [];
  const properties: Json = def.properties ?? {};
  return renderFields(Object.keys(properties).map((key) => ({ key, required: required.includes(key), schema: properties[key] })), indent);
}

function declaration(name: string, def: Json): string {
  if (def.type === "object" && def.properties) return `export interface ${name} ${renderObject(def, "")}`;
  return `export type ${name} = ${tsType(def, "")};`;
}

export function generateHcTypes(schema: Json): string {
  const methods: Json[] = schema.methods ?? [];
  const records: Json = schema.components?.schemas ?? {};
  const found = new Set<string>();
  const visit = (name: string): void => {
    if (found.has(name)) return;
    const def = records[name];
    if (!def) throw new Error(`missing schema ${name}`);
    found.add(name);
    walkRefs(def, visit);
  };

  const declarations = new Map<string, string>();
  const entries: string[] = [];
  for (const method of HC_METHODS) {
    const spec = methods.find((candidate) => candidate.name === method);
    if (!spec) throw new Error(`hc's schema has no method ${method}`);
    const params: Json[] = spec.params ?? [];
    walkRefs(params.map((param) => param.schema), visit);
    walkRefs(spec.result?.schema, visit);
    const base = methodTypeName(method);
    const paramsName = `${base}Params`;
    if (records[paramsName]) throw new Error(`${paramsName} would shadow hc's own schema of that name`);
    declarations.set(paramsName, params.length === 0
      ? `export type ${paramsName} = Record<string, never>;`
      : `export interface ${paramsName} ${renderFields(params.map((param) => ({ key: param.name, required: param.required === true, schema: param.schema })), "")}`);
    entries.push(`  ${JSON.stringify(method)}: { params: ${paramsName}; result: ${tsType(spec.result?.schema, "  ")} };`);
  }
  for (const name of found) declarations.set(name, declaration(name, records[name]));

  const body = [...declarations.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text);

  const header = [
    "/**",
    " * GENERATED FILE - DO NOT EDIT.",
    " *",
    ` * Source: herdr-core (hc) OpenRPC schema, hc ${schema.info?.version}, ${schema.info?.license?.name ?? "unknown license"}.`,
    " * Regenerate with: bun run generate:types",
    " * Verify freshness with: bun run generate:types --check",
    " */",
    "",
  ].join("\n");
  const map = [
    "/** Every hc method Ovis calls, with its params and its result. */",
    "export interface HcMethods {",
    ...entries,
    "}",
    "",
    "export type HcMethod = keyof HcMethods;",
  ].join("\n");
  return `${header}\n${body.join("\n\n")}\n\n${map}\n`;
}
