import { describe, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BETA_LINKS } from "../ovis-site/assets/beta.js";
import { fail, files, read, repo } from "./source-scan.ts";

// ovis.sh (ovis-site/) is plain HTML with no build, so what a build would keep in step is written
// by hand: the JSON-LD repeats the visible FAQ, the sitemap and hreflang name the same pages,
// llms.txt and _headers name paths that exist. These tests keep them true.

const ORIGIN = "https://ovis.sh";
const PAGES = files("ovis-site/**/*.html");
const HOME = "ovis-site/index.html";
/** Visible FAQ questions left out of the FAQPage on purpose, each with why. */
const LEFT_OUT: Record<string, string> = {
  "How much does Ovis cost?": "its \"no analytics\" sentence is under review: the PC side sends anonymous usage counts by default",
};
/** schema.org properties the repo states nothing for; structured data must not invent them. */
const UNSTATED = ["aggregateRating", "review", "reviewRating", "softwareVersion", "datePublished", "dateModified", "dateCreated", "releaseNotes", "downloadUrl", "installUrl", "fileSize"];

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    if (entity[0] !== "#") return named[entity.toLowerCase()]!;
    return String.fromCodePoint(entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
/** The text a reader sees: tags stripped, entities decoded, whitespace collapsed. */
const visible = (html: string): string => decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
/** The page script's key for #i18n-data: the HTML with whitespace collapsed. */
const norm = (html: string): string => html.replace(/\s+/g, " ").trim();

const html = (file: string): string => read(file);
const headOf = (file: string): string => html(file).split("</head>")[0]!;
const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name!.toLowerCase(), decode(value!)]));
const tags = (file: string, name: "link" | "meta"): Record<string, string>[] =>
  [...headOf(file).matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(([tag]) => attrs(tag));
const meta = (file: string, key: string): string | undefined =>
  tags(file, "meta").find((tag) => tag["name"] === key || tag["property"] === key)?.["content"];
const title = (file: string): string => visible(/<title>([\s\S]*?)<\/title>/.exec(headOf(file))?.[1] ?? "");
const noindex = (file: string): boolean => /noindex/.test(meta(file, "robots") ?? "");

/** The address Cloudflare Pages serves a file at: `privacy/index.html` is `/privacy/`. */
const urlOf = (file: string): string => `${ORIGIN}/${file.replace(/^ovis-site\//, "").replace(/(^|\/)index\.html$/, "$1")}`;
/** The file behind an ovis.sh address, or undefined when it is not on ovis.sh. */
const fileOf = (url: string): string | undefined => {
  if (!url.startsWith(`${ORIGIN}/`)) return undefined;
  const path = new URL(url).pathname.slice(1);
  return `ovis-site/${path === "" || path.endsWith("/") ? `${path}index.html` : path}`;
};
const indexable = PAGES.filter((file) => !noindex(file));
const hreflangs = (file: string): string[] =>
  tags(file, "link").filter((tag) => tag["rel"] === "alternate" && tag["hreflang"]).map((tag) => `${tag["hreflang"]} ${tag["href"]}`).sort();

describe("ovis.sh pages", () => {
  it("finds the pages", () => {
    fail(PAGES.includes(HOME) ? [] : [HOME], "These tests read the home page at this path; point HOME in scripts/ovis-site.test.ts at where it is now:");
    fail(indexable.includes(HOME) ? [] : [HOME], "The home page must stay in search: take <meta name=\"robots\" content=\"noindex\"> out of its <head>:");
  });

  it("each name one absolute https://ovis.sh canonical, their own address when indexable", () => {
    // 404.html answers for any missing address, so no single address is its canonical
    const offenders = PAGES.filter((file) => file !== "ovis-site/404.html").flatMap((file) => {
      const canonicals = tags(file, "link").filter((tag) => tag["rel"] === "canonical").map((tag) => tag["href"] ?? "");
      if (canonicals.length !== 1 || !canonicals[0]!.startsWith(`${ORIGIN}/`)) return [`${file}: has ${JSON.stringify(canonicals)}`];
      return !noindex(file) && canonicals[0] !== urlOf(file) ? [`${file}: names ${canonicals[0]}, not ${urlOf(file)}`] : [];
    });
    fail(offenders, `Give each page exactly one <link rel="canonical" href="…"> in <head>, an absolute ${ORIGIN}/ address; an indexable page names its own address (privacy/index.html is ${ORIGIN}/privacy/).`);
  });

  it("keep 404.html out of search", () => {
    fail(noindex("ovis-site/404.html") ? [] : ["ovis-site/404.html"], "Keep <meta name=\"robots\" content=\"noindex\"> in the <head> of 404.html: it answers for every missing address.");
  });

  it("give each language pair the same hreflang group, pointing at existing indexable pages", () => {
    const offenders = PAGES.flatMap((file) => {
      const group = hreflangs(file);
      if (!group.length) return [];
      const problems: string[] = [];
      if (!group.some((entry) => entry.endsWith(` ${urlOf(file)}`))) problems.push(`${file}: its group does not name the page itself (${urlOf(file)})`);
      if (!group.some((entry) => entry.startsWith("x-default "))) problems.push(`${file}: its group has no x-default`);
      for (const entry of group) {
        const href = entry.split(" ")[1]!;
        const target = fileOf(href);
        if (!target || !existsSync(join(repo, target))) problems.push(`${file}: ${entry} is not a page in ovis-site/`);
        else if (noindex(target)) problems.push(`${file}: ${entry} points at a noindex page`);
        else if (JSON.stringify(hreflangs(target)) !== JSON.stringify(group)) problems.push(`${file}: ${target} has ${JSON.stringify(hreflangs(target))}, not ${JSON.stringify(group)}`);
      }
      return problems;
    });
    fail(offenders, "Every page of a language group carries the same <link rel=\"alternate\" hreflang=\"…\" href=\"…\"> set, itself included, plus x-default, each href an indexable page in ovis-site/. Change all the pages of the group together.");
  });

  it("keep titles to 60 characters and descriptions to 160, the same in their og: and twitter: copies", () => {
    const offenders = indexable.flatMap((file) => {
      const problems: string[] = [];
      const text = title(file), description = meta(file, "description") ?? "";
      if (!text || [...text].length > 60) problems.push(`${file}: <title> is ${[...text].length} characters: ${text}`);
      if (!description || [...description].length > 160) problems.push(`${file}: meta description is ${[...description].length} characters: ${description}`);
      for (const [key, want] of [["og:title", text], ["twitter:title", text], ["og:description", description], ["twitter:description", description]] as const) {
        const got = meta(file, key);
        if (got !== undefined && got !== want) problems.push(`${file}: ${key} is "${got}", not "${want}"`);
      }
      return problems;
    });
    fail(offenders, "Search results cut a title after about 60 characters and a description after about 160: shorten them, and copy the same text into og:title / twitter:title and og:description / twitter:description.");
  });
});

describe("ovis.sh beta page", () => {
  const BETA_PAGES = ["ovis-site/beta/index.html", "ovis-site/zh/beta/index.html", "ovis-site/ja/beta/index.html", "ovis-site/ko/beta/index.html"];
  /** The kind of address each phone test link is, so a link pasted into the wrong slot fails here. */
  const SHAPES: Record<string, RegExp> = {
    testflight: /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/,
    play: /^https:\/\/groups\.google\.com\/g\/[\w.-]+$/,
  };
  const links = BETA_LINKS as Record<string, string>;

  it("sets each phone test link to its kind of address, or leaves it empty", () => {
    fail(Object.entries(links).filter(([key, link]) => !SHAPES[key] || (link && !SHAPES[key].test(link))).map(([key, link]) => `${key}: ${JSON.stringify(link)}`),
      "Set each link in BETA_LINKS (ovis-site/assets/beta.js) to the address its comment names, or to \"\" to keep its section hidden; a new key needs its shape in SHAPES in scripts/ovis-site.test.ts:");
  });

  it("ships each phone section hidden, with its link and its note, for beta.js to show", () => {
    const offenders = BETA_PAGES.flatMap((file) => {
      const page = html(file);
      if (!page.includes("<script src=\"/assets/beta.js\"></script>")) return [`${file}: does not load /assets/beta.js`];
      return Object.keys(links).flatMap((key) => [
        !new RegExp(`<section (?:id="[\\w-]+" )?data-beta="${key}" hidden>`).test(page) && `${file}: no <section data-beta="${key}" hidden>`,
        !page.includes(`<a data-beta-link="${key}">`) && `${file}: no <a data-beta-link="${key}">`,
        !page.includes(`data-beta-pending="${key}"`) && `${file}: no data-beta-pending="${key}" note`,
      ].filter((problem): problem is string => !!problem));
    });
    fail(offenders, "Each beta page loads /assets/beta.js and, for every key of BETA_LINKS, ships <section data-beta=\"<key>\" hidden> (with an id first, if any) holding an <a data-beta-link=\"<key>\"> with no href, plus a data-beta-pending=\"<key>\" note; beta.js shows the section and hides the note once the link is set:");
  });

  it("is where the home page's App Store and Google Play icons and a phone's download button lead", () => {
    // each download row's icons, and the iPhone and Android buttons assets/platform.js puts on a phone
    const rows = html(HOME).split("<div class=\"dl-row\"").slice(1).map((rest) => rest.split("</div>")[0]!);
    const platform = read("ovis-site/assets/platform.js");
    fail([
      ...(rows.length === 2 ? [] : [`${HOME} has ${rows.length} download rows (<div class="dl-row">), not the hero's and the closing one`]),
      ...rows.flatMap((row, index) => ["iphone", "android"].filter((id) => !row.includes(`<a class="dl-icon" href="/beta/#${id}"`))
        .map((id) => `${HOME} download row ${index + 1}: no <a class="dl-icon" href="/beta/#${id}">`)),
      ...[["ios", "iphone"], ["android", "android"]].filter(([key, id]) => !new RegExp(`^ {4}${key}: \\{.*\\bhref: "/beta/#${id}"`, "m").test(platform))
        .map(([key, id]) => `ovis-site/assets/platform.js: BUTTONS.${key} has no href: "/beta/#${id}"`),
    ], "The phone apps are in beta: the App Store and Google Play icons in both download rows of the home page link to /beta/#iphone and /beta/#android, and so do the iPhone and Android buttons in assets/platform.js:");
  });

  it("has the section each home page link names", () => {
    // the home page's phone icons and the phone button in assets/platform.js link to /beta/#<id>,
    // which the page's language script points at the visitor's language
    const ids = [...new Set([...`${html(HOME)}\n${read("ovis-site/assets/platform.js")}`.matchAll(/["']\/beta\/#([\w-]+)["']/g)].map(([, id]) => id!))];
    fail(BETA_PAGES.flatMap((file) => ids.filter((id) => !html(file).includes(` id="${id}"`)).map((id) => `${file}: no id="${id}"`)),
      `${HOME} and ovis-site/assets/platform.js link to these sections of the beta page: give each beta page an element with that id, or change the links:`);
  });
});

describe("ovis-site/sitemap.xml", () => {
  const sitemap = read("ovis-site/sitemap.xml");
  const urls = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, body]) => ({
    loc: /<loc>([^<]*)<\/loc>/.exec(body!)?.[1] ?? "",
    alternates: [...body!.matchAll(/<xhtml:link\b[^>]*>/g)].map(([tag]) => attrs(tag)).map((tag) => `${tag["hreflang"]} ${tag["href"]}`).sort(),
  }));

  it("lists exactly the indexable pages", () => {
    const listed = urls.map((url) => url.loc).sort();
    const want = indexable.map(urlOf).sort();
    fail([...want.filter((url) => !listed.includes(url)).map((url) => `missing ${url}`), ...listed.filter((url) => !want.includes(url)).map((url) => `not an indexable page: ${url}`)],
      "ovis-site/sitemap.xml lists every HTML page without <meta name=\"robots\" content=\"noindex\"> (so not 404.html or the ko/index.html stub), each once, at its address (privacy/index.html is https://ovis.sh/privacy/).");
  });

  it("repeats each page's hreflang group", () => {
    const offenders = urls.flatMap(({ loc, alternates }) => {
      const file = fileOf(loc);
      const want = file && existsSync(join(repo, file)) ? hreflangs(file) : [];
      return JSON.stringify(alternates) === JSON.stringify(want) ? [] : [`${loc}: has ${JSON.stringify(alternates)}, the page has ${JSON.stringify(want)}`];
    });
    fail(urls.some((url) => url.alternates.length) && !sitemap.includes("xmlns:xhtml=\"http://www.w3.org/1999/xhtml\"") ? ["ovis-site/sitemap.xml"] : [],
      "A sitemap with <xhtml:link> entries declares their namespace: add xmlns:xhtml=\"http://www.w3.org/1999/xhtml\" to its <urlset>:");
    fail(offenders, "Give each <url> in ovis-site/sitemap.xml one <xhtml:link rel=\"alternate\" hreflang=\"…\" href=\"…\"/> per hreflang link of its page, and none for a page without them.");
  });
});

describe("ovis.sh structured data", () => {
  const blocks = (file: string): string[] => [...html(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(([, body]) => body!);
  const graph = (): Record<string, any>[] => blocks(HOME).flatMap((body) => JSON.parse(body)["@graph"] ?? []);
  const node = (type: string): Record<string, any> | undefined => graph().find((entry) => entry["@type"] === type);

  it("parses on every page", () => {
    const offenders = PAGES.flatMap((file) => blocks(file).flatMap((body, index) => {
      if (body.includes("</")) return [`${file}: JSON-LD block ${index + 1} holds "</"`];
      try { JSON.parse(body); return []; } catch (error) { return [`${file}: JSON-LD block ${index + 1}: ${(error as Error).message}`]; }
    }));
    fail(offenders, "Each <script type=\"application/ld+json\"> holds valid JSON, with any \"<\" written as \\u003c.");
    const count = blocks(HOME).length;
    fail(count === 1 ? [] : [`${HOME} has ${count}`], "Keep exactly one <script type=\"application/ld+json\"> in the home page, holding the whole @graph:");
  });

  it("names the site, its maker, the app and the FAQ, linked by @id, with nothing the repo does not state", () => {
    const types = graph().map((entry) => entry["@type"]);
    fail(["WebSite", "Person", "SoftwareApplication", "FAQPage"].filter((type) => !types.includes(type)), `Keep these nodes in the @graph of the JSON-LD in ${HOME}:`);
    const ids = new Set(graph().map((entry) => entry["@id"]));
    const refs: string[] = [], unstated: string[] = [], oldRepo: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
      else if (value && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 1 && entries[0]![0] === "@id" && !ids.has(entries[0]![1])) refs.push(`${path}: ${entries[0]![1]}`);
        for (const [key, child] of entries) { if (UNSTATED.includes(key)) unstated.push(`${path}.${key}`); walk(child, `${path}.${key}`); }
      } else if (typeof value === "string" && value.includes("github.com/devswha/herdr-web-ui")) oldRepo.push(`${path}: ${value}`);
    };
    walk(graph(), "@graph");
    fail(refs, "Each {\"@id\": …} reference names a node of the same @graph:");
    fail(unstated, "Leave out ratings, reviews, versions, dates and download links: the repo states none of them, and a stale one is worse than none. Remove:");
    fail(oldRepo, "Use https://github.com/devswha/ovis for the repository:");
    const siteNames = [node("WebSite")?.["alternateName"] ?? []].flat() as string[];
    fail(siteNames.filter((name) => /herdr[ -]web[ -]ui/i.test(name)),
      "Google may show the WebSite node's alternateName as the site's name in results: keep the old name off it (\"ovis.sh\" is the fallback). The old name belongs only on the SoftwareApplication node. Remove:");
    const app = node("SoftwareApplication")!;
    const license = "https://github.com/devswha/ovis/blob/main/LICENSE";
    fail([
      app["offers"]?.["price"] !== "0" && `offers is ${JSON.stringify(app["offers"])}`,
      app["isAccessibleForFree"] !== true && `isAccessibleForFree is ${JSON.stringify(app["isAccessibleForFree"])}`,
      app["license"] !== license && `license is ${JSON.stringify(app["license"])}`,
      !existsSync(join(repo, "LICENSE")) && "the repository has no LICENSE file",
    ].filter((problem): problem is string => !!problem),
      `The SoftwareApplication node says Ovis is free under the repository's license: keep "offers": {"@type": "Offer", "price": "0", …}, "isAccessibleForFree": true and "license": "${license}", with LICENSE in the repository:`);
    const image = app["image"];
    const imageFile = typeof image === "string" ? fileOf(image) : undefined;
    fail(imageFile && existsSync(join(repo, imageFile)) ? [] : [`image is ${JSON.stringify(image)}`],
      `The SoftwareApplication image must be an absolute ${ORIGIN}/ address of a file in ovis-site/:`);
  });

  it("repeats the visible FAQ word for word", () => {
    const page = html(HOME);
    // each item on its own, from its opening tag to the next </details>, so one item off the shape
    // is named instead of being read together with the next
    const shape = /^<details class="faq-item"[^>]*>\s*<summary>\s*<span>([\s\S]*?)<\/span>[\s\S]*?<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>\s*<\/details>$/;
    const parsed = page.split("<details class=\"faq-item\"").slice(1)
      .map((rest) => `<details class="faq-item"${rest.split("</details>")[0]}</details>`)
      .map((block, index) => ({ block, index, match: shape.exec(block) }));
    fail(parsed.filter(({ match }) => !match).map(({ block, index }) => `FAQ item ${index + 1}: ${visible(block).slice(0, 80)}`),
      `Keep each FAQ item in ${HOME} in this shape so the FAQPage check can read it: <details class="faq-item"><summary><span>question</span>…</summary><div class="faq-answer">answer</div></details>. These did not parse:`);
    const items = parsed.map(({ match }) => ({ name: visible(match![1]!), text: visible(match![2]!) }));
    const shown = new Map(items.map((item) => [item.name, item.text]));
    const marked = (node("FAQPage")?.["mainEntity"] ?? []) as Record<string, any>[];
    const names = marked.map((question) => question["name"]);
    fail(marked.flatMap((question) => {
      const want = shown.get(question["name"]);
      if (want === undefined) return [`"${question["name"]}" is not a question on the page`];
      return question["acceptedAnswer"]?.["text"] === want ? [] : [`"${question["name"]}": the page answers "${want}"`];
    }), `Copy each FAQ answer into the FAQPage of the JSON-LD in ${HOME} as the page shows it (tags stripped, entities decoded, whitespace collapsed):`);
    fail(items.filter((item) => !names.includes(item.name) && !(item.name in LEFT_OUT)).map((item) => item.name),
      `Add these FAQ items to the FAQPage of the JSON-LD in ${HOME}, or, to leave one out on purpose, to LEFT_OUT in scripts/ovis-site.test.ts with the reason:`);
    fail(Object.keys(LEFT_OUT).filter((name) => !shown.has(name) || names.includes(name)),
      "Remove these from LEFT_OUT in scripts/ovis-site.test.ts: the page no longer asks them, or the FAQPage has them now:");
  });
});

describe("ovis.sh translations", () => {
  const raw = /<script type="application\/json" id="i18n-data">([\s\S]*?)<\/script>/.exec(html(HOME))?.[1] ?? "";

  it("keep #i18n-data on one line, with < written as \\u003c", () => {
    fail(raw ? [] : [HOME], "The page script reads its translations from <script type=\"application/json\" id=\"i18n-data\">; keep that tag in the home page:");
    fail([raw.includes("\n") && "it spans several lines", raw.includes("<") && "it holds a raw \"<\""].filter((problem): problem is string => !!problem),
      `Keep the #i18n-data JSON in ${HOME} on one line and write each "<" as \\u003c, as the rest of it does:`);
  });

  it("translate the title and the description", () => {
    const dict = JSON.parse(raw) as Record<string, Record<string, string>>;
    const offenders = [title(HOME), meta(HOME, "description") ?? ""].flatMap((english) => ["zh", "ja", "ko"].flatMap((lang) => {
      const translated = dict[norm(english)]?.[lang];
      return translated && translated !== english ? [] : [`${lang} for "${norm(english)}"`];
    }));
    fail(offenders, `The page script swaps document.title and the meta description through #i18n-data, keyed by their English text with whitespace collapsed. In ${HOME}, give each of these an entry with a real translation (replace the entry of the old English text):`);
  });
});

describe("ovis-site/llms.txt", () => {
  const llms = read("ovis-site/llms.txt");
  const links = [...llms.matchAll(/\]\((https?:\/\/[^)\s]+)\)|(?<!\w)(https?:\/\/[^\s)`>]+[^\s)`>.,;:])/g)].map(([, inMarkdown, bare]) => inMarkdown ?? bare!);
  const redirects = read("ovis-site/_redirects").split("\n").filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.trim().split(/\s+/)[0]!);
  // paths _routes.json sends to _worker.js are served by it (the demo), not by a file or a redirect
  const routed = existsSync(join(repo, "ovis-site/_worker.js")) ? (JSON.parse(read("ovis-site/_routes.json")) as { include: string[] }).include : [];
  const covers = (from: string, path: string): boolean => from.endsWith("/*") ? path.startsWith(from.slice(0, -1)) : from === path || `${from}/` === path;
  const served = (url: string): boolean => {
    const path = new URL(url).pathname;
    const file = fileOf(url)!;
    if (existsSync(join(repo, file))) return true;
    return [...redirects, ...routed].some((from) => covers(from, path));
  };

  it("opens as llmstxt.org asks: the name as H1, then a blockquote summary", () => {
    fail([!llms.startsWith("# Ovis\n\n> ") && "it does not open with \"# Ovis\", a blank line and a \"> \" summary", !llms.includes("\n## Docs\n") && "it has no \"## Docs\" section"]
      .filter((problem): problem is string => !!problem),
      "ovis-site/llms.txt follows llmstxt.org: \"# Ovis\" on the first line, a blank line, the one-paragraph summary as a \"> \" blockquote, then the details and a \"## Docs\" list of links:");
  });

  it("links only to ovis.sh paths and repository files that exist", () => {
    fail(links.length > 5 ? [] : [`${links.length} links found`], "This test found almost no links in ovis-site/llms.txt: keep the docs as [name](https://…) Markdown links, or update the link pattern in this test:");
    const offenders = links.flatMap((url) => {
      if (url.startsWith(`${ORIGIN}/`) || url === ORIGIN) return served(url) ? [] : [`${url}: no file in ovis-site/, no rule in ovis-site/_redirects and no route in ovis-site/_routes.json`];
      const blob = /^https:\/\/github\.com\/devswha\/ovis\/blob\/main\/(.+)$/.exec(url);
      if (blob) return existsSync(join(repo, blob[1]!.split("#")[0]!)) ? [] : [`${url}: no ${blob[1]} in the repository`];
      return url.includes("devswha/herdr-web-ui") ? [`${url}: the repository is https://github.com/devswha/ovis now`] : [];
    });
    fail(offenders, "Fix these links in ovis-site/llms.txt: an ovis.sh link names a file in ovis-site/ or a path ovis-site/_redirects hands on, a repository link names a file on main.");
  });

  it("names the herdr version the plugin requires", () => {
    const required = /^min_herdr_version = "([^"]+)"/m.exec(read("herdr-plugin.toml"))?.[1];
    fail(required ? [] : ["herdr-plugin.toml"], "This test reads the herdr version Ovis needs from a min_herdr_version = \"…\" line in herdr-plugin.toml; point it at where that version is now:");
    fail(llms.includes(`herdr](https://github.com/herdrdev/herdr) ${required} or newer`) ? [] : [`herdr ${required}`],
      "ovis-site/llms.txt says which herdr Ovis needs: make it read \"[herdr](https://github.com/herdrdev/herdr) <min_herdr_version> or newer\", with the version from herdr-plugin.toml:");
  });
});

