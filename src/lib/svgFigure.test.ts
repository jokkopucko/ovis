import { expect, it } from "bun:test";

import { SVG_FIGURE_MAX_LENGTH, svgFigurePalette, svgFigureUrl } from "./svgFigure.ts";

const decode = (url: string | null): string => {
  expect(url).not.toBeNull();
  const prefix = "data:image/svg+xml;charset=utf-8,";
  expect(url!.startsWith(prefix)).toBe(true);
  return decodeURIComponent(url!.slice(prefix.length));
};

it("keeps a fence that is not a whole figure yet as code", () => {
  expect(svgFigureUrl('<svg viewBox="0 0 10 10"><rect', { fg: "#fff" })).toBeNull();
  expect(svgFigureUrl("not svg at all", { fg: "#fff" })).toBeNull();
});

it("resolves theme tokens, a fallback for an unknown one, and the text color otherwise", () => {
  const svg = decode(svgFigureUrl(
    '<svg viewBox="0 0 10 10"><rect fill="var(--accent)"/><rect fill="var(--nope, rgb(1, 2, 3))"/><rect fill="var(--nope)"/></svg>',
    { fg: "#eee", accent: "#f0a830" },
  ));
  expect(svg).toContain('fill="#f0a830"');
  expect(svg).toContain('fill="rgb(1, 2, 3)"');
  expect(svg).toContain('fill="#eee"');
  expect(svg).not.toContain("var(");
});

it("gives the root what an image document cannot inherit, and keeps what it already says", () => {
  const sized = decode(svgFigureUrl('<svg viewBox="0 0 900 560"><text fill="currentColor">x</text></svg>', { fg: "#eee" }));
  expect(sized).toMatch(/^<svg color="#eee" font-family="sans-serif" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="900" height="560" viewBox/);

  const own = decode(svgFigureUrl('<svg xmlns="http://www.w3.org/2000/svg" width="40" color="red" viewBox="0 0 900 560"></svg>', { fg: "#eee" }));
  expect(own).not.toContain('color="#eee"');
  expect(own).not.toContain('width="900"');
});

it("reads each token from its theme role", () => {
  const roles: Record<string, string> = { "--text": " #d8d0c3 ", "--status-done": "#93c36b" };
  const palette = svgFigurePalette((property) => roles[property] ?? "");
  expect(palette).toEqual({ fg: "#d8d0c3", success: "#93c36b" });
});

it("keeps a figure that could run or load something as code", () => {
  const unsafe = [
    '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>',
    '<svg/onload="alert(1)" viewBox="0 0 10 10"></svg>',
    '<svg viewBox="0 0 10 10"><set attributeName="onload" to="alert(1)"/></svg>',
    '<svg viewBox="0 0 10 10"><rect ONCLICK = "x()"/></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject><div>x</div></foreignObject></svg>',
    '<svg viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
    '<svg viewBox="0 0 10 10"><use xlink:href="other.svg#a"/></svg>',
    '<svg viewBox="0 0 10 10"><image href = " data:image/png;base64,AAAA"/></svg>',
    '<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg viewBox="0 0 10 10"><rect style="fill: url(https://example.com/x)"/></svg>',
    '<svg viewBox="0 0 10 10"><style>@import "https://example.com/x.css";</style></svg>',
    '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg viewBox="0 0 10 10"><text>&a;</text></svg>',
    '<svg viewBox="0 0 10 10"><rect style="fill: u&#114;l(https://example.com/x)"/></svg>',
    '<svg viewBox="0 0 10 10"><style>&#x40;import "https://example.com/x.css";</style></svg>',
    '<svg viewBox="0 0 10 10"><image h&#114;ef="https://example.com/a.png"/></svg>',
  ];
  for (const source of unsafe) expect(svgFigureUrl(source, { fg: "#eee" })).toBeNull();
});

