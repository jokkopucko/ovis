import type { Demo } from "./ideal-state-behaviour-harness.ts";
import { panes } from "./ideal-state-behaviour-harness.ts";

declare global {
  interface Window {
    readonly __probe: {
      finishTurn(): void;
      status(pane: string, status: string): void;
    };
  }
}

export async function probeIdleState(demo: Demo): Promise<{ readonly status: "PASS" | "FAIL"; readonly value: string }> {
  const { context, page } = await demo.open({ pane: panes.flaky });
  try {
    await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
    await page.evaluate(() => window.__probe.finishTurn());
    for (const pane of [panes.api, panes.web, panes.flaky, panes.omp, panes.cli, panes.hermes]) {
      await page.evaluate((id) => window.__probe.status(id, "idle"), pane);
    }
    await page.waitForFunction(() => document.querySelector('.badge-working, .badge-blocked, .tab-strip-dot[data-status="working"], .tab-strip-dot[data-status="blocked"], .work-block.is-live') === null);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || !Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)), undefined, { timeout: 5_000 });
    const found = await page.evaluate(() => {
      const resolve = (token: string) => { const swatch = document.createElement("span"); swatch.style.color = `var(${token})`; document.body.append(swatch); const color = getComputedStyle(swatch).color; swatch.remove(); return color; };
      const danger = new Set(["--danger-text", "--status-blocked", "--indicator-blocked"].map(resolve));
      const tint = new Set([...["--danger-tint", "--status-blocked-tint"].map(resolve), ...danger]);
      const name = (node: Element) => `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`;
      const drawnDanger = [...document.querySelectorAll("body *")].filter((node) => {
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const style = getComputedStyle(node);
        const ownText = [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() !== "");
        const dangerBorder = (["Top", "Right", "Bottom", "Left"] as const).some((side) => parseFloat(style[`border${side}Width`]) > 0 && danger.has(style[`border${side}Color`]));
        return (ownText && danger.has(style.color)) || tint.has(style.backgroundColor) || dangerBorder;
      }).map(name);
      const running = document.getAnimations().filter((animation) => animation.playState === "running").map((animation) => animation.effect instanceof KeyframeEffect && animation.effect.target instanceof Element ? name(animation.effect.target) : "unknown animation target");
      return { running, drawnDanger };
    });
    return {
      status: found.running.length === 0 && found.drawnDanger.length === 0 ? "PASS" : "FAIL",
      value: `all agents idle: ${found.running.length} running animations [${found.running.join(" ")}], ${found.drawnDanger.length} danger elements [${found.drawnDanger.join(" ")}]`,
    };
  } finally { await context.close(); }
}