describe("ovis-site/_redirects", () => {
  const rules = read("ovis-site/_redirects").split("\n").filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.trim().split(/\s+/));

  it("hands guessed paths to repository files that exist and to home page sections that exist", () => {
    const ids = new Set([...html(HOME).matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id!));
    const offenders = rules.flatMap(([from, to]) => {
      const blob = /^https:\/\/github\.com\/devswha\/ovis\/blob\/main\/([^#]+)/.exec(to ?? "");
      if (blob) return existsSync(join(repo, blob[1]!)) ? [] : [`${from} -> ${to}: no ${blob[1]} in the repository`];
      const section = /^\/#(.+)$/.exec(to ?? "");
      if (section) return ids.has(section[1]!) ? [] : [`${from} -> ${to}: no id="${section[1]}" in ${HOME}`];
      return [];
    });
    fail(offenders, "Fix these rules in ovis-site/_redirects: a rule that hands a path to the repository names a file on main, and one to the home page names a section it has.");
  });
});

describe("ovis-site/_headers", () => {
  const rules = read("ovis-site/_headers").split(/\n(?=\S)/).map((block) => block.split("\n").filter((line) => line.trim() && !line.startsWith("#")))
    .filter((lines) => lines.length).map(([url, ...headers]) => ({ url: url!.trim(), headers: headers.map((line) => line.trim()) }));
  const noindexRules = rules.filter((rule) => rule.headers.some((header) => /^x-robots-tag:.*noindex/i.test(header))).map((rule) => rule.url);
  /** Cloudflare's matching: `*` takes everything, a `:placeholder` stops at a dot in the host and a slash in the path. */
  const matches = (pattern: string, url: string): boolean => {
    const absolute = /^https:\/\/([^/]+)(\/.*)$/.exec(pattern);
    const [host, path] = absolute ? [absolute[1]!, absolute[2]!] : [null, pattern];
    const target = new URL(url);
    const regex = (part: string, stop: string) => new RegExp(`^${part.split(/(\*|:[A-Za-z]\w*)/).map((piece) =>
      piece === "*" ? ".*" : piece.startsWith(":") ? `[^${stop}]+` : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`);
    return (host === null || regex(host, "./").test(target.host)) && regex(path, "/").test(target.pathname);
  };

  it("keeps the pages.dev copies and README.md out of search", () => {
    fail(["https://:project.pages.dev/*", "https://:version.:project.pages.dev/*", "/README.md"].filter((url) => !noindexRules.includes(url)),
      "Keep these rules in ovis-site/_headers, each with an indented \"X-Robots-Tag: noindex\" line under it:");
    fail([["https://:project.pages.dev/*", "https://ovis.pages.dev/privacy/"], ["https://:version.:project.pages.dev/*", "https://feat-x.ovis.pages.dev/"]]
      .filter(([pattern, url]) => !matches(pattern!, url!)).map(([pattern, url]) => `${pattern} does not match ${url}`),
      "matches() in scripts/ovis-site.test.ts no longer follows Cloudflare's _headers matching, so the noindex checks cannot be trusted; fix it:");
  });

  it("never puts noindex on an ovis.sh page", () => {
    const offenders = noindexRules.flatMap((pattern) => indexable.map(urlOf).filter((url) => matches(pattern, url)).map((url) => `${pattern} matches ${url}`));
    fail(offenders, "A noindex rule in ovis-site/_headers would take these ovis.sh pages out of search: narrow the rule to the pages.dev hosts or to files that are not pages.");
  });
});
