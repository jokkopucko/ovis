import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "./wheelSteps.ts";
import { layoutScroll } from "./layoutScroll.ts";
import { claimTouchStroke, TOUCH_STROKE_CLAIMED } from "./touchClaim.ts";
import { drawerSettles, EDGE_PX, FLING_SPEED, SWIPE_PX, swipeVerdict, watchDrawerSwipe as watchDrawerSwipeListener } from "./edgeSwipe.ts";

// Most listener fixtures model an available drawer without rendering the app shell.
const watchDrawerSwipe = (isOpen: () => boolean, setOpen: (open: boolean) => void, canOpen = () => true) =>
  watchDrawerSwipeListener(isOpen, setOpen, canOpen);

describe("swipeVerdict", () => {
  test("a swipe in from the left edge opens the closed drawer", () => {
    expect(swipeVerdict(false, 4, 20, 2)).toBe("claim");
    expect(swipeVerdict(false, 4, SWIPE_PX, 5)).toBe("open");
  });

  test("a flat rightward stroke opens from mid-screen, including the angle boundary", () => {
    expect(swipeVerdict(false, 200, 20, 10)).toBe("pending");
    expect(swipeVerdict(false, 200, SWIPE_PX, SWIPE_PX / 2)).toBe("open");
    expect(swipeVerdict(false, 200, SWIPE_PX, -SWIPE_PX / 2)).toBe("open");
    expect(swipeVerdict(false, 200, -SWIPE_PX, 0)).toBe("ignore");
    expect(swipeVerdict(false, 200, 3, 2)).toBe("pending");
  });

  test("diagonal strokes scroll away from the edge, which keeps its looser angle", () => {
    expect(swipeVerdict(false, EDGE_PX + 1, 56, 29)).toBe("ignore");
    expect(swipeVerdict(false, 200, 56, -29)).toBe("ignore");
    expect(swipeVerdict(false, EDGE_PX, 56, 40)).toBe("open");
    expect(swipeVerdict(true, 200, -56, 40)).toBe("close");
  });

  test("a vertical stroke from the edge still scrolls", () => {
    expect(swipeVerdict(false, 4, 12, 40)).toBe("ignore");
  });

  test("a tiny movement is not a direction yet", () => {
    expect(swipeVerdict(false, 4, 3, 2)).toBe("pending");
  });

  test("a swipe to the left anywhere closes the open drawer", () => {
    expect(swipeVerdict(true, 200, -20, 3)).toBe("claim");
    expect(swipeVerdict(true, 200, -SWIPE_PX, 3)).toBe("close");
    expect(swipeVerdict(true, 200, SWIPE_PX, 3)).toBe("ignore");
  });
});

describe("drawerSettles", () => {
  test("let go slowly, the drawer stays open when more than half of it shows", () => {
    expect(drawerSettles(170, 300, 0)).toBe(true);
    expect(drawerSettles(130, 300, 0)).toBe(false);
  });

  test("a flick settles it the way it went, wherever it is let go", () => {
    expect(drawerSettles(40, 300, FLING_SPEED)).toBe(true);
    expect(drawerSettles(260, 300, -FLING_SPEED)).toBe(false);
  });
});