it("keeps a style that holds an element as code, since the element would split a CSS token past the checks", () => {
  const split = [
    '<svg viewBox="0 0 10 10"><style>@im<g/>port "https://example.com/x.css";</style></svg>',
    '<svg viewBox="0 0 10 10"><style>rect { fill: u<g/>rl(https://example.com/x) }</style></svg>',
    '<svg viewBox="0 0 10 10"><style>rect { fill: image<g/>-set("https://example.com/x" 1x) }</style></svg>',
    '<svg xmlns:é="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><é:style>@im<é:g/>port "https://example.com/x.css";</é:style></svg>',
    '<svg viewBox="0 0 10 10"><style>rect { fill: red }',
  ];
  for (const source of split) expect(svgFigureUrl(source, { fg: "#eee" })).toBeNull();
  expect(svgFigureUrl('<svg viewBox="0 0 10 10"><style>rect { fill: red }</style><rect width="1" height="1"/></svg>', { fg: "#eee" })).not.toBeNull();
});

it("draws a figure whose references stay inside it", () => {
  const svg = decode(svgFigureUrl(
    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/><path id="p" d="M0 0"/></defs><rect fill="url(#g)" style="fill: url( \'#g\' )"/><use href="#p"/><use xlink:href = \' #p\'/></svg>',
    { fg: "#eee" },
  ));
  expect(svg).toContain('fill="url(#g)"');
});

for (const prefix of ["é", "図", "😀"]) {
  it(`keeps executable elements with the ${prefix} namespace prefix as code`, () => {
    expect(svgFigureUrl(
      `<svg xmlns:${prefix}="http://www.w3.org/2000/svg"><${prefix}:script>alert(1)</${prefix}:script></svg>`,
      { fg: "#eee" },
    )).toBeNull();
  });

  it(`vets styles with the ${prefix} namespace prefix`, () => {
    expect(svgFigureUrl(
      `<svg xmlns:${prefix}="http://www.w3.org/2000/svg"><${prefix}:style>@\\69mport "https://example.com/x.css";</${prefix}:style></svg>`,
      { fg: "#eee" },
    )).toBeNull();
  });

  it(`keeps animation of an href with the ${prefix} namespace prefix as code`, () => {
    expect(svgFigureUrl(
      `<svg xmlns:${prefix}="http://www.w3.org/1999/xlink"><use href="#p"><set attributeName="${prefix}:href" to="https://example.com/x.svg#p"/></use></svg>`,
      { fg: "#eee" },
    )).toBeNull();
  });

  it(`vets attribute local names with the ${prefix} namespace prefix`, () => {
    for (const attribute of [`${prefix}:onload="alert(1)"`, `${prefix}:href="https://example.com/x"`,
      `${prefix}:attributeName="${prefix}:href" to="https://example.com/x"`]) {
      expect(svgFigureUrl(`<svg xmlns:${prefix}="http://www.w3.org/2000/svg"><set ${attribute}/></svg>`, { fg: "#eee" })).toBeNull();
    }
  });

  it(`draws safe elements and local references with the ${prefix} namespace prefix`, () => {
    const source = `<svg xmlns:${prefix}="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0"/></defs><${prefix}:g><${prefix}:style>path { fill: red; }</${prefix}:style><${prefix}:use href="#p"/></${prefix}:g></svg>`;
    expect(decode(svgFigureUrl(source, { fg: "#eee" }))).toContain(`<${prefix}:use href="#p"/>`);
  });
}

for (const element of ["iframe", "object", "embed", "link", "unknown", "é:foreignObject"]) {
  it(`keeps the non-drawing element ${element} as code`, () => {
    expect(svgFigureUrl(`<svg><${element}/></svg>`, { fg: "#eee" })).toBeNull();
  });
}

for (const [name, body] of [
  ["escaped paint URL", '<rect fill="u\\72l(https://example.com/x)"/>'],
  ["character-reference escaped paint URL", '<rect fill="u&#92;72l(https://example.com/x)"/>'],
  ["comment-split style URL", '<style>rect { fill: u<!--x-->rl(https://example.com/x); }</style>'],
  ["comment-split style import", '<style>@im<!--x-->port "https://example.com/x.css";</style>'],
  ["CDATA-split style URL", '<style>rect { fill: u<![CDATA[r]]>l(https://example.com/x); }</style>'],
  ["XML base", '<g xml:base="https://example.com/"><use href="#p"/></g>'],
  ["animated XML base", '<set attributeName="xml:base" to="https://example.com/"/>'],
]) {
  it(`keeps ${name} as code`, () => {
    expect(svgFigureUrl(`<svg>${body}</svg>`, { fg: "#eee" })).toBeNull();
  });
}

