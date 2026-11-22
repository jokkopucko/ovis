import type { Page } from "playwright-core";
import assert from "node:assert/strict";

/** Measure main-thread CPU over the diff check; Long Tasks records elapsed time, including descheduling. */
export async function startRendererTiming(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const cpuTime = async (): Promise<number> => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const task = metrics.find((metric) => metric.name === "TaskDuration");
    assert.ok(task, "Chromium reports renderer task CPU time");
    return task.value * 1_000;
  };
  const start = await cpuTime();
  return async () => {
    const cpuMs = await cpuTime() - start;
    await cdp.detach();
    return cpuMs;
  };
}
