import { shouldSyncViewportOnResume } from "./viewportResume.ts";
import { keyboardTypingField, keyboardViewportReference } from "./keyboard.ts";
import { keyboardControl } from "./keyboardControl.ts";

/*
 * Sizes the shell to the VISUAL viewport. When the soft keyboard opens, iOS
 * Safari shrinks window.visualViewport but leaves the layout viewport (and so
 * 100dvh) at full height and scrolls the page to reveal the focused textarea,
 * which drags the header off-screen and puts the key bar under the keyboard.
 * Publishing the visual height as --app-height (read by .app in styles.css)
 * and pinning the page at (0, 0) keeps header, terminal and key bar in view.
 * Chrome resizes the layout viewport itself (interactive-widget=resizes-content
 * in index.html), so there the same value changes nothing.
 *
 * Only the shell (.app) is pinned. The token gate sizes itself to the same height
 * and is otherwise a plain page: pinning it fought iOS scrolling the focused field
 * into view, and a second tap on the field (to paste) landed after the page jumped,
 * off the field, which dismissed the keyboard.
 *
 * The visual height is published only while the soft keyboard is up. An iPhone home
 * screen app (standalone, black-translucent status bar) reports a visual viewport
 * shorter than the screen with no keyboard at all, which left a band as tall as the
 * status bar under the composer. Without a keyboard the shell is 100dvh unless
 * the missing height matches the measured standalone top safe area.
 */

