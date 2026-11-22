import { afterEach, beforeEach, expect, it } from "bun:test";

import type { UserFont } from "../../shared/user-fonts.ts";
import { nativeTransport, setTransport } from "./transport.ts";
import { addServedFonts } from "./userFonts.ts";

interface Made { family: string; source: string; weight?: string; style?: string }

let asked: string[];
let made: Made[];
const added: Made[] = [];
const fontSet = { add: (face: FontFace) => { added.push(face as unknown as Made); return fontSet as unknown as FontFaceSet; } };

const font = (file: string, family: string, weight: 400 | 700 = 400, style: "normal" | "italic" = "normal"): UserFont => ({ file, family, weight, style, bytes: 4, version: "4-1" });

function serving(fonts: readonly UserFont[] | null): void {
  setTransport({ ...nativeTransport, fetch: async (input) => {
    const url = new URL(String(input), "http://pc.test");
    asked.push(url.pathname + url.search);
    if (url.pathname === "/api/fonts") return fonts === null ? new Response("{}", { status: 404 }) : Response.json({ fonts });
    return new Response(decodeURIComponent(url.pathname.slice("/api/fonts/".length)));
  } });
}

beforeEach(() => {
  asked = [];
  made = [];
  added.length = 0;
  globalThis.FontFace = class {
    readonly loaded = Promise.resolve();
    readonly family: string; readonly source: string; readonly weight?: string; readonly style?: string;
    constructor(family: string, source: ArrayBuffer, descriptors: FontFaceDescriptors) {
      this.family = family;
      this.source = new TextDecoder().decode(source);
      this.weight = descriptors.weight;
      this.style = descriptors.style;
      made.push(this);
    }
  } as unknown as typeof FontFace;
});
afterEach(() => {
  setTransport(nativeTransport);
  delete (globalThis as { FontFace?: unknown }).FontFace;
});

it("asks the PC nothing while no font is named", async () => {
  serving([font("Alpha.ttf", "Alpha")]);
  await addServedFonts("", fontSet);
  await addServedFonts(" , ", fontSet);
  expect(asked).toEqual([]);
  expect(added).toEqual([]);
});

it("adds every face of a named family the PC serves, once, and no other family", async () => {
  serving([font("QA Mono-Regular.ttf", "QA Mono"), font("QA Mono-BoldItalic.woff2", "QA Mono", 700, "italic"), font("D2Coding.ttf", "D2Coding")]);
  await addServedFonts('Menlo, "qa mono"', fontSet);
  await addServedFonts('Menlo, "qa mono"', fontSet);
  expect(added.map(({ family, source, weight, style }) => ({ family, source, weight, style }))).toEqual([
    { family: "QA Mono", source: "QA Mono-Regular.ttf", weight: "400", style: "normal" },
    { family: "QA Mono", source: "QA Mono-BoldItalic.woff2", weight: "700", style: "italic" },
  ]);
  expect(asked).toEqual(["/api/fonts", "/api/fonts/QA%20Mono-Regular.ttf?v=4-1", "/api/fonts/QA%20Mono-BoldItalic.woff2?v=4-1"]);
});

it("gives FontFace the family as it is, never quoted, whatever CSS would need to read it bare", async () => {
  // FontFace takes its family literally: a quoted one is a family named with the quotes, which no stack names
  serving([font("1st.Mono+X.ttf", "1st.Mono+X")]);
  await addServedFonts('"1st.Mono+X"', fontSet);
  expect(added.map(({ family }) => family)).toEqual(["1st.Mono+X"]);
});

it("adds nothing from a server without the route, and fails no one", async () => {
  serving(null);
  await addServedFonts("Gamma", fontSet);
  expect(asked).toEqual(["/api/fonts"]);
  expect(made).toEqual([]);
});
