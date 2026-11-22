/**
 * Every image is an opaque rectangle (the README loop GIF
 * cannot carry soft alpha, so nothing next to it is rounded either). Each PNG is then quantized to
 * 256 colours with ffmpeg, since the README must stay light.
 */
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dir, "../..");
const stills = process.env["STILLS"] ?? join(root, "_film/footage/stills");
const fonts = process.env["FONTS"] ?? join(root, "_film/fonts");
const tmp = mkdtempSync(join(tmpdir(), "herdr-banner-"));
const what = process.argv.slice(2);
const want = (part: string) => what.length === 0 || what.includes(part);
const url = (path: string) => pathToFileURL(path).href;

function ffmpeg(args: string[]) {
  const proc = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args]);
  if (proc.exitCode !== 0) throw new Error(`ffmpeg: ${proc.stderr.toString()}`);
}

const icon = join(root, "app/assets/icon-only.png");
const grain = join(tmp, "grain.png");
ffmpeg(["-f", "lavfi", "-i", "nullsrc=s=256x256,geq=random(1)*255:128:128,format=gray", "-frames:v", "1", grain]);

const windowObject = (still: string) => `<div class="window"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="url">localhost:7317</span></div><img src="${url(join(stills, still))}" alt=""></div>`;
const phoneObject = (still: string) => `<div class="phone"><img src="${url(join(stills, still))}" alt=""></div>`;
// no install command in the art: at the README's display size it would be ~8px; the README has it as text
const copy = `<div class="copy"><img class="mark" src="${url(icon)}" alt=""><div class="word">Ovis</div><div class="tag">Anyharness, <span class="accent">Anywhere, Anytime.</span></div></div>`;
const hero = `${copy}<div class="scene">${windowObject("01-desktop-chat-claude.png")}${phoneObject("14-phone-codex-approval.png")}</div>`;

interface Job { out: string; kind: "banner" | "look"; w: number; h: number; content: string; look?: { w: number; anchor: "whole" | "detail" }; maxBytes: number }
// the stills are 2x, so 1.25 px per CSS px is still below 1 output px per source px
const looks = [
  { name: "chat", still: "02-desktop-chat-worked-open", look: { w: 1540, anchor: "whole" } },
  { name: "prompt", still: "04-desktop-codex-approval", look: { w: 1440 * 1.25, anchor: "detail" } },
  { name: "terminal", still: "07-desktop-terminal", look: { w: 1440 * 1.25, anchor: "detail" } },
] as const;
const jobs = ([
  { out: "docs/media/banner.png", kind: "banner" as const, w: 1920, h: 800, content: hero, maxBytes: 600_000 },
  ...looks.map((x): Job => ({ out: `docs/media/look-${x.name}.png`, kind: "look", w: 1760, h: 1150, content: windowObject(`${x.still}.png`), look: x.look, maxBytes: 700_000 })),
] satisfies Job[] as Job[]).filter((job) => want(job.kind));

const template = readFileSync(join(import.meta.dir, "banner.html"), "utf8");
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files"] });
const page = await (await browser.newContext({ deviceScaleFactor: 1, colorScheme: "dark" })).newPage();
for (const job of jobs) {
  const html = template
    .replaceAll("{{FONTS}}", url(fonts))
    .replaceAll("{{GRAIN}}", url(grain))
    .replaceAll("{{W}}", String(job.w))
    .replaceAll("{{H}}", String(job.h))
    .replaceAll("{{LOOK_W}}", String(job.look?.w ?? 0))
    .replaceAll("{{KIND}}", job.kind)
    .replaceAll("{{LOOK}}", job.look?.anchor ?? "")
    .replace("{{CONTENT}}", job.content);
  const file = join(tmp, `${job.kind}.html`);
  writeFileSync(file, html);
  await page.setViewportSize({ width: job.w, height: job.h });
  await page.goto(url(file), { waitUntil: "load" });
  const ok = await page.evaluate(async () => {
    await Promise.all(['700 72px "Pretendard Variable"', '500 18px "JetBrains Mono"'].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
    return document.fonts.check('700 72px "Pretendard Variable"') && document.fonts.check('500 18px "JetBrains Mono"');
  });
  if (!ok) throw new Error("brand fonts did not load");
  const raw = join(tmp, `${job.kind}-${job.out.replaceAll("/", "_")}`);
  await page.screenshot({ path: raw, clip: { x: 0, y: 0, width: job.w, height: job.h }, });
  const target = join(root, job.out);
  mkdirSync(join(target, ".."), { recursive: true });
  ffmpeg(["-i", raw, "-vf", "format=rgb24,split[a][b];[a]palettegen=max_colors=256:stats_mode=single:reserve_transparent=0[p];[b][p]paletteuse=dither=sierra2_4a", "-frames:v", "1", target]);
  const bytes = statSync(target).size;
  console.log(`${job.out}  ${job.w}x${job.h}  ${Math.round(bytes / 1024)} KB`);
  if (bytes > job.maxBytes) throw new Error(`${job.out} is ${bytes} bytes, over ${job.maxBytes}`);
}
await browser.close();
