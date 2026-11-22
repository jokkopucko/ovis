import assert from "node:assert/strict";
import { startDemo, type Demo } from "./ideal-state-behaviour-harness.ts";
import { probeIdleState } from "./ideal-state-idle.ts";

const demo = await startDemo();
const injecting = (className: string, css: string): Demo => ({
  ...demo,
  async open(options) {
    const visit = await demo.open(options);
    try {
      await visit.page.evaluate(({ className, css }) => {
        const block = document.createElement("div");
        block.className = className;
        block.style.cssText = `position:fixed;top:50px;left:50px;width:44px;height:44px;box-sizing:border-box;z-index:99999;${css}`;
        document.body.append(block);
      }, { className, css });
      const measured = await visit.page.locator(`.${className}`).evaluate((block) => ({
        background: getComputedStyle(block).backgroundColor,
        width: block.getBoundingClientRect().width,
        height: block.getBoundingClientRect().height,
      }));
      console.log("INJECTED", measured);
      assert.equal(measured.width, 44);
      assert.equal(measured.height, 44);
      return visit;
    } catch (error) {
      await visit.context.close();
      throw error;
    }
  },
});
try {
  const idle = await probeIdleState(demo);
  console.log(`${idle.status} IS-018 clean: ${idle.value}`);
  assert.equal(idle.status, "PASS", idle.value);
  const danger = await probeIdleState(injecting("reviewer-danger", "background:var(--status-blocked)"));
  console.log(`${danger.status} IS-018 injected: ${danger.value}`);
  assert.equal(danger.status, "FAIL", danger.value);
  assert.equal(danger.value, "all agents idle: 0 running animations [], 1 danger elements [div.reviewer-danger]");
  const border = await probeIdleState(injecting("reviewer-danger-border", "border-bottom:3px solid var(--status-blocked)"));
  console.log(`${border.status} IS-018 border only: ${border.value}`);
  assert.equal(border.status, "FAIL", border.value);
  assert.equal(border.value, "all agents idle: 0 running animations [], 1 danger elements [div.reviewer-danger-border]");
} finally {
  await demo.close();
}
