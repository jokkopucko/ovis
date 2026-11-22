import { describe, expect, test } from "bun:test";
import { createElement, memo } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createDayStore, DayStoreContext, type DayClock } from "../lib/localDay.ts";
import { currentLocale } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { TurnTime } from "./TurnTime.tsx";

const MemoTurn = memo(function MemoTurn({ ts }: { ts: string }) {
  return createElement("div", null, createElement(TurnTime, { ts }));
});

describe("TurnTime", () => {
  test("reads today from the day store, not the wall clock: 'today 23:59' turns into yesterday after midnight", () => {
    let now = new Date(2020, 1, 3, 23, 59, 30).getTime();
    const clock: DayClock = { now: () => now, setTimer: () => 1, clearTimer: () => {} };
    const store = createDayStore(clock);
    const ts = new Date(2020, 1, 3, 23, 59).toISOString();
    const time = new Date(ts).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
    const render = (): string => {
      const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
      Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
      try {
        return renderToStaticMarkup(createElement(SettingsProvider, {
          children: createElement(DayStoreContext.Provider, { value: store }, createElement(MemoTurn, { ts })),
        }));
      } finally {
        if (saved) Object.defineProperty(navigator, "languages", saved);
        else Reflect.deleteProperty(navigator, "languages");
      }
    };
    expect(render()).toContain(`>${time}</time>`);
    now += 60_000;
    expect(render()).toContain(`>yesterday at ${time}</time>`);
  });
});
