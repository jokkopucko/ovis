import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateHcTypes, HC_METHODS, methodTypeName } from "./hc-types.ts";

const ROOT = join(import.meta.dir, "..");
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "scripts", "hc-schema.json"), "utf8"));
const GENERATED = join(ROOT, "server", "herdr-core", "hc-api.generated.ts");

function schemaWith(extra: { params?: unknown[]; result?: unknown; schemas?: Record<string, unknown> }) {
  return {
    info: { version: "0.0.0", license: { name: "Apache-2.0" } },
    methods: HC_METHODS.map((name) => ({
      name,
      params: name === "terminal.get" ? extra.params ?? [] : [],
      result: { schema: name === "terminal.get" ? extra.result ?? { type: "object" } : { type: "object" } },
    })),
    components: { schemas: extra.schemas ?? {} },
  };
}

describe("hc schema snapshot", () => {
  it("names every method Ovis calls", () => {
    const names = new Set(SCHEMA.methods.map((method: { name: string }) => method.name));
    expect(HC_METHODS.filter((method) => !names.has(method))).toEqual([]);
  });
});

describe("generateHcTypes", () => {
  it("types every called method's params and result in HcMethods", () => {
    const source = readFileSync(GENERATED, "utf8");
    for (const method of HC_METHODS) {
      expect(source).toContain(`${JSON.stringify(method)}: { params: ${methodTypeName(method)}Params;`);
    }
    expect(source).toContain('"terminal.get": { params: TerminalGetParams; result: Terminal };');
  });

  it("keeps required params required and the rest optional", () => {
    const out = generateHcTypes(schemaWith({
      params: [
        { name: "terminal", required: true, schema: { type: "string" } },
        { name: "caller", required: false, schema: { type: ["string", "null"] } },
      ],
    }));
    expect(out).toContain("export interface TerminalGetParams {\n  caller?: string | null;\n  terminal: string;\n}");
  });

  it("widens enums, makes fixed-length arrays tuples and maps to records", () => {
    const out = generateHcTypes(schemaWith({
      result: { $ref: "#/components/schemas/Shape" },
      schemas: {
        Shape: {
          type: "object",
          required: ["mode"],
          properties: {
            mode: { enum: ["working", "idle"] },
            cell: { type: ["array", "null"], items: { type: "integer" }, minItems: 2, maxItems: 2 },
            labels: { type: "object", additionalProperties: { type: "string" } },
            value: true,
          },
        },
      },
    }));
    expect(out).toContain('mode: "idle" | "working" | (string & {});');
    expect(out).toContain("cell?: [number, number] | null;");
    expect(out).toContain("labels?: Record<string, string>;");
    expect(out).toContain("value?: unknown;");
    expect(out).toContain('"terminal.get": { params: TerminalGetParams; result: Shape };');
  });

  it("fails when hc no longer has a method Ovis calls", () => {
    const schema = schemaWith({});
    schema.methods = schema.methods.filter((method) => method.name !== "terminal.send");
    expect(() => generateHcTypes(schema)).toThrow("terminal.send");
  });

  it("makes a union with an any-value variant any value", () => {
    const out = generateHcTypes(schemaWith({ result: { anyOf: [{ type: "string" }, {}] } }));
    expect(out).toContain('"terminal.get": { params: TerminalGetParams; result: unknown };');
  });

  it("is deterministic", () => {
    expect(generateHcTypes(SCHEMA)).toBe(generateHcTypes(structuredClone(SCHEMA)));
  });
});