describe("watchDrawerSwipe", () => {
  type Handler = (event: unknown) => void;
  let listeners: Map<string, Handler>;
  let saved: { window: unknown; document: unknown };
  let narrow: { matches: boolean; addEventListener(type: string, handler: Handler): void; removeEventListener(type: string): void };
  let modal: unknown;
  let selection: { isCollapsed: boolean };

  beforeEach(() => {
    listeners = new Map();
    narrow = { matches: true,
      addEventListener: (_type, handler) => { listeners.set("media-change", handler); },
      removeEventListener: () => { listeners.delete("media-change"); } };
    modal = null;
    selection = { isCollapsed: true };
    saved = { window: (globalThis as Record<string, unknown>)["window"], document: (globalThis as Record<string, unknown>)["document"] };
    (globalThis as Record<string, unknown>)["window"] = { matchMedia: () => narrow,
      addEventListener: (type: string, handler: Handler) => listeners.set(`window:${type}`, handler),
      removeEventListener: (type: string) => listeners.delete(`window:${type}`) };
    (globalThis as Record<string, unknown>)["document"] = {
      addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
      removeEventListener: (type: string) => listeners.delete(type),
      querySelector: () => modal,
      getSelection: () => selection,
    };
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>)["window"] = saved.window;
    (globalThis as Record<string, unknown>)["document"] = saved.document;
  });

  const stroke = (points: [number, number][], open = false, target: unknown = null, midway?: () => void) => {
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => open, (next) => calls.push(next));
    let reached = 0;
    const event = (x: number, y: number) => {
      let blocked = false;
      return { touches: [{ clientX: x, clientY: y }], preventDefault: () => { blocked = true; }, stopPropagation: () => { blocked = true; }, get blocked() { return blocked; } };
    };
    const [first, ...rest] = points;
    listeners.get("touchstart")!({ ...event(first![0], first![1]), target });
    for (const [index, [x, y]] of rest.entries()) {
      if (index === 1) midway?.();
      const move = event(x, y);
      listeners.get("touchmove")!(move);
      if (!move.blocked) reached++;
    }
    listeners.get("touchend")!({ touches: [] });
    stop();
    return { reached, calls };
  };

  test("an unavailable closed drawer leaves interior and edge strokes with the page", () => {
    for (const x of [4, 200]) {
      const calls: boolean[] = [];
      const target = scrollTarget();
      let claims = 0;
      target.dispatchEvent = () => { claims++; return true; };
      const stop = watchDrawerSwipe(() => false, (next) => calls.push(next), () => false);
      const event = (dx: number, dy: number) => ({ target, touches: [{ clientX: x + dx, clientY: 300 + dy }],
        preventDefault() { throw new Error("page scroll prevented"); },
        stopPropagation() { throw new Error("page move stopped"); } });
      listeners.get("touchstart")!(event(0, 0));
      listeners.get("touchmove")!(event(54, 27));
      listeners.get("touchmove")!(event(70, 30));
      listeners.get("touchmove")!(event(70, 90));
      listeners.get("touchend")!({ touches: [] });
      expect(calls).toEqual([]);
      expect(claims).toBe(0);
      expect(target.style.getPropertyValue("overflow-y")).toBe("");
      stop();
    }
  });

  test("an unavailable drawer preserves the terminal remainder until lift", () => {
    const target = new EventTarget();
    let pixels = 0;
    let reports = 0;
    const stepPixels = 16.5 * HERDR_MOUSE_SCROLL_LINES;
    target.addEventListener(TOUCH_STROKE_CLAIMED, () => { pixels = 0; });
    const stop = watchDrawerSwipe(() => false, () => { throw new Error("drawer opened"); }, () => false);
    let lastY = 300;
    const event = (x: number, y: number) => {
      let blocked = false;
      return { target, touches: [{ clientX: x, clientY: y }], preventDefault() { blocked = true; },
        stopPropagation() { blocked = true; }, get blocked() { return blocked; } };
    };
    listeners.get("touchstart")!(event(200, 300));
    for (const [x, y] of [[254, 327], [270, 330]] as const) {
      const move = event(x, y);
      listeners.get("touchmove")!(move);
      if (!move.blocked) {
        const next = wheelSteps(pixels + y - lastY, stepPixels);
        reports += next.steps;
        pixels = next.rest;
        lastY = y;
      }
    }
    listeners.get("touchend")!({ touches: [] });
    reports += finalStep(pixels, stepPixels);
    expect(reports).toBe(1);
    stop();
  });

  test("availability is rechecked before claiming a pending interior stroke", () => {
    let available = true;
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (next) => calls.push(next), () => available);
    const event = (x: number) => ({ touches: [{ clientX: x, clientY: 300 }],
      preventDefault() { throw new Error("page scroll prevented"); },
      stopPropagation() { throw new Error("page move stopped"); } });
    listeners.get("touchstart")!(event(200));
    listeners.get("touchmove")!(event(230));
    available = false;
    listeners.get("touchmove")!(event(270));
    listeners.get("touchend")!({ touches: [] });
    expect(calls).toEqual([]);
    stop();
  });

  test("an already open drawer can close even when opening is blocked", () => {
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => true, (next) => calls.push(next), () => false);
    const event = (x: number) => ({ touches: [{ clientX: x, clientY: 300 }], preventDefault() {}, stopPropagation() {} });
    listeners.get("touchstart")!(event(200));
    listeners.get("touchmove")!(event(130));
    listeners.get("touchend")!({ touches: [] });
    expect(calls).toEqual([false]);
    stop();
  });

  test("a claimed stroke that comes back within the slop keeps every move from the page", () => {
    expect(stroke([[4, 400], [24, 400], [6, 400], [5, 400]])).toEqual({ reached: 0, calls: [] });
  });

  test("a claimed stroke that comes back and goes on opens the drawer once, and keeps its moves", () => {
    expect(stroke([[4, 400], [24, 400], [6, 400], [70, 400], [90, 460], [120, 520]])).toEqual({ reached: 0, calls: [true] });
  });

  test("a flat mid-screen stroke opens and retains the stroke after opening", () => {
    expect(stroke([[200, 300], [220, 305], [260, 320], [280, 370]])).toEqual({ reached: 1, calls: [true] });
  });

  test("an initially flat interior stroke turns into scrolling without cancelling either move", () => {
    expect(stroke([[200, 300], [220, 302], [220, 370]])).toEqual({ reached: 2, calls: [] });
  });

  test("a diagonal mid-screen stroke stays with the page even if it later flattens", () => {
    expect(stroke([[200, 300], [220, 311], [280, 311]])).toEqual({ reached: 2, calls: [] });
  });

  test("a divider excludes opening, but still permits closing the open drawer", () => {
    const divider = { getAttribute: (name: string) => name === "role" ? "separator" : null, parentElement: null };
    const child = { parentElement: divider };
    for (const target of [divider, child]) {
      expect(stroke([[200, 300], [230, 300], [280, 300]], false, target)).toEqual({ reached: 2, calls: [] });
      expect(stroke([[200, 300], [170, 300], [120, 300]], true, target)).toEqual({ reached: 0, calls: [false] });
    }
  });

  test("only a committed interior opening cancels the origin's pending touch work, once", () => {
    const target = new EventTarget();
    let claims = 0;
    target.addEventListener(TOUCH_STROKE_CLAIMED, () => claims++);
    stroke([[200, 300], [220, 302]], false, target);
    stroke([[200, 300], [220, 302], [220, 370]], false, target);
    stroke([[4, 300], [24, 302], [70, 302]], false, target);
    expect(claims).toBe(0);
    stroke([[200, 300], [220, 310], [260, 326], [280, 330], [300, 340]], false, target);
    expect(claims).toBe(1);
    stroke([[300, 300], [240, 300], [200, 300]], true, target);
    expect(claims).toBe(1);
  });

  const inlineStyle = () => {
    const values = new Map<string, { value: string; priority: string }>();
    return {
      getPropertyValue: (property: string) => values.get(property)?.value ?? "",
      getPropertyPriority: (property: string) => values.get(property)?.priority ?? "",
      setProperty: (property: string, value: string, priority = "") => { values.set(property, { value, priority }); },
      removeProperty: (property: string) => { const old = values.get(property)?.value ?? ""; values.delete(property); return old; },
    };
  };

  const scrollTarget = () => {
    const target = { scrollHeight: 500, clientHeight: 100, scrollTop: 100,
      scrollWidth: 200, clientWidth: 100, scrollLeft: 0, parentElement: null, style: inlineStyle(),
      dispatchEvent: (event: Event) => { listeners.get(event.type)?.({ target }); return true; } };
    return target;
  };

  test.each(["touchend", "touchcancel"])("a replaced transcript row carries the pending stroke through %s", (ending) => {
    const host = scrollTarget();
    const row = Object.assign(new EventTarget(), { isConnected: true, parentElement: host });
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (next) => calls.push(next));
    const move = (x: number) => Object.assign(new Event("touchmove", { cancelable: true }), {
      touches: [{ clientX: x, clientY: 300 }],
    });
    try {
      listeners.get("touchstart")?.({ ...move(200), target: row, composedPath: () => [row, host] });
      const pending = move(230);
      listeners.get("touchmove")?.(pending);
      expect(pending.defaultPrevented).toBe(false);
      row.isConnected = false;
      row.dispatchEvent(move(270));
      expect(calls).toEqual([true]);
      expect(host.style.getPropertyValue("overflow-y")).toBe("hidden");
      row.dispatchEvent(new Event(ending));
      expect(host.style.getPropertyValue("overflow-y")).toBe("");
      const afterLift = move(280);
      row.dispatchEvent(afterLift);
      expect(afterLift.defaultPrevented).toBe(false);
    } finally {
      stop();
    }
  });

  test("only the committed interior opening locks scroll axes, then restores inline values and priorities", () => {
    for (const ending of ["touchend", "touchcancel", "second-finger", "wide", "cleanup", "set-open-throws", "partial-lock-throws", "hidden", "pagehide", "blur", "detached"] as const) {
      narrow.matches = true;
      const target = scrollTarget();
      const originListeners = new Map<string, EventListener>();
      if (ending === "detached") Object.assign(target, {
        addEventListener: (type: string, handler: EventListener) => originListeners.set(type, handler),
        removeEventListener: (type: string) => originListeners.delete(type),
      });
      target.style.setProperty("overflow-x", "scroll", "important");
      target.style.setProperty("overflow-y", "auto");
      (document as unknown as { getElementById(): unknown }).getElementById = () => ({ style: {}, getBoundingClientRect: () => ({ width: 300 }) });
      let open = false;
      const stop = watchDrawerSwipe(() => open, (next) => {
        if (ending === "set-open-throws" && next) throw new Error("open failed");
        open = next;
      });
      const event = (x: number) => ({ touches: [{ clientX: x, clientY: 300 }], target, cancelable: false, stopPropagation() {}, timeStamp: x });
      listeners.get("touchstart")!(event(200));
      listeners.get("touchmove")!(event(220));
      expect(target.style.getPropertyValue("overflow-x")).toBe("scroll");
      expect(target.style.getPropertyValue("overflow-y")).toBe("auto");
      if (ending === "partial-lock-throws") {
        const set = target.style.setProperty;
        target.style.setProperty = (property, value, priority) => {
          if (property === "overflow-y" && value === "hidden") throw new Error("lock failed");
          set(property, value, priority);
        };
      }
      if (ending === "set-open-throws" || ending === "partial-lock-throws") {
        expect(() => listeners.get("touchmove")!(event(270))).toThrow();
      } else {
        listeners.get("touchmove")!(event(270));
        expect(target.style.getPropertyValue("overflow-x")).toBe("hidden");
        expect(target.style.getPropertyValue("overflow-y")).toBe("hidden");
        if (ending === "hidden") {
          (document as unknown as { visibilityState: string }).visibilityState = "hidden";
          listeners.get("visibilitychange")!({});
        }
        else if (ending === "pagehide" || ending === "blur") listeners.get(`window:${ending}`)!({});
        else if (ending === "detached") {
          Object.assign(target, { isConnected: false });
          originListeners.get("touchend")?.(new Event("touchend"));
          expect(originListeners.size).toBe(0);
        }
        else if (ending === "cleanup") stop();
        else if (ending === "wide") { narrow.matches = false; listeners.get("media-change")!({}); }
        else if (ending === "second-finger") listeners.get("touchstart")!({ ...event(270), touches: [{ clientX: 270, clientY: 300 }, { clientX: 290, clientY: 300 }] });
        else listeners.get(ending)!({ touches: [], timeStamp: 400 });
      }
      expect(target.style.getPropertyValue("overflow-x")).toBe("scroll");
      expect(target.style.getPropertyPriority("overflow-x")).toBe("important");
      expect(target.style.getPropertyValue("overflow-y")).toBe("auto");
      expect(target.style.getPropertyPriority("overflow-y")).toBe("");
      stop();
    }
  });

  test("folded hosts lock only the scrollable axis and adopted hosts lock both", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const savedStyle = globals["getComputedStyle"];
    try {
      for (const folded of [true, false]) {
        globals["getComputedStyle"] = () => ({ overflowX: folded ? "hidden" : "auto", overflowY: "auto" });
        const target = scrollTarget();
        expect(stroke([[200, 300], [260, 300], [280, 250]], false, target, () => {
          expect(target.style.getPropertyValue("overflow-x")).toBe(folded ? "" : "hidden");
          expect(target.style.getPropertyValue("overflow-y")).toBe("hidden");
        })).toEqual({ reached: 0, calls: [true] });
        expect(target.style.getPropertyValue("overflow-x")).toBe("");
        expect(target.style.getPropertyValue("overflow-y")).toBe("");
      }
    } finally {
      if (savedStyle === undefined) delete globals["getComputedStyle"];
      else globals["getComputedStyle"] = savedStyle;
    }
  });

  test("yielding before a claim never locks, and absent inline declarations are removed after lift", () => {
    const target = scrollTarget();
    let writes = 0;
    const set = target.style.setProperty;
    target.style.setProperty = (...args) => { writes++; set(...args); };
    expect(stroke([[200, 300], [220, 310], [270, 330]], false, target,
      () => { target.scrollTop -= 10; })).toEqual({ reached: 2, calls: [] });
    expect(writes).toBe(0);
    target.scrollTop = 100;
    expect(stroke([[200, 300], [220, 300], [270, 300]], false, target)).toEqual({ reached: 1, calls: [true] });
    expect(writes).toBe(2);
    expect(target.style.getPropertyValue("overflow-x")).toBe("");
    expect(target.style.getPropertyValue("overflow-y")).toBe("");
  });

  test("an interior gesture that already scrolled vertically or horizontally stays with the page", () => {
    const target = scrollTarget();
    expect(stroke([[200, 300], [220, 310], [270, 330]], false, target,
      () => { target.scrollTop = 90; })).toEqual({ reached: 2, calls: [] });
    expect(stroke([[200, 300], [220, 310], [270, 330]], false, target,
      () => { target.scrollLeft = 10; })).toEqual({ reached: 2, calls: [] });
  });

  test("an unchanged scroll container still allows an interior opening", () => {
    expect(stroke([[200, 300], [220, 310], [270, 330]], false, scrollTarget())).toEqual({ reached: 1, calls: [true] });
  });

  test("a late compositor scroll yields the drawer too, instead of letting it stay open over scrolling", () => {
    const target = scrollTarget();
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = () => drawer;
    expect(stroke([[200, 300], [260, 310], [300, 320]], false, target, () => {
      target.scrollTop = 90;
      listeners.get("scroll")!({ target });
    })).toEqual({ reached: 1, calls: [true, false] });
    expect(drawer.style["transform"]).toBe("");
  });

  test("explicit layout following keeps opening through growth, shrinkage and two-stage near-end moves", () => {
    for (const committed of [false, true]) for (const resize of [20, -20, 0]) {
      const target = scrollTarget();
      target.scrollTop = 380;
      const points: [number, number][] = committed
        ? [[200, 300], [260, 310], [300, 320]] : [[200, 300], [220, 310], [270, 330]];
      expect(stroke(points, false, target, () => {
        layoutScroll(target as unknown as HTMLElement, () => {
          target.scrollHeight += resize;
          target.scrollTop += resize / 2;
          layoutScroll(target as unknown as HTMLElement, () => { target.scrollTop += resize / 2; });
        });
        layoutScroll(target as unknown as HTMLElement, () => { target.scrollTop = target.scrollHeight - target.clientHeight; });
        listeners.get("scroll")!({ target });
      })).toEqual({ reached: committed ? 0 : 1, calls: [true] });
    }
  });

  test("native movement cannot be hidden by an automatic absolute write before its scroll event arrives", () => {
    for (const committed of [false, true]) {
      const target = scrollTarget();
      const points: [number, number][] = committed
        ? [[200, 300], [260, 310], [300, 320]] : [[200, 300], [220, 310], [270, 330]];
      expect(stroke(points, false, target, () => {
        target.scrollTop -= 10;
        layoutScroll(target as unknown as HTMLElement, () => { target.scrollTop = 400; });
      })).toEqual({ reached: committed ? 1 : 2, calls: committed ? [true, false] : [] });
    }
  });

  test("a native scroll after an automatic write still wins", () => {
    const target = scrollTarget();
    expect(stroke([[200, 300], [260, 310], [300, 320]], false, target, () => {
      layoutScroll(target as unknown as HTMLElement, () => { target.scrollTop += 20; });
      target.scrollTop -= 10;
      listeners.get("scroll")!({ target });
    })).toEqual({ reached: 1, calls: [true, false] });
  });

  test("a browser clamp to a shorter end needs no layout notification", () => {
    const target = scrollTarget();
    target.scrollTop = 380;
    expect(stroke([[200, 300], [260, 310], [300, 320]], false, target, () => {
      target.scrollHeight = 400;
      target.scrollTop = 300;
      listeners.get("scroll")!({ target });
    })).toEqual({ reached: 0, calls: [true] });
  });

  test("a native scroll at lift yields, but later receipt scrolls cannot close a settled drawer", () => {
    for (const phase of ["at-lift", "after-lift", "after-layout"] as const) {
      const target = scrollTarget();
      const drawer = { style: {}, getBoundingClientRect: () => ({ width: 300 }) };
      (document as unknown as { getElementById(): unknown }).getElementById = () => drawer;
      let open = false;
      const stop = watchDrawerSwipe(() => open, (next) => { open = next; });
      listeners.get("touchstart")!({ touches: [{ clientX: 200, clientY: 300 }], target, timeStamp: 0 });
      listeners.get("touchmove")!({ touches: [{ clientX: 270, clientY: 310 }], cancelable: false, stopPropagation() {}, timeStamp: 100 });
      expect(open).toBe(true);
      if (phase === "at-lift") target.scrollTop -= 10;
      listeners.get("touchend")!({ touches: [], timeStamp: 250 });
      if (phase === "after-layout") {
        layoutScroll(target as unknown as HTMLElement, () => { target.scrollTop += 50; });
        listeners.get("scroll")!({ target });
        expect(open).toBe(true);
      }
      if (phase !== "at-lift") {
        target.scrollTop -= 10;
        listeners.get("scroll")!({ target });
      }
      expect(open).toBe(phase !== "at-lift");
      stop();
    }
  });

  test("a new interaction does not attribute scrolling to an ended opening", () => {
    const target = scrollTarget();
    (document as unknown as { getElementById(): unknown }).getElementById = () => ({ style: {}, getBoundingClientRect: () => ({ width: 300 }) });
    let open = false;
    const stop = watchDrawerSwipe(() => open, (next) => { open = next; });
    listeners.get("touchstart")!({ touches: [{ clientX: 200, clientY: 300 }], target, timeStamp: 0 });
    listeners.get("touchmove")!({ touches: [{ clientX: 270, clientY: 300 }], cancelable: false, stopPropagation() {}, timeStamp: 100 });
    listeners.get("touchend")!({ touches: [], timeStamp: 250 });
    expect(open).toBe(true);
    listeners.get("touchstart")!({ touches: [{ clientX: 200, clientY: 300 }], target: null, timeStamp: 300 });
    target.scrollTop -= 10;
    listeners.get("scroll")!({ target });
    expect(open).toBe(true);
    stop();
  });

  test("programmatic scrolling of overflow-hidden ancestors is not a native scroll", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const savedStyle = globals["getComputedStyle"];
    globals["getComputedStyle"] = () => ({ overflowX: "hidden", overflowY: "hidden" });
    try {
      const target = scrollTarget();
      expect(stroke([[200, 300], [220, 310], [270, 330]], false, target,
        () => { target.scrollTop = 90; })).toEqual({ reached: 1, calls: [true] });
    } finally {
      if (savedStyle === undefined) delete globals["getComputedStyle"];
      else globals["getComputedStyle"] = savedStyle;
    }
  });

  test("ownership reaches a connected ancestor after a renderer replaces the original row", () => {
    const row = Object.assign(new EventTarget(), { isConnected: false });
    const host = Object.assign(new EventTarget(), { isConnected: true });
    let rowClaims = 0;
    let hostClaims = 0;
    row.addEventListener(TOUCH_STROKE_CLAIMED, () => rowClaims++);
    host.addEventListener(TOUCH_STROKE_CLAIMED, () => hostClaims++);
    claimTouchStroke([row, host]);
    expect(rowClaims).toBe(0);
    expect(hostClaims).toBe(1);
  });

  test("page-level scrolling also wins an undecided interior gesture", () => {
    const view = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;
    expect(stroke([[200, 300], [220, 310], [270, 330]], false, null,
      () => { view["scrollY"] = 10; })).toEqual({ reached: 2, calls: [] });
  });

  test("a vertical stroke from mid-screen belongs to the page", () => {
    expect(stroke([[200, 300], [200, 330], [200, 360], [200, 400]])).toEqual({ reached: 3, calls: [] });
  });

  test("a swipe to the left closes the open drawer", () => {
    expect(stroke([[300, 400], [270, 400], [200, 400]], true)).toEqual({ reached: 0, calls: [false] });
  });

  test("a stroke that turns to scrolling before the drawer moved goes back to the page", () => {
    expect(stroke([[4, 300], [15, 302], [15, 360], [15, 430]])).toEqual({ reached: 2, calls: [] });
  });

  test("a swipe over a dialog, the palette or a sheet leaves the drawer under it alone", () => {
    modal = {};
    expect(stroke([[4, 400], [24, 400], [90, 400]])).toEqual({ reached: 2, calls: [] });
  });

  test("a sheet opened after touchdown keeps a pending stroke from opening the drawer", () => {
    const target = scrollTarget();
    expect(stroke([[200, 400], [230, 400], [280, 400]], false, target,
      () => { modal = {}; })).toEqual({ reached: 2, calls: [] });
  });

  test("a swipe on a code block scrolled sideways scrolls it back instead", () => {
    const code = { scrollLeft: 40, scrollWidth: 900, clientWidth: 350, parentElement: null };
    const text = { scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: code };
    for (const target of [code, text]) {
      expect(stroke([[200, 400], [230, 400], [270, 400]], false, target)).toEqual({ reached: 2, calls: [] });
      expect(stroke([[200, 400], [170, 400], [130, 400]], false, target)).toEqual({ reached: 2, calls: [] });
    }
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, text)).toEqual({ reached: 2, calls: [] });
    code.scrollLeft = 0;
    expect(stroke([[200, 400], [230, 400], [270, 400]], false, text)).toEqual({ reached: 1, calls: [true] });
  });

  test("a stroke that goes on after the screen turned wide leaves the drawer alone", () => {
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, null, () => { narrow.matches = false; })).toEqual({ reached: 1, calls: [] });
  });

  test("a stroke on a text field edits it, the drawer open or closed", () => {
    const input = { tagName: "TEXTAREA", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: null };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, input)).toEqual({ reached: 2, calls: [] });
    expect(stroke([[300, 400], [270, 400], [200, 400]], true, input)).toEqual({ reached: 2, calls: [] });
    const block = { isContentEditable: true, tagName: "DIV", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: null };
    const inner = { tagName: "SPAN", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: block };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, inner)).toEqual({ reached: 2, calls: [] });
  });

  test("a stroke while text is selected drags the selection, not the drawer", () => {
    selection = { isCollapsed: false };
    expect(stroke([[4, 400], [24, 400], [90, 400]])).toEqual({ reached: 2, calls: [] });
    expect(stroke([[300, 400], [270, 400], [200, 400]], true)).toEqual({ reached: 2, calls: [] });
  });

  test("a selection begun mid-stroke, before the drawer moved, hands the stroke back", () => {
    expect(stroke([[4, 400], [24, 400], [40, 400], [90, 400]], false, null, () => { selection = { isCollapsed: false }; })).toEqual({ reached: 2, calls: [] });
  });

  test("the drawer is under the finger while it moves, and settles where it is let go", () => {
    const style: Record<string, string> = {};
    const drawer = { style, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = (id: string) => (id === "workspace-drawer" ? drawer : null);
    const seen: string[] = [];
    const watch = new Proxy(style, { set: (target, key: string, value: string) => { target[key] = value; if (key === "transform") seen.push(value); return true; } });
    drawer.style = watch;
    const timed = stroke([[4, 400], [24, 400], [100, 400], [100, 400], [100, 400]]);
    expect(seen).toContain("translateX(-204px)");
    expect(timed.calls).toEqual([true, false]);
    expect(style["transform"]).toBe("");
    expect(style["visibility"]).toBe("");
    delete doc["getElementById"];
  });

  test("a stroke whose end never came lets the drawer go at the next touch", () => {
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const scrim = { style: {} as Record<string, string> };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = (id: string) => (id === "workspace-drawer" ? drawer : null);
    doc["querySelector"] = (selector: string) => (selector === ".scrim" ? scrim : null);
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => true, (next) => calls.push(next));
    const event = (x: number, timeStamp: number) => ({ touches: [{ clientX: x, clientY: 400 }], target: null, timeStamp, preventDefault: () => {}, stopPropagation: () => {} });
    listeners.get("touchstart")!(event(360, 0));
    listeners.get("touchmove")!(event(330, 16));
    listeners.get("touchmove")!(event(290, 32));
    expect(calls).toEqual([false]);
    expect(drawer.style["transform"]).toBe("translateX(-70px)");
    expect(scrim.style["transition"]).toBe("none");
    listeners.get("touchstart")!(event(100, 5000));
    expect(calls).toEqual([false, true]);
    expect(drawer.style["transform"]).toBe("");
    expect(drawer.style["transition"]).toBe("");
    expect(drawer.style["visibility"]).toBe("");
    expect(scrim.style["transition"]).toBe("");
    expect(scrim.style["opacity"]).toBe("");
    stop();
    delete doc["getElementById"];
  });

  test("a flick that lifts after one move settles by its speed from the touch down", () => {
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = (id: string) => (id === "workspace-drawer" ? drawer : null);
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (next) => calls.push(next));
    const event = (x: number, timeStamp: number) => ({ touches: [{ clientX: x, clientY: 400 }], target: null, timeStamp, preventDefault: () => {}, stopPropagation: () => {} });
    listeners.get("touchstart")!(event(4, 0));
    listeners.get("touchmove")!(event(40, 20));
    listeners.get("touchend")!({ touches: [], timeStamp: 30 });
    expect(calls).toEqual([true]);
    stop();
    delete doc["getElementById"];
  });

  test("a decided flat interior move can open even when the browser no longer allows cancellation", () => {
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (open) => calls.push(open));
    listeners.get("touchstart")!({ touches: [{ clientX: 200, clientY: 300 }], target: null });
    listeners.get("touchmove")!({ touches: [{ clientX: 270, clientY: 300 }], cancelable: false,
      preventDefault: () => { throw new Error("must not call preventDefault on a non-cancelable event"); }, stopPropagation: () => {} });
    expect(calls).toEqual([true]);
    stop();
  });

  /** Timed moves with a real drawer stand-in, including a rested lift that cannot count as a flick. */
  const timedStroke = (points: [number, number][], liftAt: number) => {
    const drawer = { style: {} as Record<string, string>, getBoundingClientRect: () => ({ width: 300 }) };
    const doc = (globalThis as Record<string, unknown>)["document"] as Record<string, unknown>;
    doc["getElementById"] = () => drawer;
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => false, (open) => calls.push(open));
    const event = ([x, at]: [number, number]) => ({ touches: [{ clientX: x, clientY: 400 }], timeStamp: at,
      target: null, cancelable: true, preventDefault: () => {}, stopPropagation: () => {} });
    listeners.get("touchstart")!(event(points[0]!));
    for (const point of points.slice(1)) listeners.get("touchmove")!(event(point));
    listeners.get("touchend")!({ touches: [], timeStamp: liftAt });
    expect(drawer.style["transform"]).toBe("");
    stop();
    return calls;
  };

  test("a slow short opening from the right half stays open after a rested lift", () => {
    expect(timedStroke([[320, 0], [340, 200], [360, 400], [380, 600]], 1600)).toEqual([true]);
  });

  test("an interior opening can still be reversed or flicked closed", () => {
    expect(timedStroke([[320, 0], [380, 600], [330, 900]], 1600)).toEqual([true, false]);
    expect(timedStroke([[200, 0], [360, 400], [300, 416]], 420)).toEqual([true, false]);
  });

  test("the edge keeps its existing half-width settling for a slow short stroke", () => {
    expect(timedStroke([[4, 0], [64, 600]], 1600)).toEqual([true, false]);
  });

  test("a selection after the drawer moved leaves the stroke with it", () => {
    expect(stroke([[4, 400], [70, 400], [90, 400], [100, 400]], false, null, () => { selection = { isCollapsed: false }; })).toEqual({ reached: 0, calls: [true] });
  });
});