it("draws safe style text, comments, CDATA and presentation attributes", () => {
  const source = '<svg><!-- a figure --><style><![CDATA[rect { fill: url(#g); }]]></style><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><text>é 図 😀</text></svg>';
  expect(decode(svgFigureUrl(source, { fg: "#eee" }))).toContain('<rect fill="url(#g)"/>');
});

it("keeps a figure past the size cap as code", () => {
  const body = "<rect/>".repeat(Math.ceil(SVG_FIGURE_MAX_LENGTH / 7));
  expect(svgFigureUrl(`<svg viewBox="0 0 10 10">${body}</svg>`, { fg: "#eee" })).toBeNull();
});

it("judges the markup as drawn, so a token cannot assemble an href, a handler or a script", () => {
  for (const source of [
    '<svg viewBox="0 0 10 10"><image hvar(--missing, ref)="https://example.com/x.png"/></svg>',
    '<svg viewBox="0 0 10 10"><rect onvar(--nope, load)="x()"/></svg>',
    '<svg viewBox="0 0 10 10"><var(--nope, script)>x</script></svg>',
  ]) expect(svgFigureUrl(source, { fg: "#eee" })).toBeNull();
});

it("keeps a figure no URL can carry, or whose root is not first, as code, and reads the root's quotes", () => {
  expect(svgFigureUrl('<svg viewBox="0 0 10 10"><text>\ud800</text></svg>', { fg: "#eee" })).toBeNull();
  expect(svgFigureUrl('<!-- <svg fake="yes"> --><svg viewBox="0 0 10 10"></svg>', { fg: "#eee" })).toBeNull();
  const quoted = decode(svgFigureUrl('<?xml version="1.0"?>\n<svg data-note="a>b" viewBox="0 0 900 560"></svg>', { fg: "#eee" }));
  expect(quoted).toMatch(/^<svg color="#eee"[^>]* width="900" height="560" data-note="a>b"/);
});

it("takes a token's fallback when its name is no palette entry, inherited ones included, however spaced", () => {
  expect(decode(svgFigureUrl(`<svg viewBox="0 0 10 10"><rect fill="var( --nope ,${" ".repeat(500)}red )"/></svg>`, { fg: "#eee" }))).toContain('fill="red"');
  expect(decode(svgFigureUrl('<svg viewBox="0 0 10 10"><rect fill="var(--toString, red)"/></svg>', { fg: "#eee" }))).toContain('fill="red"');
});

it("reads a fence in time that grows with its length, not its square", () => {
  const cpu = (): number => { const used = process.cpuUsage(); return (used.user + used.system) / 1000; };
  const shapes = [(n: number) => '<svg viewBox="0 0 1 1"><text>' + "var(--x," + " ".repeat(n) + "!</text></svg>", (n: number) => "<svg ".repeat(n / 5),
    (n: number) => '<svg viewBox="0 0 1 1"><a href=' + " ".repeat(n) + "x/></svg>",
    (n: number) => '<svg viewBox="0 0 1 1"><rect style="fill: url(' + " ".repeat(n) + 'x)"/></svg>',
    (n: number) => '<svg viewBox="0 0 1 1"><set attributeName="' + " ".repeat(n) + 'x"/></svg>',
    (n: number) => '<svg><g data-note="' + "x".repeat(n) + '"/></svg>',
    (n: number) => "<svg><" + "é".repeat(n) + ":g/></svg>",
    (n: number) => "<svg>" + "<!--".repeat(n / 4) + "</svg>",
    (n: number) => "<svg>" + "<![CDATA[".repeat(n / 9) + "</svg>"];
  for (const shape of shapes) {
    const small = shape(8_000);
    const large = shape(64_000);
    let fastestSmall = Infinity;
    let fastestLarge = Infinity;
    for (let round = 0; round < 5 && !(fastestLarge / Math.max(fastestSmall, 0.05) < 30); round += 1) {
      let start = cpu();
      for (let run = 0; run < 20; run += 1) svgFigureUrl(small, { fg: "#eee" });
      fastestSmall = Math.min(fastestSmall, cpu() - start);
      start = cpu();
      for (let run = 0; run < 20; run += 1) svgFigureUrl(large, { fg: "#eee" });
      fastestLarge = Math.min(fastestLarge, cpu() - start);
    }
    expect(fastestLarge / Math.max(fastestSmall, 0.05)).toBeLessThan(30);
  }
});
