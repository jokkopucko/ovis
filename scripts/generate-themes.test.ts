import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DESIGN_BEGIN, DESIGN_END, OUTPUTS, renderAll, renderDesign, renderIndex, renderManifest, renderModule, SOURCE } from "./generate-themes.ts";

const ROOT = join(import.meta.dir, "..");
const GENERATOR = join(ROOT, "scripts", "generate-themes.ts");
const read = (root: string, file: string): string => readFileSync(join(root, file), "utf8");
const css = read(ROOT, SOURCE);

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "generate-themes-"));
  copies.push(dir);
  for (const file of [SOURCE, ...Object.values(OUTPUTS)]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

async function run(args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bun", "run", GENERATOR, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, output: stdout + stderr };
}

describe("generate-themes", () => {
  it("renders exactly the committed outputs from the committed CSS", () => {
    for (const { path, content } of renderAll(ROOT)) expect(content, path).toBe(read(ROOT, path));
  });

  it("is deterministic", () => {
    expect(renderModule(css)).toBe(renderModule(css));
    expect(renderAll(ROOT)).toEqual(renderAll(ROOT));
  });

  it("rejects missing light ANSI declarations and any dark ANSI declarations", () => {
    expect(() => renderModule(css.replace("--term-black: #2a251f;", ""))).toThrow("amber/light must declare --term-black");
    expect(() => renderModule(css.replace(":root {", ":root { --term-black: #123456;"))).toThrow("amber/dark must not declare --term-black");
  });

  it("rejects a duplicated, missing or out-of-order DESIGN.md marker, naming it", () => {
    const design = read(ROOT, OUTPUTS.design);
    expect(() => renderDesign(css, design.replace(DESIGN_BEGIN, `${DESIGN_BEGIN}\n${DESIGN_BEGIN}`))).toThrow(`DESIGN.md: marker ${DESIGN_BEGIN} found 2 times`);
    expect(() => renderDesign(css, design.replace(DESIGN_END, ""))).toThrow(`DESIGN.md: marker ${DESIGN_END} found 0 times`);
    expect(() => renderDesign(css, design.replace(DESIGN_BEGIN, "@@").replace(DESIGN_END, DESIGN_BEGIN).replace("@@", DESIGN_END))).toThrow("comes before");
  });

  it("rejects a theme-color meta tag or manifest key found other than once", () => {
    const html = read(ROOT, OUTPUTS.index);
    const tag = /<meta name="theme-color"[^>]*>/.exec(html)![0];
    expect(() => renderIndex(css, html.replace(tag, ""))).toThrow("found 0 times");
    expect(() => renderIndex(css, html.replace(tag, `${tag}\n${tag}`))).toThrow("found 2 times");
    const manifest = read(ROOT, OUTPUTS.manifest);
    expect(() => renderManifest(css, manifest.replace(/"theme_color": "[^"]*",\n/, ""))).toThrow('"theme_color" found 0 times');
  });

  it("counts a second target in any formatting as a duplicate", async () => {
    const html = read(ROOT, OUTPUTS.index);
    const tag = /<meta name="theme-color"[^>]*>/.exec(html)![0];
    for (const extra of ['<meta name="theme-color" content="#abcdef">', "<META content='#abcdef' NAME='theme-color'/>", "<meta  name=theme-color content=#abcdef>", '<meta content="a>b" name="theme&#45;color">', '<meta name="description" content="<!--">\n    <meta name="theme-color" content="#abcdef">\n    <!-- -->']) {
      expect(() => renderIndex(css, html.replace(tag, `${extra}\n    ${tag}`)), extra).toThrow("found 2 times");
    }
    const manifest = read(ROOT, OUTPUTS.manifest);
    for (const extra of ['"theme_color":"#abcdef",', '"background_color" :  "#abcdef",', '"theme\\u005fcolor": "#abcdef",']) {
      const key = extra.includes("background") ? "background_color" : "theme_color";
      expect(() => renderManifest(css, manifest.replace('"theme_color": ', `${extra}\n  "theme_color": `)), extra).toThrow(`"${key}" found 2 times`);
    }

    const root = copyRoot();
    writeFileSync(join(root, OUTPUTS.index), html.replace(tag, `<meta name="theme-color" content="#abcdef">\n    ${tag}`));
    const index = await run(["--check", "--root", root]);
    expect(index.exitCode).toBe(1);
    expect(index.output).toContain('index.html: marker <meta name="theme-color"> found 2 times');
    writeFileSync(join(root, OUTPUTS.index), html);
    writeFileSync(join(root, OUTPUTS.manifest), manifest.replace('"theme_color": ', '"theme_color":"#abcdef",\n  "theme_color": '));
    const json = await run(["--check", "--root", root]);
    expect(json.exitCode).toBe(1);
    expect(json.output).toContain('public/manifest.webmanifest: marker "theme_color" found 2 times');
  });

  it("counts only a real theme-color tag and real top-level manifest keys", async () => {
    const html = read(ROOT, OUTPUTS.index);
    const tag = /<meta name="theme-color"[^>]*>/.exec(html)![0];
    const lookalikes = [
      '<meta data-name="theme-color" content="#abcdef">',
      '<meta itemprop="name" content="theme-color">',
      '<meta name="theme-color-x" content="#abcdef">',
      '<meta content=" name=theme-color">',
      '<meta name="description" name="theme-color">',
      '<!-- <meta name="theme-color" content="#abcdef"> -->',
      '<script>const s = \'<meta name="theme-color">\';</script>',
    ];
    for (const lookalike of lookalikes) {
      expect(renderIndex(css, html.replace(tag, `${lookalike}\n    ${tag}`)), lookalike).toContain(lookalike);
      expect(() => renderIndex(css, html.replace(tag, lookalike)), lookalike).toThrow('index.html: marker <meta name="theme-color"> found 0 times');
    }
    const manifest = read(ROOT, OUTPUTS.manifest);
    for (const lookalike of ['"x_theme_color": "#abcdef",', '"note": "\\"theme_color\\": \\"#abcdef\\"",', '"extra": { "theme_color": "#abcdef" },', '"list": [{ "background_color": "#abcdef" }],']) {
      const rendered = renderManifest(css, manifest.replace('"theme_color": ', `${lookalike}\n  "theme_color": `));
      expect(rendered, lookalike).toContain(lookalike);
      expect(JSON.parse(rendered).theme_color).toBe("#1f1f1f");
    }
    expect(() => renderManifest(css, manifest.replace('"theme_color"', '"x_theme_color"'))).toThrow('"theme_color" found 0 times');

    for (const mode of [["--check"], []]) {
      const root = copyRoot();
      writeFileSync(join(root, OUTPUTS.index), html.replace(tag, `<meta name="description" content="<!--">\n    <meta name="theme-color" content="#abcdef">\n    <!-- -->\n    ${tag}`));
      const before = Object.values(OUTPUTS).map((file) => read(root, file));
      const result = await run([...mode, "--root", root]);
      expect([result.exitCode, result.output.trim()]).toEqual([1, 'generate-themes: index.html: marker <meta name="theme-color"> found 2 times, expected exactly once']);
      expect(Object.values(OUTPUTS).map((file) => read(root, file))).toEqual(before);
    }

    for (const mode of [["--check"], []]) {
      const root = copyRoot();
      const broken = html.replace(tag, '<meta data-name="theme-color" content="#abcdef">');
      writeFileSync(join(root, OUTPUTS.index), broken);
      const before = Object.values(OUTPUTS).map((file) => read(root, file));
      const result = await run([...mode, "--root", root]);
      expect([result.exitCode, result.output.trim()]).toEqual([1, 'generate-themes: index.html: marker <meta name="theme-color"> found 0 times, expected exactly once']);
      expect(Object.values(OUTPUTS).map((file) => read(root, file))).toEqual(before);
    }
  });

  it("changes nothing outside the DESIGN.md region", () => {
    const design = read(ROOT, OUTPUTS.design);
    const edited = design.replace(/(\| Surface\/base \| `--bg` \| `)#[0-9a-f]{6}/, "$1#000000");
    expect(edited).not.toBe(design);
    const rendered = renderDesign(css, edited);
    expect(rendered).toBe(design);
    const outside = (text: string): string[] => [text.slice(0, text.indexOf(DESIGN_BEGIN)), text.slice(text.indexOf(DESIGN_END))];
    expect(outside(rendered)).toEqual(outside(edited));
  });

  it("writes every copy from src/styles.css and never writes the CSS", async () => {
    const root = copyRoot();
    const source = read(root, SOURCE).replace("--bg-panel: #181613;", "--bg-panel: #1a1714;").replace("--bg-panel: #1f1f1f;", "--bg-panel: #202020;");
    expect(source).not.toBe(css);
    writeFileSync(join(root, SOURCE), source);

    const stale = await run(["--check", "--root", root]);
    expect(stale.exitCode).toBe(1);
    for (const file of Object.values(OUTPUTS)) expect(stale.output).toContain(`STALE ${file} - Run: bun run generate:themes`);
    expect(read(root, OUTPUTS.module)).toBe(read(ROOT, OUTPUTS.module));

    expect((await run(["--root", root])).exitCode).toBe(0);
    expect(read(root, SOURCE)).toBe(source);
    expect(read(root, OUTPUTS.module)).toContain('bgPanel: "#1a1714"');
    expect(read(root, OUTPUTS.design)).toContain("| Surface/panel | `--bg-panel` | `#1a1714` |");
    expect(read(root, OUTPUTS.index)).toContain('<meta name="theme-color" content="#202020" />');
    expect(JSON.parse(read(root, OUTPUTS.manifest)).theme_color).toBe("#202020");

    const fresh = await run(["--check", "--root", root]);
    expect([fresh.exitCode, fresh.output.trim()]).toEqual([0, "generated themes are up to date"]);
  });

  it("fails --check with the marker named when a copy cannot be generated", async () => {
    const root = copyRoot();
    writeFileSync(join(root, OUTPUTS.design), read(root, OUTPUTS.design).replace(DESIGN_BEGIN, `${DESIGN_BEGIN}\n${DESIGN_BEGIN}`));
    const result = await run(["--check", "--root", root]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`marker ${DESIGN_BEGIN} found 2 times`);
  });

  it("generates terminal rows from CSS and detects a stale terminal copy", async () => {
    const root = copyRoot();
    const source = read(root, SOURCE).replace("--term-bg: #181613;", "--term-bg: #1a1714;");
    expect(source).not.toBe(css);
    writeFileSync(join(root, SOURCE), source);

    expect((await run(["--root", root])).exitCode).toBe(0);
    const design = read(root, OUTPUTS.design);
    expect(design).toContain("| Terminal/background | `--term-bg` | `#1a1714` |");
    expect((await run(["--check", "--root", root])).exitCode).toBe(0);

    writeFileSync(join(root, OUTPUTS.design), design.replace("| Terminal/background | `--term-bg` | `#1a1714` |", "| Terminal/background | `--term-bg` | `#000000` |"));
    const stale = await run(["--check", "--root", root]);
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain("STALE DESIGN.md");
  });
});