const viewport = window.visualViewport;
const root = document.documentElement;
// What the device says it is. iPadOS reports "MacIntel" with touch points unless the mobile site was asked
// for, and so does an iPhone showing the desktop site, so an iPad is also told by its screen (the smallest
// is 744 points on its short side; page zoom and the window's size leave the screen's own size alone).
const ios = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const ipad = (/iPad/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
  && Math.min(window.screen.width, window.screen.height) >= 744;

/**
 * Focus starts it, and is not sufficient: dismissal and hardware keyboards leave the
 * field focused. Accept keyboard geometry where available, or detect a
 * substantial viewport occlusion relative to the large CSS viewport or a remembered
 * unobstructed height. Comparing visualViewport with innerHeight alone misses browsers
 * that resize both. The relative cutoff excludes ordinary browser/status-bar insets;
 * Safari has no exact keyboard-visibility API, so small floating keyboards cannot be
 * inferred this way. xterm's automatically focused helper only counts in direct typing.
 * Once up, the keyboard counts as up until its occlusion ends, whatever holds the focus: a
 * field unmounted under it (the chat's composer as the lens switches) or a tap that moves the
 * focus to a button leaves the keyboard on screen for its own hide animation, and the shell,
 * the sheets and the terminal's grid (#1045) follow the keyboard, not the focus.
 */
const touch = window.matchMedia("(pointer: coarse)");
const keyboard = (navigator as Navigator & {
  virtualKeyboard?: EventTarget & { boundingRect: DOMRectReadOnly };
}).virtualKeyboard;
const largeViewport = document.createElement("div");
largeViewport.style.cssText = "position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;contain:strict";
largeViewport.setAttribute("aria-hidden", "true");
root.append(largeViewport);
const topInset = document.createElement("div");
topInset.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none;contain:strict";
topInset.setAttribute("aria-hidden", "true");
root.append(topInset);
// Width separates portrait and landscape. Retain the baseline when a keyboard
// shrinks all three viewports, but not when a split view shrinks the large
// viewport while leaving only its ordinary visual inset.
const unobstructedHeights = new Map<number, { large: number; height: number }>();
const typing = keyboardTypingField;
// An iPad home-screen app with a hardware keyboard (iPadOS 26, Magic Keyboard) reports a visual viewport
// shrunk for a single frame on every keystroke and whole again on the next. Applied at once, that frame
// collapsed the shell to a keyboard-sized height and the page flashed on each key. Such a dip is read
// again a moment later and applied only where it lasted.
// Only that dip waits: on an iPad, with no keyboard counted yet, a visual viewport shorter than the one
// applied last while the window is as it was (the same width and the same large viewport). Everything
// else is applied in its own event, as it always was: a phone's keyboard (an iPhone's, and Android's,
// where Chrome shrinks the layout too), a keyboard that is up and grows, a viewport growing back (a
// keyboard going away never waits), a rotation, a window made smaller, and the first sync of a page.
// The wait starts at the first event of a dip and the ones after it leave it running, so a keyboard that
// opens under a stream of viewport events counts 40 ms after its first event, not after its last. A field
// that had the focus when the dip began still counts when the wait ends: by then a tap may have moved
// the focus to a button, or the field may be unmounted, with the keyboard still on screen.
const SHRINK_SETTLE_MS = 40;
let shrinkTimer: number | undefined;
let shrinkFocused = false;
let applied: { width: number; height: number; large: number } | undefined;
const typingFocused = (): boolean => touch.matches && typing(document.activeElement);
const pinPage = (): void => {
  if (document.querySelector(".app") !== null) window.scrollTo(0, 0);
};
const syncKeyboard = (): void => {
  const height = viewport?.height ?? window.innerHeight;
  const dip = ipad && !!viewport && applied !== undefined && !root.hasAttribute("data-keyboard")
    && window.innerWidth === applied.width && Math.abs(largeViewport.getBoundingClientRect().height - applied.large) < 1
    && height < applied.height - 1;
  if (!dip) {
    window.clearTimeout(shrinkTimer);
    shrinkTimer = undefined;
    shrinkFocused = false;
    applyKeyboard(false);
    return;
  }
  // iOS scrolls the page to reveal the focused field: it stays in place while the dip waits
  pinPage();
  shrinkFocused ||= typingFocused();
  shrinkTimer ??= window.setTimeout(() => {
    const held = shrinkFocused;
    shrinkTimer = undefined;
    shrinkFocused = false;
    applyKeyboard(held);
  }, SHRINK_SETTLE_MS);
};
const applyKeyboard = (held: boolean): void => {
  const width = window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const large = largeViewport.getBoundingClientRect().height;
  applied = { width, height, large };
  const remembered = unobstructedHeights.get(width);
  const focused = held || typingFocused();
  const keyboardActive = focused || root.hasAttribute("data-keyboard");
  const reference = keyboardViewportReference(height, large, window.innerHeight, remembered, keyboardActive);
  const visible = keyboardActive && ((keyboard?.boundingRect.height ?? 0) > 0
    // A pinch zoom narrows the visual viewport and is not a keyboard. Safari's per-site page zoom
    // (Settings → Apps → Safari → Page Zoom, kept by the home-screen app) also reports as a scale
    // below 1 while the visual viewport stays as wide as the layout, so the width tells them apart.
    || !!viewport && Math.abs(viewport.width - document.documentElement.clientWidth) < 2 && reference - height > reference * 0.2);
  if (!visible) unobstructedHeights.set(width, { large, height: Math.max(reference, height) });
  root.toggleAttribute("data-keyboard", visible);
  // the key bar's keyboard control reads this value with its tap word (lib/keyboardControl.ts):
  // label and tap hold the user's word while the value is mid-animation
  keyboardControl.measure(visible);
  if (visible && viewport) root.style.setProperty("--app-height", `${Math.round(height)}px`);
  else {
    // Only correct the standalone status region when the screen-to-CSS gap
    // agrees with the measured top safe area.
    const inset = topInset.getBoundingClientRect().height;
    const missing = window.screen.height - largeViewport.getBoundingClientRect().height;
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    if (standalone && inset > 0
      && Math.abs(missing - inset) < 2 && window.screen.height > window.innerWidth)
      root.style.setProperty("--app-height", `${Math.round(window.screen.height)}px`);
    // An iPad home-screen app in landscape draws the shell 100dvh tall while the visual viewport stops
    // above the status bar. The page can then scroll by that band, and iOS does so to reveal a field that
    // gets the focus: the whole shell slid up and back on every tap into the composer. With no keyboard and
    // no browser chrome, the visual viewport is the whole usable screen, so the shell fits it. Only a small
    // band counts; a larger gap is a keyboard or a split view, which the rules above own. iPads only (the
    // smallest is 744 points on its short side); a phone keeps the rule above. The screen tells the iPad,
    // not the layout: an enlarged page zoom (125% lays an 820-point side out at 656px) or a narrow window
    // shrinks the layout under 744px on the same iPad. Safari's page zoom reports as a scale other than 1
    // with the visual viewport as wide as the layout, a pinch zoom narrows it: the width test keeps this
    // on at a page zoom and off while pinched.
    else if (standalone && Math.min(window.screen.width, window.screen.height) >= 744 && viewport
      && Math.abs(viewport.width - document.documentElement.clientWidth) < 2 && large - height > 0 && large - height < reference * 0.2)
      root.style.setProperty("--app-height", `${Math.round(height)}px`);
    else root.style.removeProperty("--app-height");
  }
  pinPage();
};
// iOS Safari zooms the page into a field whose text is under 16px when it gets the focus. Fields draw at
// the interface size (styles.css .input/.select), like the labels beside them; on iOS the press that
// precedes the focus arms a text field to --fs-input, and the field keeps it while it has the focus. A
// press on a field's label arms the field the label focuses. A field focused by a handler (a press on
// Find in diff or Rename tab focuses a field it did not touch) is armed as it takes the focus.
// A native select is armed only as it takes the focus: its box follows its text, so armed by the press it
// would widen under the finger, could push its row's label onto another line and move away from the tap.
// Only a control Safari zooms into is armed: a text field, a textarea or a native select that can take the
// focus. A button drawn as a select (the agent picker) opens a menu, never zooms and may not even take the
// focus, so a press must not resize its label; a disabled field is not focused by its label either.
// Nothing stays armed without the focus: a press the browser cancels (a scroll), one that ends in a click
// a handler kept from focusing, one that never ends in a click (the next press clears it), and a field
// that lost the focus by being disabled or hidden, with a blur or, where the browser sends none, without.
if (ios) {
  const field = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const control = target.closest<HTMLElement>(".input, .select") ?? target.closest("label")?.control;
    return control instanceof HTMLElement && control.matches(".input, .select")
      && control.matches("input, textarea, select") && !control.matches(":disabled") ? control : null;
  };
  let pressed: HTMLElement | null = null;
  const disarm = (keep: Element | null): void => {
    for (const armed of document.querySelectorAll("[data-armed]"))
      if (armed !== document.activeElement && armed !== keep) armed.removeAttribute("data-armed");
  };
  const release = (): void => {
    pressed = null;
    disarm(null);
  };
  document.addEventListener("pointerdown", (event) => {
    release();
    const target = field(event.target);
    pressed = target instanceof HTMLSelectElement ? null : target;
    pressed?.setAttribute("data-armed", "");
  }, true);
  document.addEventListener("pointercancel", release, true);
  // a click's own default (a label focusing its field) runs after its listeners: look once it is done
  document.addEventListener("click", () => {
    if (pressed) window.setTimeout(release, 0);
  }, true);
  document.addEventListener("focusin", (event) => {
    disarm(pressed);
    field(event.target)?.setAttribute("data-armed", "");
  }, true);
  // unfiltered: a field disabled while it had the focus is no longer one `field` accepts
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof Element) event.target.removeAttribute("data-armed");
  }, true);
}
// iPadOS 26 draws a windowed app's controls (close, minimize, full screen) over the page's top-left
// corner, where the header's first button sits, and no safe area or titlebar-area value reports them.
// A full-screen app has none there (they wait in the menu bar). A home-screen app narrower than the
// screen is in a window: mark it, and the header leaves the corner free (styles.css). The visual
// viewport's width × scale is the window's width in points whatever Safari's page zoom. The controls
// are drawn in points and the page in CSS pixels, so their room is converted through the page zoom
// (viewport.scale while the visual viewport is as wide as the layout, i.e. not pinched).
// Only iPadOS 26 and later draw them. iPadOS 16 to 18 show a home-screen app narrower than the screen too
// (Split View, Slide Over, a Stage Manager window) with nothing in that corner, and a home-screen app's
// user agent on an iPad names no system version. CSS anchor positioning arrived with Safari 26, so its
// support tells the two apart.
const WINDOW_CONTROLS_PT = 68; // the controls' right edge plus a gap, in points, measured on iPadOS 26
const drawsWindowControls = ios && typeof CSS !== "undefined" && CSS.supports("anchor-name: --a");
const standaloneApp = window.matchMedia("(display-mode: standalone)");
const syncWindowControls = (): void => {
  if (viewport && Math.abs(viewport.width - window.innerWidth) < 2)
    root.style.setProperty("--window-controls-w", `${Math.ceil(WINDOW_CONTROLS_PT / viewport.scale)}px`);
  const width = viewport ? viewport.width * viewport.scale : window.innerWidth;
  const landscape = screen.orientation ? screen.orientation.type.startsWith("landscape") : window.innerWidth > window.innerHeight;
  const screenWidth = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  // the width carries up to one CSS pixel of rounding, which is `scale` points: at a 300% page zoom a
  // full-screen app can read two points narrower than its screen. A real window is far narrower than that.
  const slack = Math.max(1, viewport?.scale ?? 1) + 1;
  root.toggleAttribute("data-window-controls", standaloneApp.matches && width < screenWidth - slack);
};
// every way in or out of a window changes its width, so a resize is the only event to follow
if (drawsWindowControls) {
  viewport?.addEventListener("resize", syncWindowControls);
  window.addEventListener("resize", syncWindowControls);
  syncWindowControls();
}
viewport?.addEventListener("resize", syncKeyboard);
viewport?.addEventListener("scroll", syncKeyboard);
window.addEventListener("resize", syncKeyboard);
window.addEventListener("orientationchange", syncKeyboard);
touch.addEventListener("change", syncKeyboard);
keyboard?.addEventListener("geometrychange", syncKeyboard);
document.addEventListener("focusin", syncKeyboard);
document.addEventListener("visibilitychange", () => {
  if (shouldSyncViewportOnResume("visibilitychange", document.visibilityState)) syncKeyboard();
});
window.addEventListener("pageshow", () => {
  if (shouldSyncViewportOnResume("pageshow", document.visibilityState)) syncKeyboard();
});
// focus moving from one field to the next blurs first: read where it landed
document.addEventListener("focusout", () => window.setTimeout(syncKeyboard, 0));
// Switching xterm direct typing leaves its helper focused; observe the mode change.
new MutationObserver(syncKeyboard).observe(root, { attributes: true, subtree: true, attributeFilter: ["data-direct-typing"] });
syncKeyboard();
