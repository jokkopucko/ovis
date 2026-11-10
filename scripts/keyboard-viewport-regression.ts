/**
 * bun scripts/keyboard-viewport-regression.ts
 * Runs the real viewport module and shell/composer CSS against controlled viewport
 * events. Chromium cannot emulate iOS keyboard dismissal or safe-area env() values;
 * only those platform inputs are faked. No live herdr session or production build.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

async function checkState(page: Page, visible: boolean, height: number, inset: number, correction = false): Promise<void> {
  // The page's clock is paused: this lets only the timers already due run (the zero timer a blur leaves), so the
  // state read is the one the event itself left. A wait that should not be there (lib/viewport.ts holds only an
  // iPad's shrink without a keyboard) shows as a stale state; a case that must wait runs the clock itself.
  await page.clock.runFor(1);
  const state = await page.evaluate((visible) => {
    const composer = document.querySelector(".composer")!;
    const root = document.documentElement;
    return {
      keyboard: root.hasAttribute("data-keyboard"),
      published: root.style.getPropertyValue("--app-height"),
      height: document.querySelector(".app")!.getBoundingClientRect().height,
      padding: parseFloat(getComputedStyle(composer).paddingBottom),
      hostPadding: parseFloat(getComputedStyle(document.querySelector(".terminal-host")!).paddingBottom),
      bottom: composer.getBoundingClientRect().bottom,
      space: parseFloat(getComputedStyle(root).getPropertyValue(visible ? "--space-2" : "--space-4")),
    };
  }, visible);
  assert.equal(state.keyboard, visible, "keyboard flag follows occlusion, not focus alone");
  assert.equal(state.published, visible || correction ? `${height}px` : "", "height override follows keyboard or measured standalone inset");
  assert.equal(state.height, height, "unobstructed standalone shell remains 100dvh without a blank band");
  assert.equal(state.bottom, height, "composer stays at the shell bottom");
  assert.equal(state.padding, visible ? state.space : Math.max(state.space, inset - state.space), "home indicator padding is restored on dismissal");
  assert.equal(state.hostPadding, 0, "home-indicator inset is not duplicated by the host");
}

async function geometry(page: Page, height: number, layout: number, large: number, event = "resize", scale = 1): Promise<void> {
  await page.evaluate(({ height, layout, large, event, scale }) => {
    const fake = (window as any).viewportFixture;
    Object.assign(fake, { height, layout, large, scale });
    fake.viewport.dispatchEvent(new Event(event));
    window.dispatchEvent(new Event(event === "orientationchange" ? event : "resize"));
  }, { height, layout, large, event, scale });
}

const repo = join(import.meta.dir, "..");
const bundle = await Bun.build({ entrypoints: [join(repo, "src/lib/viewport.ts")], target: "browser" });
assert.ok(bundle.success, String(bundle.logs));
const js = bundle.outputs.find((output) => output.path.endsWith(".js"));
assert.ok(js);
const css = readFileSync(join(repo, "src/styles.css"), "utf8") + "\n" + readFileSync(join(repo, "src/components/Composer.css"), "utf8");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/viewport.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (url.pathname === "/styles.css") {
    const inset = url.searchParams.get("inset") ?? "0";
    const fixtureCss = url.searchParams.has("short")
      ? css.replace("height: var(--app-height, 100dvh);", "height: var(--app-height, 793px);") + "\n@media (orientation: landscape) { .app { height: var(--app-height, 100dvh); } }"
      : css;
    return new Response(fixtureCss.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, `${inset}px`), { headers: { "content-type": "text/css" } });
  }
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css?inset=${url.searchParams.get("inset") ?? "0"}${url.searchParams.has("short") ? "&short" : ""}"><style>.terminal-host{display:flex;flex-direction:column}.fixture-chat{flex:1;min-height:0}.xterm-helper-textarea{position:absolute;width:1px;height:1px;opacity:0}</style></head><body><div class="app"><div class="app-body"><div class="terminal-host"><div class="fixture-chat"></div><div class="composer"><textarea aria-label="Message"></textarea></div><textarea class="xterm-helper-textarea"></textarea></div></div></div><script src="/viewport.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
} });
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const scenario of ["mobile", "split-view", "desktop", "virtual-keyboard", "standalone", "standalone-full", "browser-short", "ipad"] as const) {
    const mobile = scenario !== "desktop";
    // "ipad" is an iPad home-screen app in landscape: the platform and the portrait-valued screen iPadOS reports
    const context = await browser.newContext(scenario === "ipad"
      ? { viewport: { width: 1180, height: 820 }, screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true }
      : { viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
    try {
      await context.addInitScript(({ mobile, virtualKeyboard, scenario }) => {
        // Init scripts run before the viewport meta tag is parsed. Playwright's
        // emulated screen, unlike innerHeight at that point, has the requested size.
        const ipad = scenario === "ipad";
        if (ipad) {
          Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
          Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
        }
        const initialHeight = ipad ? 820 : window.screen.height;
        const fake = {
          height: ipad ? 796 : initialHeight - (mobile ? (window.screen.width > initialHeight ? 21 : 59) : 0), layout: initialHeight, large: scenario === "standalone" || scenario === "browser-short" ? 793 : initialHeight,
          scale: 1, viewport: new EventTarget(), keyboard: new EventTarget(), keyboardHeight: 0,
        };
        Object.assign(window, { viewportFixture: fake });
        for (const key of ["height", "scale"] as const) Object.defineProperty(fake.viewport, key, { get: () => fake[key] });
        // a pinch zoom narrows the visual viewport by its scale; Safari's page zoom keeps the width (fake.width)
        Object.defineProperty(fake.viewport, "width", { get: () => fake.width ?? document.documentElement.clientWidth / fake.scale });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: fake.viewport });
        Object.defineProperty(window, "innerHeight", { configurable: true, get: () => fake.layout });
        const originalMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(display-mode: standalone)"
          ? ({ matches: scenario.startsWith("standalone") || ipad } as MediaQueryList) : originalMatchMedia(query);
        const nativeRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          // Fake only the module's rulers, never app layout.
          if (this.style.height === "100lvh") return new DOMRect(0, 0, 0, fake.large);
          if (this.style.height === "env(safe-area-inset-top, 0px)") return new DOMRect(0, 0, 0, ipad ? 24 : mobile ? 59 : 0);
          return nativeRect.call(this);
        };
        if (virtualKeyboard) {
          Object.defineProperty(fake.keyboard, "boundingRect", { get: () => new DOMRect(0, 0, 393, fake.keyboardHeight) });
          Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: fake.keyboard });
        } else Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: undefined });
      }, { mobile, virtualKeyboard: scenario === "virtual-keyboard", scenario });
      const page = await context.newPage();
      await page.clock.install();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?inset=${mobile ? 34 : 0}${scenario === "standalone" || scenario === "browser-short" ? "&short" : ""}`);
      // an installed clock still runs in real time: paused, only runFor moves it, so a slow runner cannot let the
      // shrink wait run out between two steps, and nothing can land late unseen
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      // at rest: 100dvh, a phone home-screen app's status-bar correction, or the iPad's shell fitted under its status bar
      const rest = scenario === "ipad" ? 796 : scenario === "browser-short" ? 793 : mobile ? 852 : 800;
      const corrected = scenario === "standalone" || scenario === "ipad";
      await checkState(page, false, rest, mobile ? 34 : 0, corrected);
      if (scenario === "standalone") {
        const bounds = await page.evaluate(() => {
          const composer = document.querySelector(".composer")!;
          const corrected = composer.getBoundingClientRect().bottom;
          document.documentElement.style.removeProperty("--app-height");
          const uncorrected = composer.getBoundingClientRect().bottom;
          window.dispatchEvent(new Event("resize"));
          return { corrected, uncorrected, padding: parseFloat(getComputedStyle(composer).paddingBottom) };
        });
        assert.deepEqual(bounds, { corrected: 852, uncorrected: 793, padding: 18 }, "status inset is added exactly once with home-indicator clearance");
      }
      await page.getByRole("textbox", { name: "Message", exact: true }).focus();
      await checkState(page, false, rest, mobile ? 34 : 0, corrected); // hardware keyboard / focus without soft keyboard
      if (scenario === "ipad") {
        const composer = page.getByRole("textbox", { name: "Message", exact: true });
        const mark = () => page.evaluate(() => ({ keyboard: document.documentElement.hasAttribute("data-keyboard"), published: document.documentElement.style.getPropertyValue("--app-height") }));
        // a hardware keyboard's one-frame shrink on each key (iPadOS 26) is not applied in its frame and is gone by the
        // next: nothing lands late either
        await geometry(page, 420, 820, 820);
        assert.deepEqual(await mark(), { keyboard: false, published: "796px" }, "iPad: a shrink waits before it counts");
        await geometry(page, 796, 820, 820);
        await checkState(page, false, 796, 34, true);
        await page.clock.runFor(50);
        await checkState(page, false, 796, 34, true);
        // an on-screen keyboard that comes in one event counts once it lasted; up, it is followed in each event
        await geometry(page, 366, 820, 820);
        assert.deepEqual(await mark(), { keyboard: false, published: "796px" }, "iPad: the keyboard's shrink waits too");
        await page.clock.runFor(50);
        await checkState(page, true, 366, 34);
        await geometry(page, 300, 820, 820);
        await checkState(page, true, 300, 34);
        await geometry(page, 796, 820, 820, "scroll");
        await checkState(page, false, 796, 34, true);
        // a keyboard opening under a stream of viewport events (one a frame): the wait starts at the first shrinking
        // event and the ones after it do not start it again, so the keyboard counts while it still opens, and from
        // then on the shell is at the viewport's height in every frame
        for (let frame = 1; frame <= 12; frame += 1) {
          await geometry(page, 796 - frame * 20, 820, 820);
          await page.clock.runFor(16);
        }
        assert.deepEqual(await mark(), { keyboard: true, published: "556px" }, "iPad: a keyboard opening under a stream of viewport events counts while it opens");
        await geometry(page, 796, 820, 820, "scroll");
        await checkState(page, false, 796, 34, true);
        // the field loses the focus while the shrink waits (a tap on a button, a composer unmounted under the keyboard):
        // the keyboard is still up and still counts, as it did when the shrink was applied in its event
        await geometry(page, 366, 820, 820);
        await composer.blur();
        await page.clock.runFor(50);
        await checkState(page, true, 366, 34);
        await geometry(page, 796, 820, 820, "scroll");
        await checkState(page, false, 796, 34, true);
        await composer.focus();
        // a window made smaller is not a keyboard: its large viewport shrinks with it, and the shell follows in that event
        await geometry(page, 676, 700, 700);
        await checkState(page, false, 676, 34, true);
        // nor is a rotation, which changes the width
        await page.setViewportSize({ width: 820, height: 1180 });
        await geometry(page, 1156, 1180, 1180, "orientationchange");
        await checkState(page, false, 1156, 34, true);
        await page.setViewportSize({ width: 1180, height: 820 });
        await geometry(page, 796, 820, 820, "orientationchange");
        await checkState(page, false, 796, 34, true);
      } else if (scenario === "split-view") {
        await page.setViewportSize({ width: 393, height: 1000 });
        await geometry(page, 976, 1000, 1000);
        await checkState(page, false, 1000, 34);
        // Same-width top/bottom split view changes the large/layout viewport,
        // while the visual viewport retains a small non-keyboard inset.
        await page.setViewportSize({ width: 393, height: 600 });
        await geometry(page, 576, 600, 600);
        await checkState(page, false, 600, 34); // focused hardware keyboard
        await geometry(page, 300, 600, 600);
        await checkState(page, true, 300, 34);
        await geometry(page, 576, 600, 600, "scroll");
        await checkState(page, false, 600, 34); // soft keyboard dismissed, still focused
        await page.getByRole("textbox", { name: "Message", exact: true }).blur();
        await page.getByRole("textbox", { name: "Message", exact: true }).focus();
        await checkState(page, false, 600, 34); // blur/refocus must not revive stale height
      } else if (scenario === "mobile") {
        // a phone's keyboard is applied in the event that reports it: only an iPad's shrink waits
        await geometry(page, 472, 852, 852);
        await checkState(page, true, 472, 34);
        await geometry(page, 400, 852, 852); // the keyboard grows while it is up (a suggestion bar)
        await checkState(page, true, 400, 34);
        await geometry(page, 793, 852, 852, "scroll"); // native dismissal, focus remains
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).evaluate((el) => document.activeElement === el), true);
        await checkState(page, false, 852, 34);
        await geometry(page, 472, 472, 472); // resizes-content: both viewports and CSS units shrink
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
        // resizes-content as Chrome 133 reports it with Gboard up (lib/viewport.test.ts): the visual and the layout
        // viewport shrink to 477 while the lvh ruler stays above them, at 533
        await geometry(page, 477, 477, 533);
        await checkState(page, true, 477, 34);
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
        await geometry(page, 400, 852, 852, "resize", 2); // pinch zoom is not a keyboard
        await checkState(page, false, 852, 34);
        await geometry(page, 793, 852, 852);
        // Safari page zoom 85%: the scale is below 1 but the visual viewport stays full width, so a keyboard still counts
        await page.evaluate(() => { (window as any).viewportFixture.width = document.documentElement.clientWidth; });
        await geometry(page, 472, 852, 852, "resize", 0.85);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852, "resize", 0.85);
        await checkState(page, false, 852, 34);
        await page.evaluate(() => { delete (window as any).viewportFixture.width; });
        await geometry(page, 793, 852, 852);
        await geometry(page, 210, 393, 393);
        await page.setViewportSize({ width: 852, height: 393 });
        await geometry(page, 210, 393, 393, "orientationchange"); // rotate with keyboard still open
        await checkState(page, true, 210, 34);
        await geometry(page, 372, 393, 393);
        await checkState(page, false, 393, 34);
        await page.goto(`http://127.0.0.1:${server.port}/?inset=21`);
        await geometry(page, 372, 393, 393);
        await page.getByRole("textbox", { name: "Message", exact: true }).focus();
        await checkState(page, false, 393, 21);
        await geometry(page, 210, 393, 393);
        await checkState(page, true, 210, 21);
        await geometry(page, 372, 393, 393);
        await checkState(page, false, 393, 21);
        await page.locator(".xterm-helper-textarea").focus();
        await geometry(page, 210, 393, 393);
        await checkState(page, false, 393, 21); // automatic xterm focus does not raise keyboard state
        await page.locator(".terminal-host").evaluate((el) => el.setAttribute("data-direct-typing", ""));
        await geometry(page, 210, 393, 393);
        await checkState(page, true, 210, 21);
      } else if (scenario === "standalone") {
        await geometry(page, 472, 852, 793);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 793, "scroll");
        await checkState(page, false, 852, 34, true);
        await page.setViewportSize({ width: 852, height: 393 });
        await geometry(page, 372, 393, 393, "orientationchange");
        await checkState(page, false, 393, 34);
        await geometry(page, 210, 393, 393);
        await checkState(page, true, 210, 34);
        await geometry(page, 372, 393, 393);
        await checkState(page, false, 393, 34);
      } else if (scenario === "browser-short") {
        await geometry(page, 472, 852, 793);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 793, "scroll");
        await checkState(page, false, 793, 34);
      } else if (scenario === "standalone-full") {
        await geometry(page, 472, 852, 852);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852, "scroll");
        await checkState(page, false, 852, 34);
      } else if (scenario === "virtual-keyboard") {
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
        await page.evaluate(() => {
          const fake = (window as any).viewportFixture;
          fake.keyboardHeight = 300;
          fake.keyboard.dispatchEvent(new Event("geometrychange"));
        });
        await checkState(page, true, 793, 34); // geometry alone detects a keyboard
        await page.evaluate(() => {
          const fake = (window as any).viewportFixture;
          fake.keyboardHeight = 0;
          fake.keyboard.dispatchEvent(new Event("geometrychange"));
        });
        await checkState(page, false, 852, 34);
        await geometry(page, 472, 852, 852);
        await checkState(page, true, 472, 34);
        // Zero geometry must not mask visual occlusion on browsers exposing the API.
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
      } else {
        await geometry(page, 400, 400, 800);
        await checkState(page, false, 800, 0); // desktop focus/resize never activates phone keyboard handling
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  // an iPad home-screen app in landscape: the visual viewport stops above the status bar while the shell would be
  // 100dvh tall, so the page could scroll by that band whenever a field takes the focus. The shell fits the visual
  // viewport, also at Safari's page zoom; a pinch, a keyboard-sized gap, a Safari tab or a phone keep the rules above.
  // Page zoom scales the layout (125% of an 1180x820 screen lays out 944x656) and leaves the screen's own size, so
  // the iPad is told by its screen. Each case reads the shell right after the load, with no clock: the first sync
  // of a page never waits for a shrink
  const landscape = { width: 1180, height: 820 };
  const ipad = { width: 820, height: 1180 }; // iOS reports the screen as it is in portrait, whichever way it is held
  for (const [name, size, screen, visual, scale, pinched, standalone, fits] of [
    ["iPad landscape", landscape, ipad, 796, 1, false, true, true],
    ["iPad landscape at 85% page zoom", { width: 1388, height: 965 }, ipad, 936, 0.85, false, true, true],
    ["iPad landscape at 125% page zoom", { width: 944, height: 656 }, ipad, 637, 1.25, false, true, true],
    ["iPad landscape in a 600px window", { width: 600, height: 700 }, ipad, 676, 1, false, true, true],
    ["iPad landscape pinched", landscape, ipad, 796, 2, true, true, false],
    ["iPad landscape, keyboard-sized gap", landscape, ipad, 500, 1, false, true, false],
    ["iPad landscape Safari tab", landscape, ipad, 796, 1, false, false, false],
    ["phone landscape", { width: 852, height: 393 }, { width: 852, height: 393 }, 372, 1, false, true, false],
  ] as const) {
    const context = await browser.newContext({ viewport: size, screen, isMobile: true, hasTouch: true });
    try {
      await context.addInitScript(({ layout, visual, scale, pinched, standalone }) => {
        const fake = new EventTarget();
        Object.defineProperty(fake, "height", { get: () => visual });
        Object.defineProperty(fake, "scale", { get: () => scale });
        Object.defineProperty(fake, "width", { get: () => document.documentElement.clientWidth / (pinched ? scale : 1) });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
        Object.defineProperty(window, "innerHeight", { configurable: true, get: () => layout });
        const originalMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(display-mode: standalone)" ? ({ matches: standalone } as MediaQueryList) : originalMatchMedia(query);
        const nativeRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.style.height === "100lvh") return new DOMRect(0, 0, 0, layout);
          if (this.style.height === "env(safe-area-inset-top, 0px)") return new DOMRect(0, 0, 0, 24);
          return nativeRect.call(this);
        };
      }, { layout: size.height, visual, scale, pinched, standalone });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const shell = await page.evaluate(() => ({ published: document.documentElement.style.getPropertyValue("--app-height"), height: document.querySelector(".app")!.getBoundingClientRect().height }));
      assert.deepEqual(shell, fits ? { published: `${visual}px`, height: visual } : { published: "", height: size.height }, `${name}: the shell ${fits ? "fits the visual viewport" : "keeps 100dvh"}`);
    } finally { await context.close(); }
  }
  // a field draws at the interface size like the label beside it (--fs-md on a phone, --fs-sm from 641px); on iOS the
  // press before its focus arms it to 16px, the size Safari does not zoom the page for, and the blur disarms it. A
  // desktop browser never arms it
  for (const [ios, width] of [[true, 393], [true, 1180], [false, 1180]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: ios });
    try {
      if (ios) await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.evaluate((token) => document.querySelector(".app")!.insertAdjacentHTML("afterbegin", `<input class="input" aria-label="Field"><span style="display: inline-flex"><select class="select" aria-label="Choice"><option>Comfortable spacing</option></select></span><span class="fixture-label" style="font-size: var(${token})">Label</span>`), width < 641 ? "--fs-md" : "--fs-sm");
      const size = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).fontSize);
      const body = await size(".fixture-label");
      const where = `${ios ? "iOS" : "desktop"} ${width}px`;
      for (const selector of ['.input[aria-label="Field"]', ".select"]) {
        assert.equal(await size(selector), body, `${where} ${selector}: the interface size at rest`);
        const box = () => page.locator(selector).evaluate((el) => { const rect = el.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; });
        const resting = await box();
        await page.locator(selector).dispatchEvent("pointerdown");
        // the press arms a text field, whose box does not follow its text. A select's box does: armed by the press it
        // would widen under the finger and could move away from it, so a select is armed only once it has the focus
        const select = selector === ".select";
        assert.equal(await size(selector), ios && !select ? "16px" : body, `${where} ${selector}: ${ios && !select ? "16px from the press itself" : "a press leaves the size"}`);
        if (select) assert.deepEqual(await box(), resting, `${where} ${selector}: a press leaves the select's box where it is`);
        await page.locator(selector).focus();
        assert.equal(await size(selector), ios ? "16px" : body, `${where} ${selector}: ${ios ? "16px with the focus" : "the interface size when focused"}`);
        if (select && ios) assert.ok((await box())[2]! > resting[2]!, `${where} ${selector}: an armed select is wider than at rest, which is why the press does not arm it`);
        await page.locator(selector).blur();
        assert.equal(await size(selector), body, `${where} ${selector}: the interface size again after the blur`);
      }
      // a press on a field's label arms the field it focuses; a press a scroll cancels leaves no armed field behind
      await page.evaluate(() => document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<label for="fixture-dir">Directory</label><input id="fixture-dir" class="input">'));
      await page.locator('label[for="fixture-dir"]').dispatchEvent("pointerdown");
      await page.locator('label[for="fixture-dir"]').click();
      assert.equal(await size("#fixture-dir"), ios ? "16px" : body, `${where}: ${ios ? "16px from a press on its label" : "a label press leaves the size"}`);
      await page.locator("#fixture-dir").blur();
      await page.locator('.input[aria-label="Field"]').dispatchEvent("pointerdown");
      await page.locator('.input[aria-label="Field"]').dispatchEvent("pointercancel");
      assert.equal(await size('.input[aria-label="Field"]'), body, `${where}: a cancelled press disarms the field`);
      // a press on a button whose handler focuses a field (Find in diff, Rename tab) arms the field it focuses
      await page.evaluate(() => {
        document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<button type="button" id="fixture-find">Find</button><input id="fixture-search" class="input">');
        document.querySelector("#fixture-find")!.addEventListener("click", () => document.querySelector<HTMLElement>("#fixture-search")!.focus());
      });
      await page.locator("#fixture-find").dispatchEvent("pointerdown");
      await page.locator("#fixture-find").click();
      assert.equal(await size("#fixture-search"), ios ? "16px" : body, `${where}: ${ios ? "16px for a field a button's press focuses" : "a focused field keeps the interface size"}`);
      await page.locator("#fixture-search").blur();
      assert.equal(await size("#fixture-search"), body, `${where}: the interface size again after the blur`);
      // a button drawn as a select (the agent picker) opens a menu and Safari never zooms into it, and it may not even
      // take the focus: a press leaves its size alone, during the press and after it
      await page.evaluate(() => document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<button type="button" class="select" id="fixture-picker">Agent</button>'));
      await page.locator("#fixture-picker").dispatchEvent("pointerdown");
      assert.equal(await size("#fixture-picker"), body, `${where}: a pressed picker button keeps the interface size`);
      for (const type of ["pointerup", "click"]) await page.locator("#fixture-picker").dispatchEvent(type);
      assert.equal(await size("#fixture-picker"), body, `${where}: a picker button keeps the interface size after its press`);
      // a press that ends in a click without the field taking the focus (a handler refused it) leaves nothing armed
      // once the click is done, and the label of a disabled field arms nothing
      await page.evaluate(() => {
        document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<input id="fixture-refused" class="input"><label for="fixture-off">Off</label><input id="fixture-off" class="input" disabled>');
        document.querySelector("#fixture-refused")!.addEventListener("mousedown", (event) => event.preventDefault());
      });
      await page.locator("#fixture-refused").dispatchEvent("pointerdown");
      assert.equal(await size("#fixture-refused"), ios ? "16px" : body, `${where}: ${ios ? "16px while the press lasts" : "a press leaves the size"}`);
      for (const type of ["pointerup", "click"]) await page.locator("#fixture-refused").dispatchEvent(type);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.equal(await size("#fixture-refused"), body, `${where}: a press that ends without the focus disarms the field`);
      await page.locator('label[for="fixture-off"]').dispatchEvent("pointerdown");
      assert.equal(await size("#fixture-off"), body, `${where}: the label of a disabled field arms nothing`);
      // a press that never ends in a click (the finger slid off) is cleared by the next press anywhere
      await page.locator("#fixture-refused").dispatchEvent("pointerdown");
      await page.locator("#fixture-find").dispatchEvent("pointerdown");
      assert.equal(await size("#fixture-refused"), body, `${where}: the next press clears a field an earlier press left armed`);
      // a field disabled while it has the focus (a form that is sending) does not stay armed: its blur disarms it
      // though it is disabled by then, and where the browser drops the focus without a blur, the next press does
      await page.locator("#fixture-dir").focus();
      assert.equal(await size("#fixture-dir"), ios ? "16px" : body, `${where}: ${ios ? "16px with the focus" : "a focused field keeps the interface size"}`);
      await page.locator("#fixture-dir").evaluate((el: HTMLInputElement) => {
        el.disabled = true;
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        el.disabled = false;
      });
      assert.equal(await size("#fixture-dir"), body, `${where}: the blur of a field disabled while focused disarms it`);
      await page.locator("#fixture-dir").blur();
      if (ios) {
        await page.locator("#fixture-dir").evaluate((el) => el.setAttribute("data-armed", "")); // as a dropped focus leaves it
        await page.locator("#fixture-find").dispatchEvent("pointerdown");
        assert.equal(await size("#fixture-dir"), body, `${where}: the next press disarms a field that lost the focus without a blur`);
      }
    } finally { await context.close(); }
  }
  // an interface size over 16px: the press keeps the field at the interface size instead of shrinking it to 16px
  for (const width of [393, 1180]) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: true });
    try {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "iPhone" });
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      // a 20px interface body size over the 14px default, as lib/settings.ts writes it on <html>
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--ui-scale", String(20 / 14));
        document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<input class="input" aria-label="Large field">');
      });
      const field = page.locator('.input[aria-label="Large field"]');
      const rest = await field.evaluate((el) => getComputedStyle(el).fontSize);
      assert.ok(Number.parseFloat(rest) > 16, `iOS ${width}px: the field follows a 20px interface (${rest})`);
      await field.dispatchEvent("pointerdown");
      await field.focus();
      assert.equal(await field.evaluate((el) => getComputedStyle(el).fontSize), rest, `iOS ${width}px: the press keeps a size over 16px`);
    } finally { await context.close(); }
  }
  // an iPad home-screen app in a window (iPadOS 26): the window's controls sit over the page's top-left corner, so
  // the header's first button moves clear of them, by the controls' width in points through Safari's page zoom.
  // A full-screen app, a Safari tab and a desktop browser keep the header as it is, and so does iPadOS 16 to 18,
  // whose Split View and Slide Over are narrower than the screen too with nothing in that corner. A full-screen
  // app is not taken for a window when a high page zoom rounds its width (an iPad mini at 300% and at 115%)
  const air = { width: 1180, height: 820 };
  const mini = { width: 1133, height: 744 };
  for (const [name, width, scale, screen, portrait, standalone, ipad, os26, room] of [
    ["windowed", 800, 1, air, false, true, true, true, 68],
    ["windowed at 85% page zoom", 941, 0.85, air, false, true, true, true, 80],
    ["windowed under 769px", 600, 1, air, false, true, true, true, 68],
    ["full screen", 1180, 1, air, false, true, true, true, null],
    ["full screen at 85% page zoom", 1388, 0.85, air, false, true, true, true, null],
    ["Split View on iPadOS 18", 590, 1, air, false, true, true, false, null],
    ["Slide Over on iPadOS 18", 320, 1, air, false, true, true, false, null],
    ["full screen at 300% page zoom", 377, 3, mini, false, true, true, true, null],
    ["full screen in portrait at 115% page zoom", 646, 1.15, mini, true, true, true, true, null],
    ["Safari tab", 800, 1, air, false, false, true, true, null],
    ["desktop", 800, 1, air, false, true, false, true, null],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, screen, hasTouch: ipad });
    try {
      await context.addInitScript(({ width, scale, portrait, standalone, ipad, os26 }) => {
        if (ipad) {
          Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
          Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
        }
        const fixture = { width, viewport: new EventTarget() };
        Object.assign(window, { windowFixture: fixture });
        Object.defineProperty(fixture.viewport, "width", { get: () => fixture.width });
        for (const [key, value] of [["height", 820], ["scale", scale]] as const) Object.defineProperty(fixture.viewport, key, { get: () => value });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: fixture.viewport });
        // iOS keeps screen.width and screen.height as they are in portrait, whichever way the iPad is held
        Object.defineProperty(window.screen, "orientation", { configurable: true, value: { type: portrait ? "portrait-primary" : "landscape-primary" } });
        const originalMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(display-mode: standalone)" ? ({ matches: standalone } as MediaQueryList) : originalMatchMedia(query);
        // what lib/viewport.ts asks to tell iPadOS 26 from the ones before it, whatever this Chromium supports
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((...args: [string, string?]) => args[0] === "anchor-name: --a" ? os26 : supports(...(args as [string]))) as typeof CSS.supports;
      }, { width, scale, portrait, standalone, ipad, os26 });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      // the connecting shell's bare header, and the app's own: zoned, with the sidebar's top row (.header-side) in it
      await page.evaluate(() => document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<header class="app-header" id="fixture-bare"></header><header class="app-header is-zoned" id="fixture-zoned"><div class="header-side"></div></header>'));
      const header = () => page.evaluate(() => {
        const left = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).paddingLeft);
        return { marked: document.documentElement.hasAttribute("data-window-controls"), bare: left("#fixture-bare"), zoned: left("#fixture-zoned"), side: left("#fixture-zoned .header-side") };
      });
      const open = await header();
      assert.equal(open.marked, room !== null, `${name}: the window's controls are ${room === null ? "not " : ""}there`);
      if (room === null) continue;
      assert.equal(open.bare, room, `${name}: a bare header leaves the controls' room`);
      // from 769px the sidebar's top row is the header's first zone: the room goes there and the header adds none
      assert.deepEqual({ zoned: open.zoned, side: open.side }, width >= 769 ? { zoned: 0, side: room } : { zoned: room, side: 0 }, `${name}: the room is left once, in the zone that holds the first button`);
      await page.locator(".app").evaluate((app) => app.classList.add("sidebar-collapsed"));
      const collapsed = await header();
      assert.deepEqual({ zoned: collapsed.zoned, side: collapsed.side }, { zoned: room, side: 0 }, `${name}: with the sidebar collapsed the header itself leaves the room`);
      await page.locator(".app").evaluate((app) => app.classList.remove("sidebar-collapsed"));
      // the window goes full screen and back: the mark follows the resize
      const resize = (to: number) => page.evaluate((to) => {
        const fixture = (window as any).windowFixture;
        fixture.width = to;
        fixture.viewport.dispatchEvent(new Event("resize"));
      }, to);
      await resize(Math.round(screen.width / scale));
      assert.equal((await header()).marked, false, `${name}: full screen clears the mark`);
      await resize(width);
      assert.equal((await header()).marked, true, `${name}: a window again is marked again`);
    } finally { await context.close(); }
  }
  console.log("PASS mobile viewport: same-width split view, dismissal without blur, hardware keyboard, dual viewport resize, orientation, standalone, safe area, desktop, zoom, page zoom, xterm, keyboard geometry, a phone keyboard in its own event, an iPad's one-frame shrink, iPad landscape home-screen shell, field size on iOS, iPad window controls");
} finally { await browser?.close(); server.stop(); }
